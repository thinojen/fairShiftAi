/**
 * npm run db:migrate — apply the generated SQL migrations in /drizzle.
 * Use the Supabase *session* pooler (port 5432) or a direct connection for this.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { prepare: false, max: 1 });
  try {
    await migrate(drizzle({ client }), { migrationsFolder: "./drizzle" });
    console.log("✓ Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
