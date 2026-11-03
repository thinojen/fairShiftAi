"use client";
import { Button } from "@/components/ui/button";

export default function ManagerError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold">Couldn&rsquo;t load this page</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          The database may be unreachable or not configured (check <code>DATABASE_URL</code>). No payment actions were taken.
        </p>
        <Button className="mt-4" variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
