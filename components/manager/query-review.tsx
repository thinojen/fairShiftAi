"use client";
import { useActionState } from "react";
import { Check, CheckCheck, Loader2, X } from "lucide-react";
import { reviewPayQueryAction } from "@/app/payquery-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function QueryReviewForm({ queryId, status }: { queryId: string; status: string }) {
  const [state, action, pending] = useActionState(reviewPayQueryAction, null);
  if (status !== "submitted" && status !== "accepted") {
    // Keep the confirmation visible after the final transition.
    return state ? <p className={cn("text-xs", state.ok ? "text-accent-foreground" : "text-destructive")}>{state.message}</p> : null;
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="queryId" value={queryId} />
      <label className="text-xs font-medium">
        Note to the worker {status === "accepted" ? "(required to resolve)" : "(required to reject)"}
        <textarea name="note" rows={2} maxLength={1000} className="border-input mt-1 w-full rounded-md border bg-white px-2 py-1.5 text-sm font-normal" />
      </label>
      <div className="flex flex-wrap gap-2">
        {status === "submitted" && (
          <>
            <Button size="sm" name="to" value="accepted" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <Check />} Accept
            </Button>
            <Button size="sm" variant="outline" name="to" value="rejected" disabled={pending}>
              <X /> Not upheld
            </Button>
          </>
        )}
        {status === "accepted" && (
          <Button size="sm" name="to" value="resolved" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <CheckCheck />} Mark resolved
          </Button>
        )}
      </div>
      {state && <p className={cn("text-xs", state.ok ? "text-accent-foreground" : "text-destructive")}>{state.message}</p>}
    </form>
  );
}
