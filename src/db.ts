import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from "mysql2/promise";

/** Parsed connection target, derived from a client-supplied DSN. */
export interface DbConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * The four DML operations whose access can be toggled independently. A SQL
 * statement is accepted only if its operation is enabled here.
 */
export interface AllowedOperations {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

/** One of the configurable operations. */
export type SqlOperation = keyof AllowedOperations;

/** Server-controlled behaviour applied to every connection. */
export interface DbOptions {
  allowedOperations: AllowedOperations;
  maxRows: number;
  connectTimeoutMs: number;
}

/** Scalar value types that can be safely bound to a `?` placeholder. */
export type SqlParam = string | number | boolean | null;

/** Leading keywords that classify a statement as a read ("select") operation. */
const READ_KEYWORDS = ["select", "show", "describe", "desc", "explain", "with"];

/** Env var that enables each operation — surfaced in errors so the fix is obvious. */
const OPERATION_ENV_VAR: Record<SqlOperation, string> = {
  select: "MYSQL_ALLOW_SELECT",
  insert: "MYSQL_ALLOW_INSERT",
  update: "MYSQL_ALLOW_UPDATE",
  delete: "MYSQL_ALLOW_DELETE",
};

/**
 * Wraps a single MySQL connection created from a client-supplied DSN.
 *
 * The connection is created lazily (only when a tool actually queries) and is
 * meant to live for the duration of one request, then be closed. Credentials
 * are never logged or persisted.
 */
export class Database {
  private connection: Connection | null = null;

  constructor(
    private readonly config: DbConnectionConfig,
    private readonly options: DbOptions,
  ) {}

  private async getConnection(): Promise<Connection> {
    if (this.connection === null) {
      this.connection = await mysql.createConnection({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        connectTimeout: this.options.connectTimeoutMs,
        // Reject several statements in one string at the driver level.
        multipleStatements: false,
        // Return BIGINT and DECIMAL as strings to avoid precision loss.
        supportBigNumbers: true,
        bigNumberStrings: true,
        decimalNumbers: false,
      });
    }
    return this.connection;
  }

  /** Guard read/introspection behind the SELECT permission. */
  private requireRead(): void {
    if (!this.options.allowedOperations.select) {
      throw new Error(
        "Reading is disabled on this server. Set MYSQL_ALLOW_SELECT=true to allow " +
          "list_tables, describe_table and SELECT queries.",
      );
    }
  }

  async listTables(): Promise<string[]> {
    this.requireRead();
    const connection = await this.getConnection();
    const [rows] = await connection.query<RowDataPacket[]>("SHOW TABLES");
    // `SHOW TABLES` returns a single column whose name depends on the database.
    return rows.map((row) => String(Object.values(row)[0]));
  }

  async describeTable(table: string): Promise<RowDataPacket[]> {
    this.requireRead();
    // Validate the identifier against the live schema rather than interpolating
    // arbitrary input into SQL.
    const allowed = await this.listTables();
    if (!allowed.includes(table)) {
      throw new Error(`Unknown table: ${table}`);
    }
    const safeTable = table.replace(/`/g, "");
    const connection = await this.getConnection();
    const [rows] = await connection.query<RowDataPacket[]>(
      `SHOW FULL COLUMNS FROM \`${safeTable}\``,
    );
    return rows;
  }

  async runQuery(
    sql: string,
    params: SqlParam[],
  ): Promise<RowDataPacket[] | ResultSetHeader> {
    const normalized = stripLeadingComments(sql).trimStart();
    const operation = classifyStatement(normalized);

    if (operation === "other") {
      throw new Error(
        "Only SELECT, INSERT, UPDATE and DELETE statements are supported by this server.",
      );
    }

    if (!this.options.allowedOperations[operation]) {
      throw new Error(
        `${operation.toUpperCase()} statements are disabled on this server. ` +
          `Set ${OPERATION_ENV_VAR[operation]}=true to enable them.`,
      );
    }

    if (containsMultipleStatements(normalized)) {
      throw new Error("Multiple SQL statements are not allowed in a single query.");
    }

    const connection = await this.getConnection();
    const [result] =
      params.length > 0
        ? await connection.execute<RowDataPacket[] | ResultSetHeader>(sql, params)
        : await connection.query<RowDataPacket[] | ResultSetHeader>(sql);

    // Reads return an array of rows (capped to maxRows); writes return a
    // ResultSetHeader (affectedRows, insertId, ...) which we pass through as-is.
    return Array.isArray(result) ? result.slice(0, this.options.maxRows) : result;
  }

  async close(): Promise<void> {
    if (this.connection !== null) {
      const connection = this.connection;
      this.connection = null;
      try {
        await connection.end();
      } catch {
        // Ignore errors raised while closing a connection.
      }
    }
  }
}

/**
 * Strip leading line (`--`) and block (`/* *​/`) comments so a query cannot
 * disguise its real first keyword. Defense in depth only — the real boundary is
 * a read-only MySQL user (see the README).
 */
function stripLeadingComments(sql: string): string {
  let result = sql.trimStart();
  for (;;) {
    if (result.startsWith("--")) {
      const newline = result.indexOf("\n");
      result = newline === -1 ? "" : result.slice(newline + 1).trimStart();
    } else if (result.startsWith("/*")) {
      const end = result.indexOf("*/");
      result = end === -1 ? "" : result.slice(end + 2).trimStart();
    } else {
      return result;
    }
  }
}

/** The leading SQL keyword, lower-cased (e.g. "select", "insert"). */
function leadingKeyword(sql: string): string {
  return sql.toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
}

/**
 * Classify a statement by its leading keyword into one of the four configurable
 * operations, or "other" for anything we don't expose (CREATE, DROP, ALTER,
 * TRUNCATE, REPLACE, ...). This is a lightweight gate; the real boundary is the
 * MySQL user's grants (see the README).
 *
 * A `WITH` (CTE) is treated as a read, matching its most common use. A CTE that
 * ultimately drives a write still depends on the database user holding that
 * privilege, which is where such cases should be stopped.
 */
function classifyStatement(sql: string): SqlOperation | "other" {
  const keyword = leadingKeyword(sql);
  if (READ_KEYWORDS.includes(keyword)) return "select";
  if (keyword === "insert") return "insert";
  if (keyword === "update") return "update";
  if (keyword === "delete") return "delete";
  return "other";
}

/**
 * Reject any non-trailing semicolon. The driver already refuses multiple
 * statements; this just yields a clearer error. A semicolon inside a string
 * literal is a known false positive.
 */
function containsMultipleStatements(sql: string): boolean {
  const withoutTrailingSemicolon = sql.replace(/;\s*$/, "");
  return withoutTrailingSemicolon.includes(";");
}
