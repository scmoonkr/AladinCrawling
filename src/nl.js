import * as cheerio from "cheerio";
import { getCollection } from "./db.js";

// 국립중앙도서관(nl.go.kr) 소장자료 검색 → 도서 목록 / MARC 수집
const NL_BASE_URL = "https://www.nl.go.kr";
const NL_LIST_PATH = "/NL/contents/search.do";
const NL_MARC_PATH = "/NL/search/marc_view.do";
const MARC_SUBFIELD_DELIMITER = "▼";
const NL_COLLECTION = "nl";
const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};

function normalizeText(value) {
  return String(value ?? "")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  return response.text();
}

function buildListUrl({ kdc, page = 1, pageSize = 100 }) {
  const url = new URL(NL_LIST_PATH, NL_BASE_URL);
  url.searchParams.set("detailSearch", "true");
  url.searchParams.set("sort", "iregdate");
  url.searchParams.set("desc", "desc");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("category", "도서");
  url.searchParams.set("gu2", "kdc");
  url.searchParams.set("guCode2", String(kdc).padStart(3, "0"));
  url.searchParams.set("pageNum", String(page));
  return url.toString();
}

// fn_setDetailLog('viewKey','viewType','제어번호','제목','시스템','카테고리','소장처')
function parseDetailLog(onclick) {
  const matched = String(onclick ?? "").match(/fn_setDetailLog\((.*)\)/s);

  if (!matched) {
    return null;
  }

  const args = [...matched[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  return {
    viewKey: args[0] ?? "",
    viewType: args[1] ?? "",
    controlNo: args[2] ?? "",
    title: normalizeText(args[3]),
    systemType: args[4] ?? "",
    category: args[5] ?? "",
    place: normalizeText(args[6])
  };
}

// "량기백 씀 - 바우하우스 - 1997 - 청구기호 : 010.3-양873ㅎ" (구분자는 span.hyphen)
function parseResultText($, $li) {
  const $info = $li.find(".book_info .result_txt").first().clone();
  $info.find("span.hyphen").replaceWith("\u0001");
  const parts = $info.text().split("\u0001").map(normalizeText).filter(Boolean);

  const callPart = parts.find((part) => part.startsWith("청구기호"));
  const rest = parts.filter((part) => part !== callPart);
  const yearIndex = rest.findIndex((part) => /^\d{4}$/.test(part));

  return {
    authors: rest[0] && yearIndex !== 0 ? rest[0] : "",
    publisher: yearIndex > 1 ? rest[1] : "",
    pub_year: yearIndex >= 0 ? Number(rest[yearIndex]) : null,
    call_nbr: callPart ? normalizeText(callPart.replace(/^청구기호\s*:?\s*/, "")) : ""
  };
}

function parseList(html) {
  const $ = cheerio.load(html);

  return $("a.detail_btn_layer")
    .map((_, anchor) => {
      const log = parseDetailLog($(anchor).attr("onclick"));

      if (!log || !log.viewKey) {
        return null;
      }

      const $li = $(anchor).closest("li");
      return { ...log, ...parseResultText($, $li) };
    })
    .get()
    .filter((item) => item && item.category === "도서");
}

export async function fetchNlList({ kdc, page = 1, pageSize = 100 }) {
  if (kdc === undefined || kdc === null || kdc === "") {
    throw new Error("kdc is required.");
  }

  return parseList(await fetchHtml(buildListUrl({ kdc, page, pageSize })));
}

function buildMarcUrl({ viewType, viewKey }) {
  const url = new URL(NL_MARC_PATH, NL_BASE_URL);
  url.searchParams.set("viewType", String(viewType));
  url.searchParams.set("viewKey", String(viewKey));
  return url.toString();
}

function parseSubfields(text) {
  const raw = String(text ?? "").replace(/ /g, " ");

  if (!raw.includes(MARC_SUBFIELD_DELIMITER)) {
    // 제어필드(00X)는 고정길이 위치가 의미 있으므로 내부 공백 유지
    const data = raw.replace(/^[\r\n\t]+|[\r\n\t]+$/g, "");
    return data.trim() ? [{ sfld: "", data }] : [];
  }

  return raw
    .split(MARC_SUBFIELD_DELIMITER)
    .slice(1)
    .map((chunk) => ({ sfld: chunk.charAt(0), data: normalizeText(chunk.slice(1)) }))
    .filter((subfield) => subfield.sfld);
}

function getSubfield(tags, tagno, sfld) {
  const tag = tags.find((entry) => entry.tagno === tagno);
  const subfield = tag?.subfield.find((entry) => entry.sfld === sfld);
  return subfield ? subfield.data : "";
}

export async function fetchNlDetail({ viewKey, viewType = "AH1" }) {
  if (!viewKey) {
    throw new Error("viewKey is required.");
  }

  const $ = cheerio.load(await fetchHtml(buildMarcUrl({ viewType, viewKey })));
  const leader = normalizeText($("table").first().find("td").first().text());

  const tags = $("table").eq(1).find("tbody tr")
    .map((_, row) => {
      const cells = $(row).find("td");

      if (cells.length < 3) {
        return null;
      }

      const ind = String($(cells[1]).text()).replace(/ /g, " ");
      return {
        tagno: normalizeText($(cells[0]).text()),
        ind1: ind.charAt(0),
        ind2: ind.charAt(1),
        subfield: parseSubfields($(cells[2]).text())
      };
    })
    .get()
    .filter((tag) => tag && tag.tagno);

  const rawIsbn = getSubfield(tags, "020", "a");
  const priceDigits = getSubfield(tags, "020", "c").replace(/[^0-9]/g, "");

  return {
    viewKey: String(viewKey),
    viewType: String(viewType),
    controlNo: tags.find((tag) => tag.tagno === "001")?.subfield[0]?.data ?? "",
    isbn: rawIsbn ? rawIsbn.replace(/[^0-9Xx].*$/, "").toUpperCase() : "",
    kdc: getSubfield(tags, "056", "a"),
    ddc: getSubfield(tags, "082", "a") || getSubfield(tags, "052", "a"),
    price: priceDigits ? Number(priceDigits) : null,
    leader,
    tags
  };
}

export async function saveNlList(items, { kdc } = {}) {
  const collection = await getCollection(NL_COLLECTION);
  const now = new Date();
  const operations = items
    .filter((item) => item.viewKey)
    .map((item) => ({
      updateOne: {
        filter: { viewKey: String(item.viewKey) },
        update: {
          $set: {
            viewKey: String(item.viewKey),
            viewType: item.viewType ?? "",
            controlNo: item.controlNo ?? "",
            title: item.title ?? "",
            authors: item.authors ?? "",
            publisher: item.publisher ?? "",
            pub_year: item.pub_year ?? null,
            call_nbr: item.call_nbr ?? "",
            place: item.place ?? "",
            ...(kdc != null ? { list_kdc: String(kdc).padStart(3, "0") } : {}),
            updated_at: now
          },
          $setOnInsert: { created_at: now }
        },
        upsert: true
      }
    }));

  if (operations.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  const result = await collection.bulkWrite(operations, { ordered: false });
  return {
    matchedCount: result.matchedCount ?? 0,
    modifiedCount: result.modifiedCount ?? 0,
    upsertedCount: result.upsertedCount ?? 0
  };
}

export async function saveNlDetail(detail) {
  const collection = await getCollection(NL_COLLECTION);
  const now = new Date();

  return collection.updateOne(
    { viewKey: String(detail.viewKey) },
    {
      $set: {
        viewKey: String(detail.viewKey),
        viewType: detail.viewType ?? "",
        controlNo: detail.controlNo ?? "",
        isbn: detail.isbn ?? "",
        kdc: detail.kdc ?? "",
        ddc: detail.ddc ?? "",
        price: detail.price ?? null,
        leader: detail.leader ?? "",
        tags: Array.isArray(detail.tags) ? detail.tags : [],
        updated_at: now
      },
      $setOnInsert: { created_at: now }
    },
    { upsert: true }
  );
}

// kdc: 단일 코드("010") 또는 범위 시작/끝. 빈 페이지·마지막 페이지까지 순회
export async function crawlNlKdc(kdc, { pageSize = 100, maxPages = Infinity } = {}) {
  const db = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  let savedCount = 0;
  let page = 1;

  while (page <= maxPages) {
    const items = await fetchNlList({ kdc, page, pageSize });
    console.log(`nl kdc:${kdc} page:${page} items:${items.length}`);

    if (items.length === 0) {
      break;
    }

    const result = await saveNlList(items, { kdc });
    db.matchedCount += result.matchedCount;
    db.modifiedCount += result.modifiedCount;
    db.upsertedCount += result.upsertedCount;
    savedCount += items.length;
    page += 1;
  }

  return { kdc: String(kdc).padStart(3, "0"), crawled_pages: page - 1, saved_count: savedCount, db };
}
