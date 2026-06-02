import { z } from "zod";

/**
 * Server-side configuration, read from environment variables.
 *
 * Note: this holds *no database credentials*. The database to connect to is
 * supplied by each client per connection (via the `X-DB-DSN` header), so the
 * only secret the server itself holds is the optional endpoint access token.
 */
const ConfigSchema = z.object({
  /** Port to listen on. Render injects this via `PORT`. */
  port: z.number().int().positive(),
  /** Optional bearer token required on the `Authorization` header. Null = open. */
  authToken: z.string().min(1).nullable(),
  /** Per-operation allowlist. A statement runs only if its operation is enabled. */
  allowedOperations: z.object({
    select: z.boolean(),
    insert: z.boolean(),
    update: z.boolean(),
    delete: z.boolean(),
  }),
  /** Hard cap on rows returned per query. */
  maxRows: z.number().int().positive(),
  /** Optional allowlist of database hosts clients may connect to. Null = any. */
  allowedDbHosts: z.array(z.string().min(1)).nullable(),
  /** Connection timeout for the MySQL handshake, in milliseconds. */
  connectTimeoutMs: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseList(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return items.length > 0 ? items : null;
}

export function loadConfig(): Config {
  const token = process.env.MCP_AUTH_TOKEN;
  const raw = {
    port: parseInteger(process.env.PORT, 3000),
    authToken: token !== undefined && token.trim() !== "" ? token : null,
    // Safe default: read-only — SELECT enabled, all writes disabled.
    allowedOperations: {
      select: parseBool(process.env.MYSQL_ALLOW_SELECT, true),
      insert: parseBool(process.env.MYSQL_ALLOW_INSERT, false),
      update: parseBool(process.env.MYSQL_ALLOW_UPDATE, false),
      delete: parseBool(process.env.MYSQL_ALLOW_DELETE, false),
    },
    maxRows: parseInteger(process.env.MYSQL_MAX_ROWS, 1000),
    allowedDbHosts: parseList(process.env.ALLOWED_DB_HOSTS),
    connectTimeoutMs: parseInteger(process.env.MYSQL_CONNECT_TIMEOUT_MS, 10000),
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid server configuration:\n${issues}`);
  }

  return result.data;
}
