"use client";
import { useTransition, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { submitPayQueryAction } from "@/app/payquery-actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type WorkerQueryRow = {
  id: string;
  status: string;
  statusLabel: string;
  shiftLabel: string;
  claimLabel: string;
  note: string | null;
  createdLabel: string;
};

const TONE: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  submitted: "bg-info/10 text-info",
  accepted: "bg-warning/15 text-[oklch(0.45_0.11_70)]",
  resolved: "bg-accent text-accent-foreground",
  rejected: "bg-destructive/10 text-destructive",
};

export function PayQueryList({ rows }: { rows: WorkerQueryRow[] }) {
  if (!rows.length) return <p className="text-muted-foreground text-sm">No pay queries. If a time looks wrong, ask the assistant.</p>;
  return (
    <ul className="-my-2 divide-y">
      {rows.map((q) => (
        <QueryRow key={q.id} q={q} />
      ))}
    </ul>
  );
}

function QueryRow({ q }: { q: WorkerQueryRow }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{q.shiftLabel}</p>
        <p className="text-muted-foreground text-xs">{q.claimLabel} · raised {q.createdLabel}</p>
        {q.note && <p className="text-muted-foreground mt-1 text-xs">Manager: &ldquo;{q.note}&rdquo;</p>}
      </div>
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE[q.status])}>{q.statusLabel}</span>
      {q.status === "draft" && (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await submitPayQueryAction(q.id);
              if (r && !r.ok) setErr(r.message);
            })
          }
        >
          {pending ? <Loader2 className="animate-spin" /> : <Send />} Send to manager
        </Button>
      )}
      {err && <p className="text-destructive w-full text-xs">{err}</p>}
    </li>
  );
}
