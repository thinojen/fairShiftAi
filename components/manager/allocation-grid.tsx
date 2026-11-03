"use client";
/**
 * Allocation table (AG Grid). Display only: every number arrives pre-computed
 * from the server-side tip engine. This component does no money arithmetic
 * beyond formatting.
 */
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";
import { formatMinutes, formatWeight } from "@/lib/format";
import { formatGBP } from "@/lib/money";

ModuleRegistry.registerModules([AllCommunityModule]);

const fairshiftTheme = themeQuartz.withParams({
  accentColor: "#059669",
  backgroundColor: "#ffffff",
  foregroundColor: "#16213a",
  headerBackgroundColor: "#f6f8fb",
  headerTextColor: "#3b4a63",
  headerFontWeight: 600,
  borderColor: "#e6eaf0",
  rowHoverColor: "#ecfdf5",
  oddRowBackgroundColor: "#fcfdfe",
  fontFamily: "inherit",
  fontSize: 13,
  wrapperBorderRadius: 12,
  spacing: 7,
});

export type AllocationRow = {
  workerId: string;
  worker: string;
  role: string;
  workedMinutes: number;
  weightBp: number;
  points: number;
  sharePence: number;
  remainderPence: number;
  eligible: boolean;
  note: string;
  payoutStatus?: string;
};

const STATUS_LABEL: Record<string, string> = {
  success: "Paid",
  pending: "Pending",
  unclaimed: "Unclaimed",
  onhold: "On hold",
  failed: "Failed",
  returned: "Returned",
  blocked: "Blocked",
  refunded: "Refunded",
  reversed: "Reversed",
  review: "Needs review",
};

export function AllocationGrid({ rows, totalPoints, showPayout }: { rows: AllocationRow[]; totalPoints: number; showPayout?: boolean }) {
  const columns = useMemo<ColDef<AllocationRow>[]>(() => {
    const cols: ColDef<AllocationRow>[] = [
      { field: "worker", headerName: "Worker", flex: 1.4, minWidth: 140, pinned: "left" },
      { field: "role", headerName: "Role", flex: 1, minWidth: 100, cellClass: "capitalize" },
      { field: "workedMinutes", headerName: "Hours", minWidth: 90, flex: 0.8, type: "rightAligned", valueFormatter: (p) => formatMinutes(p.value ?? 0) },
      { field: "weightBp", headerName: "Weight", minWidth: 85, flex: 0.7, type: "rightAligned", valueFormatter: (p) => formatWeight(p.value ?? 0) },
      { field: "points", headerName: "Points", minWidth: 95, flex: 0.8, type: "rightAligned", valueFormatter: (p) => (p.value ?? 0).toLocaleString("en-GB") },
      {
        headerName: "% of points",
        minWidth: 120,
        flex: 0.9,
        type: "rightAligned",
        // Display-only percentage; the money comes from the engine, not from this.
        valueGetter: (p) => (totalPoints > 0 && p.data ? (p.data.points / totalPoints) * 100 : 0),
        valueFormatter: (p) => `${(p.value as number).toFixed(1)}%`,
      },
      {
        field: "sharePence",
        headerName: "Tip share",
        minWidth: 110,
        flex: 1,
        type: "rightAligned",
        sort: "desc",
        cellClass: "font-semibold tabular-nums",
        valueFormatter: (p) => formatGBP(p.value ?? 0),
      },
      { field: "note", headerName: "Notes", flex: 1.4, minWidth: 160, cellClass: "text-muted-foreground" },
    ];
    if (showPayout) {
      cols.splice(7, 0, {
        field: "payoutStatus",
        headerName: "PayPal status",
        minWidth: 120,
        flex: 0.9,
        valueFormatter: (p) => (p.value ? (STATUS_LABEL[p.value] ?? p.value) : "—"),
        cellClassRules: {
          "text-success font-medium": (p) => p.value === "success",
          "text-destructive font-medium": (p) => ["failed", "returned", "blocked", "refunded", "reversed", "review"].includes(p.value),
          "text-warning font-medium": (p) => ["unclaimed", "onhold"].includes(p.value),
        },
      });
    }
    return cols;
  }, [showPayout, totalPoints]);

  return (
    <div className="w-full">
      <AgGridReact<AllocationRow>
        theme={fairshiftTheme}
        rowData={rows}
        columnDefs={columns}
        getRowId={(p) => p.data.workerId}
        defaultColDef={{ sortable: true, resizable: true }}
        suppressCellFocus
        domLayout="autoHeight"
      />
    </div>
  );
}
