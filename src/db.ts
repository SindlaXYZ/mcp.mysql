import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

/** Parsed connection target, derived from a client-supplied DSN. */
export interface DbConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Server-controlled behaviour applied to every connection. */
export interface DbOptions {
  readOnly: boolean;
  maxRows: number;
  connectTimeoutMs: number;
}

/** Scalar value types that can be safely bound to a `?` placeholder. */
export type SqlParam = string | number | boolean | null;

/** Statement prefixes considered read-only. */
const READ_ONLY_PREFIXES = ["select", "show", "describe", "desc", "explain", "with"];

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

  async listTables(): Promise<string[]> {
    const connection = await this.getConnection();
    const [rows] = await connection.query<RowDataPacket[]>("SHOW TABLES");
    // `SHOW TABLES` returns a single column whose name depends on the database.
    return rows.map((row) => String(Object.values(row)[0]));
  }

  async describeTable(table: string): Promise<RowDataPacket[]> {
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

  async runQuery(sql: string, params: SqlParam[]): Promise<RowDataPacket[]> {
    const normalized = stripLeadingComments(sql).trimStart();

    if (this.options.readOnly && !isReadOnly(normalized)) {
      throw new Error(
        "Only read-only statements (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) " +
          "are allowed while read-only mode is enabled.",
      );
    }

    if (containsMultipleStatements(normalized)) {
      throw new Error("Multiple SQL statements are not allowed in a single query.");
    }

    const connection = await this.getConnection();
    const [rows] =
      params.length > 0
        ? await connection.execute<RowDataPacket[]>(sql, params)
        : await connection.query<RowDataPacket[]>(sql);

    return Array.isArray(rows) ? rows.slice(0, this.options.maxRows) : rows;
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

function isReadOnly(sql: string): boolean {
  const firstWord = sql.toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
  return READ_ONLY_PREFIXES.includes(firstWord);
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
