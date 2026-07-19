import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const sql = readFileSync(resolve(process.cwd(), "src/db/meta.sql"), "utf8");
  const pool = new Pool({ connectionString });

  await pool.query(sql);
  console.log("✓ _meta schema ready");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
