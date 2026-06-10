import { getCollection } from "./db.js";

const AUTHORS_COLLECTION = "authors";

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)
  );
}

function buildFilter(author) {
  return {
    author_id: String(author.author_id)
  };
}

function buildBaseFields(author) {
  return compactObject({
    author_id: String(author.author_id),
    image_url: author.image_url ?? "",
    name: author.name ?? "",
    name_original: author.name_original ?? "",
    works: Array.isArray(author.works) ? author.works : [],
    overview_url: author.overview_url ?? "",
    category_type: author.category_type,
    alphabet: author.alphabet
  });
}

function buildDetailFields(author) {
  return compactObject({
    ...buildBaseFields(author),
    categories: Array.isArray(author.categories) ? author.categories : [],
    nationality: author.nationality ?? "",
    birth: author.birth ?? "",
    death: author.death ?? "",
    job: author.job ?? "",
    family: author.family ?? "",
    introduction: author.introduction ?? "",
    etc: author.etc ?? {}
  });
}

export async function saveAuthorList(items) {
  const collection = await getCollection(AUTHORS_COLLECTION);
  const now = new Date();
  const operations = [];

  for (const author of items) {
    operations.push({
      updateOne: {
        filter: buildFilter(author),
        update: {
          $set: {
            ...buildBaseFields(author),
            updated_at: now,
            list_updated_at: now
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
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  const result = await collection.bulkWrite(operations, { ordered: false });
  return {
    matchedCount: result.matchedCount ?? 0,
    modifiedCount: result.modifiedCount ?? 0,
    upsertedCount: result.upsertedCount ?? 0
  };
}

export async function saveAuthorDetail(author) {
  const collection = await getCollection(AUTHORS_COLLECTION);
  const now = new Date();

  return collection.updateOne(
    buildFilter(author),
    {
      $set: {
        ...buildDetailFields(author),
        updated_at: now,
        detail_updated_at: now
      },
      $setOnInsert: {
        created_at: now
      }
    },
    { upsert: true }
  );
}
