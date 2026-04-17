// NEXUS MCP Server — expose NEXUS tools as a Model Context Protocol server
//
// Start with: nexus mcp
// Or programmatically: startMcpServer()
//
// Implements MCP over stdio (JSON-RPC 2.0). Compatible with Claude Desktop/Code.
// Spec: https://modelcontextprotocol.io/specification
//
// SECURITY (CRIT-4):
// - stdio mode: trust boundary is the parent process (Claude Desktop spawns us).
//   No auth needed — the stdio channel itself is the authentication.
// - HTTP mode: disabled by default. To enable, set NEXUS_MCP_HTTP=1 and provide
//   NEXUS_MCP_TOKEN=<token> in the environment. Clients MUST send
//   `Authorization: Bearer <token>` on every request. Without the env var HTTP
//   mode refuses to start, so a local attacker can't silently bind the port.

import { createInterface } from 'node:readline';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { toolDefinitions } from '../tools/definitions.js';

const log = createLogger('MCPServer');

// ── JSON-RPC types ─────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP Protocol constants ─────────────────────────────────────────────────

const MCP_VERSION = '2024-11-05';

// ── Tool handler — dispatches to NEXUS tool executor if available ──────────

let toolExecutor: { execute: (name: string, args: Record<string, unknown>) => Promise<string> } | null = null;

export function setMcpToolExecutor(
  executor: { execute: (name: string, args: Record<string, unknown>) => Promise<string> },
): void {
  toolExecutor = executor;
}

// ── Server ─────────────────────────────────────────────────────────────────

export function startMcpServer(): void {
  log.info('Starting NEXUS MCP server on stdio');

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }

    const response = await handleRequest(request);
    if (response !== null) {
      sendResponse(response);
    }
  });

  rl.on('close', () => {
    log.info('MCP server: stdin closed, exiting');
    process.exit(0);
  });

  // Send initialize notification on start
  log.info('NEXUS MCP server ready — waiting for requests on stdin');
}

function sendResponse(resp: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + '\n');
}

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: MCP_VERSION,
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: 'nexus',
            version: '1.0.0',
          },
        },
      };

    case 'notifications/initialized':
      // Client confirms initialization — no response needed
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: toolDefinitions.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: {
              type: 'object',
              properties: t.parameters.properties,
              required: t.parameters.required,
            },
          })),
        },
      };

    case 'tools/call': {
      const toolName = String((params as Record<string, unknown>)?.name ?? '');
      const toolArgs = ((params as Record<string, unknown>)?.arguments ?? {}) as Record<string, unknown>;

      if (!toolName) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: 'Missing tool name' },
        };
      }

      // Verify tool exists
      const toolDef = toolDefinitions.find((t) => t.name === toolName);
      if (!toolDef) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` },
        };
      }

      if (!toolExecutor) {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'Tool executor not initialized — start NEXUS first',
          },
        };
      }

      try {
        const result = await toolExecutor.execute(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: result }],
            isError: result.startsWith('Error:'),
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          },
        };
      }
    }

    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };

    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ── HTTP mode (optional, opt-in, authenticated) ────────────────────────────
// Disabled unless the env var NEXUS_MCP_HTTP=1 is set. Requires bearer token
// via NEXUS_MCP_TOKEN (if unset, we generate a random one and print it to
// stderr for the user to copy). Binds to 127.0.0.1 only (never 0.0.0.0).

function timingSafeTokenMatch(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function startMcpHttpServer(port = 3333): Promise<void> {
  // Opt-in guard — HTTP is a network exposure and must be explicitly enabled.
  if (process.env.NEXUS_MCP_HTTP !== '1') {
    log.warn(
      'MCP HTTP mode is disabled. Set NEXUS_MCP_HTTP=1 to enable. Refusing to bind the port.',
    );
    throw new Error(
      'NEXUS MCP HTTP mode is disabled. Set NEXUS_MCP_HTTP=1 (and NEXUS_MCP_TOKEN=<secret>) to enable.',
    );
  }

  const token =
    process.env.NEXUS_MCP_TOKEN ??
    (() => {
      const generated = randomBytes(24).toString('hex');
      // Write to stderr so it doesn't pollute a caller's stdout-parsing.
      process.stderr.write(
        `[nexus-mcp] No NEXUS_MCP_TOKEN set. Generated token for this session:\n` +
          `  ${generated}\n` +
          `Use it as: Authorization: Bearer ${generated}\n`,
      );
      return generated;
    })();

  log.info({ port }, 'Starting NEXUS MCP HTTP server (auth enabled, 127.0.0.1 only)');

  const { createServer } = await import('node:http');

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // AuthN: require bearer token on every request. Use timing-safe compare.
    const auth = req.headers['authorization'];
    const provided = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length).trim()
      : undefined;
    if (!timingSafeTokenMatch(token, provided)) {
      log.warn({ remote: req.socket.remoteAddress }, 'MCP HTTP: unauthenticated request rejected');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(body) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const response = await handleRequest(request);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // No wildcard CORS — localhost only, no cross-origin browsers should be
        // reaching this endpoint at all. If they are, it's an attack.
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(response ?? { jsonrpc: '2.0', id: request.id, result: {} }));
    });
  });

  // Bind to loopback explicitly — we never want this on a non-local interface.
  server.listen(port, '127.0.0.1', () => {
    log.info({ port }, 'MCP HTTP server listening on 127.0.0.1');
    process.stderr.write(`[nexus-mcp] Listening on http://127.0.0.1:${port} (auth required)\n`);
  });
}
