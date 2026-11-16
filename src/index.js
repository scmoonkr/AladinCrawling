import http from "node:http";
import { BlockedDetailError, fetchBookDetail, fetchBookList, fetchNewBookList } from "./aladin.js";
import { closeMongo, getCollection } from "./db.js";
import { fetchAuthorDetail, fetchAuthorListPage, getAuthorAlphabets, getAuthorCategoryTypes } from "./authors.js";
import { fetchCallNumberByIsbn } from "./read365.js";
import { closeKyoboBrowser, crawlKyoboPrice, KyoboRateLimitError } from "./kyobo.js";
import { crawlNlcyByKdc, crawlNlcyNew, fetchNlcyDetail, fetchNlcyList, saveNlcyDetail } from "./nlcy.js";
import { crawlNlKdc, crawlNlNew, fetchNlDetail, getNlCollection, fetchNlList, saveNlDetail } from "./nl.js";
import { saveAuthorDetail, saveAuthorList } from "./author-store.js";
import { saveBookDetail, saveBookList } from "./store.js";
import { AWARD_TYPES, fetchAwardItems, fetchAwardList } from "./awards.js";
import { findListItemsWithoutBook, saveAwardList, saveKyoboList, saveRecommendList } from "./list-store.js";
import { fetchRecommendItems, fetchRecommendList } from "./recommends.js";
import { fetchKyoboRecommendItems, fetchKyoboRecommendMenus } from "./kyobo-recommend.js";
import { Aladin as AladinCategoryList } from "./category.js";

// category.js는 최상위 카테고리 배열(Aladin)을 export한다. 기존 코드가 기대하는 { category: [...] } 형태로 감싼다.
const Aladin = { category: Array.isArray(AladinCategoryList) ? AladinCategoryList : (AladinCategoryList?.category ?? []) };

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
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
    const startedAt = Date.now();
    let data;
    try {
      data = await fetchBookList({ CID, page, pageSize: 50 });
    } catch (error) {
      // 재시도 후에도 실패하면 이 카테고리는 중단하고 다음 카테고리로 넘어간다(전체 크롤 중단 방지).
      const message = error instanceof Error ? error.message : String(error);
      console.error(`목록 수집 실패 CID=${CID} page=${page}: ${message}`);
      pages.push({ page, saved_count: 0, error: message });
      break;
    }
    if (data.items.length === 0) {
      console.log(CID, page, 0, "-", 0, `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      break;
    }

    const result = await saveBookList(data.items);
    console.log(CID, page, data.items.length, "-", result.upsertedCount ?? 0, `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

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
		console.log("--->", subCategory.linkClass, pageCount, `[${categoryPayload.name}] - ${subCategory.name}`);
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

// Aladin 상품 페이지는 ItemId 기반이라 ISBN URL로 직접 접근할 수 없다.
// DB에 이미 저장된 isbn->item_id 매핑을 이용해 해당 상품의 상세를 (재)수집한다.
async function runDetailByIsbnCommand(isbn) {
  if (!isbn) {
    throw new Error("Usage: node src/index.js detailByIsbn <isbn>");
  }

  const collection = await getCollection();
  const doc = await collection.findOne(
    { isbn: String(isbn) },
    { projection: { item_id: 1, url: 1 } }
  );

  if (!doc || (!doc.item_id && !doc.url)) {
    throw new Error(`ISBN ${isbn} 에 해당하는 문서를 DB에서 찾지 못했습니다.`);
  }

  return runDetailCommand(doc.item_id ?? null, doc.url ?? null);
}

// 동적 섹션(책소개/목차/저자/출판사 책소개)을 받지 못한 건은 완료로 찍지 않고
// 실패로 처리해 다음 실행에서 다시 수집되게 한다.
function assertDynamicSections(payload) {
  if (payload.item.dynamic_failed) {
    throw new Error("동적 섹션 수집 실패 (정적 필드만 저장, 다음 실행에서 재시도)");
  }
}

async function markDetailUpdated(filter) {
  const collection = await getCollection();
  const now = new Date();

  await collection.updateOne(filter, {
    $set: {
      updated_at: now,
      detail_updated_at: now
    }
  });
}

// 성인도서(19세)/비공개 상품은 본문을 받을 수 없으므로 빈 데이터로 저장하지 않고
// 플래그(is_adult / is_private)만 찍어 이후 상세 수집 대상에서 제외(건너뛰기)한다.
async function markBlockedDetail(filter, reason) {
  const collection = await getCollection();
  const now = new Date();
  const field = reason === "private" ? "is_private" : "is_adult";

  await collection.updateOne(filter, {
    $set: {
      updated_at: now,
      [field]: true,
      blocked_reason: reason,
      blocked_checked_at: now
    }
  });
}

// ── 문학상 수상작 목록 (book_lists / book_list_items) ──────────────────────────

function awardTypesOf(awardType) {
  if (!awardType || awardType === "all") return Object.keys(AWARD_TYPES).map(Number);
  if (!AWARD_TYPES[awardType]) throw new Error("Usage: node src/index.js awards <all|1|2|3|4> [awardId] [maxPages] [--dry-run]");
  return [Number(awardType)];
}

// 분류별 상 목록만 본다 (DB 를 쓰지 않는다)
async function runAwardListsCommand(awardType) {
  const types = [];
  for (const type of awardTypesOf(awardType)) {
    const awards = await fetchAwardList(type);
    types.push({ awardType: type, name: AWARD_TYPES[type].name, count: awards.length, awards });
  }
  return { command: "awardLists", total: types.reduce((sum, type) => sum + type.count, 0), types };
}

// 수상작 수집 → book_lists / book_list_items 저장. --dry-run 이면 수집만 하고 저장하지 않는다
async function runAwardsCommand({ awardType, awardId, maxPages, dryRun }) {
  const summary = [];
  const failed = [];
  let listCount = 0;
  let itemCount = 0;
  let upserted = 0;

  for (const type of awardTypesOf(awardType)) {
    const awards = (await fetchAwardList(type)).filter((award) => !awardId || award.awardId === String(awardId));
    for (const award of awards) {
      try {
        const { items, lastPage } = await fetchAwardItems(award, { maxPages });
        const withYear = items.filter((item) => item.year != null).length;
        let saved = { upserted: 0, modified: 0 };
        if (!dryRun) saved = await saveAwardList(award, items);
        listCount += 1;
        itemCount += items.length;
        upserted += saved.upserted;
        summary.push({ awardType: type, awardId: award.awardId, name: award.name, items: items.length, withYear, pages: lastPage, new: saved.upserted });
        console.error(`[${AWARD_TYPES[type].name}] ${award.name} — ${items.length}권 (연도 ${withYear})${dryRun ? "" : ` 신규 ${saved.upserted}`}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ awardType: type, awardId: award.awardId, name: award.name, error: message });
        console.error(`수상 목록 수집 실패 ${award.name}: ${message}`);
      }
    }
  }

  return { command: "awards", dryRun, lists: listCount, items: itemCount, new_items: upserted, failed_count: failed.length, failed, summary };
}

// 외부/전문기관 추천도서 수집 → book_lists / book_list_items. cid 를 주면 그 목록만
async function runRecommendsCommand({ cid, maxPages, dryRun }) {
  const all = await fetchRecommendList();
  const topCids = new Set(all.map((list) => list.cid));
  const lists = all.filter((list) => !cid || list.cid === String(cid));
  const summary = [];
  const failed = [];
  let itemCount = 0;
  let upserted = 0;

  for (const list of lists) {
    try {
      const { items, lastPage, children } = await fetchRecommendItems(list, { topCids, maxPages });
      const withYear = items.filter((item) => item.year != null).length;
      let saved = { upserted: 0, modified: 0 };
      if (!dryRun) saved = await saveRecommendList(list, items);
      itemCount += items.length;
      upserted += saved.upserted;
      summary.push({ cid: list.cid, name: list.name, audience: list.audience, items: items.length, withYear, pages: lastPage, children: children.length, new: saved.upserted });
      console.error(`[추천] ${list.name} — ${items.length}권 (연도 ${withYear}, 하위 ${children.length})${dryRun ? "" : ` 신규 ${saved.upserted}`}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ cid: list.cid, name: list.name, error: message });
      console.error(`추천 목록 수집 실패 ${list.name}: ${message}`);
    }
  }

  return { command: "recommends", dryRun, lists: summary.length, items: itemCount, new_items: upserted, failed_count: failed.length, failed, summary };
}

// 교보 추천도서 · 문학상 수집 → book_lists / book_list_items. menuNum 을 주면 그 목록만
async function runKyoboRecommendsCommand({ menuNum, maxPages, dryRun }) {
  const menus = (await fetchKyoboRecommendMenus()).filter((menu) => !menuNum || menu.menuNum === Number(menuNum));
  const summary = [];
  const failed = [];
  let itemCount = 0;
  let upserted = 0;

  for (const menu of menus) {
    try {
      const { items, total, divisions } = await fetchKyoboRecommendItems(menu, { maxPages });
      const withYear = items.filter((item) => item.year != null).length;
      let saved = { upserted: 0, modified: 0 };
      if (!dryRun) saved = await saveKyoboList(menu, items);
      itemCount += items.length;
      upserted += saved.upserted;
      summary.push({ menuNum: menu.menuNum, type: menu.type, group: menu.groupName, name: menu.name, audience: menu.audience, total, items: items.length, withYear, divisions: divisions.length, new: saved.upserted });
      console.error(`[교보 ${menu.type === "AWARD" ? "수상" : "추천"}] ${menu.groupName} / ${menu.name} — ${items.length}권 (연도 ${withYear}, 부문 ${divisions.length})${dryRun ? "" : ` 신규 ${saved.upserted}`}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ menuNum: menu.menuNum, name: menu.name, error: message });
      console.error(`교보 목록 수집 실패 ${menu.name}: ${message}`);
    }
  }

  return { command: "kyoboRecommends", dryRun, lists: summary.length, items: itemCount, new_items: upserted, failed_count: failed.length, failed, summary };
}

// 목록에는 있는데 books 에 상세가 없는 책의 상세를 수집한다 (KRIN 이 GlobalBook 으로 만들 수 있게)
async function runListDetailsCommand(limit) {
  const targets = await findListItemsWithoutBook(limit);
  let saved = 0;
  const blocked = [];
  const failed = [];

  for (const target of targets) {
    try {
      const data = await fetchBookDetail({ itemId: target.itemId });
      await saveBookDetail(data);
      saved += 1;
      if (saved % 50 === 0) console.error(`listDetails … ${saved}/${targets.length}`);
    } catch (error) {
      if (error instanceof BlockedDetailError) {
        // 성인·비공개 상품 — 다음 실행에서 다시 시도하지 않도록 표시만 남긴다
        const collection = await getCollection();
        const now = new Date();
        await collection.updateOne(
          { item_id: String(target.itemId) },
          {
            $set: { title: target.title, blocked_reason: error.reason, blocked_checked_at: now, updated_at: now, [error.reason === "private" ? "is_private" : "is_adult"]: true },
            $setOnInsert: { created_at: now }
          },
          { upsert: true }
        );
        blocked.push({ itemId: target.itemId, reason: error.reason });
        continue;
      }
      failed.push({ itemId: target.itemId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { command: "listDetails", target_count: targets.length, saved_count: saved, blocked_count: blocked.length, failed_count: failed.length, blocked, failed };
}

// 알라딘 내부코드(K로 시작)나 자리수가 모자란 값(9자 이하)은 정상 ISBN이 아니므로
// 상세를 수집하지 않는다. 대상에서 영구 제외되도록 detail_updated_at 을 찍어둔다.
// list 크롤 직후에는 ISBN 이 아직 없으므로(null), 빈 값은 스킵하지 않고 상세를 수집한다.
function isSkippableIsbn(isbn) {
  const value = String(isbn ?? "").trim();
  if (!value) {
    return false;
  }
  return value.startsWith("K") || value.length <= 9;
}

async function markDetailSkipped(filter, reason) {
  const collection = await getCollection();
  const now = new Date();

  await collection.updateOne(filter, {
    $set: {
      updated_at: now,
      detail_updated_at: now,
      detail_skipped: true,
      skip_reason: reason,
      skip_checked_at: now
    }
  });
}

async function runDetailLinkClassCommand(linkClass, limit = 5000, skip = 0) {
  if (!linkClass) {
    throw new Error("Usage: node src/index.js detailLinkClass <linkClass> [limit] [skip]");
  }

  const collection = await getCollection();
  const query = {
    linkClass: String(linkClass),
    detail_updated_at: null,
    is_adult: { $ne: true },
    is_private: { $ne: true }
  };
  const targets = await collection.find(
    query,
    {
      projection: {
        _id: 1,
        item_id: 1,
        isbn: 1,
        title: 1,
        url: 1,
        linkClass: 1
      }
    }
  )
  .sort({ pub_date: -1 })   // 내림차순, 오름차순은 1
  .skip(skip)
  .limit(limit)
	.toArray();

  const processed = [];
  const failed = [];
  const skippedBlocked = [];

  let count = 1;
  for (const target of targets) {
    try {
      const n = count++;
      if (isSkippableIsbn(target.isbn)) {
        await markDetailSkipped({ _id: target._id }, "invalid_isbn");
        console.log(linkClass, "item_id:", target.item_id, `: ${n} / ${targets.length} ISBN '${target.isbn ?? ""}' → 스킵(다음에 제외)`);
        skippedBlocked.push({
          item_id: target.item_id ?? null,
          title: target.title ?? "",
          url: target.url ?? "",
          linkClass: target.linkClass ?? null,
          reason: "invalid_isbn"
        });
        continue;
      }
      console.log(linkClass, "item_id:", target.item_id, `: ${n} / ${targets.length}`);
      const payload = await runDetailCommand(target.item_id ?? null, target.url ?? null);
      assertDynamicSections(payload);
      await markDetailUpdated({ _id: target._id });
      processed.push({
        item_id: payload.item.item_id,
        title: payload.item.title,
        url: payload.item.url,
        linkClass: target.linkClass ?? null
      });
    } catch (error) {
      if (error instanceof BlockedDetailError) {
        await markBlockedDetail({ _id: target._id }, error.reason);
        const label = error.reason === "private" ? "비공개 상품" : "성인도서(19세)";
        console.log(linkClass, "item_id:", target.item_id, `: ${label} → ${error.reason} 플래그 후 건너뜀`);
        skippedBlocked.push({
          item_id: target.item_id ?? null,
          title: target.title ?? "",
          url: target.url ?? "",
          linkClass: target.linkClass ?? null,
          reason: error.reason
        });
        continue;
      }
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
    skip,
    limit,
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    skipped_blocked_count: skippedBlocked.length,
    processed,
    failed,
    skipped_blocked: skippedBlocked
  };
}

async function runDetailLinkClassAllCommand(limit = 5000, skip = 0) {
  const collection = await getCollection();
  const targets = await collection.find(
    {
      detail_updated_at: null,
      is_adult: { $ne: true },
      is_private: { $ne: true },
      detail_status: { $ne: "adult_blocked" },
      // 알라딘 출처가 아닌 문서(item_id/url 없음, 예: yes24·orderm)는 상세 수집 대상이 아님
      $or: [
        { item_id: { $exists: true, $nin: [null, ""] } },
        { url: { $exists: true, $nin: [null, ""] } }
      ]
    },
    {
      projection: {
        _id: 1,
        item_id: 1,
        isbn: 1,
        title: 1,
        url: 1,
        linkClass: 1
      }
    }
  )
  .sort({ pub_date: -1 })
  .skip(skip)
  .limit(limit)
  .toArray();

  const processed = [];
  const failed = [];
  const skippedBlocked = [];
  let count = 1;

  for (const target of targets) {
    const n = count++;
    const startedAt = Date.now();
    try {
      if (isSkippableIsbn(target.isbn)) {
        await markDetailSkipped({ _id: target._id }, "invalid_isbn");
        console.log("ALL", "item_id:", target.item_id, `: ${n} / ${targets.length} ISBN '${target.isbn ?? ""}' → 스킵(다음에 제외)`);
        skippedBlocked.push({
          item_id: target.item_id ?? null,
          title: target.title ?? "",
          url: target.url ?? "",
          linkClass: target.linkClass ?? null,
          reason: "invalid_isbn"
        });
        continue;
      }
      const payload = await runDetailCommand(target.item_id ?? null, target.url ?? null);
      assertDynamicSections(payload);
      await markDetailUpdated({ _id: target._id });
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log("ALL", "item_id:", target.item_id, `: ${n} / ${targets.length} (${elapsed}s) ${payload.item.title ?? target.title ?? ""}`);
      processed.push({
        item_id: payload.item.item_id,
        title: payload.item.title,
        url: payload.item.url,
        linkClass: target.linkClass ?? null
      });
    } catch (error) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (error instanceof BlockedDetailError) {
        await markBlockedDetail({ _id: target._id }, error.reason);
        const label = error.reason === "private" ? "비공개 상품" : "성인도서(19세)";
        console.log("ALL", "item_id:", target.item_id, `: ${n} / ${targets.length} ${label} → ${error.reason} 플래그 후 건너뜀 (${elapsed}s) ${target.title ?? ""}`);
        skippedBlocked.push({
          item_id: target.item_id ?? null,
          title: target.title ?? "",
          url: target.url ?? "",
          linkClass: target.linkClass ?? null,
          reason: error.reason
        });
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.log("ALL", "item_id:", target.item_id, `: ${n} / ${targets.length} 실패 → ${message} (${elapsed}s) ${target.title ?? ""}`);
      failed.push({
        item_id: target.item_id ?? null,
        title: target.title ?? "",
        url: target.url ?? "",
        linkClass: target.linkClass ?? null,
        error: message
      });
    }
  }

  return {
    command: "detailLinkClassAll",
    skip,
    limit,
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    skipped_blocked_count: skippedBlocked.length,
    processed,
    failed,
    skipped_blocked: skippedBlocked
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
      detail_updated_at: null,
      is_adult: { $ne: true },
      is_private: { $ne: true }
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

async function runAuthorListCommand(categoryType, alphabet) {
  if (!categoryType || !alphabet) {
    throw new Error("Usage: node src/index.js authorList <categoryType> <alphabet>");
  }

  const payload = await runAuthorAlphabetCommand(categoryType, alphabet);

  return {
    command: "authorList",
    categoryType: payload.categoryType,
    alphabet: payload.alphabet,
    crawledPages: payload.crawledPages,
    maxPage: payload.maxPage,
    saved_count: payload.saved_count,
    db: payload.db,
    pages: payload.pages
  };
}

async function runAuthorAlphabetCommand(categoryType, alphabet, maxPages = Infinity) {
  if (!categoryType || !alphabet) {
    throw new Error("Usage: node src/index.js authorAlphabet <categoryType> <alphabet> [maxPages]");
  }

  const pages = [];
  const db = {
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0
  };
  let savedCount = 0;
  let currentPage = 1;
  let lastMaxPage = 1;

  while (currentPage <= maxPages) {
		console.log(`categoryType: ${categoryType}, alphabet: ${alphabet}, page: ${currentPage} / ${lastMaxPage}`);
    const payload = await fetchAuthorListPage({ categoryType, alphabet, page: currentPage });
    const result = await saveAuthorList(payload.items);

    pages.push({
      page: payload.page,
      saved_count: payload.items.length,
      maxPage: payload.maxPage,
      db: {
        matchedCount: result.matchedCount ?? 0,
        modifiedCount: result.modifiedCount ?? 0,
        upsertedCount: result.upsertedCount ?? 0
      }
    });

    db.matchedCount += result.matchedCount ?? 0;
    db.modifiedCount += result.modifiedCount ?? 0;
    db.upsertedCount += result.upsertedCount ?? 0;
    savedCount += payload.items.length;
    lastMaxPage = payload.maxPage;

    if (payload.items.length === 0 || currentPage >= payload.maxPage) {
      break;
    }

    currentPage += 1;
  }

  return {
    command: "authorAlphabet",
    categoryType: Number(categoryType),
    alphabet: Number(alphabet),
    crawledPages: pages.length,
    maxPage: lastMaxPage,
    saved_count: savedCount,
    db,
    pages
  };
}

async function runAuthorSyncAllCommand(maxPagesPerAlphabet = Infinity, detailBatchLimit = 5000) {
  const summaries = [];
  const db = {
    matchedCount: 0,
    modifiedCount: 0,
    upsertedCount: 0
  };
  let savedCount = 0;

  for (const categoryType of getAuthorCategoryTypes()) {
    for (const alphabet of getAuthorAlphabets()) {
      console.log("authors:list", categoryType, alphabet);
      const payload = await runAuthorAlphabetCommand(categoryType, alphabet, maxPagesPerAlphabet);
      summaries.push(payload);
      db.matchedCount += payload.db.matchedCount ?? 0;
      db.modifiedCount += payload.db.modifiedCount ?? 0;
      db.upsertedCount += payload.db.upsertedCount ?? 0;
      savedCount += payload.saved_count ?? 0;
    }
  }

  const detailBatches = [];
  let detailProcessedCount = 0;
  let detailFailedCount = 0;

  while (true) {
    const detailPayload = await runAuthorDetailCommand(detailBatchLimit, 0);

    if (detailPayload.matched_count === 0) {
      break;
    }

    detailBatches.push({
      matched_count: detailPayload.matched_count,
      processed_count: detailPayload.processed_count,
      failed_count: detailPayload.failed_count
    });
    detailProcessedCount += detailPayload.processed_count ?? 0;
    detailFailedCount += detailPayload.failed_count ?? 0;

    if (detailPayload.processed_count === 0) {
      break;
    }
  }

  return {
    command: "authorSyncAll",
    categoryTypes: getAuthorCategoryTypes(),
    alphabets: getAuthorAlphabets(),
    saved_count: savedCount,
    db,
    groups: summaries,
    details: {
      batchLimit: detailBatchLimit,
      processed_count: detailProcessedCount,
      failed_count: detailFailedCount,
      batches: detailBatches
    }
  };
}

async function runAuthorDetailByIdCommand(authorIdOrUrl) {
  if (!authorIdOrUrl) {
    throw new Error("Usage: node src/index.js authorDetailById <authorId|overviewUrl>");
  }

  const payload = await fetchAuthorDetail(authorIdOrUrl);
  const result = await saveAuthorDetail(payload);

  return {
    command: "authorDetail",
    db: {
      matchedCount: result.matchedCount ?? 0,
      modifiedCount: result.modifiedCount ?? 0,
      upsertedCount: result.upsertedCount ?? 0,
      upsertedId: result.upsertedId ?? null
    },
    author: payload
  };
}

function buildPendingAuthorDetailFilter() {
  return {
    $or: [
      { detail_updated_at: { $exists: false } },
      { detail_updated_at: null }
    ]
  };
}

async function runAuthorDetailCommand(limit = 5000, skip = 0) {
  const collection = await getCollection("authors");
  const targets = await collection.find(
    buildPendingAuthorDetailFilter(),
    {
      projection: {
        _id: 1,
        author_id: 1,
        name: 1,
        overview_url: 1
      }
    }
  )
    .sort({ created_at: 1, author_id: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const processed = [];
  const failed = [];
  let count = 1;

  for (const target of targets) {
    try {
      console.log("authors:detail", target.author_id, `: ${count++} / ${targets.length}`);
      const payload = await runAuthorDetailByIdCommand(target.overview_url || target.author_id);
      processed.push({
        author_id: payload.author.author_id,
        name: payload.author.name
      });
    } catch (error) {
      failed.push({
        author_id: target.author_id ?? null,
        name: target.name ?? "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    command: "authorDetail",
    skip,
    limit,
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    processed,
    failed
  };
}

async function runNlcyListCommand(kdc, page = 1, pageSize = 100) {
  if (!kdc) {
    throw new Error("Usage: node src/index.js nlcyList <kdc> [page] [pageSize]");
  }

  return fetchNlcyList({ kdc, page, pageSize });
}

async function runNlcyCrawlCommand(kdc, pageSize = 100, maxPages = Infinity) {
  if (!kdc) {
    throw new Error("Usage: node src/index.js nlcyCrawl <kdc> [pageSize] [maxPages]");
  }

  return crawlNlcyByKdc(kdc, { pageSize, maxPages });
}

async function runNlcyNewCommand(yyyymm, pageSize = 100, maxPages = Infinity) {
  if (!yyyymm) {
    throw new Error("Usage: node src/index.js nlcyNew <yyyymm> [pageSize] [maxPages]");
  }

  return crawlNlcyNew(yyyymm, { pageSize, maxPages });
}

async function runNlcyDetailCommand(viewKey, viewType = "AH1") {
  if (!viewKey) {
    throw new Error("Usage: node src/index.js nlcyDetail <viewKey> [viewType]");
  }

  const detail = await fetchNlcyDetail({ viewKey, viewType });
  const result = await saveNlcyDetail(detail);

  return {
    command: "nlcyDetail",
    db: {
      matchedCount: result.matchedCount ?? 0,
      modifiedCount: result.modifiedCount ?? 0,
      upsertedCount: result.upsertedCount ?? 0,
      upsertedId: result.upsertedId ?? null
    },
    detail
  };
}

async function runNlcyDetailAllCommand(limit = 5000, skip = 0) {
  const collection = await getCollection("nlcy");
  const targets = await collection.find(
    {
      viewKey: { $exists: true },
      marc_updated_at: { $exists: false }
    },
    {
      projection: {
        _id: 1,
        viewKey: 1,
        viewType: 1,
        title: 1
      }
    }
  )
    .sort({ created_at: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const processed = [];
  const failed = [];
  let count = 1;

  for (const target of targets) {
    try {
      console.log("nlcy:detail", target.viewKey, `: ${count++} / ${targets.length}`);
      const detail = await fetchNlcyDetail({
        viewKey: target.viewKey,
        viewType: target.viewType || "AH1"
      });
      await saveNlcyDetail(detail);
      processed.push({ viewKey: target.viewKey, title: target.title ?? "", tags: detail.tags.length });
    } catch (error) {
      failed.push({
        viewKey: target.viewKey ?? null,
        title: target.title ?? "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    command: "nlcyDetailAll",
    skip,
    limit,
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    processed,
    failed
  };
}

// nl 컬렉션 중 MARC 미수집 건의 상세를 수집한다
async function runNlDetailAllCommand(limit = 5000, skip = 0) {
  const collection = await getNlCollection();
  const targets = await collection.find(
    { viewKey: { $exists: true }, tags: { $exists: false } },
    { projection: { _id: 1, viewKey: 1, viewType: 1, title: 1 } }
  )
    .sort({ created_at: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const processed = [];
  const failed = [];
  let count = 1;

  for (const target of targets) {
    const startedAt = Date.now();
    try {
      const detail = await fetchNlDetail({ viewKey: target.viewKey, viewType: target.viewType || "AH1" });
      await saveNlDetail(detail);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log("nl:detail", target.viewKey, `: ${count++} / ${targets.length} (${elapsed}s) ${target.title ?? ""}`);
      processed.push({ viewKey: target.viewKey, title: target.title ?? "", tags: detail.tags.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log("nl:detail", target.viewKey, `: ${count++} / ${targets.length} 실패 → ${message} ${target.title ?? ""}`);
      failed.push({ viewKey: target.viewKey ?? null, title: target.title ?? "", error: message });
    }
  }

  return {
    command: "nlDetailAll",
    skip,
    limit,
    matched_count: targets.length,
    processed_count: processed.length,
    failed_count: failed.length,
    processed,
    failed
  };
}

async function runRead365Command(isbn) {
  if (!isbn) {
    throw new Error("Usage: node src/index.js read365 <isbn>");
  }

  return fetchCallNumberByIsbn(isbn);
}

async function runKyoboCommand(isbn) {
  if (!isbn) {
    throw new Error("Usage: node src/index.js kyobo <isbn>");
  }

  const result = await crawlKyoboPrice(isbn);
  return { command: "kyobo", ...result };
}

async function runKyoboAllCommand(limit = 5000, skip = 0) {
  const collection = await getCollection();
  const targets = await collection.find(
    {
      isbn: { $exists: true, $nin: [null, ""] },
      kyobo_checked_at: { $exists: false }
    },
    {
      projection: {
        _id: 1,
        isbn: 1,
        title: 1
      }
    }
  )
    .sort({ created_at: 1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const processed = [];
  const notFound = [];
  const failed = [];
  const startedAt = Date.now();
  let rateLimitedMessage = "";
  let done = 0;

  // 교보 검색은 동시에 여러 건을 보내면 서버가 검색을 막으므로 한 건씩 순차로 처리한다.
  for (const target of targets) {
    try {
      const result = await crawlKyoboPrice(target.isbn);

      if (result.found) {
        processed.push({
          isbn: result.isbn,
          title: target.title ?? "",
          price: result.price,
          wholesale_price: result.wholesale_price
        });
      } else {
        notFound.push({ isbn: target.isbn, title: target.title ?? "" });
      }

      console.log("kyobo:price", target.isbn, `: ${++done} / ${targets.length}`, result.found ? "" : "(not found)");
    } catch (error) {
      // 서버가 검색을 제한하면 남은 항목을 계속 두드려봐야 소용없으므로 배치를 멈춘다.
      if (error instanceof KyoboRateLimitError) {
        rateLimitedMessage = error.message;
        console.error("kyobo:price stopped -", error.message);
        break;
      }

      failed.push({
        isbn: target.isbn ?? null,
        title: target.title ?? "",
        error: error instanceof Error ? error.message : String(error)
      });
      console.log("kyobo:price", target.isbn, `: ${++done} / ${targets.length} (error)`);
    }
  }

  const elapsedMs = Date.now() - startedAt;

  return {
    command: "kyoboAll",
    skip,
    limit,
    stopped: rateLimitedMessage || null,
    targetCount: targets.length,
    processedCount: processed.length,
    notFoundCount: notFound.length,
    failedCount: failed.length,
    elapsedMs,
    msPerBook: targets.length > 0 ? Math.round(elapsedMs / targets.length) : 0,
    processed,
    notFound,
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

    const nlcyListMatch = pathname.match(/^\/api\/nlcy_list\/([^/]+)$/);
    if (nlcyListMatch) {
      const kdc = decodeURIComponent(nlcyListMatch[1] ?? "");
      const page = parsePositiveInt(searchParams.get("page") || searchParams.get("pageNum"), 1);
      const pageSize = parsePositiveInt(searchParams.get("pageSize"), 100);
      const payload = await runNlcyListCommand(kdc, page, pageSize);
      sendJson(response, 200, payload);
      return;
    }

    const nlcyCrawlMatch = pathname.match(/^\/api\/nlcy_crawl\/([^/]+)$/);
    if (nlcyCrawlMatch) {
      const kdc = decodeURIComponent(nlcyCrawlMatch[1] ?? "");
      const pageSize = parsePositiveInt(searchParams.get("pageSize"), 100);
      const maxPages = parsePositiveInt(searchParams.get("maxPages"), Infinity);
      const payload = await runNlcyCrawlCommand(kdc, pageSize, maxPages);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/nlcy_detail_all") {
      const limit = parsePositiveInt(searchParams.get("limit"), 5000);
      const skip = parseNonNegativeInt(searchParams.get("skip"), 0);
      const payload = await runNlcyDetailAllCommand(limit, skip);
      sendJson(response, 200, payload);
      return;
    }

    const nlcyNewMatch = pathname.match(/^\/api\/nlcy_new\/([^/]+)$/);
    if (nlcyNewMatch) {
      const yyyymm = decodeURIComponent(nlcyNewMatch[1] ?? "");
      const pageSize = parsePositiveInt(searchParams.get("pageSize"), 100);
      const maxPages = parsePositiveInt(searchParams.get("maxPages"), Infinity);
      const payload = await runNlcyNewCommand(yyyymm, pageSize, maxPages);
      sendJson(response, 200, payload);
      return;
    }

    const nlcyDetailMatch = pathname.match(/^\/api\/nlcy_detail\/([^/]+)$/);
    if (nlcyDetailMatch) {
      const viewKey = decodeURIComponent(nlcyDetailMatch[1] ?? "");
      const viewType = searchParams.get("viewType") || "AH1";
      const payload = await runNlcyDetailCommand(viewKey, viewType);
      sendJson(response, 200, payload);
      return;
    }

    const read365Match = pathname.match(/^\/api\/read365\/([^/]+)$/);
    if (read365Match) {
      const isbn = decodeURIComponent(read365Match[1] ?? "");
      const payload = await runRead365Command(isbn);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/kyobo") {
      const isbn = searchParams.get("isbn");
      const payload = await runKyoboCommand(isbn);
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
      const limit = parsePositiveInt(searchParams.get("limit"), 5000);
      const skip = parseNonNegativeInt(searchParams.get("skip"), 0);
      const payload = await runDetailLinkClassCommand(linkClass, limit, skip);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/detailLinkClassAll") {
      const limit = parsePositiveInt(searchParams.get("limit"), 5000);
      const skip = parseNonNegativeInt(searchParams.get("skip"), 0);
      const payload = await runDetailLinkClassAllCommand(limit, skip);
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

    if (pathname === "/api/authors/list") {
      const categoryType = parsePositiveInt(searchParams.get("categoryType"), 1);
      const alphabet = parsePositiveInt(searchParams.get("alphabet"), 1);
      const payload = await runAuthorListCommand(categoryType, alphabet);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/authors/alphabet") {
      const categoryType = parsePositiveInt(searchParams.get("categoryType"), 1);
      const alphabet = parsePositiveInt(searchParams.get("alphabet"), 1);
      const maxPages = parsePositiveInt(searchParams.get("maxPages"), 10000);
      const payload = await runAuthorAlphabetCommand(categoryType, alphabet, maxPages);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/authors/syncAll") {
      const maxPages = parsePositiveInt(searchParams.get("maxPages"), 10000);
      const detailLimit = parsePositiveInt(searchParams.get("detailLimit"), 5000);
      const payload = await runAuthorSyncAllCommand(maxPages, detailLimit);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/authors/detail") {
      const limit = parsePositiveInt(searchParams.get("count") || searchParams.get("limit"), 5000);
      const skip = parseNonNegativeInt(searchParams.get("skip"), 0);
      const payload = await runAuthorDetailCommand(limit, skip);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/authors/detailPending") {
      const limit = parsePositiveInt(searchParams.get("count") || searchParams.get("limit"), 5000);
      const skip = parseNonNegativeInt(searchParams.get("skip"), 0);
      const payload = await runAuthorDetailCommand(limit, skip);
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === "/api/authors/detailById") {
      const authorId = searchParams.get("authorId");
      const url = searchParams.get("url");
      const payload = await runAuthorDetailByIdCommand(authorId || url);
      sendJson(response, 200, payload);
      return;
    }

    sendJson(response, 404, {
      error: "Not found.",
      routes: ["GET /api/list", "GET /api/listAll", "GET /api/new", "GET /api/detail", "GET /api/nlcy_list/:kdc", "GET /api/nlcy_crawl/:kdc", "GET /api/nlcy_new/:yyyymm", "GET /api/nlcy_detail/:viewKey", "GET /api/nlcy_detail_all", "GET /api/read365/:isbn", "GET /api/detailCategory", "GET /api/detailLinkClass", "GET /api/detailLinkClassAll", "GET /api/listCategory", "GET /api/listCategoryAll", "GET /api/authors/list", "GET /api/authors/alphabet", "GET /api/authors/syncAll", "GET /api/authors/detail", "GET /api/authors/detailPending", "GET /api/authors/detailById"]
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
      routes: ["GET /api/list", "GET /api/listAll", "GET /api/new", "GET /api/detail", "GET /api/nlcy_list/:kdc", "GET /api/nlcy_crawl/:kdc", "GET /api/nlcy_new/:yyyymm", "GET /api/nlcy_detail/:viewKey", "GET /api/nlcy_detail_all", "GET /api/read365/:isbn", "GET /api/detailCategory", "GET /api/detailLinkClass", "GET /api/detailLinkClassAll", "GET /api/listCategory", "GET /api/listCategoryAll", "GET /api/authors/list", "GET /api/authors/alphabet", "GET /api/authors/syncAll", "GET /api/authors/detail", "GET /api/authors/detailPending", "GET /api/authors/detailById"]
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

  if (command === "detailByIsbn") {
    const isbn = process.argv[3];
    const payload = await runDetailByIsbnCommand(isbn);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "detailByItemid") {
    const itemId = process.argv[3];
    if (!itemId) {
      throw new Error("Usage: node src/index.js detailByItemid <itemId>");
    }
    const payload = await runDetailCommand(itemId, null);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  // 국립중앙도서관(nl.go.kr): nlList <kdc> [page] [pageSize] | nlCrawl <kdc|from-to> [pageSize] [maxPages] | nlDetail <viewKey> [--save]
  if (command === "nlList") {
    const items = await fetchNlList({
      kdc: process.argv[3],
      page: parsePositiveInt(process.argv[4], 1),
      pageSize: parsePositiveInt(process.argv[5], 100)
    });
    console.log(JSON.stringify({ command: "nlList", count: items.length, items }, null, 2));
    return;
  }

  if (command === "nlCrawl") {
    const range = String(process.argv[3] ?? "");
    const [from, to = from] = range.split("-");
    if (!/^\d{1,3}$/.test(from) || !/^\d{1,3}$/.test(to)) {
      throw new Error("Usage: node src/index.js nlCrawl <kdc|from-to> [pageSize] [maxPages]  (예: 010 / 000-999)");
    }
    const pageSize = parsePositiveInt(process.argv[4], 100);
    const maxPages = parsePositiveInt(process.argv[5], Infinity);
    const groups = [];
    for (let code = Number(from); code <= Number(to); code += 1) {
      groups.push(await crawlNlKdc(String(code).padStart(3, "0"), { pageSize, maxPages }));
    }
    const saved = groups.reduce((sum, group) => sum + group.saved_count, 0);
    console.log(JSON.stringify({ command: "nlCrawl", range, saved_count: saved, groups }, null, 2));
    return;
  }

  if (command === "nlDetail") {
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
    const detail = await fetchNlDetail({ viewKey: args[0], viewType: args[1] || "AH1" });
    if (process.argv.includes("--save")) {
      await saveNlDetail(detail);
    }
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  // 국립중앙도서관 신착도서: nlNew [YYYYMMDD_YYYYMMDD|all] [pageSize] [maxPages]
  if (command === "nlNew") {
    const arg = process.argv[3];
    const regDate = !arg || arg === "all" ? null : arg;
    if (regDate && !/^\d{8}_\d{8}$/.test(regDate)) {
      throw new Error("Usage: node src/index.js nlNew [YYYYMMDD_YYYYMMDD|all] [pageSize] [maxPages]");
    }
    const payload = await crawlNlNew(regDate, {
      pageSize: parsePositiveInt(process.argv[4], 100),
      maxPages: parsePositiveInt(process.argv[5], Infinity)
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "nlDetailAll") {
    const limit = parsePositiveInt(process.argv[3], 5000);
    const skip = parseNonNegativeInt(process.argv[4], 0);
    const payload = await runNlDetailAllCommand(limit, skip);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "nlcyCrawl") {
    const kdc = process.argv[3];
    const pageSize = parsePositiveInt(process.argv[4], 100);
    const maxPages = parsePositiveInt(process.argv[5], Infinity);
    const payload = await runNlcyCrawlCommand(kdc, pageSize, maxPages);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "nlcyNew") {
    const yyyymm = process.argv[3];
    const pageSize = parsePositiveInt(process.argv[4], 100);
    const maxPages = parsePositiveInt(process.argv[5], Infinity);
    const payload = await runNlcyNewCommand(yyyymm, pageSize, maxPages);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "nlcyDetail") {
    const viewKey = process.argv[3];
    const viewType = process.argv[4] || "AH1";
    const payload = await runNlcyDetailCommand(viewKey, viewType);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "nlcyDetailAll") {
    const limit = parsePositiveInt(process.argv[3], 5000);
    const skip = parseNonNegativeInt(process.argv[4], 0);
    const payload = await runNlcyDetailAllCommand(limit, skip);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "awardLists") {
    const payload = await runAwardListsCommand(process.argv[3]);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "awards") {
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
    const payload = await runAwardsCommand({
      awardType: args[0],
      awardId: args[1],
      maxPages: parsePositiveInt(args[2], Infinity),
      dryRun: process.argv.includes("--dry-run")
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "recommendLists") {
    const lists = await fetchRecommendList();
    console.log(JSON.stringify({ command: "recommendLists", total: lists.length, lists }, null, 2));
    return;
  }

  if (command === "recommends") {
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
    const payload = await runRecommendsCommand({
      cid: args[0] && args[0] !== "all" ? args[0] : null,
      maxPages: parsePositiveInt(args[1], Infinity),
      dryRun: process.argv.includes("--dry-run")
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "kyoboRecommendMenus") {
    const menus = await fetchKyoboRecommendMenus();
    console.log(JSON.stringify({ command: "kyoboRecommendMenus", total: menus.length, menus }, null, 2));
    return;
  }

  if (command === "kyoboRecommends") {
    const args = process.argv.slice(3).filter((arg) => !arg.startsWith("--"));
    const payload = await runKyoboRecommendsCommand({
      menuNum: args[0] && args[0] !== "all" ? args[0] : null,
      maxPages: parsePositiveInt(args[1], Infinity),
      dryRun: process.argv.includes("--dry-run")
    });
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "listDetails") {
    const payload = await runListDetailsCommand(parsePositiveInt(process.argv[3], 1000));
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "read365") {
    const isbn = process.argv[3];
    const payload = await runRead365Command(isbn);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "kyobo") {
    const isbn = process.argv[3];
    const payload = await runKyoboCommand(isbn);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "kyoboAll") {
    const limit = parsePositiveInt(process.argv[3], 5000);
    const skip = parseNonNegativeInt(process.argv[4], 0);
    const payload = await runKyoboAllCommand(limit, skip);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "nlcyList") {
    const kdc = process.argv[3];
    const page = parsePositiveInt(process.argv[4], 1);
    const pageSize = parsePositiveInt(process.argv[5], 100);
    const payload = await runNlcyListCommand(kdc, page, pageSize);
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
    const limit = parsePositiveInt(process.argv[4], 5000);
    const skip = parseNonNegativeInt(process.argv[5], 0);
    const payload = await runDetailLinkClassCommand(linkClass, limit, skip);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "detailLinkClassAll") {
    const limit = parsePositiveInt(process.argv[3], 5000);
    const skip = parseNonNegativeInt(process.argv[4], 0);
    const payload = await runDetailLinkClassAllCommand(limit, skip);
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
    // console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "authorList") {
    const categoryType = parsePositiveInt(process.argv[3], 1);
    const alphabet = parsePositiveInt(process.argv[4], 1);
    const payload = await runAuthorListCommand(categoryType, alphabet);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "authorAlphabet") {
    const categoryType = parsePositiveInt(process.argv[3], 1);
    const alphabet = parsePositiveInt(process.argv[4], 1);
    const maxPages = parsePositiveInt(process.argv[5], 10000);
    const payload = await runAuthorAlphabetCommand(categoryType, alphabet, maxPages);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "authorSyncAll") {
    const maxPages = parsePositiveInt(process.argv[3], 10000);
    const detailLimit = parsePositiveInt(process.argv[4], 5000);
    const payload = await runAuthorSyncAllCommand(maxPages, detailLimit);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "authorDetail") {
    const limit = parsePositiveInt(process.argv[3], 5000);
    const skip = parseNonNegativeInt(process.argv[4], 0);
    const payload = await runAuthorDetailCommand(limit, skip);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "authorDetailPending") {
    const limit = parsePositiveInt(process.argv[3], 5000);
    const skip = parseNonNegativeInt(process.argv[4], 0);
    const payload = await runAuthorDetailCommand(limit, skip);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (command === "authorDetailById") {
    const authorIdOrUrl = process.argv[3];
    const payload = await runAuthorDetailByIdCommand(authorIdOrUrl);
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
      await closeKyoboBrowser();
      await closeMongo();
    }
  });
