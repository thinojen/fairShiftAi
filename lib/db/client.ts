import "server-only";
import { createDb, type Db } from "./connect";

let cached: Db | undefined;

/** App-side database handle (server components / route handlers only). */
export function getDb(): Db {
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const max = Number(process.env.DATABASE_POOL_MAX);
    cached = createDb(url, { max: Number.isSafeInteger(max) && max > 0 ? Math.min(max, 20) : 5 }).db;
  }
  return cached;
}
