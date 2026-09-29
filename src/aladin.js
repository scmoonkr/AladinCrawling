import * as cheerio from "cheerio";

const ALADIN_BASE_URL = "https://www.aladin.co.kr";
const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function htmlToText(value) {
  return normalizeText(
    String(value ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
}

// decodeURIComponent는 잘못된 % 시퀀스(예: HTML 속 "width=100%;")를 만나면 "URI malformed"로
// 전체가 throw된다. 유효한 퍼센트 인코딩 구간만 디코딩하고(멀티바이트 UTF-8 보존) 나머지는 그대로 둔다.
function safeDecodeURIComponent(value) {
  const str = String(value ?? "");
  try {
    return decodeURIComponent(str);
  } catch {
    return str.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
}

function cleanDetailText(text) {
  return normalizeText(
    String(text ?? "")
      .replace(/(?:\uC811\uAE30|\uB354\uBCF4\uAE30)\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
  );
}

function sanitizeInsideText(text) {
  const cleaned = cleanDetailText(text);
  if (cleaned.includes("var htm_bookSentence") || cleaned.includes("Underline3 = new fn_community_more")) {
    return "";
  }
  return cleaned;
}

function toAbsoluteUrl(url) {
  if (!url) return "";
  // 알라딘 페이지의 일부 img src 는 상대/절대 어느 쪽으로도 파싱되지 않는
  // 깨진 값(예: 잘못된 스킴)이라 new URL 이 "Invalid URL" 을 던진다.
  // 이미지 하나 때문에 상세 수집 전체가 실패하지 않도록 실패 시 빈 문자열로 무시한다.
  try {
    return new URL(url, ALADIN_BASE_URL).toString();
  } catch {
    return "";
  }
}

function parseNumber(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function readMeta($, selector, attribute = "content") {
  return normalizeText($(selector).attr(attribute));
}

function parseJsonLd($) {
  const blocks = $('script[type="application/ld+json"]')
    .map((_, node) => $(node).html())
    .get()
    .map((raw) => String(raw ?? '').trim())
    .filter(Boolean);

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (Array.isArray(parsed)) {
        const bookNode = parsed.find((item) => item && (item['@type'] === 'Book' || item.name));
        if (bookNode) {
          return bookNode;
        }
      } else if (parsed && typeof parsed === 'object') {
        if (parsed['@type'] === 'Book' || parsed.name) {
          return parsed;
        }
      }
    } catch {
      // Ignore malformed ld+json blocks and keep searching.
    }
  }

  return null;
}

// 저자 문자열의 역할 표기를 정리한다. 괄호는 제거하고, 일부 역할은 짧은 표기로 치환한다.
//   (지은이)->지음, (옮긴이)->옮김, (그린이)->그림, (그림)->그림, (감수)->감수 등(그 외는 괄호만 제거)
const AUTHOR_ROLE_MAP = {
  "지은이": "지음",
  "옮긴이": "옮김",
  "그린이": "그림"
};

function normalizeAuthorRoles(author) {
  return normalizeText(
    String(author ?? "").replace(/\s*\(([^)]*)\)/g, (match, role) => {
      const key = normalizeText(role);
      const mapped = AUTHOR_ROLE_MAP[key] ?? key; // 매핑이 없으면 단어는 유지하고 괄호만 제거
      return mapped ? ` ${mapped}` : "";
    })
  );
}

function parseListMetaParts(metaParts) {
  const cleaned = (metaParts || []).map((part) => normalizeText(part)).filter(Boolean);
  const author = normalizeAuthorRoles(cleaned[0] ?? "");
  let publisher = "";
  let pubDate = "";

  if (cleaned.length >= 3) {
    publisher = cleaned[1] ?? "";
    pubDate = cleaned[2] ?? "";
  } else if (cleaned.length === 2) {
    const looksLikeDate = /^\d{4}/.test(cleaned[1]);
    if (looksLikeDate) {
      pubDate = cleaned[1];
    } else {
      publisher = cleaned[1];
    }
  }

  return { author, publisher, pub_date: pubDate };
}

function parseBookCard($, $card) {
  const itemNodes = $card.find(".ss_book_list").first().find("ul > li").toArray();
  const titleIndex = itemNodes.findIndex((node) => $(node).find("a.bo3").length > 0);
  const titleItem = titleIndex >= 0 ? $(itemNodes[titleIndex]) : $([]);
  const titleLink = titleItem.find("a.bo3").first();
  const detailUrl = toAbsoluteUrl(titleLink.attr("href"));
  const metaIndex = itemNodes.findIndex((node, index) => index > titleIndex && $(node).text().includes("|"));
  const priceIndex = itemNodes.findIndex((node, index) => index > metaIndex && $(node).find(".ss_p2").length > 0);
  const metaItem = metaIndex >= 0 ? $(itemNodes[metaIndex]) : $([]);
  const priceItem = priceIndex >= 0 ? $(itemNodes[priceIndex]) : $([]);
  const metaLine = normalizeText(metaItem.text());
  const metaParts = metaLine.split("|").map((part) => normalizeText(part)).filter(Boolean);
  const parsedMeta = parseListMetaParts(metaParts);
  const listPrice = parseNumber(priceItem.find("span").first().text()) || parseNumber(priceItem.text());
  const salePrice = parseNumber(priceItem.find(".ss_p2 em").first().text()) || parseNumber(priceItem.find(".ss_p2").first().text()) || listPrice;
  const imageUrl = $card.find('.cover_area img[src*="cover"]').attr("src") || $card.find(".cover_area img").first().attr("src");
  const subtitle = normalizeText(titleItem.find(".ss_f_g2").first().text()).replace(/^[-:]\s*/, "");

  return {
    title: normalizeText(titleLink.text()),
    author: parsedMeta.author,
    publisher: parsedMeta.publisher,
    pub_date: parsedMeta.pub_date,
    isbn: null,
    image_url: toAbsoluteUrl(imageUrl),
    price: listPrice,
    sale_price: salePrice,
    url: detailUrl,
    subtitle
  };
}

function parseDetailPrices($) {
  const priceRows = $(".info_list li").toArray();
  const listPriceRow = priceRows.find((row) => $(row).find(".Litem").first().text().includes("정가"));
  const salePriceRow = priceRows.find((row) => {
    const label = normalizeText($(row).find(".Litem_P, .Litem").first().text());
    return label.includes("판매가");
  });

  const listPrice = parseNumber($(listPriceRow).find(".Ritem del").first().text())
    || parseNumber($(listPriceRow).find(".Ritem").first().text());
  const salePrice = parseNumber($(".hd_PriceSales").attr("value"))
    || parseNumber($(salePriceRow).find('[itemprop="price"]').first().attr("content"))
    || parseNumber($(salePriceRow).find('em[itemprop="price"]').first().text())
    || parseNumber($(salePriceRow).find(".Ritem").first().text())
    || parseNumber(readMeta($, 'meta[property="og:price"]'));

  return {
    listPrice: listPrice || salePrice,
    salePrice: salePrice || listPrice
  };
}

function parseDetailPricesByLabel($) {
  const priceRows = $(".info_list li").toArray();
  const listPriceRow = priceRows.find((row) => normalizeText($(row).find(".Litem").first().text()).includes("\uC815\uAC00"));
  const salePriceRow = priceRows.find((row) => {
    const label = normalizeText($(row).find(".Litem_P, .Litem").first().text());
    return label.includes("\uD310\uB9E4\uAC00");
  });

  const listPrice = parseNumber($(listPriceRow).find(".Ritem del").first().text())
    || parseNumber($(listPriceRow).find(".Ritem").first().text());
  const salePrice = parseNumber($(".hd_PriceSales").attr("value"))
    || parseNumber($(salePriceRow).find('[itemprop="price"]').first().attr("content"))
    || parseNumber($(salePriceRow).find('em[itemprop="price"]').first().text())
    || parseNumber($(salePriceRow).find(".Ritem").first().text())
    || parseNumber(readMeta($, 'meta[property="og:price"]'));

  return {
    listPrice: listPrice || salePrice,
    salePrice: salePrice || listPrice
  };
}

function parseDetailSubtitle($) {
  return normalizeText($(".Ere_bo_title")
    .first()
    .siblings(".Ere_sub1_title")
    .first()
    .text())
    .replace(/^[-:]\s*/, "");
}

function parseBasicInfo($) {
  const info = {
    page: null,
    size: "",
    weight: "",
    isbn: ""
  };

  $(".conts_info_list1 li").each((_, node) => {
    const text = normalizeText($(node).text());

    if (!text) return;
    if (text.startsWith("ISBN")) {
      info.isbn = normalizeText(text.replace(/^ISBN\s*:\s*/i, ""));
      return;
    }
    if (/\d+\s*[*xX]\s*\d+/.test(text)) {
      info.size = text.replace(/\s/g, "");
      return;
    }
    if (text.endsWith("g")) {
      info.weight = text;
      return;
    }
    if (!info.page && /\d/.test(text)) {
      info.page = parseNumber(text);
    }
  });

  return info;
}

function parseCategories($) {
  return $("#ulCategory li")
    .map((_, node) => {
      const text = $(node)
        .find("a")
        .map((__, anchor) => normalizeText($(anchor).text()))
        .get()
        .join(" > ")
        .replace(/\s*>\s*\uC811\uAE30\s*$/u, "");

      return normalizeText(text);
    })
    .get()
    .filter(Boolean);
}

function extractItemId(url) {
  return String(url ?? "").match(/[?&]ItemId=(\d+)/)?.[1] ?? null;
}

function parseTopMetadata($) {
  const top = $(".Ere_prod_titlewrap .left .tlist");
  const titleLine = top.find(".Ere_bo_title").first();
  const seriesLink = titleLine.parent().find("a.Ere_sub1_title, a.Ere_sub_blue").first();
  const metaLine = top.find(".Ere_sub2_title").first();
    const titleOriginal = normalizeText(metaLine.find("a").filter((_, node) => normalizeText($(node).text()).startsWith("\uC6D0\uC81C :")).first().text()).replace(/^\uC6D0\uC81C\s*:\s*/u, "");

  return {
    series_name: normalizeText(seriesLink.text()),
    title_original: titleOriginal
  };
}

function parseCardReviewImages($) {
  const urls = $(".cardreview_swiper img, .swiper-container.cardreview_swiper img")
    .map((_, node) => toAbsoluteUrl($(node).attr("src")))
    .get()
    .filter(Boolean);

  return [...new Set(urls)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 일시적으로 재시도할 가치가 있는 상태코드 (과부하/속도 제한 등)
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// 지수 백오프 상한. 알라딘 429(속도 제한)가 지속돼도 한 요청이 이보다 오래 대기하진 않는다.
const MAX_BACKOFF_MS = 30000;

// 지수 백오프 + 지터. 재시도가 같은 시각에 몰려 다시 429 를 유발하지 않도록 ±25% 흔든다.
function backoffDelay(baseDelayMs, attempt) {
  const capped = Math.min(baseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(capped * (0.75 + Math.random() * 0.5));
}

// 429 응답이 Retry-After 헤더(초 또는 날짜)를 주면 그 값을 우선 존중한다.
function parseRetryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const dateMs = Date.parse(header);
  return Number.isFinite(dateMs) ? Math.max(0, Math.min(dateMs - Date.now(), MAX_BACKOFF_MS)) : 0;
}

// ── 전역 적응형 요청 스로틀 ────────────────────────────────────
// 알라딘 429(속도 제한)를 근본적으로 줄이기 위해 모든 HTTP 요청을 하나의 큐로 통제한다.
// 서버 한도를 미리 알 수 없으므로 간격을 "적응형"으로 운용한다:
//   - 429 를 만나면 현재 간격을 늘리고(느려짐) 전체를 잠깐 멈춘다(쿨다운).
//   - 성공이 일정 횟수 이어지면 간격을 조금씩 다시 줄인다(빨라짐).
// 필요하면 .env 로 조절한다:
//   ALADIN_MAX_CONCURRENCY(기본1) / ALADIN_MIN_GAP_MS(기본700) /
//   ALADIN_MAX_GAP_MS(기본10000) / ALADIN_429_COOLDOWN_MS(기본15000)
// .env 는 db.js 의 dotenv.config() 로 로드되는데, 이 모듈이 그보다 먼저 import 되므로
// 모듈 로드 시점에 process.env 를 읽으면 값이 비어 있다. 따라서 "요청 시점"에 지연 평가한다.
function rlNum(name, fallback) {
  return Number(process.env[name]) || fallback;
}
const RATE_LIMIT = {
  get maxConcurrency() { return rlNum("ALADIN_MAX_CONCURRENCY", 1); },
  get minGapMs() { return rlNum("ALADIN_MIN_GAP_MS", 700); },
  get maxGapMs() { return rlNum("ALADIN_MAX_GAP_MS", 10000); },
  get cooldownMs() { return rlNum("ALADIN_429_COOLDOWN_MS", 15000); },
};

const _rlQueue = [];
let _rlActive = 0;
let _rlLastStart = 0;
let _rlTimer = null;
let _rlCurrentGap = 0;   // 적응형 추가 간격(0이면 minGap 사용). 429 시 증가.
let _rlPauseUntil = 0;   // 429 쿨다운: 이 시각까지 전체 대기
let _rlOkStreak = 0;

// 현재 유효 간격(설정된 minGap 과 적응형 값 중 큰 값).
function _rlEffectiveGap() {
  return Math.max(_rlCurrentGap, RATE_LIMIT.minGapMs);
}

// 다음 요청을 시작해도 되는 가장 이른 시각(간격 + 쿨다운 반영).
function _rlNextStartAt() {
  return Math.max(_rlLastStart + _rlEffectiveGap(), _rlPauseUntil);
}

// 429 발생: 간격을 1.5배로 늘리고(상한 maxGap) 전체를 cooldown 만큼 멈춘다.
function _rlNote429() {
  _rlOkStreak = 0;
  _rlCurrentGap = Math.min(Math.round(_rlEffectiveGap() * 1.5), RATE_LIMIT.maxGapMs);
  _rlPauseUntil = Date.now() + RATE_LIMIT.cooldownMs;
  console.warn(`[rate-limit] 429 감지 → 간격 ${_rlCurrentGap}ms 로 상향, ${RATE_LIMIT.cooldownMs}ms 쿨다운`);
}

// 성공 누적: 20회 연속 성공마다 간격을 20%씩(하한 minGap) 되돌린다.
function _rlNoteOk() {
  _rlOkStreak += 1;
  if (_rlOkStreak >= 20 && _rlEffectiveGap() > RATE_LIMIT.minGapMs) {
    _rlCurrentGap = Math.max(RATE_LIMIT.minGapMs, Math.round(_rlEffectiveGap() * 0.8));
    _rlOkStreak = 0;
  }
}

function _rlSchedule() {
  if (_rlTimer) return;
  if (_rlActive >= RATE_LIMIT.maxConcurrency || _rlQueue.length === 0) return;
  const wait = Math.max(0, _rlNextStartAt() - Date.now());
  _rlTimer = setTimeout(() => {
    _rlTimer = null;
    if (_rlActive >= RATE_LIMIT.maxConcurrency || _rlQueue.length === 0) {
      _rlSchedule();
      return;
    }
    // 대기 중 429 쿨다운이 늘어났을 수 있으니 시작 시각을 다시 확인한다.
    if (Date.now() < _rlNextStartAt()) {
      _rlSchedule();
      return;
    }
    const resolve = _rlQueue.shift();
    _rlActive += 1;
    _rlLastStart = Date.now();
    resolve();
    _rlSchedule(); // 다음 대기자도 간격/동시성/쿨다운 규칙에 맞춰 예약
  }, wait);
}

function _rlAcquire() {
  return new Promise((resolve) => {
    _rlQueue.push(resolve);
    _rlSchedule();
  });
}

function _rlRelease() {
  _rlActive -= 1;
  _rlSchedule();
}

// 모든 알라딘 요청은 이 래퍼를 통해서만 나간다(동시성·간격·쿨다운 강제).
async function throttledFetch(url, options) {
  await _rlAcquire();
  try {
    return await fetch(url, options);
  } finally {
    _rlRelease();
  }
}

async function fetchHtml(url, { retries = 6, baseDelayMs = 2000, headers } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await throttledFetch(url, { headers: { ...DEFAULT_HEADERS, ...headers } });
    } catch (error) {
      // 네트워크 오류는 재시도 대상
      if (attempt >= retries) {
        throw error;
      }
      const delay = backoffDelay(baseDelayMs, attempt);
      console.warn(`fetch 재시도 ${attempt + 1}/${retries} (network: ${error.message}, ${delay}ms 대기): ${url}`);
      await sleep(delay);
      continue;
    }

    if (response.ok) {
      _rlNoteOk(); // 성공 누적 → 간격을 서서히 되돌림
      return response.text();
    }

    // 404 등 영구 오류는 즉시 실패, 재시도 가능한 상태코드만 백오프 후 재시도
    if (!RETRYABLE_STATUS.has(response.status) || attempt >= retries) {
      throw new Error("Failed to fetch " + url + " (" + response.status + ")");
    }

    // 429 는 전역 스로틀을 늦추고 쿨다운을 건 뒤, Retry-After 우선·없으면 지수 백오프.
    if (response.status === 429) {
      _rlNote429();
    }
    const retryAfter = response.status === 429 ? parseRetryAfterMs(response) : 0;
    const delay = retryAfter || backoffDelay(baseDelayMs, attempt);
    console.warn(`fetch 재시도 ${attempt + 1}/${retries} (HTTP ${response.status}, ${delay}ms 대기): ${url}`);
    await sleep(delay);
  }
}

// 상세페이지를 정상 수집할 수 없는 차단 상태. reason: "adult"(성인도서 19세) | "private"(비공개)
export class BlockedDetailError extends Error {
  constructor(reason, detailUrl) {
    super("Blocked detail (" + reason + "): " + detailUrl);
    this.name = "BlockedDetailError";
    this.isBlocked = true;
    this.reason = reason;
    this.url = detailUrl;
  }
}

// 비로그인/비공개 상태에서 상세페이지를 요청하면 알라딘은 정상 페이지(수백 KB) 대신
// confirm()/alert() + 리다이렉트만 담긴 수백 바이트짜리 스텁(HTTP 200)을 돌려준다.
//   - 성인도서(19세): confirm('19세 이상만...') + isAdult=1
//   - 비공개 상품:     alert('비공개 상태입니다.')
function detectBlockReason(html) {
  const text = String(html ?? "");
  if (text.length > 4000) {
    return null;
  }
  if (/confirm\(['"]19/.test(text) || /isAdult=1/.test(text)) {
    return "adult";
  }
  if (/비공개 상태입니다/.test(text)) {
    return "private";
  }
  return null;
}

async function fetchListItemCategories(detailUrl) {
  try {
    const html = await fetchHtml(detailUrl);
    const $ = cheerio.load(html);
    return parseCategories($);
  } catch {
    return [];
  }
}

async function enrichListItemsWithCategories(items) {
  return Promise.all(
    items.map(async (item) => ({
      ...item,
      categories: await fetchListItemCategories(item.url)
    }))
  );
}

async function fetchInsideContent(itemId) {
  if (!itemId) {
    return "";
  }

  const url = new URL("/ucl/shop/product/ajax/GetCommunityMoreAjax.aspx", ALADIN_BASE_URL);
  url.searchParams.set("itemid", String(itemId));
  url.searchParams.set("communitytype", "Underline");
  url.searchParams.set("page", "1");
  url.searchParams.set("pagesize", "5");
  url.searchParams.set("paperlength", "0");
  url.searchParams.set("contenttype", "3");

  const response = await throttledFetch(url, { headers: { ...DEFAULT_HEADERS, "x-requested-with": "XMLHttpRequest" } });

  if (!response.ok) {
    return "";
  }

  const text = await response.text();
  let payload;

  try {
    payload = JSON.parse(text);
  } catch {
    return "";
  }

  const phrases = Array.isArray(payload?.List)
    ? payload.List.map((item) => safeDecodeURIComponent(item?.PhraseAll || item?.Phrase || "").trim()).filter(Boolean)
    : [];

  return cleanDetailText(phrases.join("\n\n"));
}

// 동적 섹션(책소개/저자소개/출판사서평)은 상세페이지에서 XHR로 불러오는
// getContents.aspx 응답이다. 예전에는 Chromium 세션이 필요하다고 보고 항목마다
// 브라우저를 띄웠지만, 실측 결과 referer + x-requested-with 헤더만 붙이면 Node fetch로
// 동일한 HTML을 받을 수 있어(두 헤더가 없으면 빈 응답) 브라우저를 완전히 제거했다.
async function fetchDynamicSections(detailUrl, productIsbn) {
  if (!productIsbn) {
    return {};
  }

  const headers = {
    referer: detailUrl,
    "x-requested-with": "XMLHttpRequest"
  };
  const names = ["Introduce", "AuthorInfo", "PublisherDesc"];
  const results = {};

  for (const name of names) {
    const url = new URL("/shop/product/getContents.aspx", ALADIN_BASE_URL);
    url.searchParams.set("ISBN", productIsbn);
    url.searchParams.set("name", name);
    url.searchParams.set("type", "0");
    url.searchParams.set("date", String(new Date().getHours()));
    results[name] = await fetchHtml(url, { headers });
  }

  return results;
}

function getBoxes(html) {
  const $ = cheerio.load(html || "");
  return $(".Ere_prod_mconts_box").toArray().map((node) => $(node));
}

function parseAuthorDetails(html) {
  const $ = cheerio.load(html || "");
  const container = $(".Ere_prod_mconts_box").first();
  const blocks = container.children(".Ere_prod_mconts_R").toArray();

  return blocks
    .map((node) => {
      const block = $(node);
      const header = block.find(".Ere_fs18.Ere_sub_gray3.Ere_str").first();
      const nameLink = header.find('> a, a[href*="AuthorSearch"]').first();
      const profileLink = header.find('a[href*="wauthor_overview"]').first();
      const image = block.find(".author_box .pic img").first().attr("src");
      const detailHtml = block.find('.author_box .introduction [id$="_All"]').first().html()
        || block.find('.author_box .introduction [id$="_Short"]').first().html()
        || block.find(".author_box .introduction").first().html()
        || "";
      const award = cleanDetailText(block.find(".conts_info_list2 li").filter((_, li) => $(li).text().includes("\uC218\uC0C1"))[0] ? htmlToText($(block.find(".conts_info_list2 li").filter((_, li) => $(li).text().includes("\uC218\uC0C1"))[0]).html()) : "").replace(/^\uC218\uC0C1\s*:\s*/u, "");
      const recently = block.find(".conts_info_list2 li").filter((_, li) => $(li).text().includes("최근작")).find("a.Ere_sub_blue, a.np_bfpm2").map((_, a) => normalizeText($(a).text()).replace(/^<|>$/g, "")).get().filter(Boolean);

      const name = normalizeText(nameLink.text());
      if (!name) return null;

      return {
        name,
        url: toAbsoluteUrl(profileLink.attr("href") || nameLink.attr("href")),
        image: toAbsoluteUrl(image),
        detail: cleanDetailText(htmlToText(detailHtml)),
        award,
        recently
      };
    })
    .filter(Boolean);
}

function parseDynamicDetails(sections, fallbackImages) {
  const introBoxes = getBoxes(sections.Introduce);
  const authorBoxes = getBoxes(sections.AuthorInfo);
  const publisherBoxes = getBoxes(sections.PublisherDesc);

  const bookReviewBox = introBoxes[0];
  const tocBox = introBoxes[1];
  const insideBox = introBoxes[2];
  const publisherReviewBox = publisherBoxes[1];

  const bookReviewHtml = bookReviewBox ? (bookReviewBox.find(".Ere_prod_mconts_R").first().html() || "") : "";
  const indexHtml = tocBox ? (tocBox.find("#div_TOC_All").first().html() || tocBox.find("#div_TOC_Short").first().html() || tocBox.find(".Ere_prod_mconts_R").first().html() || "") : "";
  const insideHtml = insideBox ? (insideBox.find("#div_BookIn_All").first().html() || insideBox.find("#div_BookIn_Brief").first().html() || insideBox.find(".Ere_prod_mconts_R").first().html() || "") : "";
  const authorDetails = parseAuthorDetails(sections.AuthorInfo || "");
  const publisherReviewHtml = publisherReviewBox ? (publisherReviewBox.find("#div_PublisherDesc_All").first().html() || publisherReviewBox.find("#div_PublisherDesc_Short").first().html() || publisherReviewBox.find(".Ere_prod_mconts_R").first().html() || "") : "";

  const publisherImages = publisherReviewBox
    ? publisherReviewBox.find("img").map((_, node) => toAbsoluteUrl(publisherReviewBox.find(node).attr("src"))).get().filter((url) => {
        return url && !url.includes("icon_arrow_");
      })
    : [];

  const mergedImages = [...new Set([...(fallbackImages || []), ...publisherImages])];

  return {
    book_review: cleanDetailText(htmlToText(bookReviewHtml)),
    index: cleanDetailText(htmlToText(indexHtml)),
    inside: sanitizeInsideText(htmlToText(insideHtml)),
    author_detail: authorDetails,
    publisher_review: {
      images: mergedImages,
      review: cleanDetailText(htmlToText(publisherReviewHtml))
    }
  };
}

function buildNewListUrl(options = {}) {
  const branchType = options.branchType ?? 1;
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  const newType = options.newType ?? "SpecialNew";
  const sortOrder = options.sortOrder ?? 5;
  const categoryId = options.CID ?? options.categoryId;

  const url = new URL("/shop/common/wnew.aspx", ALADIN_BASE_URL);
  url.searchParams.set("BranchType", String(branchType));
  url.searchParams.set("SortOrder", String(sortOrder));
  if (newType) url.searchParams.set("NewType", newType);
  if (page > 1) url.searchParams.set("page", String(page));
  if (pageSize) url.searchParams.set("ViewRowsCount", String(pageSize));
  if (categoryId) url.searchParams.set("CID", String(categoryId));
  return url;
}

function buildBrowseListUrl(options = {}) {
  const categoryId = options.CID ?? options.categoryId;
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  const sortOrder = options.sortOrder ?? 5;
  const publishMonth = options.publishMonth ?? 0;
  const publishDay = options.publishDay ?? 84;
  const stockStatus = options.stockStatus ?? 1;

  const url = new URL("/shop/wbrowse.aspx", ALADIN_BASE_URL);
  url.searchParams.set("BrowseTarget", "List");
  url.searchParams.set("ViewRowsCount", String(pageSize));
  url.searchParams.set("ViewType", "Detail");
  url.searchParams.set("PublishMonth", String(publishMonth));
  url.searchParams.set("SortOrder", String(sortOrder));
  url.searchParams.set("page", String(page));
  url.searchParams.set("Stockstatus", String(stockStatus));
  url.searchParams.set("PublishDay", String(publishDay));
  if (categoryId) url.searchParams.set("CID", String(categoryId));
  url.searchParams.set("CustReviewRankStart", "");
  url.searchParams.set("CustReviewRankEnd", "");
  url.searchParams.set("CustReviewCountStart", "");
  url.searchParams.set("CustReviewCountEnd", "");
  url.searchParams.set("PriceFilterMin", "");
  url.searchParams.set("PriceFilterMax", "");
  url.searchParams.set("SearchOption", "");
  return url;
}

async function fetchBookCards(url, options = {}) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const rawItems = $(".ss_book_box").map((_, element) => parseBookCard($, $(element))).get();
  // 목록 단계에서 항목별 카테고리를 받으려면 각 상세페이지를 50건씩 추가로 요청해야 해
  // 페이지당 시간이 수십 배로 늘어난다. 카테고리는 상세 크롤 단계에서 채워지므로 기본은 생략.
  // 목록 단계에서도 카테고리가 필요하면 .env 에 ALADIN_LIST_CATEGORIES=1 을 설정한다.
  const items = process.env.ALADIN_LIST_CATEGORIES === "1"
    ? await enrichListItemsWithCategories(rawItems)
    : rawItems;
  const linkClass = options.CID ?? options.categoryId ?? null;

  return {
    url: url.toString(),
    total_count: null,
    items: items.map((item) => ({
      ...item,
      linkClass: linkClass ? String(linkClass) : null
    }))
  };
}

export async function fetchNewBookList(options = {}) {
  const url = buildNewListUrl(options);
  return fetchBookCards(url, options);
}

export async function fetchBookList(options = {}) {
  const url = buildBrowseListUrl(options);
  return fetchBookCards(url, options);
}

export async function fetchBookDetail(input) {
  const detailUrl = typeof input === "string"
    ? new URL(input, ALADIN_BASE_URL).toString()
    : input?.url
      ? new URL(input.url, ALADIN_BASE_URL).toString()
      : input?.itemId
        ? new URL("/shop/wproduct.aspx?ItemId=" + input.itemId, ALADIN_BASE_URL).toString()
        : "";

  if (!detailUrl) {
    throw new Error("A detail url or itemId is required.");
  }

  const html = await fetchHtml(detailUrl);

  const blockReason = detectBlockReason(html);
  if (blockReason) {
    throw new BlockedDetailError(blockReason, detailUrl);
  }

  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd($);
  const basicInfo = parseBasicInfo($);
  const topMetadata = parseTopMetadata($);
  const itemId = extractItemId(detailUrl);
  const detailPrices = parseDetailPricesByLabel($);
  const subtitle = parseDetailSubtitle($);
  const salePrice = parseNumber($(".hd_PriceSales").attr("value")) || parseNumber(readMeta($, 'meta[property="og:price"]'));
  const listPrice = parseNumber($("body").text().match(/����\s*([\d,]+)\s*��/)?.[1]) || salePrice;
  const isbn = basicInfo.isbn || readMeta($, 'meta[property="books:isbn"]') || readMeta($, 'meta[property="og:barcode"]');
  const productIsbn = $(".hd_ISBN").attr("value") || isbn;
  const fallbackImages = parseCardReviewImages($);
  let sections;
  try {
    sections = await fetchDynamicSections(detailUrl, productIsbn);
  } catch (error) {
    // 일시적 실패(네트워크/타임아웃 등)는 정적 필드(isbn/page/size/weight 등)라도
    // 저장되도록 빈 섹션으로 대체하고 경고만 남긴다.
    console.warn(`동적 섹션 수집 실패 (item ${itemId}) → 정적 필드만 저장: ${error instanceof Error ? error.message : error}`);
    sections = {};
  }
  const dynamic = parseDynamicDetails(sections, fallbackImages);
  const insideContent = await fetchInsideContent(itemId);

  return {
    item_id: itemId,
    series_name: topMetadata.series_name,
    title_original: topMetadata.title_original,
    subtitle,
    title: $("#hd_Title").attr("value") || normalizeText(jsonLd?.name) || readMeta($, 'meta[name="title"]').replace(/\s*:\s*\uC54C\uB77C\uB518$/u, ""),
    author: readMeta($, 'meta[name="author"]') || normalizeText(jsonLd?.author?.name),
    publisher: normalizeText(jsonLd?.publisher?.name),
    pub_date: readMeta($, 'meta[itemprop="datePublished"]') || normalizeText(jsonLd?.workExample?.[0]?.datePublished),
    isbn,
    image_url: readMeta($, 'meta[property="og:image"]'),
    price: detailPrices.listPrice,
    sale_price: detailPrices.salePrice,
    url: detailUrl,
    page: basicInfo.page,
    size: basicInfo.size,
    weight: basicInfo.weight,
    categories: parseCategories($),
    book_review: dynamic.book_review,
    index: dynamic.index,
    inside: insideContent || dynamic.inside,
    author_detail: dynamic.author_detail,
    publisher_review: dynamic.publisher_review
  };
}
