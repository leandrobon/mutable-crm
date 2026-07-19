"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createRecord,
  deleteRecord,
  loadTable,
  updateRecordCell,
} from "@/app/actions";
import { baseType, formatCell, isEditable, type CellValue, type TableData } from "@/lib/rows/cells";
import type { Column } from "@/lib/schema/types";

/**
 * The non-technical view: entities down the side, their records in the middle,
 * editable in place.
 *
 * Like the database view, this is generated entirely from the introspected
 * schema — there is no component here that knows what a contact is.
 */
export function CrmView({ tables }: { tables: TableData[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(
    tables[0]?.table.name ?? null,
  );
  const [page, setPage] = useState(0);
  const [data, setData] = useState<TableData | null>(tables[0] ?? null);

  // The entity may vanish under us — the chat can change the schema at any
  // time — so fall back to whatever the first one is now.
  const name = selected && tables.some((t) => t.table.name === selected)
    ? selected
    : tables[0]?.table.name ?? null;

  // Adjusted during render, not in an effect: React re-runs this component
  // immediately without committing the first result, so nothing downstream ever
  // sees the stale entity. An effect would paint the wrong table for a frame.
  if (name !== selected) {
    setSelected(name);
    setPage(0);
  }

  const reload = useCallback(async () => {
    if (!name) return;
    const fresh = await loadTable(name, page);
    setData(fresh);
    // A delete can empty the last page; the server clamps and tells us where
    // it actually landed.
    if (fresh && fresh.page !== page) setPage(fresh.page);
  }, [name, page]);

  // Genuine synchronisation with an external system: the rows for this entity
  // and page are fetched from the server. `reload` sets state only after its
  // await, never synchronously in the effect body, which the lint rule cannot
  // see past — hence the targeted exception rather than a restructure.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload, tables]);

  if (tables.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium">Nothing to show yet</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Ask for an entity on the left — try &ldquo;I want to track contacts
            with a name and an email&rdquo;.
          </p>
        </div>
      </div>
    );
  }

  async function afterChange() {
    await reload();
    // Keeps the row counts in the database view, and the schema, in step.
    router.refresh();
  }

  return (
    <div className="flex h-full min-h-0">
      <nav className="w-44 shrink-0 overflow-y-auto border-r p-3">
        <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Entities
        </p>
        {tables.map((t) => (
          <button
            key={t.table.name}
            type="button"
            onClick={() => {
              setSelected(t.table.name);
              setPage(0);
            }}
            className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm capitalize transition-colors ${
              t.table.name === name
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <span className="truncate">{t.table.name.replace(/_/g, " ")}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {t.totalRows}
            </span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto">
        {data && (
          <RecordList
            key={data.table.name}
            data={data}
            page={page}
            onPage={setPage}
            onChanged={afterChange}
          />
        )}
      </div>
    </div>
  );
}

function RecordList({
  data,
  page,
  onPage,
  onChanged,
}: {
  data: TableData;
  page: number;
  onPage: (page: number) => void;
  onChanged: () => Promise<void>;
}) {
  const { table, rows, totalRows, pageCount } = data;
  const columns = table.columns.filter(isEditable);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(id: number) {
    const result = await deleteRecord(table.name, id);
    if (!result.ok) setError(result.reason);
    else await onChanged();
  }

  return (
    <div className="p-6">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold capitalize">
            {table.name.replace(/_/g, " ")}
          </h2>
          <span className="text-xs text-muted-foreground">
            {totalRows} {totalRows === 1 ? "record" : "records"}
          </span>
        </div>
        <Button size="sm" onClick={() => setAdding(true)} disabled={adding}>
          New
        </Button>
      </header>

      {error && (
        <p className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.name} className="whitespace-nowrap capitalize">
                  {column.name.replace(/_/g, " ")}
                </TableHead>
              ))}
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && !adding ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 1}
                  className="h-20 text-center text-sm text-muted-foreground"
                >
                  No records yet
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.id}>
                  {columns.map((column) => (
                    <TableCell key={column.name} className="p-0 align-middle">
                      <EditableCell
                        column={column}
                        value={row.cells[column.name]}
                        onSave={async (value) => {
                          const result = await updateRecordCell(
                            table.name,
                            row.id,
                            column.name,
                            value,
                          );
                          if (!result.ok) {
                            setError(result.reason);
                            return false;
                          }
                          setError(null);
                          await onChanged();
                          return true;
                        }}
                      />
                    </TableCell>
                  ))}
                  <TableCell className="p-1 text-right">
                    <DeleteButton onDelete={() => onDelete(row.id)} />
                  </TableCell>
                </TableRow>
              ))
            )}

            {adding && (
              <NewRecordRow
                columns={columns}
                onCancel={() => setAdding(false)}
                onCreate={async (values) => {
                  const result = await createRecord(table.name, values);
                  if (!result.ok) {
                    setError(result.reason);
                    return false;
                  }
                  setError(null);
                  setAdding(false);
                  await onChanged();
                  return true;
                }}
              />
            )}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPage(page - 1)}
            disabled={page === 0}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onPage(page + 1)}
            disabled={page >= pageCount - 1}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

/** The HTML input that suits a column's type. */
function inputType(column: Column): string {
  switch (baseType(column.type)) {
    case "date":
      return "date";
    case "integer":
    case "bigint":
    case "numeric":
      return "number";
    default:
      return "text";
  }
}

function inputStep(column: Column): string | undefined {
  const type = baseType(column.type);
  if (type === "integer" || type === "bigint") return "1";
  if (type === "numeric") return "any";
  return undefined;
}

/**
 * A cell that becomes an input when clicked. Booleans skip that step — a
 * checkbox is already the editor — and save on the spot.
 *
 * `onSave` returns whether the write succeeded, so a rejected value stays in
 * the input for the user to fix instead of silently reverting.
 */
function EditableCell({
  column,
  value,
  onSave,
}: {
  column: Column;
  value: CellValue;
  onSave: (value: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  if (baseType(column.type) === "boolean") {
    return (
      <label className="flex h-9 cursor-pointer items-center px-3">
        <input
          type="checkbox"
          className="size-4 cursor-pointer accent-primary"
          checked={value === true}
          disabled={saving}
          onChange={async (event) => {
            setSaving(true);
            await onSave(event.target.checked);
            setSaving(false);
          }}
        />
      </label>
    );
  }

  if (editing) {
    const commit = async () => {
      if (saving) return;
      setSaving(true);
      const ok = await onSave(draft);
      setSaving(false);
      if (ok) setEditing(false);
    };

    return (
      <Input
        autoFocus
        type={inputType(column)}
        step={inputStep(column)}
        value={draft}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
          if (event.key === "Escape") setEditing(false);
        }}
        className="h-9 rounded-none border-0 shadow-none focus-visible:ring-0"
      />
    );
  }

  const display = formatCell(value, column.type);

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value === null ? "" : String(value));
        setEditing(true);
      }}
      className="flex h-9 w-full items-center px-3 text-left text-sm hover:bg-accent/50"
    >
      {display ?? <span className="text-muted-foreground/50">—</span>}
    </button>
  );
}

/** The draft row at the bottom of the table. */
function NewRecordRow({
  columns,
  onCancel,
  onCreate,
}: {
  columns: Column[];
  onCancel: () => void;
  onCreate: (values: Record<string, unknown>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onCreate(values);
    setSaving(false);
  }

  return (
    <TableRow className="bg-muted/40">
      {columns.map((column, index) => (
        <TableCell key={column.name} className="p-1">
          {baseType(column.type) === "boolean" ? (
            <input
              type="checkbox"
              className="ml-2 size-4 cursor-pointer accent-primary"
              checked={values[column.name] === true}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [column.name]: event.target.checked }))
              }
            />
          ) : (
            <Input
              autoFocus={index === 0}
              type={inputType(column)}
              step={inputStep(column)}
              placeholder={column.nullable ? "" : "required"}
              disabled={saving}
              value={String(values[column.name] ?? "")}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [column.name]: event.target.value }))
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
                if (event.key === "Escape") onCancel();
              }}
              className="h-8"
            />
          )}
        </TableCell>
      ))}
      <TableCell className="p-1">
        <div className="flex items-center gap-1">
          <Button size="sm" className="h-8" onClick={save} disabled={saving}>
            {saving ? "…" : "Save"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * Deleting a record cannot be undone — there is no reverse for data the way
 * there is for a migration — so it takes two clicks.
 */
function DeleteButton({ onDelete }: { onDelete: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="destructive"
          className="h-7 px-2 text-xs"
          onClick={onDelete}
        >
          Delete
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => setConfirming(false)}
        >
          No
        </Button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label="Delete record"
      className="h-7 px-2 text-muted-foreground hover:text-destructive"
      onClick={() => setConfirming(true)}
    >
      ×
    </Button>
  );
}
