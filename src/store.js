import { getCollection } from "./db.js";

function extractItemId(url) {
  return String(url ?? "").match(/[?&]ItemId=(\d+)/)?.[1] ?? null;
}

function buildFilter(book) {
  const itemId = book.item_id ?? extractItemId(book.url);

  if (itemId) {
    return { item_id: String(itemId) };
  }

  if (book.isbn) {
    return { isbn: book.isbn };
  }

  return { url: book.url };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)
  );
}

function buildBaseFields(book) {
  return compactObject({
    item_id: book.item_id ?? extractItemId(book.url),
    isbn: book.isbn ?? null,
    url: book.url,
    title: book.title,
    subtitle: book.subtitle ?? "",
    author: book.author,
    publisher: book.publisher,
    pub_date: book.pub_date,
    image_url: book.image_url ?? "",
    price: book.price ?? null,
    sale_price: book.sale_price ?? null,
    linkClass: book.linkClass ?? null,
    categories: Array.isArray(book.categories) ? book.categories : []
  });
}

function buildDetailFields(book) {
  return compactObject({
    ...buildBaseFields(book),
    series_name: book.series_name ?? null,
    title_original: book.title_original ?? null,
    page: book.page ?? null,
    size: book.size ?? "",
    weight: book.weight ?? "",
    categories: Array.isArray(book.categories) ? book.categories : [],
    book_review: book.book_review ?? "",
    index: book.index ?? "",
    inside: book.inside ?? "",
    author_detail: Array.isArray(book.author_detail) ? book.author_detail : [],
    publisher_review: book.publisher_review ?? { images: [], review: "" }
  });
}

export async function saveBookList(items) {
  const collection = await getCollection();
  const now = new Date();
  const operations = [];
  let skippedCount = 0;

  for (const book of items) {
    const filter = buildFilter(book);
    const existing = await collection.findOne(filter, {
      projection: { _id: 1, detail_updated_at: 1 }
    });

    if (existing?.detail_updated_at) {
      skippedCount += 1;
      continue;
    }

    operations.push({
      updateOne: {
        filter,
        update: {
          $set: {
            ...buildBaseFields(book),
            updated_at: now,
            booklist_updated_at: now
          },
          $unset: {
            booklist: "",
            book_detail: ""
          },
          $setOnInsert: {
            created_at: now
          }
        },
        upsert: true
      }
    });
  }

  if (operations.length === 0) {
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, skippedCount };
  }

  const result = await collection.bulkWrite(operations, { ordered: false });
  return {
    matchedCount: result.matchedCount ?? 0,
    modifiedCount: result.modifiedCount ?? 0,
    upsertedCount: result.upsertedCount ?? 0,
    skippedCount
  };
}

export async function saveBookDetail(book) {
  const collection = await getCollection();
  const now = new Date();

  return collection.updateOne(
    buildFilter(book),
    {
      $set: {
        ...buildDetailFields(book),
        updated_at: now,
        detail_updated_at: now
      },
      $unset: {
        booklist: "",
        book_detail: ""
      },
      $setOnInsert: {
        created_at: now
      }
    },
    { upsert: true }
  );
}
