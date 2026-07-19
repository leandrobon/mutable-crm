import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@/db";
import type { Proposal } from "./sql";

export type ApplyResult =
  | { ok: true; filename: string; fileWritten: boolean }
  | { ok: false; reason: string };

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

/** e.g. 20260719T142233__add_column_contacts_company */
function migrationName(proposal: Proposal, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

  const snake = proposal.toolName.replace(
    /[A-Z]/g,
    (c) => `_${c.toLowerCase()}`,
  );

  const args = proposal.args as Record<string, unknown>;
  const subject = [args.tableName, args.columnName ?? args.from]
    .filter((v): v is string => typeof v === "string")
    .join("_");

  return `${stamp}__${snake}_${subject}`;
}

function fileContents(proposal: Proposal, name: string): string {
  return [
    `-- ${name}`,
    `-- ${proposal.summary}`,
    "",
    "-- +up",
    proposal.upSql,
    "",
    "-- +down",
    proposal.downSql,
    "",
  ].join("\n");
}

/**
 * Applies a proposal.
 *
 * The schema change and the history row go in one transaction on a single
 * connection — Postgres runs DDL transactionally, so if the SQL fails nothing
 * is changed and nothing is recorded.
 *
 * The .sql file is written afterwards, deliberately outside the transaction. A
 * filesystem error should not roll back a schema change that already succeeded,
 * and the `_meta.migrations` row already holds the same up and down SQL. The
 * caller gets `fileWritten: false` so it can say so rather than pretend.
 */
export async function applyMigration(
  proposal: Proposal,
  now: Date = new Date(),
): Promise<ApplyResult> {
  const name = migrationName(proposal, now);
  const filename = `${name}.sql`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(proposal.upSql);
    await client.query(
      `INSERT INTO _meta.migrations
         (filename, summary, tool_name, tool_args, up_sql, down_sql)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        filename,
        proposal.summary,
        proposal.toolName,
        JSON.stringify(proposal.args),
        proposal.upSql,
        proposal.downSql,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, reason: (err as Error).message };
  } finally {
    client.release();
  }

  let fileWritten = true;
  try {
    await mkdir(MIGRATIONS_DIR, { recursive: true });
    await writeFile(
      join(MIGRATIONS_DIR, filename),
      fileContents(proposal, name),
      "utf8",
    );
  } catch {
    fileWritten = false;
  }

  return { ok: true, filename, fileWritten };
}

export type MigrationRecord = {
  id: number;
  filename: string;
  summary: string;
  toolName: string;
  upSql: string;
  downSql: string;
  appliedAt: Date;
  revertedAt: Date | null;
};

/** The migration history, newest first. */
export async function listMigrations(): Promise<MigrationRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, filename, summary, tool_name, up_sql, down_sql, applied_at, reverted_at
       FROM _meta.migrations
      ORDER BY id DESC`,
  );

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    summary: r.summary,
    toolName: r.tool_name,
    upSql: r.up_sql,
    downSql: r.down_sql,
    appliedAt: r.applied_at,
    revertedAt: r.reverted_at,
  }));
}
