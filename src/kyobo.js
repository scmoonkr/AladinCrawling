import dotenv from "dotenv";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { getCollection } from "./db.js";

dotenv.config();

const BROWSER_PROFILE_DIR = resolve(".kyobo-profile");
const ROW_ID_PREFIX = "mf_wfm_content_tac_main_contents_content1_body_gen_bksSrch_";
const PRICE_SUFFIX = "_tbx_wncrPrce";
const WHOLESALE_SUFFIX = "_tbx_byngPrce";
const ISBN_SUFFIX = "_tbx_cmdtCode";
const TITLE_SUFFIX = "_tbx_cmdtName";
const PUBLISHER_SUFFIX = "_tbx_pbcmName";
const AUTHOR_SUFFIX = "_tbx_autrName";
const PUB_DATE_SUFFIX = "_tbx_rlseDate";
const SUPPLY_RATE_SUFFIX = "_tbx_byngRate";
const PRICE_SELECTOR = `div[id^="${ROW_ID_PREFIX}"][id$="${PRICE_SUFFIX}"]`;
const LOGIN_ID_SELECTOR = "input#mf_ibx_userId";
const LOGIN_PASSWORD_SELECTOR = "input#mf_sct_password";
const LOGIN_BUTTON_SELECTOR = "a#mf_btn_login";
const SEARCH_INPUT_SELECTOR = "input#mf_wfm_header_ibx_findName";
const DEFAULT_TIMEOUT = 30_000;
const RESULT_TIMEOUT = 12_000;
const RESULT_POLL_INTERVAL = 150;
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

let sharedContextPromise = null;
let loginPromise = null;
const idlePages = [];
const pageWaiters = [];
let createdPageCount = 0;
let loginPageIssued = false;

function readConfig() {
  const url = String(process.env.KYOBO_URL ?? "").trim();
  const id = String(process.env.KYOBO_ID ?? "").trim();
  const password = String(process.env.KYOBO_PASSWORD ?? "").trim();

  if (!url || !id || !password) {
    throw new Error("KYOBO_URL, KYOBO_ID, KYOBO_PASSWORD are required in .env.");
  }

  return { url, id, password };
}

export function getKyoboConcurrency() {
  const parsed = Number(process.env.KYOBO_CONCURRENCY);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_CONCURRENCY;
  }

  return Math.min(Math.trunc(parsed), MAX_CONCURRENCY);
}

function isHeadless() {
  const value = String(process.env.KYOBO_HEADLESS ?? "true").trim().toLowerCase();
  return value !== "false" && value !== "0";
}

function parsePrice(text) {
  const digits = String(text ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

async function launchContext(headless) {
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    locale: "ko-KR",
    viewport: { width: 1440, height: 960 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  });
}

async function getSharedContext(headless = isHeadless()) {
  if (!sharedContextPromise) {
    sharedContextPromise = launchContext(headless).catch((error) => {
      sharedContextPromise = null;
      throw error;
    });
  }

  return sharedContextPromise;
}

export async function closeKyoboBrowser() {
  if (!sharedContextPromise) {
    return;
  }

  const context = await sharedContextPromise.catch(() => null);
  sharedContextPromise = null;
  loginPromise = null;
  idlePages.length = 0;
  pageWaiters.length = 0;
  createdPageCount = 0;
  loginPageIssued = false;
  await context?.close();
}

async function isVisible(page, selector, timeout = 3000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function assertNotUnderMaintenance(page) {
  const text = await page.locator("body").innerText().catch(() => "");

  if (/점검\s*시간|점검\s*중/.test(text)) {
    const notice = text.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new Error(`Kyobo service is under maintenance: ${notice}`);
  }
}

async function login(page, config) {
  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });

  if (!(await isVisible(page, LOGIN_ID_SELECTOR, 8000))) {
    await assertNotUnderMaintenance(page);
    // 이미 로그인된 세션(.kyobo-profile 재사용)
    return false;
  }

  await page.fill(LOGIN_ID_SELECTOR, config.id);
  await page.fill(LOGIN_PASSWORD_SELECTOR, config.password);
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => null),
    page.click(LOGIN_BUTTON_SELECTOR)
  ]);

  await page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: DEFAULT_TIMEOUT });
  return true;
}

async function createLoginPage(config) {
  const context = await getSharedContext();
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  if (await isVisible(page, SEARCH_INPUT_SELECTOR, 2000)) {
    return page;
  }

  await login(page, config);

  if (!(await isVisible(page, SEARCH_INPUT_SELECTOR, 8000))) {
    throw new Error("Kyobo login failed: search input not found.");
  }

  return page;
}

// 로그인은 프로세스당 1회. 이후 조회는 같은 페이지를 계속 재사용한다.
async function ensureLoginPage(config) {
  if (!loginPromise) {
    loginPromise = createLoginPage(config).catch((error) => {
      loginPromise = null;
      throw error;
    });
  }

  return loginPromise;
}

// 세션 쿠키는 컨텍스트가 공유하므로 두 번째 탭부터는 로그인 없이 열린다.
async function openExtraPage(config) {
  const context = await getSharedContext();
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  try {
    await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });

    if (!(await isVisible(page, SEARCH_INPUT_SELECTOR, 10000))) {
      await login(page, config);

      if (!(await isVisible(page, SEARCH_INPUT_SELECTOR, 8000))) {
        throw new Error("Kyobo tab is not logged in: search input not found.");
      }
    }

    return page;
  } catch (error) {
    await page.close().catch(() => null);
    throw error;
  }
}

async function acquirePage(config) {
  const loginPage = await ensureLoginPage(config);

  if (!loginPageIssued) {
    loginPageIssued = true;
    createdPageCount = 1;
    return loginPage;
  }

  if (idlePages.length > 0) {
    return idlePages.pop();
  }

  if (createdPageCount < getKyoboConcurrency()) {
    createdPageCount += 1;

    try {
      return await openExtraPage(config);
    } catch (error) {
      createdPageCount -= 1;
      throw error;
    }
  }

  return new Promise((resolve) => {
    pageWaiters.push(resolve);
  });
}

function releasePage(page) {
  const waiter = pageWaiters.shift();

  if (waiter) {
    waiter(page);
    return;
  }

  idlePages.push(page);
}

async function readRows(page) {
  return page.$$eval(
    PRICE_SELECTOR,
    (nodes, meta) =>
      nodes.map((node) => {
        const index = node.id.slice(meta.prefix.length, node.id.length - meta.suffixes.price.length);
        const text = (suffix) =>
          (document.getElementById(`${meta.prefix}${index}${suffix}`)?.innerText ?? "").trim();

        return {
          index: Number(index),
          isbn_text: text(meta.suffixes.isbn),
          title: text(meta.suffixes.title),
          publisher: text(meta.suffixes.publisher),
          author: text(meta.suffixes.author),
          pub_date: text(meta.suffixes.pubDate),
          supply_rate_text: text(meta.suffixes.supplyRate),
          price_text: (node.innerText ?? "").trim(),
          wholesale_price_text: text(meta.suffixes.wholesale)
        };
      }),
    {
      prefix: ROW_ID_PREFIX,
      suffixes: {
        price: PRICE_SUFFIX,
        wholesale: WHOLESALE_SUFFIX,
        isbn: ISBN_SUFFIX,
        title: TITLE_SUFFIX,
        publisher: PUBLISHER_SUFFIX,
        author: AUTHOR_SUFFIX,
        pubDate: PUB_DATE_SUFFIX,
        supplyRate: SUPPLY_RATE_SUFFIX
      }
    }
  );
}

function normalizeIsbn(value) {
  return String(value ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
}

function toRow(row) {
  return {
    index: row.index,
    isbn: normalizeIsbn(row.isbn_text),
    title: row.title,
    publisher: row.publisher,
    author: row.author,
    pub_date: row.pub_date,
    price: parsePrice(row.price_text),
    wholesale_price: parsePrice(row.wholesale_price_text),
    supply_rate: parsePrice(row.supply_rate_text)
  };
}

// 검색 결과가 없으면 이전/기본 목록이 그대로 남기 때문에
// 행의 상품코드(ISBN)가 실제로 일치하는지 확인한다.
async function waitForMatchingRows(page, isbn, timeout = RESULT_TIMEOUT) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const rows = (await readRows(page)).map(toRow);
    const matched = rows
      .filter((row) => row.isbn === isbn)
      .sort((left, right) => left.index - right.index);

    if (matched.length > 0) {
      return matched;
    }

    await page.waitForTimeout(RESULT_POLL_INTERVAL);
  }

  return [];
}

export async function fetchKyoboPriceByIsbn(isbn) {
  const normalizedIsbn = normalizeIsbn(isbn);

  if (!normalizedIsbn) {
    throw new Error("isbn is required.");
  }

  const config = readConfig();
  const page = await acquirePage(config);

  try {
    await page.fill(SEARCH_INPUT_SELECTOR, normalizedIsbn);
    await page.press(SEARCH_INPUT_SELECTOR, "Enter");

    const rows = await waitForMatchingRows(page, normalizedIsbn);

    if (rows.length === 0) {
      return {
        isbn: normalizedIsbn,
        found: false,
        title: "",
        price: null,
        wholesale_price: null,
        rows: []
      };
    }

    const first = rows[0];

    return {
      isbn: normalizedIsbn,
      found: true,
      title: first.title,
      publisher: first.publisher,
      author: first.author,
      pub_date: first.pub_date,
      price: first.price,
      wholesale_price: first.wholesale_price,
      supply_rate: first.supply_rate,
      rows
    };
  } finally {
    releasePage(page);
  }
}

export async function saveKyoboPrice(result) {
  const collection = await getCollection();
  const now = new Date();
  const filter = { isbn: String(result.isbn) };

  if (!result.found) {
    // 교보에 없는 ISBN으로 신규 문서를 만들지 않는다.
    return collection.updateOne(filter, {
      $set: {
        kyobo_found: false,
        kyobo_checked_at: now
      }
    });
  }

  return collection.updateOne(
    filter,
    {
      $set: {
        isbn: String(result.isbn),
        price: result.price ?? null,
        wholesale_price: result.wholesale_price ?? null,
        supply_rate: result.supply_rate ?? null,
        kyobo_found: true,
        kyobo_title: result.title ?? "",
        kyobo_checked_at: now,
        kyobo_updated_at: now,
        updated_at: now
      },
      $unset: {
        kyobo_price: "",
        kyobo_wholesale_price: "",
        kyobo_supply_rate: ""
      },
      $setOnInsert: {
        created_at: now
      }
    },
    { upsert: true }
  );
}

export async function crawlKyoboPrice(isbn) {
  const result = await fetchKyoboPriceByIsbn(isbn);
  const saveResult = await saveKyoboPrice(result);

  return {
    ...result,
    saved: result.found && (saveResult.modifiedCount > 0 || saveResult.upsertedCount > 0)
  };
}
