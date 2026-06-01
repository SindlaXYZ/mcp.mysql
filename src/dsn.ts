import type { DbConnectionConfig } from "./db.js";

/**
 * Parse a client-supplied DSN of the form
 *   mysql://user:password@host:3306/database
 * into a connection config. Special characters in the username/password must be
 * URL-encoded by the client.
 *
 * If `allowedHosts` is non-null, the DSN host must be a member of it; this is a
 * guard against the server being used as an open proxy to arbitrary databases.
 */
export function parseDsn(dsn: string, allowedHosts: string[] | null): DbConnectionConfig {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("Invalid DSN: expected a URL like mysql://user:password@host:3306/database");
  }

  if (url.protocol !== "mysql:") {
    throw new Error('Invalid DSN: the protocol must be "mysql:".');
  }

  const host = decodeURIComponent(url.hostname);
  if (host === "") {
    throw new Error("Invalid DSN: missing host.");
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database === "") {
    throw new Error("Invalid DSN: missing database name (mysql://user:pass@host/<database>).");
  }

  if (allowedHosts !== null && !allowedHosts.includes(host)) {
    throw new Error(`Database host "${host}" is not allowed by this server.`);
  }

  return {
    host,
    port: url.port !== "" ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}
