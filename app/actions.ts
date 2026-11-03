"use server";
/**
 * Server Actions. Every action re-checks on the server; nothing trusts the client.
 *
 * Two layers, deliberately separate:
 *  - The DEMO role cookie decides which views and edit controls are shown.
 *    It is not authentication.
 *  - Payouts additionally require PAYOUTS_ENABLED, MANAGER_APPROVAL_CODE and a
 *    correct code within the rate limit — regardless of the cookie.
 */
import { refresh } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { DEMO_ROLES, getDemoRole, ROLE_COOKIE } from "@/lib/demo/role";
import { fromLondonLocalInput } from "@/lib/format";
import { authorisePayout } from "@/lib/payouts/approval";
import { paypalGateway } from "@/lib/payouts/gateway";
import { PayoutError, refreshShiftPayoutStatus, requestShiftPayout } from "@/lib/payouts/service";
import { assertPayoutAllowed, getPayPal, PayPalApiError } from "@/lib/paypal/server";
import { correctAssignmentTime, reopenShift, saveAllocation, ShiftCommandError } from "@/lib/shifts/commands";

export type ActionResult = { ok: boolean; message: string; tone?: "success" | "warning" | "error" } | null;

const MANAGER_ACTOR = "demo-manager";

async function managerOnly(): Promise<ActionResult | null> {
  const role = await getDemoRole();
  if (role.kind !== "manager") return { ok: false, tone: "error", message: "Switch to the Manager view to do this." };
  return null;
}

function failure(err: unknown): ActionResult {
  if (err instanceof ShiftCommandError || err instanceof PayoutError) return { ok: false, tone: "error", message: err.message };
  if (err instanceof PayPalApiError) return { ok: false, tone: "error", message: `PayPal error ${err.status}. debug_id=${err.debugId ?? "n/a"}` };
  console.error(err);
  return { ok: false, tone: "error", message: "Something went wrong. Nothing was paid." };
}

export async function switchRoleAction(formData: FormData) {
  const value = String(formData.get("role") ?? "manager");
  if (!DEMO_ROLES.some((r) => r.value === value)) return;
  (await cookies()).set(ROLE_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production" });
  redirect(value === "manager" ? "/manager" : "/worker");
}

export async function correctHoursAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const denied = await managerOnly();
  if (denied) return denied;
  try {
    const field = String(formData.get("field")) as "clock_in" | "clock_out" | "break_minutes";
    if (!["clock_in", "clock_out", "break_minutes"].includes(field)) throw new ShiftCommandError("Unknown field");
    const raw = String(formData.get("value") ?? "");
    const value = field === "break_minutes" ? raw : fromLondonLocalInput(raw).toISOString();
    await correctAssignmentTime(getDb(), {
      assignmentId: String(formData.get("assignmentId")),
      field,
      value,
      reason: String(formData.get("reason") ?? ""),
      actor: MANAGER_ACTOR,
    });
    refresh();
    return { ok: true, tone: "success", message: "Correction recorded. The original value is kept as evidence." };
  } catch (err) {
    if (err instanceof Error && /YYYY|does not exist/.test(err.message)) return { ok: false, tone: "error", message: err.message };
    return failure(err);
  }
}

export async function saveAllocationAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const denied = await managerOnly();
  if (denied) return denied;
  try {
    await saveAllocation(getDb(), String(formData.get("shiftId")), MANAGER_ACTOR);
    refresh();
    return { ok: true, tone: "success", message: "Allocation saved and locked. Review it, then approve the payout." };
  } catch (err) {
    return failure(err);
  }
}

export async function reopenShiftAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const denied = await managerOnly();
  if (denied) return denied;
  try {
    await reopenShift(getDb(), String(formData.get("shiftId")), MANAGER_ACTOR);
    refresh();
    return { ok: true, tone: "success", message: "Allocation unlocked." };
  } catch (err) {
    return failure(err);
  }
}

async function clientKey() {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
}

export async function approvePayoutAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const denied = await managerOnly();
  if (denied) return denied;

  // The role check above only decides which UI is allowed to ask. Authorisation
  // itself ignores the role entirely — see authorisePayout().
  const auth = authorisePayout({
    approvalCode: String(formData.get("approvalCode") ?? ""),
    confirmedReviewed: formData.get("confirmReviewed") === "on",
    clientKey: await clientKey(),
  });
  if (!auth.authorised) return { ok: false, tone: auth.tone, message: auth.message };

  try {
    const { client, cfg } = getPayPal();
    const out = await requestShiftPayout(getDb(), paypalGateway(client, cfg), {
      shiftId: String(formData.get("shiftId")),
      actor: MANAGER_ACTOR,
      validate: (id, items) => assertPayoutAllowed(cfg, id, items),
    });
    refresh();
    switch (out.kind) {
      case "accepted":
        return {
          ok: true,
          tone: "success",
          message: `PayPal accepted the batch (${out.paypalBatchId}). Workers are not paid until their item shows Paid — use Refresh status.`,
        };
      case "uncertain":
        return { ok: false, tone: "warning", message: out.message };
      default:
        return { ok: false, tone: "error", message: out.message };
    }
  } catch (err) {
    return failure(err);
  }
}

export async function refreshStatusAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const denied = await managerOnly();
  if (denied) return denied;
  try {
    const { client, cfg } = getPayPal();
    const r = await refreshShiftPayoutStatus(getDb(), paypalGateway(client, cfg), {
      shiftId: String(formData.get("shiftId")),
      actor: MANAGER_ACTOR,
    });
    refresh();
    return {
      ok: true,
      tone: r.allPaid ? "success" : "warning",
      message: r.allPaid
        ? "Every worker's payout has succeeded."
        : `Status updated from PayPal (${r.changed} change${r.changed === 1 ? "" : "s"}). Not everyone is paid yet.`,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "PayPalConfigError") {
      return { ok: false, tone: "warning", message: "PayPal is not configured in this environment." };
    }
    return failure(err);
  }
}
