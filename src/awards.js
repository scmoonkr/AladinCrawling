// 알라딘 문학상 수상작 목록 수집
//   https://www.aladin.co.kr/shop/book/Recommend2010/award.aspx?awardtype=<분류>&awardid=<상>
// 분류(awardtype) 페이지마다 그 분류의 상 목록이 있고, 상 페이지에는 책 카드가 페이지당 최대 100권 나온다.
// 각 카드에는 "2025년 노벨문학상 수상, 2015년 부커상 수상" 처럼 연도가 붙은 수상 표기가 있다.
// (작가에게 주는 상은 그 작가의 책 전체가 나온다 — 연도는 수상 연도)
import * as cheerio from "cheerio";
import { fetchHtml, parseBookCard } from "./aladin.js";

const AWARD_URL = "https://www.aladin.co.kr/shop/book/Recommend2010/award.aspx";
const PAGE_SIZE = 100;

// awardtype → 분류 이름 · 대상
export const AWARD_TYPES = {
  1: { name: "국내 문학상", audience: null },
  2: { name: "해외 문학상", audience: null },
  3: { name: "국내 어린이 문학상", audience: "CHILD" },
  4: { name: "해외 어린이 문학상", audience: "CHILD" }
};

function normalizeText(value) {
  return String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function extractItemId(url) {
  return String(url ?? "").match(/[?&]ItemId=(\d+)/i)?.[1] ?? null;
}

function buildAwardUrl(awardType, awardId, page = 1) {
  const url = new URL(AWARD_URL);
  url.searchParams.set("awardtype", String(awardType));
  if (awardId) url.searchParams.set("awardid", String(awardId));
  url.searchParams.set("ViewRowsCount", String(PAGE_SIZE));
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

// 분류 페이지의 상 목록 — [{ awardType, awardId, name, groupName, audience, url }]
export async function fetchAwardList(awardType) {
  const type = AWARD_TYPES[awardType];
  if (!type) {
    throw new Error("awardtype 은 1~4 중 하나여야 합니다.");
  }

  const html = await fetchHtml(buildAwardUrl(awardType));
  const $ = cheerio.load(html);
  const awards = new Map();

  $('a[href*="award.aspx"]').each((_, node) => {
    const href = $(node).attr("href") ?? "";
    const hrefType = href.match(/awardtype=(\d+)/i)?.[1];
    const awardId = href.match(/awardid=(\d+)/i)?.[1];
    const name = normalizeText($(node).text());
    // 같은 페이지에 다른 분류로 가는 링크도 있다 — 이 분류의 상만 모은다
    if (!awardId || hrefType !== String(awardType) || !name || awards.has(awardId)) return;
    awards.set(awardId, {
      awardType: Number(awardType),
      awardId,
      name,
      groupName: type.name,
      audience: type.audience,
      url: buildAwardUrl(awardType, awardId).replace(/&ViewRowsCount=\d+/, "")
    });
  });

  return [...awards.values()];
}

// 카드의 수상 표기 → [{ year, round, text }]
//   "2025년 노벨문학상 수상,  2015년 부커상 수상"
//   "2026년 49회 이상문학상 수상"            (회차)
//   "2026년 칼데콧상 칼데콧 아너 수상"        (상 이름 뒤에 부문)
function parseAwardLabel(label) {
  return normalizeText(label)
    .split(",")
    .map((part) => {
      const match = normalizeText(part).match(/^(?:(\d{4})년\s*)?(?:(\d+)회\s*)?(.+?)\s*(?:수상|후보)?$/);
      if (!match || !match[3]) return null;
      return {
        year: match[1] ? Number(match[1]) : null,
        round: match[2] ? Number(match[2]) : null,
        text: normalizeText(match[3])
      };
    })
    .filter(Boolean);
}

const squash = (value) => String(value).replace(/\s/g, "");

function parseAwardCards($, award, startRank) {
  const items = [];

  $(".ss_book_box").each((index, node) => {
    const $card = $(node);
    const card = parseBookCard($, $card);
    const itemId = extractItemId(card.url);
    if (!itemId) return;

    // 수상 표기 줄 — 수상 아이콘(i_award.gif)이 있는 li
    const label = normalizeText($card.find('img[src*="i_award"]').first().parent().text());
    const entries = parseAwardLabel(label);
    // 한 책에 여러 상이 적혀 있다. 이 목록의 상에 해당하는 연도를 쓴다
    const own = entries.find((entry) => squash(entry.text).includes(squash(award.name)));
    // 상 이름을 뺀 나머지가 부문이다 ("칼데콧상 칼데콧 아너" → "칼데콧 아너")
    const division = own ? normalizeText(own.text.replace(award.name, "")) : "";

    items.push({
      itemId,
      title: card.title,
      subtitle: card.subtitle,
      author: card.author,
      publisher: card.publisher,
      pubDate: card.pub_date,
      imageUrl: card.image_url,
      price: card.price,
      year: own?.year ?? null,
      round: own?.round ?? null,
      division,
      label,
      rank: startRank + index
    });
  });

  return items;
}

function lastPageOf($) {
  const pages = [];
  $('a[href*="Page_Set"]').each((_, node) => {
    const page = ($(node).attr("href") ?? "").match(/Page_Set\('(\d+)'\)/)?.[1];
    if (page) pages.push(Number(page));
  });
  return pages.length ? Math.max(...pages) : 1;
}

// 상 1개의 수상작 전체 — { award, items, pages }
export async function fetchAwardItems(award, { maxPages = Infinity } = {}) {
  const items = new Map();
  let lastPage = 1;
  let page = 1;

  for (; page <= Math.min(lastPage, maxPages); page += 1) {
    const html = await fetchHtml(buildAwardUrl(award.awardType, award.awardId, page));
    const $ = cheerio.load(html);
    if (page === 1) lastPage = lastPageOf($);

    const cards = parseAwardCards($, award, items.size + 1);
    if (cards.length === 0) break;
    // 같은 책이 여러 페이지에 걸쳐 다시 나오면 처음 것만 둔다
    for (const card of cards) {
      if (!items.has(card.itemId)) items.set(card.itemId, card);
    }
    // 한 페이지의 유효 카드가 100개보다 적어도(품절·세트 등) 마지막 쪽까지 읽는다 — 빈 쪽에서만 멈춘다
  }

  return { award, items: [...items.values()], pages: page - 1 > 0 ? Math.min(page, lastPage) : 1, lastPage };
}
