import Anthropic from "@anthropic-ai/sdk";
import type { DbSchema } from "@/lib/schema/types";
import { formatSchemaForPrompt } from "@/lib/schema/introspect";
import { TOOL_DEFINITIONS, isToolName, toolSchemas, type ToolCall } from "./tools";

const MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `You help a user evolve the schema of their CRM database by talking to them.

You do not execute anything. You choose one operation and its arguments; the
application generates the SQL, shows it to the user, and only applies it if they
approve. Never write SQL yourself — you have no way to run it, and the SQL in
your message would be ignored.

You can do exactly four things: create a table, add a column, rename a column,
and change a column's type. There is no way to delete a table or a column.

Guidelines:
- Choose the operation that preserves data. If the user wants a field to be
  called something else, rename it — do not add a new one.
- Every new table automatically gets an "id" primary key and a "created_at"
  timestamp. Never include them in the column list.
- Prefer optional (nullable) columns. A required column cannot be added to a
  table that already has rows.
- Use singular, lowercase, snake_case column names and plural table names.

If the request is ambiguous, would need an operation you do not have, or is not
about the schema at all, reply in plain text instead of choosing an operation.
Be brief. Answer in the language the user wrote in.`;

/**
 * What came back from the model: either an operation to propose, or plain text
 * (a question, a refusal, or an answer about the current schema).
 */
export type ProposeResult =
  | { type: "call"; call: ToolCall; text: string }
  | { type: "message"; text: string };

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Add it to .env.local — see .env.example.",
      );
    }
    client = new Anthropic();
  }
  return client;
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * Asks the model which operation the user's request maps to.
 *
 * The model sees the current schema and the four tools; it never sees or
 * produces SQL. `strict: true` on the tool definitions makes the API guarantee
 * the arguments match our schemas, and we parse them again with Zod so the rest
 * of the app gets typed values.
 */
export async function proposeChange(
  userMessage: string,
  schema: DbSchema,
): Promise<ProposeResult> {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    tools: [...TOOL_DEFINITIONS] as unknown as Anthropic.Tool[],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: `Current database schema:\n\n${formatSchemaForPrompt(
          schema,
        )}\n\nRequest: ${userMessage}`,
      },
    ],
  });

  const text = textOf(response.content);

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );

  if (!toolUse) {
    return {
      type: "message",
      text: text || "I could not work out what change you wanted.",
    };
  }

  if (!isToolName(toolUse.name)) {
    return {
      type: "message",
      text: `The model asked for an operation that does not exist ("${toolUse.name}").`,
    };
  }

  // Second validation pass. The API guarantees the shape; this gives us typed
  // values and catches anything the schema alone would not.
  const parsed = toolSchemas[toolUse.name].safeParse(toolUse.input);
  if (!parsed.success) {
    return {
      type: "message",
      text: `The proposed change was not valid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    };
  }

  return {
    type: "call",
    call: { name: toolUse.name, args: parsed.data } as ToolCall,
    text,
  };
}
