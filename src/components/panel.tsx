"use client";

import { useState } from "react";
import { CrmView } from "@/components/crm-view";
import { EntityPanel } from "@/components/entity-panel";
import type { TableData } from "@/lib/rows/cells";

type View = "crm" | "database";

/**
 * The right-hand panel, in two readings of the same data.
 *
 * "crm" is what someone using the CRM sees: entities, records, editing.
 * "database" is the technical one: every table, its column types, raw values.
 * Both render from the introspected schema — the toggle changes the
 * presentation, never the source.
 */
export function Panel({ tables }: { tables: TableData[] }) {
  const [view, setView] = useState<View>("crm");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 border-b bg-background px-4 py-2">
        <ViewTab active={view === "crm"} onClick={() => setView("crm")}>
          CRM
        </ViewTab>
        <ViewTab active={view === "database"} onClick={() => setView("database")}>
          Database
        </ViewTab>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {view === "crm" ? (
          <CrmView tables={tables} />
        ) : (
          <EntityPanel tables={tables} />
        )}
      </div>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
