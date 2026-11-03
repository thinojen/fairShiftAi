import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatGBP } from "@/lib/money";

/**
 * Milestone 1 placeholder. The manager and worker dashboards arrive in later
 * milestones (see TASKS.md). Nothing on this page touches PayPal or the database.
 */
export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-16 sm:px-6">
      <header className="flex flex-col gap-3">
        <Badge variant="secondary">Demo build · PayPal sandbox only</Badge>
        <h1 className="text-4xl font-semibold tracking-tight">FairShift AI</h1>
        <p className="text-muted-foreground text-lg">
          Fair, explainable tips for hospitality workers. Shifts in, tips calculated under a
          written policy, paid through PayPal — and an AI that can tell you{" "}
          <em>why</em> your Friday paid less than last Friday.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Tip pool" value={formatGBP(64000)} />
        <Stat label="Workers on shift" value="5" />
        <Stat label="Policy" value="v2 · hours × role" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Coming next</CardTitle>
          <CardDescription>
            Manager close-out and payouts, worker earnings, and the explain-my-pay assistant.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          Figures above are illustrative synthetic data.
        </CardContent>
      </Card>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card rounded-xl border p-4">
      <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
