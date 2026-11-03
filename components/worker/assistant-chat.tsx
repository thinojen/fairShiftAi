"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowUp, BadgeCheck, FileText, Loader2, Send, ShieldCheck, Sparkles } from "lucide-react";
import { createPayQueryDraftAction, submitPayQueryAction } from "@/app/payquery-actions";
import { Button } from "@/components/ui/button";
import type { PayQueryProposal } from "@/lib/payqueries/commands";
import type { EvidenceCard, Segment } from "@/lib/assistant/validate";
import { cn } from "@/lib/utils";
import { RichAnswer } from "./rich-text";

type AssistantPayload = {
  segments: Segment[];
  evidence: EvidenceCard[];
  proposal: PayQueryProposal | null;
  offerPayQuery: boolean;
  toolCalls: Array<{ name: string; ok: boolean }>;
  verified: boolean;
  fallback: boolean;
};

type Msg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; payload: AssistantPayload }
  | { id: number; role: "error"; text: string };

export const SUGGESTED = [
  "Why were my tips lower last Friday?",
  "How was my share calculated?",
  "What tipping policy applied?",
  "Have I been paid?",
  "I think my hours are wrong.",
];

const TOOL_LABEL: Record<string, string> = {
  get_worker_shifts: "Your shifts",
  get_tip_pool: "Tip pool",
  get_policy: "Tipping policy",
  get_allocation_breakdown: "Share breakdown",
  get_payout_status: "PayPal status",
  compare_periods: "Shift comparison",
  create_pay_query: "Pay query draft",
};

function plainText(p: AssistantPayload) {
  return p.segments.map((s) => (s.type === "text" ? s.text : s.display)).join("");
}

export function AssistantChat({ firstName, enabled, disabledReason }: { firstName: string; enabled: boolean; disabledReason?: string }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const idRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, busy]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    const history = messages
      .filter((m) => m.role !== "error")
      .map((m) => (m.role === "user" ? { role: "user" as const, content: m.text } : { role: "assistant" as const, content: plainText((m as Extract<Msg, { role: "assistant" }>).payload) }));
    setMessages((m) => [...m, { id: ++idRef.current, role: "user", text: q }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, history }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
      setMessages((m) => [...m, { id: ++idRef.current, role: "assistant", payload: data as AssistantPayload }]);
    } catch (e) {
      setMessages((m) => [...m, { id: ++idRef.current, role: "error", text: e instanceof Error ? e.message : "Something went wrong." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="FairShift assistant" className="bg-card flex min-h-[560px] flex-col overflow-hidden rounded-2xl border shadow-sm lg:h-[calc(100vh-7rem)]">
      <header className="bg-sidebar flex items-center gap-3 px-5 py-4 text-white">
        <span className="bg-primary flex size-9 items-center justify-center rounded-xl">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Ask about your tips</h2>
          <p className="text-sidebar-foreground/80 truncate text-xs">Checks your real records · every amount is verified</p>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-4">
            <div className="bg-muted/70 rounded-2xl rounded-tl-sm p-4 text-sm leading-relaxed">
              Hi {firstName} 👋 I can explain how your tips were worked out, compare shifts, check whether you&rsquo;ve been paid, and help you raise a query
              if a time looks wrong. I can&rsquo;t change records or move money — your manager does that.
            </div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTED.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={!enabled}
                  onClick={() => ask(q)}
                  className="hover:border-primary/50 hover:bg-accent rounded-full border bg-white px-3 py-1.5 text-left text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <p className="bg-primary max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm text-white">{m.text}</p>
            </div>
          ) : m.role === "error" ? (
            <p key={m.id} role="alert" className="bg-destructive/8 text-destructive rounded-xl px-4 py-3 text-sm">
              {m.text}
            </p>
          ) : (
            <AssistantMessage key={m.id} payload={m.payload} />
          ),
        )}

        {busy && (
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" /> Checking your records…
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        {!enabled ? (
          <p className="text-muted-foreground px-1 py-2 text-sm">{disabledReason ?? "The assistant is unavailable."}</p>
        ) : (
          <div className="focus-within:ring-ring/40 flex items-end gap-2 rounded-xl border bg-white p-1.5 focus-within:ring-[3px]">
            <label htmlFor="assistant-input" className="sr-only">
              Ask a question
            </label>
            <textarea
              id="assistant-input"
              rows={1}
              maxLength={500}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(input);
                }
              }}
              placeholder="e.g. Why did I earn less this Friday?"
              className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
            />
            <Button type="submit" size="icon" disabled={busy || !input.trim()} aria-label="Send">
              <ArrowUp />
            </Button>
          </div>
        )}
      </form>
    </section>
  );
}

function AssistantMessage({ payload }: { payload: AssistantPayload }) {
  const sources = [...new Set(payload.toolCalls.filter((t) => t.ok).map((t) => TOOL_LABEL[t.name] ?? t.name))];
  return (
    <div className="space-y-3">
      <div className={cn("rounded-2xl rounded-tl-sm p-4", payload.fallback ? "bg-warning/10" : "bg-muted/70")}>
        <RichAnswer segments={payload.segments} />
        {sources.length > 0 && (
          <p className="text-muted-foreground mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
            {payload.verified ? <BadgeCheck className="text-primary size-3.5" /> : <ShieldCheck className="size-3.5" />}
            {payload.verified ? "Verified against" : "Checked"}: {sources.join(" · ")}
          </p>
        )}
      </div>

      {payload.evidence.length > 0 && (
        <div className="grid gap-2">
          {payload.evidence.slice(0, 6).map((card) => (
            <div key={`${card.sourceType}:${card.sourceId}`} className="rounded-xl border bg-white p-3">
              <p className="text-muted-foreground mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
                <FileText className="size-3" /> {card.title}
              </p>
              <dl className="space-y-0.5 text-xs">
                {card.items.slice(0, 8).map((i) => (
                  <div key={i.label + i.display} className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">{i.label}</dt>
                    <dd className="text-right font-medium whitespace-nowrap tabular-nums">{i.display}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}

      {payload.proposal && <ProposalCard proposal={payload.proposal} />}
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: PayQueryProposal }) {
  const [pending, start] = useTransition();
  const [queryId, setQueryId] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const createDraft = () =>
    start(async () => {
      const r = await createPayQueryDraftAction({
        shiftAssignmentId: proposal.shiftAssignmentId,
        field: proposal.field,
        adjustMinutes: null,
        claimedTime: null,
        claimedIso: proposal.field === "break_minutes" ? null : proposal.claimedValue,
        claimedBreakMinutes: proposal.field === "break_minutes" ? Number(proposal.claimedValue) : null,
        workerStatement: proposal.workerStatement,
        aiSummary: proposal.aiSummary,
      });
      setMsg(r ? { ok: r.ok, text: r.message } : null);
      if (r?.ok && r.queryId) setQueryId(r.queryId);
    });
  const submit = () =>
    start(async () => {
      if (!queryId) return;
      const r = await submitPayQueryAction(queryId);
      setMsg(r ? { ok: r.ok, text: r.message } : null);
      if (r?.ok) setSent(true);
    });

  const ev = proposal.evidence;
  return (
    <div className="border-primary/30 rounded-2xl border-2 border-dashed bg-white p-4">
      <p className="text-accent-foreground text-xs font-semibold tracking-wide uppercase">Pay query — {sent ? "sent" : queryId ? "draft saved" : "not saved yet"}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Recorded</dt>
        <dd className="font-medium">{proposal.recordedLabel}</dd>
        <dt className="text-muted-foreground">You say</dt>
        <dd className="font-medium">{proposal.claimedLabel}{proposal.differenceLabel && <span className="text-primary ml-1.5">({proposal.differenceLabel})</span>}</dd>
        <dt className="text-muted-foreground">Evidence</dt>
        <dd className="text-muted-foreground text-xs">
          {ev.original.hoursCorrected ? `Originally ${ev.original.clockOut ? "recorded" : "missing"}; corrected ${ev.corrections.length}× by manager.` : "No manager corrections."}{" "}
          Allocation: {ev.allocation.state}. {ev.payout ? `PayPal: ${ev.payout.status}.` : "No PayPal payout yet."}
        </dd>
      </dl>
      <p className="bg-muted/70 mt-3 rounded-lg p-2.5 text-xs italic">&ldquo;{proposal.workerStatement}&rdquo;</p>
      <p className="text-muted-foreground mt-3 text-xs">
        Creating a draft doesn&rsquo;t change your hours or pay. Your manager reviews it and corrects records if needed.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {!queryId && (
          <Button size="sm" onClick={createDraft} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <FileText />} Create draft
          </Button>
        )}
        {queryId && !sent && (
          <Button size="sm" onClick={submit} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Send />} Send to manager
          </Button>
        )}
      </div>
      {msg && <p className={cn("mt-2 text-xs", msg.ok ? "text-accent-foreground" : "text-destructive")}>{msg.text}</p>}
    </div>
  );
}
