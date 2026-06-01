import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { parseDsn } from "./dsn.js";
import { registerTools } from "./tools.js";

const config = loadConfig();

const app = express();
app.use(express.json());

function firstHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

/** Gate the endpoint behind a bearer token when MCP_AUTH_TOKEN is configured. */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (config.authToken === null) {
    next();
    return;
  }
  const header = firstHeader(req, "authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match === null || !timingSafeEqual(match[1], config.authToken)) {
    res.status(401).json(jsonRpcError(-32001, "Unauthorized: missing or invalid bearer token."));
    return;
  }
  next();
}

// Health check for Render.
app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// Stateless MCP endpoint: build a fresh server + transport for each request.
app.post("/mcp", requireAuth, async (req: Request, res: Response) => {
  let db: Database | null = null;
  try {
    const dsn = firstHeader(req, "x-db-dsn");
    if (dsn !== undefined && dsn.trim() !== "") {
      const dbConfig = parseDsn(dsn, config.allowedDbHosts);
      db = new Database(dbConfig, {
        readOnly: config.readOnly,
        maxRows: config.maxRows,
        connectTimeoutMs: config.connectTimeoutMs,
      });
    }
  } catch (error) {
    res.status(400).json(jsonRpcError(-32602, error instanceof Error ? error.message : "Invalid DSN."));
    return;
  }

  const server = new McpServer({ name: "mysql-mcp", version: "0.1.0" });
  registerTools(server, db, { maxRows: config.maxRows });

  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session is kept between requests.
    sessionIdGenerator: undefined,
    // Reply with plain application/json instead of an SSE stream — simpler and
    // more robust behind a PaaS proxy like Render.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
    if (db !== null) {
      void db.close();
    }
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json(jsonRpcError(-32603, "Internal server error."));
    }
  }
});

// The stateless endpoint only supports POST.
function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json(jsonRpcError(-32000, "Method not allowed. Use POST against the /mcp endpoint."));
}
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(config.port, "0.0.0.0", () => {
  console.error(
    `mysql-mcp listening on 0.0.0.0:${config.port} ` +
      `(read-only: ${config.readOnly}, ` +
      `auth: ${config.authToken !== null ? "on" : "OFF — set MCP_AUTH_TOKEN"}, ` +
      `host allowlist: ${config.allowedDbHosts !== null ? config.allowedDbHosts.join(", ") : "none"})`,
  );
});
