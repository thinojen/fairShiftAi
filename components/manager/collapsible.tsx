"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function Reveal({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button type="button" variant={open ? "ghost" : "outline"} size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Cancel" : label}
      </Button>
      {open && children}
    </div>
  );
}
