import mongoose from "mongoose";
import { env } from "../server/config/env";
import { logger } from "../server/config/logger";

/**
 * One cached MongoDB connection for the whole Next.js server process. It lives on `globalThis` so dev hot-reloads
 * reuse it instead of opening a new connection on every edit. Server-side only: never import this in client components.
 */
const g = globalThis as unknown as { __staydeskMongo?: { promise?: Promise<typeof mongoose> } };
const cache = (g.__staydeskMongo ??= {});

/** mongodb://user:pass@host/db -> mongodb://user:***@host/db (never print credentials). */
export function maskMongoUri(uri: string) {
  return uri.replace(/\/\/([^:/@]+):([^@]+)@/, "//$1:***@");
}

export async function dbConnect(uri = env.MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    cache.promise = mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 }).then((m) => {
      logger.info("MongoDB connected");
      return m;
    });
  }
  try {
    return await cache.promise;
  } catch (e) {
    cache.promise = undefined; // allow a later request to retry
    const err = new Error(
      `Could not connect to MongoDB using MONGODB_URI=${maskMongoUri(uri)}\n` +
        `  Reason: ${(e as Error).message.split("\n")[0]}\n` +
        `  Fix: start MongoDB (e.g. "docker compose up -d" or "brew services start mongodb-community"), or set MONGODB_URI in .env.local`,
    );
    err.name = "MongoConnectionError";
    throw err;
  }
}

export async function dbDisconnect() {
  cache.promise = undefined;
  await mongoose.disconnect();
}
