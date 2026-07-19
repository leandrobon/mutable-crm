"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { revertChange } from "@/app/actions";
import {
  describeRevert,
  undoableId,
  type MigrationRecord,
} from "@/lib/migrations/revert-plan";

/**
 * The migration history, newest first, and the one place undo is offered.
 *
 * Only the newest change still in effect gets a button, because undo is last-in-
 * first-out, so anything below it is shown with what is blocking it rather than
 * a control that would be refused. The server decides this again inside the
 * transaction; this list is a snapshot and only decides what to draw.
 */
export function HistoryView({ history }: { history: MigrationRecord[] }) {
  const undoable = undoableId(history);

  if (history.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        No changes applied yet. Ask for one on the left, and it will show up here
        with its reverse.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      {history.map((record) => (
        <HistoryEntry
          key={record.id}
          record={record}
          undoable={record.id === undoable}
        />
      ))}
    </div>
  );
}

function HistoryEntry({
  record,
  undoable,
}: {
  record: MigrationRecord;
  undoable: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isReverting, startReverting] = useTransition();

  const plan = describeRevert(record);
  const reverted = record.revertedAt !== null;

  function undo() {
    setError(null);
    startReverting(async () => {
      const result = await revertChange(record.id);
      if (!result.ok) {
        setError(result.reason);
        setConfirming(false);
        return;
      }
      setConfirming(false);
      // Same refresh the apply button does: the panel and this list both redraw
      // from the schema as it is now.
      router.refresh();
    });
  }

  return (
    <div
      className={`rounded-lg border bg-background ${
        reverted ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <p className="text-sm">{record.summary}</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {formatWhen(record.appliedAt)} · {record.filename}
          </p>
        </div>
        {reverted ? (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            undone
          </Badge>
        ) : null}
      </div>

      {!reverted && undoable ? (
        <div className="border-t px-3 py-2.5">
          {confirming ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium">{plan.summary}</p>
              <ul className="flex flex-col gap-1">
                {plan.impact.map((line) => (
                  <li key={line} className="text-xs text-muted-foreground">
                    – {line}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant={plan.destructive ? "destructive" : "default"}
                  className="h-7 px-2.5 text-xs"
                  disabled={isReverting}
                  onClick={undo}
                >
                  {isReverting ? "Undoing…" : "Undo"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2.5 text-xs"
                  disabled={isReverting}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2.5 text-xs text-muted-foreground"
              onClick={() => setConfirming(true)}
            >
              Undo this change
            </Button>
          )}
        </div>
      ) : null}

      {!reverted && !undoable ? (
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Undo the changes above this one first.
        </p>
      ) : null}

      {error ? (
        <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p>
      ) : null}

      <Accordion multiple={false} className="border-t px-3">
        <AccordionItem value="sql" className="border-0">
          <AccordionTrigger className="py-2 text-[11px] text-muted-foreground hover:no-underline">
            SQL
          </AccordionTrigger>
          <AccordionContent>
            <pre className="overflow-x-auto whitespace-pre-wrap pb-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {`-- +up\n${record.upSql}\n\n-- +down\n${record.downSql}`}
            </pre>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

/** Dates cross the server boundary as Date objects; a refresh may hand back a
 *  string, so accept either rather than calling a method that isn't there. */
function formatWhen(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
