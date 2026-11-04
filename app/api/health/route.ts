/**
 * GET /api/health — liveness check for Render. Does not touch the database,
 * PayPal or the AI provider. Reports which settings the server actually read,
 * never secrets: no keys, no database URL, no approval code.
 */
import { connection } from "next/server";
import { healthReport } from "@/lib/health";

export async function GET() {
  await connection(); // evaluate per request, not at build time
  return Response.json(healthReport());
}
