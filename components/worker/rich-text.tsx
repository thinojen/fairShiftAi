/**
 * Tiny safe renderer for assistant replies: paragraphs, "- " bullets and **bold**.
 * Builds React elements only (no HTML injection). Fact segments are rendered as
 * highlighted chips from TRUSTED server data, never from model text.
 */
import { Fragment } from "react";
import type { Segment } from "@/lib/assistant/validate";
import { cn } from "@/lib/utils";

function inline(text: string, key: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={`${key}-${i}`}>{p.slice(2, -2)}</strong> : <Fragment key={`${key}-${i}`}>{p}</Fragment>,
  );
}

function FactChip({ s }: { s: Extract<Segment, { type: "fact" }> }) {
  const money = s.kind === "money";
  const negative = money && s.display.startsWith("−");
  return (
    <span
      title={`${s.label} — from ${s.sourceLabel} (verified)`}
      className={cn(
        "mx-0.5 inline-flex items-baseline rounded-md px-1.5 py-px font-semibold tabular-nums ring-1 ring-inset",
        money && !negative && "bg-accent text-accent-foreground ring-primary/20",
        negative && "bg-destructive/8 text-destructive ring-destructive/20",
        !money && "bg-secondary text-secondary-foreground ring-border",
      )}
    >
      {s.display}
    </span>
  );
}

/** Group segments into lines, then paragraphs / bullet lists. */
export function RichAnswer({ segments }: { segments: Segment[] }) {
  type Line = Array<Segment>;
  const lines: Line[] = [[]];
  for (const seg of segments) {
    if (seg.type === "fact") {
      lines[lines.length - 1].push(seg);
      continue;
    }
    const pieces = seg.text.split("\n");
    pieces.forEach((piece, i) => {
      if (i > 0) lines.push([]);
      if (piece) lines[lines.length - 1].push({ type: "text", text: piece });
    });
  }

  const blocks: Array<{ kind: "p" | "ul"; lines: Line[] }> = [];
  for (const line of lines) {
    const first = line[0];
    const isBullet = first?.type === "text" && /^\s*[-•*]\s+/.test(first.text);
    const isBlank = line.every((s) => s.type === "text" && !s.text.trim());
    if (isBlank) {
      blocks.push({ kind: "p", lines: [] });
      continue;
    }
    if (isBullet) {
      const cleaned: Line = [{ type: "text", text: (first as { text: string }).text.replace(/^\s*[-•*]\s+/, "") }, ...line.slice(1)];
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "ul") prev.lines.push(cleaned);
      else blocks.push({ kind: "ul", lines: [cleaned] });
    } else {
      const prev = blocks[blocks.length - 1];
      if (prev?.kind === "p" && prev.lines.length) prev.lines.push(line);
      else blocks.push({ kind: "p", lines: [line] });
    }
  }

  const renderLine = (line: Line, k: string) =>
    line.map((s, i) => (s.type === "text" ? <Fragment key={`${k}-${i}`}>{inline(s.text, `${k}-${i}`)}</Fragment> : <FactChip key={`${k}-${i}`} s={s} />));

  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks
        .filter((b) => b.lines.length)
        .map((b, bi) =>
          b.kind === "ul" ? (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {b.lines.map((l, li) => (
                <li key={li}>{renderLine(l, `${bi}-${li}`)}</li>
              ))}
            </ul>
          ) : (
            <p key={bi}>
              {b.lines.map((l, li) => (
                <Fragment key={li}>
                  {li > 0 && " "}
                  {renderLine(l, `${bi}-${li}`)}
                </Fragment>
              ))}
            </p>
          ),
        )}
    </div>
  );
}
