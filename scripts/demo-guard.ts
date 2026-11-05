/** Runs before `npm run demo:app`: the demo server may only use the local database. */
import { assertLocalDatabase, DemoEnvError } from "../lib/demo/sandbox";
try {
  assertLocalDatabase(process.env.DATABASE_URL);
  console.log("✓ Demo app will use the LOCAL database only.");
} catch (e) {
  console.error(`✗ ${e instanceof DemoEnvError ? e.message : "Database check failed"}`);
  process.exit(1);
}
