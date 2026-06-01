import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Database } from "./db.js";

interface ToolOptions {
  maxRows: number;
}

function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, val) => (typeof val === "bigint" ? val.toString() : val),
    2,
  );
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: toJson(value) }] };
}

/**
 * Build a detailed, human-readable error string.
 *
 * mysql2 errors often carry the useful information in fields other than
 * `message` (which can be empty) — notably `code` (e.g. "ECONNREFUSED",
 * "ETIMEDOUT", "ER_ACCESS_DENIED_ERROR"), `errno`, `sqlState`, `address` and
 * `port`. We surface all of them so failures are actually diagnosable.
 */
function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return `Error: ${String(error)}`;
  }

  const err = error as Error & {
    code?: string;
    errno?: number;
    sqlState?: string;
    sqlMessage?: string;
    address?: string;
    port?: number;
    fatal?: boolean;
  };

  // Prefer the driver's sqlMessage, then message, then the error name.
  const baseMessage =
    (err.sqlMessage && err.sqlMessage.trim()) ||
    (err.message && err.message.trim()) ||
    err.name ||
    "Unknown error";

  const details: string[] = [];
  if (err.code) details.push(`code=${err.code}`);
  if (typeof err.errno === "number") details.push(`errno=${err.errno}`);
  if (err.sqlState) details.push(`sqlState=${err.sqlState}`);
  if (err.address) details.push(`address=${err.address}`);
  if (typeof err.port === "number") details.push(`port=${err.port}`);

  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `Error: ${baseMessage}${suffix}`;
}

function errorResult(error: unknown) {
  // Log the full error server-side (stderr → Render logs) for deeper debugging.
  console.error("Tool error:", error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: formatError(error) }],
  };
}

const NO_DB_MESSAGE =
  "No database credentials were provided. Send a DSN in the X-DB-DSN header, " +
  "e.g. mysql://user:password@host:3306/database.";

/**
 * Register the database tools. `db` is null when the request carried no DSN; in
 * that case the tools still appear in `tools/list` but return a clear error when
 * actually called.
 */
export function registerTools(server: McpServer, db: Database | null, options: ToolOptions): void {
  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "List all tables in the connected database.",
    },
    async () => {
      if (db === null) {
        return errorResult(new Error(NO_DB_MESSAGE));
      }
      try {
        return jsonResult(await db.listTables());
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description: "Return the columns, types, keys and comments of a table.",
      inputSchema: {
        table: z.string().min(1).describe("Exact name of an existing table"),
      },
    },
    async ({ table }) => {
      if (db === null) {
        return errorResult(new Error(NO_DB_MESSAGE));
      }
      try {
        return jsonResult(await db.describeTable(table));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "run_query",
    {
      title: "Run SQL query",
      description: [
        "Execute a single read-only SQL query and return the rows as JSON.",
        "Use ? placeholders for values and pass them in `params` (in order) to stay safe from injection.",
        `At most ${options.maxRows} rows are returned.`,
      ].join(" "),
      inputSchema: {
        sql: z
          .string()
          .min(1)
          .describe("A single read-only SQL statement using ? placeholders for values"),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe("Values bound to the ? placeholders, in order"),
      },
    },
    async ({ sql, params }) => {
      if (db === null) {
        return errorResult(new Error(NO_DB_MESSAGE));
      }
      try {
        return jsonResult(await db.runQuery(sql, params ?? []));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
