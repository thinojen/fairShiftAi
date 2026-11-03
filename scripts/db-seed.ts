/**
 * npm run db:seed — wipe and reseed synthetic demo data. Never touches PayPal.
 */
import "dotenv/config";
import { createDb } from "../lib/db/connect";
import { seedDemo } from "../lib/db/seed";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url, { max: 1 });
  try {
    await seedDemo(db, { recipientsCsv: process.env.PAYPAL_SANDBOX_RECIPIENTS });
    console.log("✓ Demo data seeded (synthetic). No PayPal calls were made.");
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error("✗ Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
