import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Creates a Drizzle client. Shared by the app (via client.ts, server-only) and
 * by Node scripts (seed).
 *
 * Supabase pooler note: the *transaction* pooler (port 6543) does not support
 * prepared statements, so `prepare: false` is always set. That is also safe on
 * the session pooler (5432) and direct connections.
 *
 * postgres-js only opens a connection on the first query.
 */
export function createDb(url: string, opts: { max?: number } = {}) {
  const client = postgres(url, { prepare: false, max: opts.max ?? 5 });
  return { db: drizzle({ client, schema }), close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>["db"];
