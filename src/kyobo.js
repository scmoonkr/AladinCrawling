import dotenv from "dotenv";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { getCollection } from "./db.js";

dotenv.config();

const BROWSER_PROFILE_DIR = resolve(".kyobo-profile");
const LOGIN_ID_SELECTOR = "input#mf_ibx_userId";
const LOGIN_PASSWORD_SELECTOR = "input#mf_sct_password";
const LOGIN_BUTTON_SELECTOR = "a#mf_btn_login";
const SEARCH_INPUT_SELECTOR = "input#mf_wfm_header_ibx_findName";
const SEARCH_API_PATH = "/bscm/btco/findBksSrchMain.do";
const SEARCH_SUBMISSION_ID = "mf_wfm_content_sbm_findBksSrchMain";
const SEARCH_PAGE_PATH = "/WebBscm/btco/btcoBksSrch.xml";
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const SEARCH_ATTEMPTS = 3;
const RETRY_DELAY = 500;
const RATE_LIMIT_BACKOFF = 30_000;

let sharedContextPromise = null;
let loginPromise = null;
let sessionGeneration = 0;

// 검색을 너무 몰아치면 서버가 "시스템 과부하로 검색이 제한됩니다"(E9999)를 돌려준다.
// 재로그인으로는 풀리지 않고 시간을 두고 기다려야 하므로 별도 오류로 구분한다.
export class KyoboRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "KyoboRateLimitError";
  }
}

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

function normalizeIsbn(value) {
  return String(value ?? "").replace(/[^0-9Xx]/g, "").toUpperCase();
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
  sessionGeneration = 0;
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

async function performLogin(config) {
  const context = await getSharedContext();
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  await page.goto(config.url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });

  if (await isVisible(page, LOGIN_ID_SELECTOR, 8000)) {
    await page.fill(LOGIN_ID_SELECTOR, config.id);
    await page.fill(LOGIN_PASSWORD_SELECTOR, config.password);
    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: DEFAULT_TIMEOUT }).catch(() => null),
      page.click(LOGIN_BUTTON_SELECTOR)
    ]);
  } else {
    await assertNotUnderMaintenance(page);
  }

  if (!(await isVisible(page, SEARCH_INPUT_SELECTOR, DEFAULT_TIMEOUT))) {
    throw new Error("Kyobo login failed: search input not found.");
  }

  return page;
}

// 로그인은 프로세스당 1회. 이후 조회는 이 세션 쿠키로 검색 API를 직접 호출한다.
async function ensureSession(config) {
  if (!loginPromise) {
    sessionGeneration += 1;
    const generation = sessionGeneration;
    loginPromise = performLogin(config)
      .then(() => generation)
      .catch((error) => {
        loginPromise = null;
        throw error;
      });
  }

  const generation = await loginPromise;
  return { context: await getSharedContext(), generation };
}

// 여러 요청이 동시에 세션 만료를 감지해도 재로그인은 한 번만 수행한다.
// (동시에 로그인 페이지로 이동하면 서로의 이동을 취소시켜 전부 실패한다.)
async function renewSession(config, staleGeneration) {
  if (sessionGeneration === staleGeneration) {
    loginPromise = null;
  }

  return ensureSession(config);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSearchPayload(isbn) {
  return {
    dma_srch: {
      findName: isbn,
      sort: "DATE",
      viewCount: 20,
      reSrchfindName: "",
      reSrchCondition: "",
      vSAgainConAll: "",
      vSAgainConBookNm: "",
      vSAgainConAutr: "",
      vSAgainConPubNm: "",
      strColQuery: "",
      reSrchYsno: "N",
      strSiteNM: "",
      cmdtCdtn001Ysno: ""
    },
    dma_menu: {
      menuId: "",
      pgmSaveAdrs: SEARCH_PAGE_PATH
    }
  };
}

async function postSearch(context, config, isbn) {
  const origin = new URL(config.url).origin;
  const response = await context.request.post(new URL(SEARCH_API_PATH, origin).toString(), {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=\"UTF-8\"",
      Origin: origin,
      Referer: config.url,
      submissionid: SEARCH_SUBMISSION_ID
    },
    data: buildSearchPayload(isbn),
    timeout: DEFAULT_TIMEOUT
  });

  if (!response.ok()) {
    return null;
  }

  // 세션이 끊기면 JSON 대신 로그인 화면(HTML)이 돌아온다.
  return response.json().catch(() => null);
}

async function requestSearch(config, isbn) {
  let session = await ensureSession(config);
  let lastRateLimitMessage = "";

  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt += 1) {
    const payload = await postSearch(session.context, config, isbn).catch(() => null);

    if (Array.isArray(payload?.dlt_bksSrch)) {
      return payload;
    }

    // 검색 제한은 세션 문제가 아니므로 재로그인하지 않고 기다렸다 다시 시도한다.
    if (payload?.rsMsg?.statusCode === "E") {
      lastRateLimitMessage = String(payload.rsMsg.message ?? payload.rsMsg.errorCode ?? "");

      if (attempt === SEARCH_ATTEMPTS) {
        break;
      }

      await delay(RATE_LIMIT_BACKOFF * attempt);
      continue;
    }

    if (attempt === SEARCH_ATTEMPTS) {
      break;
    }

    await delay(RETRY_DELAY * attempt);

    // 첫 재시도는 같은 세션으로, 그래도 실패하면 세션 만료로 보고 다시 로그인한다.
    if (attempt > 1) {
      session = await renewSession(config, session.generation);
    }
  }

  if (lastRateLimitMessage) {
    throw new KyoboRateLimitError(`Kyobo search is restricted: ${lastRateLimitMessage}`);
  }

  throw new Error(`Kyobo search failed for ${isbn} after ${SEARCH_ATTEMPTS} attempts.`);
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPubDate(value) {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits.length === 8 ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` : "";
}

// 응답에는 정가(wncrPrce)와 출고율(byngRate)만 있고, 화면의 출고가는 이 둘을 곱한 값이다.
function toRow(item, index) {
  const price = toNumber(item.wncrPrce);
  const supplyRate = toNumber(item.byngRate);

  return {
    index,
    isbn: normalizeIsbn(item.cmdtCode),
    title: String(item.cmdtName ?? "").trim(),
    publisher: String(item.pbcmName ?? "").trim(),
    author: String(item.autrName ?? "").trim(),
    pub_date: formatPubDate(item.rlseDate),
    price,
    wholesale_price: price !== null && supplyRate !== null ? Math.round((price * supplyRate) / 100) : null,
    supply_rate: supplyRate,
    stock: toNumber(item.avlbInvnQntt),
    condition: String(item.cmdtCdtnName ?? "").trim()
  };
}

export async function fetchKyoboPriceByIsbn(isbn) {
  const normalizedIsbn = normalizeIsbn(isbn);

  if (!normalizedIsbn) {
    throw new Error("isbn is required.");
  }

  const config = readConfig();
  const payload = await requestSearch(config, normalizedIsbn);
  const rows = payload.dlt_bksSrch
    .map((item, index) => toRow(item, index))
    .filter((row) => row.isbn === normalizedIsbn);

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
    stock: first.stock,
    rows
  };
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
