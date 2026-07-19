/**
 * Recreates the `contacts` table the regression suites run against.
 *
 * This is a **test fixture, not a CRM seed**. `test-migrations.ts` and
 * `test-rows.ts` both hardcode this table: they rename `full_name`, change the
 * type of `score`, assert that `numeric(10,2)` survives a round trip, and count
 * exactly two rows. Without it they fail on a clean database.
 *
 * It lived only in the database until now, which meant `npm run db:reset` quietly
 * destroyed the only copy. Keep the shape below in step with what those two
 * scripts expect — if you change a column here, run both.
 *
 * Idempotent: safe to run against a database that already has it.
 */
import { pool } from "@/db";

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id         serial PRIMARY KEY,
      email      text NOT NULL,
      full_name  text,
      score      numeric(10,2),
      is_active  boolean DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // Only when empty, so re-running never piles up rows the suites would count.
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contacts`,
  );

  if (rows[0].n === 0) {
    await pool.query(`
      INSERT INTO contacts (email, full_name, score, is_active) VALUES
        ('ana@example.com', 'Ana Ruiz', 91.50, true),
        ('bo@example.com',  'Bo Chen',  44.25, true);
    `);
    console.log("contacts created with 2 rows");
  } else {
    console.log(`contacts already has ${rows[0].n} row(s) — left alone`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
