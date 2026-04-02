import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import { fetchBookDetail, fetchBookList, fetchNewBookList } from "./aladin.js";
import { closeMongo, getCollection } from "./db.js";
import { saveBookDetail, saveBookList } from "./store.js";

function loadCategoryData() {
  const source = fs.readFileSync(new URL("./category.js", import.meta.url), "utf8");
  const sandbox = { exports: {} };
  vm.runInNewContext(source, sandbox);
  return sandbox.exports.Aladin ?? { category: [] };
}

const Aladin = loadCategoryData();

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCategoryByClass(CID) {
  return (Aladin?.category || []).find((category) => String(category.linkClass) === String(CID)) ?? null;
}

function runListCategoryCommand(CID) {
  if (!CID) {
    throw new Error("Usage: node src/index.js listCategory <CID>");
  }

  const category = findCategoryByClass(CID);

  if (!category) {
    return {
      command: "listCategory",
      CID,
      found: false,
      name: null,
      subCategoryCount: 0,
      linkClasses: [],
      subCategories: []
    };
  }

  const subCategories = Array.isArray(category.subCategory)
    ? category.subCategory.map((item) => ({
        linkClass: String(item.linkClass),
        name: item.name
      }))
    : [];

  return {
    command: "listCategory",
    CID: String(category.linkClass),
    found: true,
    name: category.name,
    subCategoryCount: subCategories.length,
    linkClasses: subCategories.map((item) => item.linkClass),
    subCategories
  };
}

async function runListCommand(mode, CID, page, pageSize) {
  if (mode === "list" && !CID) {
    throw new Error("Usage: node src/index.js list <CID> <page> <rowcount>");
  }

  const fetcher = mode === "new" ? fetchNewBookList : fetchBookList;
  const data = await fetcher({ CID, page, pageSize });
  const result = await saveBookList(data.items);

  return {
    command: mode,
    CID: CID ?? null,
    page,
    pageSize,
    total_count: data.total_count,
    saved_count: data.items.length,
    db: {
      matchedCount: result.matchedCount ?? 0,
      modifiedCount: result.modifiedCount ?? 0,
      upsertedCount: result.upsertedCount ?? 0,
      skippedCount: result.skippedCount ?? 0
    },
    items: data.items
  };
}

async function runListAllCommand(CID, pageCount) {
  if (!CID) {
    throw new Error("Usage: node src/index.js listAll <CID> <pageCount>");
  }

  const pages = [];
  const allItems = [];
  const db = {
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0,
    skippedCount: 0
  };

  for (let page = 1; page <= pageCount; page += 1) {
    const data = await fetchBookList({ CID, page, pageSize: 50 });
    console.log(CID, page, data.items.length);

    if (data.items.length === 0) {
      break;
    }

    const result = await saveBookList(data.items);

    pages.push({
      page,
      saved_count: data.items.length,
      db: {
        matchedCount: result.matchedCount ?? 0,
        modifiedCount: result.modifiedCount ?? 0,
        upsertedCount: result.upsertedCount ?? 0,
        skippedCount: result.skippedCount ?? 0
      }
    });

    db.matchedCount += result.matchedCount ?? 0;
    db.modifiedCount += result.modifiedCount ?? 0;
    db.upsertedCount += result.upsertedCount ?? 0;
    db.skippedCount += result.skippedCount ?? 0;
    allItems.push(...data.items);
  }

  return {
    command: "listAll",
    CID,
    pageCount,
    pageSize: 50,
    total_count: null,
    saved_count: allItems.length,
    db,
    pages,
    items: allItems
  };
}

async function runListCategoryAllCommand(CID, pageCount) {
  if (!CID) {
    throw new Error("Usage: node src/index.js listCategoryAll <CID> <pageCount>");
  }

  const categoryPayload = runListCategoryCommand(CID);

  if (!categoryPayload.found) {
    return {
      command: "listCategoryAll",
      CID,
      found: false,
      pageCount,
      categories: []
    };
  }

  const categories = [];
  const db = {
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0,
    skippedCount: 0
  };
  let savedCount = 0;

  for (const subCategory of categoryPayload.subCategories) {
    const payload = await runListAllCommand(subCategory.linkClass, pageCount);
    categories.push({
      CID: subCategory.linkClass,
      name: subCategory.name,
      saved_count: payload.saved_count,
      db: payload.db,
      pages: payload.pages
    });

    db.matchedCount += payload.db.matchedCount ?? 0;
    db.modifiedCount += payload.db.modifiedCount ?? 0;
    db.upsertedCount += payload.db.upsertedCount ?? 0;
    db.skippedCount += payload.db.skippedCount ?? 0;
    savedCount += payload.saved_count ?? 0;
  }

  return {
    command: "listCategoryAll",
    CID: categoryPayload.CID,
    name: categoryPayload.name,
    found: true,
    pageCount,
    subCategoryCount: categoryPayload.subCategoryCount,
    saved_count: savedCount,
    db,
    categories
  };
}

async function runDetailCommand(itemId, url) {
  if (!itemId && !url) {
    throw new Error("Usage: node src/index.js detail <itemId>");
  }

  const data = itemId
    ? await fetchBookDetail({ itemId })
    : await fetchBookDetail({ url });
  const result = await saveBookDetail(data);

  return {
    saved: true,
    db: {
      matchedCount: result.matchedCount ?? 0,
      modifiedCount: result.modifiedCount ?? 0,
      upsertedCount: result.upsertedCount ?? 0,
      upsertedId: result.upsertedId ?? null
    },
    item: data
  };
}

async function runDetailLinkClassCommand(linkClass) {
  if (!linkClass) {
    throw new Error("Usage: node src/index.js detailLinkClass <linkClass>");
  }

  const collection = await getCollection();
  const targets = await collection.find(
    {
      linkClass: String(linkClass),
      detail_updated_at: { $exists: false }
    },
    {
      projection: {
        item_id: 1,
        title: 1,
        url: 1,
        linkClass: 1
      }
    }
  ).toArray();

  const processed = [];
  const failed = [];

	let count = 1;
  for (const target of targets) {
    try {
			console.log(linkClass, "item_id:", target.item_id, `: ${count++} / ${targets.length}`);
      const payload = await runDetailCommand(target.item_id ?? null, target.url ?? null);
      processed.push({
        item_id: payload.item.item_id,
        title: payload.item.title,
        url: payload.item.url,
        linkClass: target.linkClass ?? null
      });
    } catch (error) {
      failed.push({
        item_id: target.item_id ?? null,
        title: target.title ?? "",
        url: target.url ?? "",
        linkClass: target.linkClass ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    command: "detailLinkClass",
    linkClass: String(linkClass),
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    processed,
    failed
  };
}

async function runDetailLinkClassAllCommand(CID) {
  if (!CID) {
    throw new Error("Usage: node src/index.js detailLinkClassAll <CID>");
  }

  const categoryPayload = runListCategoryCommand(CID);

  if (!categoryPayload.found) {
    return {
      command: "detailLinkClassAll",
      CID: String(CID),
      found: false,
      categories: []
    };
  }

  const categories = [];
  let matched_count = 0;
  let processed_count = 0;
  let failed_count = 0;

  for (const subCategory of categoryPayload.subCategories) {
    const payload = await runDetailLinkClassCommand(subCategory.linkClass);
    categories.push({
      linkClass: subCategory.linkClass,
      name: subCategory.name,
      matched_count: payload.matched_count,
      processed_count: payload.processed_count,
      failed_count: payload.failed_count,
      processed: payload.processed,
      failed: payload.failed
    });

    matched_count += payload.matched_count ?? 0;
    processed_count += payload.processed_count ?? 0;
    failed_count += payload.failed_count ?? 0;
  }

  return {
    command: "detailLinkClassAll",
    CID: categoryPayload.CID,
    name: categoryPayload.name,
    found: true,
    subCategoryCount: categoryPayload.subCategoryCount,
    matched_count,
    processed_count,
    failed_count,
    categories
  };
}

async function runDetailCategoryCommand(category) {
  if (!category) {
    throw new Error("Usage: node src/index.js detailCategory <category>");
  }

  const collection = await getCollection();
  const regex = new RegExp(escapeRegex(category), "i");
  const targets = await collection.find(
    {
      categories: { $elemMatch: { $regex: regex } },
      detail_updated_at: { $exists: false }
    },
    {
      projection: {
        item_id: 1,
        title: 1,
        url: 1,
        categories: 1
      }
    }
  ).toArray();

  const processed = [];
  const failed = [];

  for (const target of targets) {
    try {
      const payload = await runDetailCommand(target.item_id ?? null, target.url ?? null);
      processed.push({
        item_id: payload.item.item_id,
        title: payload.item.title,
        url: payload.item.url
      });
    } catch (error) {
      failed.push({
        item_id: target.item_id ?? null,
        title: target.title ?? "",
        url: target.url ?? "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    command: "detailCategory",
    category,
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    processed,
    failed
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function handleApiRequest(request, response) {
  if (!request.url) {
    sendJson(response, 400, { error: "Invalid request url." });
    return;
  }

  const requestUrl = new URL(request.url, "http://localhost");
  const { pathname, searchParams } = requestUrl;

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  try {
    if (pathname === "/api/list") {
      const CID = searchParams.get("category") || searchParams.get("CID");
      const page = parsePositiveInt(searchParams.get("page"), 1);
      const pageSize = parsePositiveInt(searchParams.get("rowcount") || searchParams.get("pageSize"), 50);
      const payload = await runListCommand("list", CID, page, pageSize);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/listAll") {
      const CID = searchParams.get("category") || searchParams.get("CID");
      const pageCount = parsePositiveInt(searchParams.get("pageCount"), 1);
      const payload = await runListAllCommand(CID, pageCount);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/new") {
      const CID = searchParams.get("category") || searchParams.get("CID");
      const page = parsePositiveInt(searchParams.get("page"), 1);
      const pageSize = parsePositiveInt(searchParams.get("rowcount") || searchParams.get("pageSize"), 50);
      const payload = await runListCommand("new", CID, page, pageSize);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/detail") {
      const itemId = searchParams.get("itemId");
      const url = searchParams.get("url");
      const payload = await runDetailCommand(itemId, url);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/detailCategory") {
      const category = searchParams.get("category");
      const payload = await runDetailCategoryCommand(category);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/detailLinkClass") {
      const linkClass = searchParams.get("linkClass");
      const payload = await runDetailLinkClassCommand(linkClass);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/detailLinkClassAll") {
      const CID = searchParams.get("CID") || searchParams.get("category") || searchParams.get("categoryId") || searchParams.get("categoryClass");
      const payload = await runDetailLinkClassAllCommand(CID);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/listCategory") {
      const CID = searchParams.get("CID");
      const payload = runListCategoryCommand(CID);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/listCategoryAll") {
      const CID = searchParams.get("CID");
      const pageCount = parsePositiveInt(searchParams.get("pageCount"), 1);
      const payload = await runListCategoryAllCommand(CID, pageCount);
      sendJson(response, 200, payload);
      return;
    }

    sendJson(response, 404, {
      error: "Not found.",
      routes: ["GET /api/list", "GET /api/listAll", "GET /api/new", "GET /api/detail", "GET /api/detailCategory", "GET /api/detailLinkClass", "GET /api/detailLinkClassAll", "GET /api/listCategory", "GET /api/listCategoryAll"]
    });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function startServer() {
  const port = parsePositiveInt(process.env.PORT, 3000);
  const server = http.createServer((request, response) => {
    handleApiRequest(request, response);
  });

  server.listen(port, () => {
    console.log(JSON.stringify({
      server: true,
      port,
      routes: ["GET /api/list", "GET /api/listAll", "GET /api/new", "GET /api/detail", "GET /api/detailCategory", "GET /api/detailLinkClass", "GET /api/detailLinkClassAll", "GET /api/listCategory", "GET /api/listCategoryAll"]
    }, null, 2));
  });

  const shutdown = async () => {
    server.close(async () => {
      await closeMongo();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const command = process.argv[2] ?? "list";

  if (command === "list") {
    const CID = process.argv[3];
    const page = parsePositiveInt(process.argv[4], 1);
    const pageSize = parsePositiveInt(process.argv[5], 10);
    const payload = await runListCommand("list", CID, page, pageSize);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "listAll") {
    const CID = process.argv[3];
    const pageCount = parsePositiveInt(process.argv[4], 1);
    const payload = await runListAllCommand(CID, pageCount);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "new") {
    const CID = process.argv[3] ?? null;
    const page = parsePositiveInt(process.argv[4], 1);
    const pageSize = parsePositiveInt(process.argv[5], 10);
    const payload = await runListCommand("new", CID, page, pageSize);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "detail") {
    const itemId = process.argv[3];
    const payload = await runDetailCommand(itemId, null);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "detailCategory") {
    const category = process.argv[3];
    const payload = await runDetailCategoryCommand(category);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "detailLinkClass") {
    const linkClass = process.argv[3];
    const payload = await runDetailLinkClassCommand(linkClass);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "detailLinkClassAll") {
    const CID = process.argv[3];
    const payload = await runDetailLinkClassAllCommand(CID);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "listCategory") {
    const CID = process.argv[3];
    const payload = runListCategoryCommand(CID);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "listCategoryAll") {
    const CID = process.argv[3];
    const pageCount = parsePositiveInt(process.argv[4], 1);
    const payload = await runListCategoryAllCommand(CID, pageCount);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "server") {
    startServer();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.argv[2] !== "server") {
      await closeMongo();
    }
  });
