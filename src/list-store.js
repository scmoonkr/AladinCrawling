// 책 목록(수상 · 추천 · 베스트셀러 …) 저장
//
//   book_lists       목록 정의   — source + sourceKey 로 유일 (예: aladin / award:2:22)
//   book_list_items  목록의 책   — listId + itemId 로 유일. 연도 · 표기 · 순서
//
// 여기서는 수집한 그대로만 저장한다. global_books 연결(bookId)과 배지 계산은
// KRIN 서버의 `npm run link:book-lists` 가 한다 — 그래서 bookId 는 새로 넣을 때 null 이고, 다시 수집해도 덮어쓰지 않는다.
import { getCollection } from "./db.js";

let indexesReady = false;

async function ensureIndexes() {
  if (indexesReady) return;
  const lists = await getCollection("book_lists");
  const items = await getCollection("book_list_items");
  await lists.createIndex({ source: 1, sourceKey: 1 }, { unique: true });
  await lists.createIndex({ type: 1, name: 1 });
  await items.createIndex({ listId: 1, itemId: 1 }, { unique: true });
  await items.createIndex({ listId: 1, year: -1, rank: 1 });
  await items.createIndex({ bookId: 1 });
  await items.createIndex({ itemId: 1 });
  indexesReady = true;
}

// 수상 목록 1개 + 책들 저장 → { listId, upserted, modified }
export async function saveAwardList(award, items) {
  await ensureIndexes();
  const lists = await getCollection("book_lists");
  const listItems = await getCollection("book_list_items");
  const now = new Date();
  const sourceKey = `award:${award.awardType}:${award.awardId}`;

  const list = await lists.findOneAndUpdate(
    { source: "aladin", sourceKey },
    {
      $set: {
        type: "AWARD",
        scope: "PLATFORM",
        libraryId: null,
        name: award.name,
        groupName: award.groupName,
        audience: award.audience,
        organization: null,
        sourceUrl: award.url,
        crawledAt: now,
        updatedAt: now
      },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true, returnDocument: "after" }
  );
  const listId = list._id;

  if (items.length === 0) {
    await lists.updateOne({ _id: listId }, { $set: { itemCount: await listItems.countDocuments({ listId }) } });
    return { listId, upserted: 0, modified: 0 };
  }

  const result = await listItems.bulkWrite(
    items.map((item) => ({
      updateOne: {
        filter: { listId, itemId: item.itemId },
        update: {
          $set: {
            title: item.title,
            subtitle: item.subtitle ?? "",
            author: item.author ?? "",
            publisher: item.publisher ?? "",
            pubDate: item.pubDate ?? "",
            imageUrl: item.imageUrl ?? "",
            year: item.year,
            round: item.round ?? null,
            division: item.division ?? "",
            label: item.label,
            rank: item.rank,
            source: "aladin",
            crawledAt: now
          },
          // 연결 정보는 KRIN 쪽이 채운다 — 다시 수집해도 지우지 않는다
          $setOnInsert: { bookId: null, isbn: null, createdAt: now }
        },
        upsert: true
      }
    })),
    { ordered: false }
  );

  await lists.updateOne({ _id: listId }, { $set: { itemCount: await listItems.countDocuments({ listId }) } });
  return { listId, upserted: result.upsertedCount ?? 0, modified: result.modifiedCount ?? 0 };
}

// 목록에 있지만 books 에 상세가 없는 책의 itemId (목록에 많이 오른 책부터)
export async function findListItemsWithoutBook(limit = 1000) {
  await ensureIndexes();
  const listItems = await getCollection("book_list_items");
  return listItems
    .aggregate([
      { $match: { source: "aladin", bookId: null } },
      { $group: { _id: "$itemId", lists: { $sum: 1 }, title: { $first: "$title" } } },
      // item_id 는 문자열로 저장된다 (store.js buildFilter)
      { $lookup: { from: "books", localField: "_id", foreignField: "item_id", as: "book" } },
      // 상세가 이미 있거나, 성인·비공개로 수집할 수 없다고 표시된 책은 뺀다
      { $match: { "book.detail_updated_at": { $exists: false }, "book.blocked_reason": { $exists: false } } },
      { $sort: { lists: -1, _id: 1 } },
      { $limit: limit },
      { $project: { _id: 0, itemId: "$_id", title: 1, lists: 1 } }
    ])
    .toArray();
}
