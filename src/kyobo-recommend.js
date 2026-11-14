// 교보문고 추천도서 · 문학상 목록 수집
//   https://store.kyobobook.co.kr/recommend
// 추천 화면이 쓰는 내부 API(JSON)를 그대로 부른다 — 로그인 없이 열리고, 책마다 ISBN · 선정 연도 · 부문 · 추천 사유가 온다.
//   메뉴 트리 : 추천 페이지 HTML 안의 lnbList (bigCategory > mediumCategory > smallCategory)
//   부문      : GET /api/gw/store/recommend/category?dsplMenuNum=<메뉴>
//   책 목록   : GET /api/gw/store/recommend/category/books?page=&per=&rcmnDvsnCode=&rcmnFldCode=a,b,c
// 공식 API 가 아니다 — 교보가 구조를 바꾸면 여기부터 고친다. (도매가 조회용 kyobo.js 와는 별개)
const STORE_URL = "https://store.kyobobook.co.kr";
const API_URL = `${STORE_URL}/api/gw/store`;
// 메뉴 트리를 얻으려고 여는 페이지 (어느 추천 페이지든 전체 트리가 들어 있다)
const MENU_PAGE = `${STORE_URL}/recommend/1529/1771`;
const PAGE_SIZE = 100;
// 문학상 영역의 메뉴 번호 — 이 아래는 AWARD, 나머지는 RECOMMENDED
const AWARD_ROOT = 1525;

const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "accept-language": "ko-KR,ko;q=0.9"
};

function rlNum(name, fallback) {
  return Number(process.env[name]) || fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 요청은 한 번에 하나씩, KYOBO_RECOMMEND_INTERVAL(기본 500ms) 간격으로 보낸다
let lastRequestAt = 0;
async function request(url, { json = true, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const wait = lastRequestAt + rlNum("KYOBO_RECOMMEND_INTERVAL", 500) - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    let response;
    try {
      response = await fetch(url, {
        headers: { ...HEADERS, accept: json ? "application/json" : "text/html", referer: `${STORE_URL}/recommend` }
      });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(3000 * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      return json ? response.json() : response.text();
    }
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= retries) {
      throw new Error(`Failed to fetch ${url} (${response.status})`);
    }
    console.warn(`kyobo 재시도 ${attempt + 1}/${retries} (HTTP ${response.status}): ${url}`);
    await sleep(5000 * 2 ** attempt);
  }
}

// Next.js 가 HTML 에 심어 둔 데이터(self.__next_f.push)를 이어 붙인다
function nextPayload(html) {
  let payload = "";
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g)) {
    try {
      payload += JSON.parse(`"${match[1]}"`);
    } catch {
      // 깨진 조각은 건너뛴다
    }
  }
  return payload;
}

// text 의 start 위치에서 시작하는 JSON 값({...})을 괄호 짝을 맞춰 잘라낸다
function sliceJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function audienceOf(path) {
  const text = path.join(" ");
  if (/어린이|유아|유아동|초등|[1-6]학년|아동|그림책/.test(text)) return "CHILD";
  if (/청소년|중고등|중학|고등|중등/.test(text)) return "YOUTH";
  return null;
}

// 추천 메뉴 트리 → 책 목록이 달린 메뉴(leaf) 전체
//   [{ menuNum, name, groupName, type, audience, path, url }]
export async function fetchKyoboRecommendMenus() {
  const html = await request(MENU_PAGE, { json: false });
  const payload = nextPayload(html);
  const at = payload.indexOf('"lnbList":');
  const raw = at >= 0 ? sliceJsonObject(payload, payload.indexOf("{", at)) : null;
  if (!raw) {
    throw new Error("교보 추천 메뉴(lnbList)를 찾지 못했습니다 — 페이지 구조가 바뀌었을 수 있습니다.");
  }
  const tree = JSON.parse(raw);

  const menus = [];
  const walk = (node, ancestors, rootNum) => {
    const path = [...ancestors, node.dsplMenuName];
    const children = node.mediumCategory ?? node.smallCategory ?? [];
    if (children.length > 0) {
      for (const child of children) walk(child, path, rootNum);
      return;
    }
    menus.push({
      menuNum: Number(node.dsplMenuNum),
      name: node.dsplMenuName,
      // 상위 메뉴 경로 ("문학상 추천도서 > 해외문학상")
      groupName: ancestors.join(" > ") || null,
      type: rootNum === AWARD_ROOT ? "AWARD" : "RECOMMENDED",
      audience: audienceOf(path),
      path,
      url: `${STORE_URL}/recommend/${[rootNum, ...path.slice(1).map(() => null)].filter(Boolean).join("/")}`
    });
  };
  for (const root of tree.bigCategory ?? []) walk(root, [], Number(root.dsplMenuNum));

  // 목록 주소는 /recommend/<영역>/…/<메뉴> — 영역과 메뉴 번호만으로도 열린다
  for (const menu of menus) menu.url = `${menu.url}/${menu.menuNum}`;
  return menus;
}

// "2025년" → 2025
function yearOf(value) {
  const year = Number(String(value ?? "").match(/((?:19|20)\d{2})/)?.[1]);
  return Number.isFinite(year) && year > 0 ? year : null;
}

// "20250915" → "2025-09-15"
function dateOf(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : text;
}

function toItem(book, menu, division, rank) {
  const isbn = String(book.cmdtCode ?? "").trim();
  const year = yearOf(book.rcmnSlcnYr);
  return {
    itemId: String(book.saleCmdtid ?? isbn),
    isbn: isbn || null,
    title: String(book.cmdtName ?? "").trim(),
    subtitle: "",
    author: String(book.chrcName ?? "").trim(),
    publisher: String(book.pbcmName ?? "").trim(),
    pubDate: dateOf(book.rlseDate),
    // 교보 표지 이미지는 ISBN 으로 주소가 정해진다
    imageUrl: isbn ? `https://contents.kyobobook.co.kr/sih/fit-in/458x0/pdt/${isbn}.jpg` : "",
    price: typeof book.saleCmdtPrce === "number" ? book.saleCmdtPrce : null,
    year,
    round: null,
    division,
    label: [book.rcmnSlcnYr, menu.name, division].filter(Boolean).join(" "),
    reason: String(book.rcmnRsn ?? "").trim(),
    rank
  };
}

// 메뉴 1개의 책 전체 — { menu, items, total, divisions }
export async function fetchKyoboRecommendItems(menu, { maxPages = Infinity } = {}) {
  const category = await request(`${API_URL}/recommend/category?dsplMenuNum=${menu.menuNum}`);
  const divisions = category?.data?.detailCategory ?? [];
  if (divisions.length === 0) {
    return { menu, items: [], total: 0, divisions: [] };
  }

  // 부문(사회과학 · 초등 저학년 …)마다 따로 읽어야 책에 부문을 붙일 수 있다.
  // 부문이 하나뿐이면 목록 자체라 부문 이름을 비운다.
  const items = new Map();
  let total = 0;
  for (const division of divisions) {
    const divisionName = divisions.length > 1 ? String(division.rcmnFldName ?? "").trim() : "";
    const query = new URLSearchParams({
      per: String(PAGE_SIZE),
      rcmnDvsnCode: String(division.rcmnDvsnCode),
      rcmnFldCode: String(division.rcmnFldCode)
    });
    let divisionTotal = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      query.set("page", String(page));
      const result = await request(`${API_URL}/recommend/category/books?${query}`);
      const books = result?.data?.rcmnBook ?? [];
      divisionTotal = Number(result?.data?.total ?? divisionTotal) || divisionTotal;
      if (books.length === 0) break;

      for (const book of books) {
        const item = toItem(book, menu, divisionName, items.size + 1);
        // 같은 책이 연도·부문을 달리해 다시 나오면 먼저 나온(최신) 것만 둔다
        if (item.title && !items.has(item.itemId)) items.set(item.itemId, item);
      }
      if (page * PAGE_SIZE >= divisionTotal) break;
    }
    total += divisionTotal;
  }

  return { menu, items: [...items.values()], total, divisions: divisions.map((division) => division.rcmnFldName) };
}
