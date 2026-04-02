import * as cheerio from "cheerio";
import { chromium } from "playwright";

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
  return new URL(url, ALADIN_BASE_URL).toString();
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

function parseListMetaParts(metaParts) {
  const cleaned = (metaParts || []).map((part) => normalizeText(part)).filter(Boolean);
  const author = cleaned[0] ?? "";
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

async function fetchHtml(url) {

  const response = await fetch(url, { headers: DEFAULT_HEADERS });

  if (!response.ok) {
    throw new Error("Failed to fetch " + url + " (" + response.status + ")");
  }

  return response.text();
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

  const response = await fetch(url, { headers: { ...DEFAULT_HEADERS, "x-requested-with": "XMLHttpRequest" } });

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
    ? payload.List.map((item) => decodeURIComponent(item?.PhraseAll || item?.Phrase || "").trim()).filter(Boolean)
    : [];

  return cleanDetailText(phrases.join("\n\n"));
}

async function fetchDynamicSections(detailUrl, productIsbn) {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    return await page.evaluate(async ({ productIsbn }) => {
      const names = ["Introduce", "AuthorInfo", "PublisherDesc"];
      const results = {};

      for (const name of names) {
        const url = "/shop/product/getContents.aspx?ISBN=" + productIsbn + "&name=" + name + "&type=0&date=" + new Date().getHours();
        const response = await fetch(url, { credentials: "include" });
        results[name] = await response.text();
      }

      return results;
    }, { productIsbn });
  } finally {
    await browser.close();
  }
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
  const items = await enrichListItemsWithCategories(rawItems);
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
  const sections = await fetchDynamicSections(detailUrl, productIsbn);
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
