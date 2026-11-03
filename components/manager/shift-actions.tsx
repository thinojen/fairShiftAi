"use client";
import { useActionState, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, LockOpen, RefreshCw, Send } from "lucide-react";
import {
  approvePayoutAction,
  correctHoursAction,
  refreshStatusAction,
  reopenShiftAction,
  saveAllocationAction,
  type ActionResult,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ActionMessage({ result }: { result: ActionResult }) {
  if (!result) return null;
  const tone = result.tone ?? (result.ok ? "success" : "error");
  const Icon = tone === "success" ? CheckCircle2 : AlertTriangle;
  return (
    <p
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-sm",
        tone === "success" && "bg-accent text-accent-foreground",
        tone === "warning" && "bg-warning/15 text-foreground",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <span>{result.message}</span>
    </p>
  );
}

export function SaveAllocationForm({ shiftId, disabled }: { shiftId: string; disabled: boolean }) {
  const [state, action, pending] = useActionState(saveAllocationAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="shiftId" value={shiftId} />
      <Button type="submit" disabled={disabled || pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Lock />}
        Save &amp; lock allocation
      </Button>
      <ActionMessage result={state} />
    </form>
  );
}

export function ReopenForm({ shiftId }: { shiftId: string }) {
  const [state, action, pending] = useActionState(reopenShiftAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="shiftId" value={shiftId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        <LockOpen />
        Unlock to edit
      </Button>
      <ActionMessage result={state} />
    </form>
  );
}

export function ApprovePayoutForm({
  shiftId,
  totalLabel,
  recipients,
  retry,
  enabled,
  disabledReason,
}: {
  shiftId: string;
  totalLabel: string;
  recipients: number;
  retry: boolean;
  enabled: boolean;
  disabledReason?: string;
}) {
  const [state, action, pending] = useActionState(approvePayoutAction, null);
  if (!enabled) {
    return (
      <div className="bg-muted text-muted-foreground rounded-lg p-3 text-sm">
        <p className="text-foreground font-medium">Sandbox payouts are switched off here</p>
        <p className="mt-1">{disabledReason} You can still review hours and save allocations.</p>
      </div>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="shiftId" value={shiftId} />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="confirmReviewed" required className="accent-primary mt-0.5 size-4" />
        <span>
          I have reviewed the allocation. {retry ? "Retry" : "Send"} <strong>{totalLabel}</strong> to {recipients} worker
          {recipients === 1 ? "" : "s"} via PayPal <strong>sandbox</strong>.
        </span>
      </label>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="approvalCode" className="text-sm font-medium">
          Manager approval code
        </label>
        <input
          id="approvalCode"
          name="approvalCode"
          type="password"
          autoComplete="off"
          required
          className="border-input focus-visible:ring-ring/50 h-9 rounded-md border px-3 text-sm outline-none focus-visible:ring-[3px]"
        />
        <p className="text-muted-foreground text-xs">Checked on the server. Limited attempts.</p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <Send />}
        {retry ? "Retry with the same batch ID" : "Approve & pay"}
      </Button>
      <ActionMessage result={state} />
    </form>
  );
}

export function RefreshStatusForm({ shiftId }: { shiftId: string }) {
  const [state, action, pending] = useActionState(refreshStatusAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="shiftId" value={shiftId} />
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Refresh status from PayPal
      </Button>
      <ActionMessage result={state} />
    </form>
  );
}

export function CorrectionForm({
  assignmentId,
  workerName,
  defaults,
}: {
  assignmentId: string;
  workerName: string;
  defaults: { clock_in: string; clock_out: string; break_minutes: string };
}) {
  const [state, action, pending] = useActionState(correctHoursAction, null);
  const [field, setField] = useState<"clock_out" | "clock_in" | "break_minutes">("clock_out");
  return (
    <form action={action} className="bg-muted/60 mt-3 flex flex-col gap-3 rounded-lg border p-3">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <p className="text-sm font-medium">Correct {workerName}&rsquo;s hours</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Field
          <select
            name="field"
            value={field}
            onChange={(e) => setField(e.target.value as typeof field)}
            className="border-input h-9 rounded-md border bg-white px-2 text-sm font-normal"
          >
            <option value="clock_out">Clock-out</option>
            <option value="clock_in">Clock-in</option>
            <option value="break_minutes">Break (minutes)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          New value {field !== "break_minutes" && <span className="text-muted-foreground font-normal">(UK time)</span>}
          <input
            key={field}
            name="value"
            type={field === "break_minutes" ? "number" : "datetime-local"}
            min={field === "break_minutes" ? 0 : undefined}
            max={field === "break_minutes" ? 600 : undefined}
            defaultValue={defaults[field]}
            required
            className="border-input h-9 rounded-md border bg-white px-2 text-sm font-normal"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Reason (kept in the audit trail)
        <input
          name="reason"
          required
          minLength={5}
          maxLength={500}
          placeholder="e.g. No clock-out recorded; set to scheduled end per rota"
          className="border-input h-9 rounded-md border bg-white px-2 text-sm font-normal"
        />
      </label>
      <Button type="submit" size="sm" disabled={pending} className="self-start">
        {pending && <Loader2 className="animate-spin" />}
        Record correction
      </Button>
      <ActionMessage result={state} />
    </form>
  );
}
