import fs from "node:fs";
import * as cheerio from "cheerio";
import { getCollection } from "./db.js";

const NLCY_BASE_URL = "https://www.nlcy.go.kr";
const NLCY_LIST_PATH = "/NLCY/contents/C61000000000.do";
const NLCY_NEW_LIST_PATH = "/NLCY/contents/C10202000000.do";
const NLCY_MARC_PATH = "/NLCY/module/marc_view.do";
const MARC_SUBFIELD_DELIMITER = "▼";
const NLCY_COLLECTION = "nlcy";
const KDC_JSON_URL = new URL("../docs/kdc.json", import.meta.url);
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
  const url = new URL(NLCY_LIST_PATH, NLCY_BASE_URL);
  url.searchParams.set("detailSearch", "true");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("category", "도서");
  url.searchParams.set("kwd", " ");
  url.searchParams.set("systemType", "오프라인자료");
  url.searchParams.set("gu2", "kdc");
  url.searchParams.set("pageNum", String(page));
  url.searchParams.set("guCode2", String(kdc));
  return url.toString();
}

function parseHashParams(href) {
  const hash = String(href ?? "").split("#")[1] ?? "";
  const params = {};

  for (const pair of hash.split("&")) {
    const [key, value = ""] = pair.split("=");

    if (key) {
      params[key] = decodeURIComponent(value.replace(/\+/g, " "));
    }
  }

  return params;
}

function grabField(text, label, nextLabels) {
  const lookahead = nextLabels.map((value) => `${value}:`).join("|");
  const pattern = lookahead
    ? new RegExp(`${label}:\\s*(.*?)\\s*(?=${lookahead}|$)`)
    : new RegExp(`${label}:\\s*(.*?)\\s*$`);
  const matched = text.match(pattern);
  return matched ? normalizeText(matched[1]) : "";
}

function parseInfo(infoText) {
  const text = normalizeText(infoText);

  return {
    authors: grabField(text, "저자", ["발행처", "발행연도", "청구기호"]),
    publisher: grabField(text, "발행처", ["발행연도", "청구기호"]),
    pub_year: grabField(text, "발행연도", ["청구기호"]),
    call_nbr: grabField(text, "청구기호", [])
  };
}

function parseListItem($, anchor) {
  const $anchor = $(anchor);
  const params = parseHashParams($anchor.attr("href"));

  const titleClone = $anchor.clone();
  titleClone.find("span").remove();
  const title = normalizeText(titleClone.text()).replace(/^\d+\.\s*/, "");

  const info = parseInfo($anchor.nextAll("div.info").first().text());

  return {
    viewKey: params.viewKey ?? "",
    viewType: params.viewType ?? "",
    title,
    authors: info.authors,
    publisher: info.publisher,
    pub_year: info.pub_year ? Number(info.pub_year) : null,
    call_nbr: info.call_nbr
  };
}

function parseSubjectList(html) {
  const $ = cheerio.load(html);

  return $("a.subject")
    .map((_, node) => parseListItem($, node))
    .get()
    .filter((item) => item.viewKey);
}

export async function fetchNlcyList({ kdc, page = 1, pageSize = 100 }) {
  if (!kdc) {
    throw new Error("kdc is required.");
  }

  const html = await fetchHtml(buildListUrl({ kdc, page, pageSize }));
  return parseSubjectList(html);
}

function buildNewListUrl({ yyyymm, page = 1, pageSize = 100 }) {
  const match = String(yyyymm).match(/^(\d{4})(\d{2})$/);

  if (!match) {
    throw new Error(`yyyymm must be 6 digits (YYYYMM): ${yyyymm}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(year, month, 0).getDate();
  const start = `${yyyymm}01`;
  const end = `${yyyymm}${String(lastDay).padStart(2, "0")}`;

  const url = new URL(NLCY_NEW_LIST_PATH, NLCY_BASE_URL);
  url.searchParams.set("period", "month");
  url.searchParams.set("sortField", "reg_date");
  url.searchParams.set("sortOrder", "desc");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("regDate", `${start}_${end}`);
  url.searchParams.set("pageNum", String(page));
  return url.toString();
}

export async function fetchNlcyNewList({ yyyymm, page = 1, pageSize = 100 }) {
  if (!yyyymm) {
    throw new Error("yyyymm is required.");
  }

  const html = await fetchHtml(buildNewListUrl({ yyyymm, page, pageSize }));
  return parseSubjectList(html);
}

function buildMarcViewUrl({ viewType, viewKey }) {
  const url = new URL(NLCY_MARC_PATH, NLCY_BASE_URL);
  url.searchParams.set("viewType", String(viewType));
  url.searchParams.set("viewKey", String(viewKey));
  return url.toString();
}

function parseIndicators(text) {
  const raw = String(text ?? "").replace(/ /g, " ");
  return { ind1: raw.charAt(0), ind2: raw.charAt(1) };
}

function parseSubfields(text) {
  if (!String(text ?? "").includes(MARC_SUBFIELD_DELIMITER)) {
    // Control fields (00X) have no subfields and rely on fixed-position
    // spacing (e.g. 008), so preserve internal spaces — only trim line breaks.
    const data = String(text ?? "")
      .replace(/ /g, " ")
      .replace(/^[\r\n\t]+|[\r\n\t]+$/g, "");
    return data.trim() ? [{ sfld: "", data }] : [];
  }

  return String(text)
    .split(MARC_SUBFIELD_DELIMITER)
    .slice(1)
    .map((chunk) => ({ sfld: chunk.charAt(0), data: normalizeText(chunk.slice(1)) }))
    .filter((subfield) => subfield.sfld);
}

export async function fetchNlcyDetail({ viewKey, viewType = "AH1" }) {
  if (!viewKey) {
    throw new Error("viewKey is required.");
  }

  const html = await fetchHtml(buildMarcViewUrl({ viewType, viewKey }));
  const $ = cheerio.load(html);

  const leader = normalizeText($("div.borderWrap").first().text().replace(/^\s*리더\s*/, ""));

  const tags = $("table tr")
    .map((_, row) => {
      const cells = $(row).find("td");

      if (cells.length < 3) {
        return null;
      }

      const tagno = normalizeText($(cells[0]).text());
      const { ind1, ind2 } = parseIndicators($(cells[1]).text());
      const subfield = parseSubfields($(cells[2]).text());

      return { tagno, ind1, ind2, subfield };
    })
    .get()
    .filter((tag) => tag && tag.tagno);

  const isbn = extractIsbn(tags);
  const kdc = getSubfield(tags, "056", "a");
  const ddc = getSubfield(tags, "052", "a");
  const price = parsePrice(getSubfield(tags, "020", "c"));

  return { viewKey: String(viewKey), viewType: String(viewType), isbn, kdc, ddc, price, leader, tags };
}

function getSubfield(tags, tagno, sfld) {
  const tag = tags.find((entry) => entry.tagno === tagno);
  const subfield = tag?.subfield.find((entry) => entry.sfld === sfld);
  return subfield ? subfield.data : "";
}

function extractIsbn(tags) {
  // ▼a may carry qualifiers after the digits (e.g. "9791193138922(세트)").
  const raw = getSubfield(tags, "020", "a");
  return raw ? raw.replace(/[^0-9Xx].*$/, "").toUpperCase() : "";
}

function parsePrice(text) {
  // 020 ▼c is like "\16000" (₩ shown as backslash); keep digits only.
  const digits = String(text ?? "").replace(/[^0-9]/g, "");
  return digits ? Number(digits) : null;
}

export async function saveNlcyDetail(detail) {
  const collection = await getCollection(NLCY_COLLECTION);
  const now = new Date();

  return collection.updateOne(
    { viewKey: String(detail.viewKey) },
    {
      $set: {
        viewKey: String(detail.viewKey),
        viewType: detail.viewType ?? "",
        isbn: detail.isbn ?? "",
        kdc: detail.kdc ?? "",
        ddc: detail.ddc ?? "",
        price: detail.price ?? null,
        leader: detail.leader ?? "",
        tags: Array.isArray(detail.tags) ? detail.tags : [],
        marc_updated_at: now,
        updated_at: now
      },
      $setOnInsert: {
        created_at: now
      }
    },
    { upsert: true }
  );
}

let kdcTreeCache;

function loadKdcTree() {
  if (!kdcTreeCache) {
    kdcTreeCache = JSON.parse(fs.readFileSync(KDC_JSON_URL, "utf8"));
  }

  return kdcTreeCache;
}

function getKdcChildren(kdc) {
  const target = String(kdc).trim();
  const top = loadKdcTree().find((entry) => String(entry.kdc) === target);

  if (!top) {
    throw new Error(`Unknown top-level KDC: ${kdc}`);
  }

  const seen = new Set();
  return (Array.isArray(top.children) ? top.children : [])
    .map((child) => ({ kdc: String(child.kdc), label: String(child.label ?? "") }))
    .filter((child) => {
      if (seen.has(child.kdc)) {
        return false;
      }

      seen.add(child.kdc);
      return true;
    });
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)
  );
}

export async function saveNlcyList(items, { kdc, kdcLabel, parentKdc, regMonth } = {}) {
  const collection = await getCollection(NLCY_COLLECTION);
  const now = new Date();
  const operations = [];

  // Only set classification/source fields when provided, so saving a
  // new-arrivals record does not wipe a kdc set by a prior KDC crawl.
  const contextFields = compactObject({
    kdc: kdc != null ? String(kdc) : undefined,
    kdc_label: kdc != null ? (kdcLabel ?? "") : undefined,
    parent_kdc: parentKdc != null ? String(parentKdc) : undefined,
    reg_month: regMonth != null ? String(regMonth) : undefined
  });

  for (const item of items) {
    if (!item.viewKey) {
      continue;
    }

    operations.push({
      updateOne: {
        filter: { viewKey: String(item.viewKey) },
        update: {
          $set: {
            viewKey: String(item.viewKey),
            viewType: item.viewType ?? "",
            title: item.title ?? "",
            authors: item.authors ?? "",
            publisher: item.publisher ?? "",
            pub_year: item.pub_year ?? null,
            call_nbr: item.call_nbr ?? "",
            ...contextFields,
            updated_at: now
          },
          $setOnInsert: {
            created_at: now
          }
        },
        upsert: true
      }
    });
  }

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

async function crawlNlcyKdc({ kdc, kdcLabel, parentKdc, pageSize, maxPages }) {
  const db = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  let savedCount = 0;
  let page = 1;

  while (page <= maxPages) {
    const items = await fetchNlcyList({ kdc, page, pageSize });
    console.log(`nlcy kdc:${kdc} page:${page} items:${items.length}`);

    if (items.length === 0) {
      break;
    }

    const result = await saveNlcyList(items, { kdc, kdcLabel, parentKdc });
    db.matchedCount += result.matchedCount;
    db.modifiedCount += result.modifiedCount;
    db.upsertedCount += result.upsertedCount;
    savedCount += items.length;

    if (items.length < pageSize) {
      break;
    }

    page += 1;
  }

  return { kdc: String(kdc), label: kdcLabel ?? "", crawledPages: page, saved_count: savedCount, db };
}

export async function crawlNlcyByKdc(parentKdc, { pageSize = 100, maxPages = Infinity } = {}) {
  if (!parentKdc) {
    throw new Error("kdc is required.");
  }

  const children = getKdcChildren(parentKdc);
  const groups = [];
  const db = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  let savedCount = 0;

  for (const child of children) {
    const payload = await crawlNlcyKdc({
      kdc: child.kdc,
      kdcLabel: child.label,
      parentKdc,
      pageSize,
      maxPages
    });

    groups.push(payload);
    db.matchedCount += payload.db.matchedCount;
    db.modifiedCount += payload.db.modifiedCount;
    db.upsertedCount += payload.db.upsertedCount;
    savedCount += payload.saved_count;
  }

  return {
    command: "nlcyCrawl",
    parent_kdc: String(parentKdc),
    child_count: children.length,
    saved_count: savedCount,
    db,
    groups
  };
}

export async function crawlNlcyNew(yyyymm, { pageSize = 100, maxPages = Infinity } = {}) {
  if (!yyyymm) {
    throw new Error("yyyymm is required.");
  }

  const db = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  let savedCount = 0;
  let page = 1;

  while (page <= maxPages) {
    const items = await fetchNlcyNewList({ yyyymm, page, pageSize });
    console.log(`nlcy new:${yyyymm} page:${page} items:${items.length}`);

    if (items.length === 0) {
      break;
    }

    const result = await saveNlcyList(items, { regMonth: yyyymm });
    db.matchedCount += result.matchedCount;
    db.modifiedCount += result.modifiedCount;
    db.upsertedCount += result.upsertedCount;
    savedCount += items.length;

    if (items.length < pageSize) {
      break;
    }

    page += 1;
  }

  return {
    command: "nlcyNew",
    reg_month: String(yyyymm),
    crawled_pages: page,
    saved_count: savedCount,
    db
  };
}
