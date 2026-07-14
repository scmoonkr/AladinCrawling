import http from "node:http";
import {
  closeMyRankingBrowser,
  fetchMyRankingTimes
} from "./myranking.js";

const port = Number(process.env.MYRANKING_PORT || 3001);
let requestQueue = Promise.resolve();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function enqueue(task) {
  const result = requestQueue.then(task, task);
  requestQueue = result.catch(() => {});
  return result;
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (!request.url || request.method !== "GET") {
    sendJson(response, 405, { error: "GET 요청만 지원합니다." });
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (url.pathname !== "/api/myranking") {
    sendJson(response, 404, {
      error: "Not found.",
      route: "GET /api/myranking?q=문성중%20남자%20평영%2050M"
    });
    return;
  }

  const query = url.searchParams.get("q")?.trim();
  if (!query) {
    sendJson(response, 400, { error: "q 검색어가 필요합니다." });
    return;
  }

  try {
    const result = await enqueue(() =>
      fetchMyRankingTimes(query, {
        reuseBrowser: true,
        keepOpen: false,
        headless: false,
        securityVerificationTimeout: 600_000
      })
    );
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(port, () => {
  console.log(`MyRanking API: http://localhost:${port}`);
  console.log(
    `GET /api/myranking?q=${encodeURIComponent("문성중 남자 평영 50M")}`
  );
});

async function shutdown() {
  server.close(async () => {
    await closeMyRankingBrowser();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
