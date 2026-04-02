import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const DATABASE_NAME = "Reading";
const COLLECTION_NAME = "books";

function buildMongoUri() {
  const addr = String(process.env.MONGODB_ADDR ?? "").trim();
  const username = String(process.env.MONGO_USERNAME ?? "").trim();
  const password = String(process.env.MONGO_PWD ?? "").trim();

  if (!addr) {
    throw new Error("MONGODB_ADDR is required.");
  }

  if (addr.startsWith("mongodb://") || addr.startsWith("mongodb+srv://")) {
    return addr;
  }

  if (username && password) {
    return `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${addr}/?authSource=admin`;
  }

  return `mongodb://${addr}`;
}

let clientPromise;

export async function getCollection() {
  if (!clientPromise) {
    clientPromise = MongoClient.connect(buildMongoUri());
  }

  const client = await clientPromise;
  return client.db(DATABASE_NAME).collection(COLLECTION_NAME);
}

export async function closeMongo() {
  if (!clientPromise) {
    return;
  }

  const client = await clientPromise;
  await client.close();
  clientPromise = null;
}
