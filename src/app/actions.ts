"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/db";
import { introspectSchema } from "@/lib/schema/introspect";
import { proposeChange, type Turn } from "@/lib/migrations/propose";
import { planMigration, type Proposal } from "@/lib/migrations/sql";
import { applyMigration } from "@/lib/migrations/apply";
import { isToolName, toolSchemas, type ToolCall } from "@/lib/migrations/tools";

export type ProposeResponse =
  | { kind: "proposal"; call: ToolCall; proposal: Proposal; text: string }
  | { kind: "message"; text: string }
  | { kind: "rejected"; reason: string; text: string };

async function rowCount(tableName: string): Promise<number> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`public.${tableName}`],
  );
  if (!rows[0].present) return 0;
  const counted = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${tableName}`,
  );
  return counted.rows[0].n;
}

/**
 * Asks the model what change the message describes and turns it into a
 * proposal. Nothing is applied here.
 */
/**
 * The transcript arrives from the client, so it is shaped here before the model
 * sees it. It only ever becomes conversational context — the tool call the
 * model returns is validated on its own, and `apply` re-plans from the live
 * schema — so a doctored history cannot widen what this server will execute.
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
    await rowCount(result.call.args.tableName),
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
 * arguments, so what runs is always what this server produced — a client
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
    await rowCount(verified.args.tableName),
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
