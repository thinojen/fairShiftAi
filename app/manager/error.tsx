"use client";
import { Button } from "@/components/ui/button";

export default function ManagerError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold">Couldn&rsquo;t load this page</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Something went wrong on the server — for example the database is unreachable, or the action was refused. Nothing was
          changed and no payment actions were taken. The server log has the details.
        </p>
        {error.digest && <p className="text-muted-foreground mt-2 font-mono text-xs">Error {error.digest}</p>}
        <Button className="mt-4" variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
