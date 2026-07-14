import { chromium } from "playwright";
import { createWorker, OEM, PSM } from "tesseract.js";
import engData from "@tesseract.js-data/eng";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_URL = "https://myranking.co.kr/index.php";
const BROWSER_PROFILE_DIR = resolve(".myranking-profile");
const TIME_PATTERN = /(?<!\d)(?:\d{1,2}:)?\d{1,2}[.:]\d{2}(?!\d)/g;
const DEFAULT_SECURITY_VERIFICATION_TIMEOUT = 600_000;
let sharedContextPromise = null;

async function launchContext(headless = false) {
  return chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    locale: "ko-KR",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
  });
}

async function getSharedContext(headless = false) {
  if (!sharedContextPromise) {
    sharedContextPromise = launchContext(headless).catch((error) => {
      sharedContextPromise = null;
      throw error;
    });
  }
  return sharedContextPromise;
}

export async function closeMyRankingBrowser() {
  if (!sharedContextPromise) return;
  const context = await sharedContextPromise.catch(() => null);
  sharedContextPromise = null;
  await context?.close();
}

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTimes(text) {
  return [...new Set(normalize(text).match(TIME_PATTERN) ?? [])];
}

async function extractResultRecords(page) {
  const items = page.locator("#resultList .result-item");
  const count = await items.count();
  if (count === 0) return [];

  const worker = await createWorker(engData.code, OEM.LSTM_ONLY, {
    langPath: engData.langPath,
    gzip: engData.gzip
  });
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789:.",
    tessedit_pageseg_mode: PSM.SINGLE_LINE
  });

  const records = [];
  try {
    console.error(`기록 이미지 ${count}개의 time을 읽는 중입니다...`);
    for (let index = 0; index < count; index += 1) {
      const item = items.nth(index);
      const recordImage = item.locator(".record-time img").first();
      if ((await recordImage.count()) === 0) continue;

      const imageDataUrl = await recordImage.evaluate(async (image) => {
        if (!image.complete) {
          await new Promise((resolve, reject) => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", reject, { once: true });
          });
        }

        const scale = 8;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, image.naturalWidth * scale);
        canvas.height = Math.max(1, image.naturalHeight * scale);
        const context = canvas.getContext("2d");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = false;
        context.filter = "grayscale(1) contrast(2)";
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
      });

      const { data } = await worker.recognize(imageDataUrl);
      const ocrText = normalize(data.text).replace(/,/g, ".");
      const time = extractTimes(ocrText)[0] ?? null;
      const category = normalize(await item.locator(".category-tag").innerText());
      const eventText = normalize(await item.locator(".event-tag").innerText());
      const roundMatch = eventText.match(/(?:^|\s)(예선|준결승|결승)$/);
      const round = roundMatch?.[1] ?? null;
      const event = round ? normalize(eventText.slice(0, -round.length)) : eventText;
      const ageGroup = normalize(
        category
          .replace(/^(남자|여자|혼성)\s*/, "")
          .replace(/^성인부\s*/, "")
      );
      const rankLocator = item.locator(".record-rank");
      const rankText = normalize(await rankLocator.innerText());
      const rankImageAlt =
        (await rankLocator.locator("img").first().getAttribute("alt").catch(() => null)) ?? "";
      const rank = rankText || normalize(rankImageAlt) || null;
      const pb = (await item.locator(".pb-badge").count()) > 0;
      const team = normalize(await item.locator(".team-name-text").innerText());
      const competitionName = normalize(await item.locator(".comp-name").innerText());
      const date = normalize(await item.locator(".comp-date").innerText());

      const record = {
        idx: await item.getAttribute("data-idx"),
        team,
        ageGroup,
        round,
        pb,
        rank,
        competitionName,
        date,
        time,
        ocrText,
        category,
        event,
        competition: competitionName,
        competitionDate: date
      };
      records.push(record);
      console.error(
        `[${index + 1}/${count}] ${JSON.stringify({
          team: record.team,
          ageGroup: record.ageGroup,
          round: record.round,
          pb: record.pb,
          rank: record.rank,
          competitionName: record.competitionName,
          date: record.date,
          time: record.time
        })}`
      );
    }
  } finally {
    await worker.terminate();
  }

  return records;
}

/**
 * 마이랭킹에서 검색어와 일치하는 수영 기록 시간을 조회한다.
 * 사이트가 CSRF nonce와 Turnstile 검증을 사용하므로 실제 검색 폼을 제출한다.
 */
export async function fetchMyRankingTimes(query, options = {}) {
  if (!normalize(query)) {
    throw new Error("검색어를 입력해주세요.");
  }

  const reuseBrowser = options.reuseBrowser ?? false;
  const context = reuseBrowser
    ? await getSharedContext(options.headless ?? false)
    : await launchContext(options.headless ?? false);
  const securityVerificationTimeout =
    Number.isFinite(options.securityVerificationTimeout) &&
    options.securityVerificationTimeout > 0
      ? options.securityVerificationTimeout
      : DEFAULT_SECURITY_VERIFICATION_TIMEOUT;

  try {
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const searchInput = page.locator("#searchInput, input[name='q']").first();
    await searchInput.waitFor({ state: "visible", timeout: 30_000 });
    // nonce의 지나치게 빠른 제출을 피하고 Turnstile 초기화를 기다린다.
    await page.waitForTimeout(3_000);
    await searchInput.fill(query);

    await Promise.all([
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: securityVerificationTimeout
      }),
      searchInput.press("Enter")
    ]);
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 });

    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    if (/page=home/.test(page.url())) {
      if (options.headless) {
        throw new Error(
          "검색 결과 페이지로 이동하지 못했습니다. 창이 표시되는 기본 모드로 실행해주세요."
        );
      }

      console.error(
        `자동 검색이 보안 검증에서 거절되었습니다. 열린 브라우저에서 직접 검색하고 ` +
          `보안 검증을 완료해주세요. 최대 ${Math.ceil(securityVerificationTimeout / 60_000)}분 동안 기다립니다.`
      );

      await page.waitForURL(/page=result/, {
        timeout: securityVerificationTimeout
      });
      await page.waitForLoadState("domcontentloaded", {
        timeout: securityVerificationTimeout
      });
    }

    const bodyText = normalize(await page.locator("body").innerText());
    if (/보안\s*(확인|검증)|잠시\s*후\s*다시|비정상적인\s*접근/.test(bodyText)) {
      throw new Error(
        "마이랭킹 보안 검증에 의해 검색이 차단되었습니다. 브라우저 창에서 검증을 완료한 뒤 다시 실행해주세요."
      );
    }

    await page.locator("#resultList .result-item").first().waitFor({
      state: "attached",
      timeout: 30_000
    });
    const records = await extractResultRecords(page);
    const times = [...new Set(records.map((record) => record.time).filter(Boolean))];

    const result = {
      query,
      times,
      records,
      resultUrl: page.url()
    };

    if (options.keepOpen) {
      console.error(
        `검색이 완료되었습니다. time: ${times.join(", ") || "찾지 못함"}\n` +
          "내용을 확인한 뒤 브라우저 창을 직접 닫아주세요."
      );
      await page.waitForEvent("close");
    }

    return result;
  } finally {
    if (!reuseBrowser) {
      await context.close();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const headless = args.includes("--headless");
  const autoClose = args.includes("--auto-close");
  const timeoutArg = args.find((arg) => arg.startsWith("--timeout="));
  const timeoutSeconds = timeoutArg ? Number(timeoutArg.split("=")[1]) : 600;
  const query = args
    .filter(
      (arg) =>
        arg !== "--headless" &&
        arg !== "--auto-close" &&
        !arg.startsWith("--timeout=")
    )
    .join(" ");

  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("--timeout 값은 0보다 큰 초 단위 숫자여야 합니다.");
  }

  if (!query) {
    throw new Error(
      'Usage: node src/myranking.js "문성중 남자 평영 50M" [--timeout=600] [--auto-close] [--headless]'
    );
  }

  const result = await fetchMyRankingTimes(query, {
    headless,
    keepOpen: !headless && !autoClose,
    securityVerificationTimeout: timeoutSeconds * 1_000
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
