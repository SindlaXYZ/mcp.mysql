# mysql-mcp

A generic, always-on [Model Context Protocol](https://modelcontextprotocol.io) server that exposes **read-only** access to a MySQL database over **Streamable HTTP**. It is built to be hosted (e.g. on Render) and loaded into Claude Desktop / Claude Code as a remote connector.

The key design point: **the server does not know which database to connect to.** Each client supplies its own MySQL credentials per connection, as an HTTP header. The server is a stateless gateway — it stores no database credentials.

## How it works

Every request to `POST /mcp` carries two headers:

| Header | Purpose |
| --- | --- |
| `Authorization: Bearer <token>` | Authenticates to *this server* (the endpoint gate). Required when `MCP_AUTH_TOKEN` is set. |
| `X-DB-DSN: mysql://user:password@host:3306/database` | The database *this client* wants to query. URL-encode special characters in the user/password. |

The server reads the DSN, opens a short-lived connection, runs the requested read-only query, returns the rows, and closes the connection. Credentials are never logged or persisted.

## Tools exposed

| Tool | Description |
| --- | --- |
| `list_tables` | Lists all tables in the connected database. |
| `describe_table` | Columns, types, keys and comments for one table (validated against the live schema). |
| `run_query` | Runs a single read-only SQL statement and returns rows as JSON. Uses `?` placeholders + bound parameters. |

## Requirements

- Node.js 20 or newer.

## Local development

```bash
npm install
npm run build
node --env-file=.env dist/index.js     # uses .env (copy from .env.example)
```

Or with live reload: `npm run dev` (export the env vars in your shell first).

Test it without a client using the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
# then connect to http://localhost:3000/mcp, transport "Streamable HTTP",
# and add the Authorization + X-DB-DSN headers in the Inspector UI.
```

## Deploy to Render

1. Push this project to a GitHub/GitLab repository that Render can access.
2. In Render: **New → Blueprint**, point it at the repo. The included `render.yaml` provisions a Node web service, sets the health check to `/healthz`, and generates a random `MCP_AUTH_TOKEN` for you.
   - Prefer the dashboard? Create a **Web Service** instead, set Build Command `npm install && npm run build`, Start Command `npm start`, Health Check Path `/healthz`, and add the env vars from the table below.
3. After deploy, your endpoint is:

   ```
   https://<your-service>.onrender.com/mcp
   ```

   TLS is automatic. You can also attach a custom domain (`https://mcp.example.com/mcp`).
4. Copy the generated `MCP_AUTH_TOKEN` from the Render dashboard (Environment tab) — clients need it.

**Free tier caveat:** free web services sleep after ~15 minutes of inactivity and take 30–60s to wake up, so the first client connection after a pause may be slow or time out (it usually succeeds on retry). For an always-on demo, switch the plan to **Starter ($7/mo)** in `render.yaml` or the dashboard.

## Use it from a Claude client

Use your real endpoint URL, token, and DSN below.

### Claude Code (native remote support)

```bash
claude mcp add --transport http mysql https://<your-service>.onrender.com/mcp \
  --header "Authorization: Bearer YOUR_ENDPOINT_TOKEN" \
  --header "X-DB-DSN: mysql://reader:password@db.example.com:3306/mydb"
```

Verify with `claude mcp list`; reconnect in a session with `/mcp`.

### Claude Desktop (via `mcp-remote`)

Claude Desktop's native custom-connector UI only does OAuth, so to pass credential headers use the `mcp-remote` bridge. Edit `claude_desktop_config.json` (Windows: `%APPDATA%\Claude\…`, macOS: `~/Library/Application Support/Claude/…`):

```json
{
  "mcpServers": {
    "mysql": {
      "command": "npx",
      "args": [
        "mcp-remote@latest",
        "https://<your-service>.onrender.com/mcp",
        "--header", "Authorization:${MCP_AUTH}",
        "--header", "X-DB-DSN:${DB_DSN}"
      ],
      "env": {
        "MCP_AUTH": "Bearer YOUR_ENDPOINT_TOKEN",
        "DB_DSN": "mysql://reader:password@db.example.com:3306/mydb"
      }
    }
  }
}
```

Header values are kept in `env` and referenced with `${...}` because `mcp-remote` splits a `--header` argument on its first colon — keeping the value in a variable avoids surprises. Restart Claude Desktop after saving. Requires Node.js on the machine running Claude Desktop.

## Configuration (server env vars)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. Render injects this automatically. |
| `MCP_AUTH_TOKEN` | (unset) | Bearer token required on every request. If unset, the endpoint is **open**. |
| `MYSQL_READONLY` | `true` | Block any non-read statement. |
| `MYSQL_MAX_ROWS` | `1000` | Max rows returned per query. |
| `MYSQL_CONNECT_TIMEOUT_MS` | `10000` | MySQL connection timeout. |
| `ALLOWED_DB_HOSTS` | (unset) | Comma-separated allowlist of DB hosts. Unset = any host. |

## Security model

A public endpoint that connects to arbitrary databases with client-supplied credentials needs care:

- **HTTPS only.** On Render this is automatic; never expose it over plain HTTP — the credentials travel in headers.
- **Set `MCP_AUTH_TOKEN`.** Without it, anyone who finds the URL can use your server as a proxy to reach any reachable database. The token is the gate that keeps that to people you trust.
- **Use a read-only database user.** This is the real boundary. On the database side, grant `SELECT` only:
  ```sql
  CREATE USER 'mcp_readonly'@'%' IDENTIFIED BY 'a_strong_password';
  GRANT SELECT ON my_database.* TO 'mcp_readonly'@'%';
  FLUSH PRIVILEGES;
  ```
- **Credentials are never logged or stored.** The DSN lives only for the duration of one request.
- **`ALLOWED_DB_HOSTS`** limits which hosts clients may target — defense against using the gateway to probe internal networks (SSRF).
- For production, also add **rate limiting** in front of the service and consider Render's static outbound IPs so target databases can firewall by IP.

## Notes

- **Stateless transport** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`): a fresh MCP server is built per request and replies with plain JSON — robust behind a PaaS proxy and resilient to the service sleeping.
- The server **listens on `0.0.0.0` and `process.env.PORT`**, as Render requires.
- `GET`/`DELETE` on `/mcp` return `405` — this stateless endpoint is POST-only.
- Built on the MCP SDK v1.x (`@modelcontextprotocol/sdk`), the version recommended for production while v2 is still pre-alpha.
