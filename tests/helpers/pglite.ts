/**
 * In-process Postgres (PGlite, WebAssembly) with the REAL generated migrations
 * and the REAL demo seed. No external database or credentials needed.
 *
 * Passing tests here prove our SQL, constraints and migrations are valid
 * Postgres — not that the live Supabase database is configured correctly.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "@/lib/db/connect";
import * as schema from "@/lib/db/schema";
import { seedDemo } from "@/lib/db/seed";

export const TEST_RECIPIENTS = [
  "sam-sb@personal.example.com",
  "priya-sb@personal.example.com",
  "jordan-sb@personal.example.com",
  "alex-sb@personal.example.com",
  "casey-sb@personal.example.com",
];

export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle({ client, schema }) as unknown as Db;
  await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
  await seedDemo(db, { recipientsCsv: TEST_RECIPIENTS.join(",") });
  return { db, close: () => client.close() };
}
