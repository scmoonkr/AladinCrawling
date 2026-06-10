import * as cheerio from "cheerio";

const ALADIN_BASE_URL = "https://www.aladin.co.kr";
const AUTHOR_ALPHABETS = Array.from({ length: 15 }, (_, index) => index + 1);
const AUTHOR_CATEGORY_TYPES = [1, 2];
const KNOWN_PROFILE_LABELS = new Set(["분류", "이름", "국적", "출생", "사망", "직업", "가족", "기타", "데뷔작"]);
const DEFAULT_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "")
    .replace(/\t+/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
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

function toAbsoluteUrl(url) {
  if (!url) {
    return "";
  }

  return new URL(url, ALADIN_BASE_URL).toString();
}

function extractAuthorId(value) {
  const matched = String(value ?? "").match(/AuthorSearch=@?([^&]+)/i);
  return matched?.[1] ?? null;
}

function extractItemId(value) {
  const matched = String(value ?? "").match(/[?&]ItemId=(\d+)/i);
  return matched?.[1] ?? null;
}

function splitName(text) {
  const normalized = normalizeText(text);
  const matched = normalized.match(/^(.*?)\s*\((.+)\)\s*$/);

  if (!matched) {
    return {
      name: normalized,
      name_original: ""
    };
  }

  return {
    name: normalizeText(matched[1]),
    name_original: normalizeText(matched[2])
  };
}

function parseLinesFromHtml(html) {
  return String(html ?? "")
    .split(/<br\s*\/?>/i)
    .map((line) => htmlToText(line))
    .filter(Boolean);
}

async function fetchHtml(url) {
  const response = await fetch(url, { headers: DEFAULT_HEADERS });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }

  return response.text();
}

function buildAuthorListUrl({ categoryType, alphabet, page = 1 }) {
  const url = new URL("/author/search/wauthor_search_alphabet.aspx", ALADIN_BASE_URL);
  url.searchParams.set("CategoryType", String(categoryType));
  url.searchParams.set("Alphabet", String(alphabet));

  if (page > 1) {
    url.searchParams.set("page", String(page));
  }

  return url.toString();
}

function buildAuthorOverviewUrl(authorId) {
  return new URL(`/author/wauthor_overview.aspx?AuthorSearch=@${authorId}`, ALADIN_BASE_URL).toString();
}

function buildAuthorLifeUrl(authorId) {
  return new URL(`/author/wauthor_life.aspx?AuthorSearch=@${authorId}`, ALADIN_BASE_URL).toString();
}

function parsePaginationMaxPage($) {
  const pageNumbers = [];

  $('a[onclick*="Page_Set"]').each((_, node) => {
    const onclick = $(node).attr("onclick") || "";
    const matched = onclick.match(/Page_Set\('(\d+)'\)/);

    if (matched) {
      pageNumbers.push(Number(matched[1]));
    }
  });

  return pageNumbers.length > 0 ? Math.max(...pageNumbers) : 1;
}

function parseAuthorCard($, $box) {
  const textProfileLink = $box.find("a[href*='wauthor_overview']").filter((_, node) => $(node).find("strong").length > 0).first();
  const profileLink = textProfileLink.length ? textProfileLink : $box.find("a[href*='wauthor_overview']").last();
  const profileUrl = toAbsoluteUrl(profileLink.attr("href"));
  const authorId = extractAuthorId(profileUrl);
  const imageUrl = toAbsoluteUrl($box.find("img").first().attr("src"));
  const nameParts = splitName(profileLink.text());
  const works = $box.find("a.au_book").map((_, node) => ({
    title: normalizeText($(node).text()).replace(/^<|>$/g, ""),
    url: toAbsoluteUrl($(node).attr("href")),
    item_id: extractItemId($(node).attr("href"))
  })).get().filter((work) => work.title);

  if (!authorId) {
    return null;
  }

  return {
    author_id: authorId,
    image_url: imageUrl,
    name: nameParts.name,
    name_original: nameParts.name_original,
    overview_url: profileUrl,
    works
  };
}

function parseProfileRows($) {
  const profile = {};

  $("table[align='left']").each((_, table) => {
    const cells = $(table).find("tr").first().children("td");

    if (cells.length < 3) {
      return;
    }

    const label = normalizeText($(cells[1]).text()).replace(/:$/, "");
    const valueCell = $(cells[2]);

    if (!label || !KNOWN_PROFILE_LABELS.has(label)) {
      return;
    }

    if (label === "분류") {
      profile[label] = parseLinesFromHtml(valueCell.html());
      return;
    }

    const html = valueCell.html() || "";
    const text = htmlToText(html);
    profile[label] = text;
  });

  return profile;
}

function parseRecentWork($) {
  const recentHeader = $("td.au_pro_text_blue").filter((_, node) => normalizeText($(node).text()) === "최근작").first();

  if (!recentHeader.length) {
    return null;
  }

  const table = recentHeader.closest("table");
  const text = normalizeText(table.find("tr").eq(1).text());
  const link = table.find("tr").eq(1).find("a").first();

  return {
    text,
    title: normalizeText(link.text()),
    url: toAbsoluteUrl(link.attr("href"))
  };
}

function parseIntroduction($) {
  const introRoot = $("h3.au_bigname1").first().parent();
  const name = normalizeText(introRoot.find("h3.au_bigname1").first().text());
  const introHtml = introRoot.find("p").first().html() || "";

  return {
    display_name: name,
    introduction: htmlToText(introHtml)
  };
}

function parseRepresentativeWorks($) {
  return $("td.au_works_img")
    .map((_, node) => {
      const links = $(node).find("a");
      const imageLink = links.eq(0);
      const titleLink = links.eq(1);

      return {
        title: normalizeText(titleLink.text()),
        url: toAbsoluteUrl(titleLink.attr("href") || imageLink.attr("href")),
        item_id: extractItemId(titleLink.attr("href") || imageLink.attr("href")),
        image_url: toAbsoluteUrl(imageLink.find("img").attr("src"))
      };
    })
    .get()
    .filter((work) => work.title);
}

function parseJsonLdPerson($) {
  const scripts = $('script[type="application/ld+json"]')
    .map((_, node) => $(node).html())
    .get()
    .map((raw) => String(raw ?? "").trim())
    .filter(Boolean);

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script);
      const entity = parsed?.mainEntity;

      if (entity?.["@type"] === "Person") {
        return entity;
      }
    } catch {
      // Ignore malformed ld+json blocks.
    }
  }

  return null;
}

function mapDetailPayload($, lifeHtml, overviewUrl) {
  const person = parseJsonLdPerson($);
  const profileRows = parseProfileRows($);
  const intro = parseIntroduction($);
  const nameParts = splitName(profileRows["이름"] || person?.name || intro.display_name);
  const works = parseRepresentativeWorks($);
  const lifeText = htmlToText(cheerio.load(lifeHtml || "")("p.au_life").first().html() || "");
  const recentWork = parseRecentWork($);
  const categories = Array.isArray(profileRows["분류"]) ? profileRows["분류"] : [];

  const extraProfile = Object.fromEntries(
    Object.entries(profileRows).filter(([key]) => !["분류", "이름", "국적", "출생", "사망", "직업", "가족", "기타"].includes(key))
  );

  return {
    author_id: extractAuthorId(overviewUrl),
    image_url: toAbsoluteUrl($("meta[property='og:image']").attr("content") || person?.image || ""),
    name: nameParts.name || intro.display_name,
    name_original: nameParts.name_original,
    categories,
    nationality: profileRows["국적"] || normalizeText(person?.nationality?.name) || "",
    birth: profileRows["출생"] || "",
    death: profileRows["사망"] || "",
    job: profileRows["직업"] || normalizeText(person?.jobTitle) || "",
    family: profileRows["가족"] || "",
    works,
    introduction: intro.introduction || normalizeText(person?.description) || "",
    etc: {
      raw_profile: extraProfile,
      profile_etc: profileRows["기타"] || "",
      recent_work: recentWork,
      life: lifeText
    },
    overview_url: overviewUrl
  };
}

export async function fetchAuthorListPage({ categoryType, alphabet, page = 1 }) {
  const url = buildAuthorListUrl({ categoryType, alphabet, page });
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = $(".newbg_authorbox")
    .map((_, node) => parseAuthorCard($, $(node)))
    .get()
    .filter(Boolean)
    .map((item) => ({
      ...item,
      category_type: Number(categoryType),
      alphabet: Number(alphabet)
    }));

  return {
    url,
    categoryType: Number(categoryType),
    alphabet: Number(alphabet),
    page: Number(page),
    maxPage: parsePaginationMaxPage($),
    items
  };
}

export async function fetchAuthorDetail(input) {
  const authorId = extractAuthorId(input) || String(input ?? "").replace(/^@/, "");

  if (!authorId) {
    throw new Error("An author id or overview url is required.");
  }

  const overviewUrl = buildAuthorOverviewUrl(authorId);
  const lifeUrl = buildAuthorLifeUrl(authorId);
  const [overviewHtml, lifeHtml] = await Promise.all([
    fetchHtml(overviewUrl),
    fetchHtml(lifeUrl).catch(() => "")
  ]);
  const $ = cheerio.load(overviewHtml);

  return mapDetailPayload($, lifeHtml, overviewUrl);
}

export function getAuthorCategoryTypes() {
  return [...AUTHOR_CATEGORY_TYPES];
}

export function getAuthorAlphabets() {
  return [...AUTHOR_ALPHABETS];
}
