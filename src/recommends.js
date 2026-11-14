// 알라딘 외부/전문기관 추천도서 목록 수집
//   https://www.aladin.co.kr/shop/book/Recommend2010/type2.aspx?cid=<목록>
// 어느 목록 페이지에나 전체 목록(기관·선정 이름) 링크가 있고, 목록 페이지에는 책 카드가 페이지당 최대 100권 나온다.
// 카드에는 연도 표기가 없다. 대신 목록에 따라 연도·부문별 하위 목록("2023년", "2006년 가을")이 있고,
// 그 링크는 해당 목록 페이지에만 나온다 — 하위 목록을 따로 읽어 연도·부문을 붙인다.
import * as cheerio from "cheerio";
import { fetchHtml, parseBookCard } from "./aladin.js";

const RECOMMEND_URL = "https://www.aladin.co.kr/shop/book/Recommend2010/type2.aspx";
const PAGE_SIZE = 100;
// 전체 목록 링크를 얻으려고 여는 페이지 2개 — 두 페이지에 모두 나오는 링크가 최상위 목록이다
// (각 페이지에만 나오는 링크는 그 목록의 하위 목록)
const SEED_CIDS = ["118010", "71292"];
export const RECOMMEND_GROUP = "외부/전문기관 추천도서";

function normalizeText(value) {
  return String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function extractItemId(url) {
  return String(url ?? "").match(/[?&]ItemId=(\d+)/i)?.[1] ?? null;
}

function buildRecommendUrl(cid, page = 1, pageSize = PAGE_SIZE) {
  const url = new URL(RECOMMEND_URL);
  url.searchParams.set("cid", String(cid));
  if (pageSize) url.searchParams.set("ViewRowsCount", String(pageSize));
  if (page > 1) url.searchParams.set("page", String(page));
  return url.toString();
}

// 이름으로 대상 독자를 짐작한다 (어린이·유아 → CHILD, 청소년·중고등 → YOUTH)
function audienceOf(name) {
  if (/어린이|유아|유치원|초등|아동|그림책|취학전/.test(name)) return "CHILD";
  if (/청소년|중고등|중학|고등/.test(name)) return "YOUTH";
  return null;
}

// "2010 시사인 올해의 책" · "2006년 가을" → 2010 · 2006
function yearOf(name) {
  const year = Number(name.match(/(?:^|\D)((?:19|20)\d{2})(?!\d)/)?.[1]);
  return Number.isFinite(year) && year > 0 ? year : null;
}

// 하위 목록 이름에서 연도를 뺀 나머지가 부문이다 ("2006년 가을" → "가을", "2023년" → "")
function divisionOf(name) {
  return normalizeText(name.replace(/(?:19|20)\d{2}\s*년?(?:도)?/, ""));
}

function lastPageOf($) {
  const pages = [];
  $('a[href*="Page_Set"]').each((_, node) => {
    const page = ($(node).attr("href") ?? "").match(/Page_Set\('(\d+)'\)/)?.[1];
    if (page) pages.push(Number(page));
  });
  return pages.length ? Math.max(...pages) : 1;
}

// 목록 페이지 1쪽 — 책 카드 + 이 페이지에 있는 목록 링크(cid → 이름)
async function fetchPage(cid, page) {
  const html = await fetchHtml(buildRecommendUrl(cid, page));
  const $ = cheerio.load(html);

  const links = new Map();
  $('a[href*="type2.aspx"]').each((_, node) => {
    const linkCid = ($(node).attr("href") ?? "").match(/cid=(\d+)/i)?.[1];
    const name = normalizeText($(node).text());
    if (!linkCid || !name) return;
    // 같은 목록이 상단 배너(짧은 이름)와 전체 목록(정식 이름)에 두 번 나온다 — 긴 쪽이 정식 이름이다
    if (!links.has(linkCid) || links.get(linkCid).length < name.length) links.set(linkCid, name);
  });

  const cards = [];
  $(".ss_book_box").each((_, node) => {
    const card = parseBookCard($, $(node));
    const itemId = extractItemId(card.url);
    if (itemId) cards.push({ itemId, card });
  });

  return { links, cards, lastPage: lastPageOf($) };
}

// 최상위 추천 목록 — [{ cid, name, groupName, audience, year, url }]
export async function fetchRecommendList() {
  const pages = [];
  for (const cid of SEED_CIDS) pages.push(await fetchPage(cid, 1));

  const lists = [];
  for (const [cid, name] of pages[0].links) {
    if (!pages.slice(1).every((page) => page.links.has(cid))) continue;   // 한쪽에만 있으면 하위 목록
    const fullName = pages.reduce((best, page) => {
      const candidate = page.links.get(cid) ?? "";
      return candidate.length > best.length ? candidate : best;
    }, name);
    lists.push({
      cid,
      name: fullName,
      groupName: RECOMMEND_GROUP,
      audience: audienceOf(fullName),
      year: yearOf(fullName),
      url: buildRecommendUrl(cid, 1, 0)
    });
  }
  return lists;
}

// cid 한 곳의 책을 끝 쪽까지 읽어 items(Map)에 더한다. 이미 있는 책은 건너뛴다 (먼저 읽은 연도·부문을 지킨다)
async function collect(cid, firstPage, items, meta, maxPages) {
  let page = 1;
  let current = firstPage;
  let added = 0;
  for (;;) {
    for (const { itemId, card } of current.cards) {
      if (items.has(itemId)) continue;
      items.set(itemId, {
        itemId,
        title: card.title,
        subtitle: card.subtitle,
        author: card.author,
        publisher: card.publisher,
        pubDate: card.pub_date,
        imageUrl: card.image_url,
        price: card.price,
        year: meta.year,
        round: null,
        division: meta.division,
        label: meta.label,
        rank: items.size + 1
      });
      added += 1;
    }
    page += 1;
    if (page > Math.min(firstPage.lastPage, maxPages) || current.cards.length === 0) break;
    current = await fetchPage(cid, page);
  }
  return added;
}

// 목록 1개의 책 전체 — { list, items, children, lastPage }
//   topCids: 최상위 목록의 cid 집합 (하위 목록을 가려내는 데 쓴다)
export async function fetchRecommendItems(list, { topCids, maxPages = Infinity } = {}) {
  const top = topCids ?? new Set();
  const items = new Map();
  const first = await fetchPage(list.cid, 1);

  // 이 페이지에만 있는 링크 = 하위 목록 (연도 · 부문)
  const children = [...first.links].filter(([cid]) => cid !== list.cid && !top.has(cid));
  const known = new Set([list.cid, ...children.map(([cid]) => cid)]);
  const childSummary = [];

  for (const [childCid, childName] of children) {
    const childFirst = await fetchPage(childCid, 1);
    // 하위 목록 아래에 다시 하위(분기 · 부문)가 있으면 한 단계 더 내려간다
    const grand = [...childFirst.links].filter(([cid]) => !top.has(cid) && !known.has(cid));
    if (grand.length > 0) {
      for (const [grandCid, grandName] of grand) {
        const label = `${list.name} > ${childName} > ${grandName}`;
        const meta = { year: yearOf(grandName) ?? yearOf(childName) ?? list.year, division: normalizeText(`${divisionOf(childName)} ${divisionOf(grandName)}`), label };
        const added = await collect(grandCid, await fetchPage(grandCid, 1), items, meta, maxPages);
        childSummary.push({ cid: grandCid, name: `${childName} > ${grandName}`, items: added });
      }
    }
    const meta = { year: yearOf(childName) ?? list.year, division: divisionOf(childName), label: `${list.name} > ${childName}` };
    const added = await collect(childCid, childFirst, items, meta, maxPages);
    childSummary.push({ cid: childCid, name: childName, items: added });
  }

  // 하위 목록에 없는 책이 남아 있을 때만 상위 목록을 끝까지 읽는다 (같은 책을 두 번 받지 않으려고)
  const parentEstimate = (first.lastPage - 1) * PAGE_SIZE + first.cards.length;
  if (children.length === 0 || parentEstimate > items.size + PAGE_SIZE || first.lastPage === 1) {
    await collect(list.cid, first, items, { year: list.year, division: "", label: list.name }, maxPages);
  }

  return { list, items: [...items.values()], children: childSummary, lastPage: first.lastPage };
}
