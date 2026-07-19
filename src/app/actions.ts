"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { ident } from "@/lib/schema/types";
import { proposeChange, type Turn } from "@/lib/migrations/propose";
import { planMigration, type Proposal } from "@/lib/migrations/sql";
import { applyMigration, revertMigration } from "@/lib/migrations/apply";
import { isToolName, toolSchemas, type ToolCall } from "@/lib/migrations/tools";
import { fetchTableData } from "@/lib/rows/read";
import type { TableData } from "@/lib/rows/cells";
import { deleteRow, insertRow, updateCell } from "@/lib/rows/mutate";

export type ProposeResponse =
  | { kind: "proposal"; call: ToolCall; proposal: Proposal; text: string }
  | { kind: "message"; text: string }
  | { kind: "rejected"; reason: string; text: string };

/**
 * The existing table an operation acts on, or null when it acts on none.
 *
 * `createTables` is the null case: every table in it is new, so there are no
 * rows to count and nothing for the "would this break existing data" checks to
 * look at.
 */
function subjectTable(call: ToolCall): string | null {
  return "tableName" in call.args ? call.args.tableName : null;
}

async function rowCount(tableName: string | null): Promise<number> {
  if (tableName === null) return 0;

  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${tableName}`],
  );
  if (!rows[0].present) return 0;
  const counted = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${ident(tableName)}`,
  );
  return counted.rows[0].n;
}

/**
 * Asks the model what change the message describes and turns it into a
 * proposal. Nothing is applied here.
 */
/**
 * The transcript arrives from the client, so it is shaped here before the model
 * sees it. It only ever becomes conversational context: the tool call the
 * model returns is validated on its own, and `apply` re-plans from the live
 * schema, so a doctored history cannot widen what this server will execute.
 */
function sanitizeHistory(history: unknown): Turn[] {
  if (!Array.isArray(history)) return [];
  return history.flatMap((turn): Turn[] => {
    if (typeof turn?.text !== "string") return [];
    const text = turn.text.trim().slice(0, 4000);
    if (!text) return [];
    if (turn.role !== "user" && turn.role !== "assistant") return [];
    return [{ role: turn.role, text }];
  });
}

export async function propose(
  message: string,
  history: Turn[] = [],
): Promise<ProposeResponse> {
  const trimmed = message.trim();
  if (!trimmed) return { kind: "message", text: "Say what you'd like to change." };

  const schema = await introspectSchema();

  let result;
  try {
    result = await proposeChange(trimmed, schema, sanitizeHistory(history));
  } catch (err) {
    return {
      kind: "message",
      text: `Could not reach the model: ${(err as Error).message}`,
    };
  }

  if (result.type === "message") return { kind: "message", text: result.text };

  const plan = planMigration(
    result.call,
    schema,
    await rowCount(subjectTable(result.call)),
  );

  if (!plan.ok) {
    return { kind: "rejected", reason: plan.reason, text: result.text };
  }

  return {
    kind: "proposal",
    call: result.call,
    proposal: plan.proposal,
    text: result.text,
  };
}

export type ApplyResponse =
  | { ok: true; filename: string; fileWritten: boolean; summary: string }
  | { ok: false; reason: string };

/**
 * Applies a previously proposed change.
 *
 * Takes the tool call, not the SQL. The SQL is regenerated here from the
 * arguments, so what runs is always what this server produced. A client
 * cannot hand us a statement to execute. Re-planning also re-checks the
 * proposal against the schema as it is *now*, so a proposal that went stale
 * (the column was already renamed in another tab) is rejected instead of
 * failing halfway.
 */
export async function apply(call: ToolCall): Promise<ApplyResponse> {
  if (!isToolName(call?.name)) {
    return { ok: false, reason: "Unknown operation." };
  }

  const parsed = toolSchemas[call.name].safeParse(call.args);
  if (!parsed.success) {
    return { ok: false, reason: "The change was not valid any more." };
  }

  const verified = { name: call.name, args: parsed.data } as ToolCall;
  const schema = await introspectSchema();
  const plan = planMigration(
    verified,
    schema,
    await rowCount(subjectTable(verified)),
  );

  if (!plan.ok) return { ok: false, reason: plan.reason };

  const applied = await applyMigration(plan.proposal);
  if (!applied.ok) return { ok: false, reason: applied.reason };

  revalidatePath("/");

  return {
    ok: true,
    filename: applied.filename,
    fileWritten: applied.fileWritten,
    summary: plan.proposal.summary,
  };
}

/* ---------------------------------------------------------------------------
 * History.
 * ------------------------------------------------------------------------ */

export type RevertResponse =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

/**
 * Undoes an applied change.
 *
 * Takes only the id, for the same reason `apply` takes the tool call and not
 * the SQL. The reverse that runs is the one this server stored when the
 * migration was applied; a client has no way to supply or influence it. Which
 * migration is eligible is decided inside the transaction, not here, so a stale
 * page cannot undo something that is no longer at the top of the stack.
 */
export async function revertChange(id: number): Promise<RevertResponse> {
  if (!Number.isInteger(id)) return { ok: false, reason: "Invalid change." };

  const result = await revertMigration(id);
  if (!result.ok) return result;

  revalidatePath("/");
  return result;
}

/* ---------------------------------------------------------------------------
 * Records.
 *
 * Editing rows is not a schema change: no proposal, no migration file, no
 * model. These run straight from the CRM view. Each one re-introspects first,
 * so the table and column names are resolved against the live schema rather
 * than trusted from the request. See lib/rows/mutate.ts.
 * ------------------------------------------------------------------------ */

export type RowResult = { ok: true } | { ok: false; reason: string };

/** Re-reads one table after a change, so only that table re-renders. */
export async function loadTable(
  tableName: string,
  page = 0,
): Promise<TableData | null> {
  const schema = await introspectSchema();
  return fetchTableData(schema, tableName, page);
}

export async function createRecord(
  tableName: string,
  values: Record<string, unknown>,
): Promise<RowResult> {
  const schema = await introspectSchema();
  const result = await insertRow(schema, tableName, values ?? {});
  if (!result.ok) return result;

  revalidatePath("/");
  return { ok: true };
}

export async function updateRecordCell(
  tableName: string,
  rowId: number,
  columnName: string,
  value: unknown,
): Promise<RowResult> {
  if (!Number.isInteger(rowId)) return { ok: false, reason: "Invalid record." };

  const schema = await introspectSchema();
  const result = await updateCell(schema, tableName, rowId, columnName, value);
  if (!result.ok) return result;

  revalidatePath("/");
  return { ok: true };
}

export async function deleteRecord(
  tableName: string,
  rowId: number,
): Promise<RowResult> {
  if (!Number.isInteger(rowId)) return { ok: false, reason: "Invalid record." };

  const schema = await introspectSchema();
  const result = await deleteRow(schema, tableName, rowId);
  if (!result.ok) return result;

  revalidatePath("/");
  return { ok: true };
}
