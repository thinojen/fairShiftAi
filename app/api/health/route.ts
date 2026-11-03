/**
 * GET /api/health — liveness check for Render. Does not touch the database or
 * PayPal, and reveals no configuration beyond whether payouts are enabled.
 */
import { connection } from "next/server";

export async function GET() {
  await connection(); // evaluate per request, not at build time
  return Response.json({
    ok: true,
    service: "fairshift-ai",
    payoutsEnabled: process.env.PAYOUTS_ENABLED === "true",
  });
}
