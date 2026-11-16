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

// 문서가 수백만 건이라 viewKey 인덱스가 없으면 upsert 마다 전체 스캔이 된다. 최초 1회 보장.
let nlIndexReady;

export async function getNlCollection() {
  const collection = await getCollection(NL_COLLECTION);

  if (!nlIndexReady) {
    nlIndexReady = (async () => {
      console.log("nl: viewKey 인덱스 확인/생성 중 (처음에는 시간이 걸릴 수 있음)");
      await collection.createIndex({ viewKey: 1 }, { unique: true, name: "viewKey_1" });
      await collection.createIndex({ created_at: 1 }, { name: "created_at_1" });
    })().catch((error) => {
      nlIndexReady = null;
      throw error;
    });
  }

  await nlIndexReady;
  return collection;
}

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
  const collection = await getNlCollection();
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
  const collection = await getNlCollection();
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
    // 구간별 소요시간(조회/파싱/저장)을 찍어 어디서 느려지는지 확인한다
    const t0 = Date.now();
    const html = await fetchHtml(buildListUrl({ kdc, page, pageSize }));
    const t1 = Date.now();
    const items = parseList(html);
    const t2 = Date.now();

    if (items.length === 0) {
      console.log(`nl kdc:${kdc} page:${page} items:0 (fetch ${t1 - t0}ms)`);
      break;
    }

    const result = await saveNlList(items, { kdc });
    const t3 = Date.now();
    console.log(`nl kdc:${kdc} page:${page} items:${items.length} (fetch ${t1 - t0}ms, parse ${t2 - t1}ms, save ${t3 - t2}ms, total ${t3 - t0}ms)`);
    db.matchedCount += result.matchedCount;
    db.modifiedCount += result.modifiedCount;
    db.upsertedCount += result.upsertedCount;
    savedCount += items.length;
    page += 1;
  }

  return { kdc: String(kdc).padStart(3, "0"), crawled_pages: page - 1, saved_count: savedCount, db };
}

// ---------------------------------------------------------------------------
// 신착도서 (N10302000000.do) — 주(週) 단위 regDate(YYYYMMDD_YYYYMMDD), 최근 약 5주만 제공
// ---------------------------------------------------------------------------
const NL_NEW_PAGE_PATH = "/NL/contents/N10302000000.do";
const NL_NEW_AJAX_PATH = "/NL/search/new_arrivals_result.ajax";

// 신착자료 페이지가 제공하는 주차 목록 (jsWeekList.push("20261012_20261018"))
export async function fetchNlNewWeeks() {
  const html = await fetchHtml(new URL(NL_NEW_PAGE_PATH, NL_BASE_URL).toString());
  return [...html.matchAll(/jsWeekList\.push\("(\d{8}_\d{8})"\)/g)].map((m) => m[1]);
}

function parseNewList(html) {
  const $ = cheerio.load(html);
  const total = Number(($(".selected_data").first().text() || "0").replace(/[^0-9]/g, ""));

  const items = $("li.ucsrch3_item")
    .map((_, li) => {
      const $li = $(li);
      const anchor = $li.find("a.title").first();
      const idMatch = String(anchor.attr("onclick") ?? "").match(/setDetailPage\('[^']*','([^']*)','([^']*)'\)/);

      if (!idMatch) {
        return null;
      }

      return {
        viewKey: idMatch[1],
        viewType: idMatch[2],
        title: normalizeText(anchor.text()),
        group: normalizeText($li.find(".classify .group").first().text()),
        subject: normalizeText($li.find(".classify .category").first().text()),
        authors: normalizeText($li.find("dd.author").first().text()).replace(/^[^:]{0,20}:\s*/, ""),
        publisher: normalizeText($li.find("dd.publisher").first().text()),
        pub_year: Number($li.find("dd.year").first().text().trim()) || null,
        collect_date: normalizeText($li.find("dd.collect_date").first().text()),
        call_nbr: normalizeText($li.find("dd.book_code").first().text())
      };
    })
    .get()
    .filter(Boolean);

  return { total, items };
}

export async function fetchNlNewList({ regDate, page = 1, pageSize = 100 }) {
  if (!regDate) {
    throw new Error("regDate is required (YYYYMMDD_YYYYMMDD).");
  }

  const url = new URL(NL_NEW_AJAX_PATH, NL_BASE_URL);
  url.searchParams.set("pageNum", String(page));
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("codeName", "kdc");
  url.searchParams.set("regDate", regDate);

  const { total, items } = parseNewList(await fetchHtml(url.toString()));
  // 서버의 naCategory=도서 필터가 0건을 돌려주므로 결과의 구분(group)으로 직접 거른다
  return { total, items: items.filter((item) => item.group === "도서") };
}

async function saveNlNewList(items, regDate) {
  const collection = await getNlCollection();
  const now = new Date();
  const operations = items.map((item) => ({
    updateOne: {
      filter: { viewKey: String(item.viewKey) },
      update: {
        $set: {
          viewKey: String(item.viewKey),
          viewType: item.viewType,
          title: item.title,
          authors: item.authors,
          publisher: item.publisher,
          pub_year: item.pub_year,
          call_nbr: item.call_nbr,
          subject: item.subject,
          collect_date: item.collect_date,
          reg_week: regDate,
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

// regDate 가 없으면 제공되는 모든 주차를 수집
export async function crawlNlNew(regDate, { pageSize = 100, maxPages = Infinity } = {}) {
  const weeks = regDate ? [regDate] : await fetchNlNewWeeks();
  const db = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  const groups = [];
  let savedCount = 0;

  for (const week of weeks) {
    let page = 1;
    let weekSaved = 0;
    let total = 0;

    // 전체 자료(도서+학위논문 등)를 페이지 단위로 넘기므로, 도서가 0건인 페이지도 계속 진행하고
    // 전체 건수를 다 본 시점에 종료한다.
    while (page <= maxPages) {
      const result = await fetchNlNewList({ regDate: week, page, pageSize });
      total = result.total;
      console.log(`nl new:${week} page:${page} books:${result.items.length} (전체 ${total})`);

      if (result.total === 0 || (page - 1) * pageSize >= result.total) {
        break;
      }

      const saved = await saveNlNewList(result.items, week);
      db.matchedCount += saved.matchedCount;
      db.modifiedCount += saved.modifiedCount;
      db.upsertedCount += saved.upsertedCount;
      weekSaved += result.items.length;
      page += 1;
    }

    savedCount += weekSaved;
    groups.push({ reg_week: week, total, saved_count: weekSaved });
  }

  return { command: "nlNew", saved_count: savedCount, db, groups };
}
