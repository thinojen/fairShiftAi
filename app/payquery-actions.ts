"use server";
/**
 * Pay query actions. Every one is an explicit human click:
 *   worker: Create draft → Send to manager
 *   manager: Accept / Reject / Mark resolved
 * None of them change hours, allocations or payments.
 */
import { refresh } from "next/cache";
import { getDb } from "@/lib/db/client";
import { getDemoRole } from "@/lib/demo/role";
import { createPayQueryDraft, PayQueryError, reviewPayQuery, submitPayQuery, type PayQueryField } from "@/lib/payqueries/commands";

export type PayQueryActionResult = { ok: boolean; message: string; queryId?: string } | null;

function fail(err: unknown): PayQueryActionResult {
  if (err instanceof PayQueryError) return { ok: false, message: err.message };
  console.error(err);
  return { ok: false, message: "Something went wrong. Nothing was changed." };
}

/** The worker's intent from the proposal card. Values and evidence are recomputed on the server. */
export type DraftIntent = {
  shiftAssignmentId: string;
  field: PayQueryField;
  adjustMinutes: number | null;
  claimedTime: string | null;
  claimedIso: string | null;
  claimedBreakMinutes: number | null;
  workerStatement: string;
  aiSummary: string | null;
};

export async function createPayQueryDraftAction(intent: DraftIntent): Promise<PayQueryActionResult> {
  const role = await getDemoRole();
  if (role.kind !== "worker") return { ok: false, message: "Switch to a worker view to raise a pay query." };
  try {
    const q = await createPayQueryDraft(getDb(), role.workerId, {
      shiftAssignmentId: String(intent.shiftAssignmentId),
      field: intent.field,
      adjustMinutes: typeof intent.adjustMinutes === "number" ? intent.adjustMinutes : null,
      claimedTime: typeof intent.claimedTime === "string" ? intent.claimedTime : null,
      claimedIso: typeof intent.claimedIso === "string" ? intent.claimedIso : null,
      claimedBreakMinutes: typeof intent.claimedBreakMinutes === "number" ? intent.claimedBreakMinutes : null,
      workerStatement: String(intent.workerStatement ?? ""),
      aiSummary: typeof intent.aiSummary === "string" ? intent.aiSummary : null,
    });
    refresh();
    return { ok: true, message: "Draft saved. It's private until you send it to your manager.", queryId: q.id };
  } catch (err) {
    return fail(err);
  }
}

export async function submitPayQueryAction(queryId: string): Promise<PayQueryActionResult> {
  const role = await getDemoRole();
  if (role.kind !== "worker") return { ok: false, message: "Switch to a worker view." };
  try {
    await submitPayQuery(getDb(), role.workerId, String(queryId));
    refresh();
    return { ok: true, message: "Sent to your manager." };
  } catch (err) {
    return fail(err);
  }
}

export async function reviewPayQueryAction(_prev: PayQueryActionResult, formData: FormData): Promise<PayQueryActionResult> {
  const role = await getDemoRole();
  if (role.kind !== "manager") return { ok: false, message: "Switch to the Manager view to review queries." };
  const to = String(formData.get("to"));
  if (to !== "accepted" && to !== "rejected" && to !== "resolved") return { ok: false, message: "Unknown action." };
  try {
    await reviewPayQuery(getDb(), String(formData.get("queryId")), to, "demo-manager", String(formData.get("note") ?? ""));
    refresh();
    return { ok: true, message: to === "accepted" ? "Accepted. Correct the records through the shift page if needed." : to === "rejected" ? "Marked as not upheld." : "Marked resolved." };
  } catch (err) {
    return fail(err);
  }
}
