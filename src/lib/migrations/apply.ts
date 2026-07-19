import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@/db";
import type { Proposal } from "./sql";
import type { MigrationRecord } from "./revert";

export type { MigrationRecord };

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

/** The migration history, newest first. */
export async function listMigrations(): Promise<MigrationRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, filename, summary, tool_name, tool_args, up_sql, down_sql,
            applied_at, reverted_at
       FROM _meta.migrations
      ORDER BY id DESC`,
  );

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    summary: r.summary,
    toolName: r.tool_name,
    toolArgs: r.tool_args,
    upSql: r.up_sql,
    downSql: r.down_sql,
    appliedAt: r.applied_at,
    revertedAt: r.reverted_at,
  }));
}

export type RevertResult =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

/**
 * Undoes an applied migration by running the reverse it was stored with.
 *
 * Three things happen in one transaction on one connection, and the order
 * matters:
 *
 * 1. The row is read `FOR UPDATE`. That lock is what makes the stack check
 *    below true at the moment the SQL runs rather than at the moment it was
 *    read — two people clicking Undo at once cannot both see themselves at the
 *    top of the stack.
 * 2. The stack check. Only the newest migration still in effect may be undone;
 *    see `undoableId()` for why LIFO rather than a dependency graph.
 * 3. `down_sql`, then the `reverted_at` stamp. Postgres runs DDL
 *    transactionally, so a reverse that fails — a `changeColumnType` back to a
 *    type some value written since no longer fits — rolls the whole thing back.
 *    Nothing changes and the migration is still marked as in effect. That is
 *    the decision recorded in docs/ARCHITECTURE.md: store the reverse anyway
 *    and let it fail loudly, rather than silently truncating.
 *
 * The .sql file is left alone. It records that the migration was applied, which
 * remains true; `reverted_at` on the row records that it was later undone.
 */
export async function revertMigration(id: number): Promise<RevertResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT id, summary, down_sql, reverted_at
         FROM _meta.migrations
        WHERE id = $1
          FOR UPDATE`,
      [id],
    );

    const target = rows[0];
    if (!target) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "That change is not in the history." };
    }
    if (target.reverted_at !== null) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "That change has already been undone." };
    }

    const newest = await client.query(
      `SELECT id, summary
         FROM _meta.migrations
        WHERE reverted_at IS NULL
        ORDER BY id DESC
        LIMIT 1`,
    );

    if (newest.rows[0] && newest.rows[0].id !== id) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        reason: `Undo the newer change first — "${newest.rows[0].summary}" was applied after this one and may depend on it.`,
      };
    }

    try {
      await client.query(target.down_sql);
    } catch (err) {
      await client.query("ROLLBACK");
      // Kept verbatim rather than softened: the Postgres message names the
      // value that does not fit, which is the only way to find the row.
      return {
        ok: false,
        reason: `The database refused the undo, so nothing was changed: ${
          (err as Error).message
        }`,
      };
    }

    await client.query(
      `UPDATE _meta.migrations SET reverted_at = now() WHERE id = $1`,
      [id],
    );

    await client.query("COMMIT");
    return { ok: true, summary: target.summary };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, reason: (err as Error).message };
  } finally {
    client.release();
  }
}
