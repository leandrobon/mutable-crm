/** Dev utility: prints what introspection currently sees. */
import { introspectSchema, formatSchemaForPrompt } from "@/lib/schema/introspect";
import { pool } from "@/db";

async function main() {
  const schema = await introspectSchema();

  console.log("--- raw ---");
  console.dir(schema, { depth: null });

  console.log("\n--- as the model sees it ---");
  console.log(formatSchemaForPrompt(schema));

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
