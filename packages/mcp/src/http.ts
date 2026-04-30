import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID } from "node:crypto";
import { registerTools } from "./tools.js";

const PORT = process.env.MCP_HTTP_PORT ? parseInt(process.env.MCP_HTTP_PORT) : 3456;
const SESSION_TTL_MS = 30 * 60 * 1000;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Session>();

function evict(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) {
    clearTimeout(s.timer);
    sessions.delete(sessionId);
  }
}

function touch(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => evict(sessionId), SESSION_TTL_MS);
}

const app = createMcpExpressApp();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    touch(sessionId);
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = new McpServer({ name: "usage-analyzer", version: "1.0.0" });
  registerTools(server);
  await server.connect(transport);

  transport.onclose = () => {
    if (transport.sessionId) evict(transport.sessionId);
  };

  await transport.handleRequest(req, res, req.body);

  if (transport.sessionId) {
    const timer = setTimeout(() => evict(transport.sessionId!), SESSION_TTL_MS);
    sessions.set(transport.sessionId, { server, transport, timer });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: "No active session. Send POST /mcp to initialize." });
    return;
  }
  touch(sessionId);
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: "Session not found." });
    return;
  }
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
  evict(sessionId);
});

app.listen(PORT, () => {
  process.stderr.write(`MCP HTTP server listening on http://127.0.0.1:${PORT}/mcp\n`);
  process.stderr.write(`Register in Claude.ai: expose via ngrok (ngrok http ${PORT}), then add https://<id>.ngrok-free.app/mcp\n`);
});
