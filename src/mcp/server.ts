// NEXUS MCP Server — expose NEXUS tools as a Model Context Protocol server
//
// Start with: nexus mcp
// Or programmatically: startMcpServer()
//
// Implements MCP over stdio (JSON-RPC 2.0). Compatible with Claude Desktop/Code.
// Spec: https://modelcontextprotocol.io/specification

import { createInterface } from 'node:readline';
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

// ── HTTP mode (optional) ───────────────────────────────────────────────────

export async function startMcpHttpServer(port = 3333): Promise<void> {
  log.info({ port }, 'Starting NEXUS MCP HTTP server');

  const { createServer } = await import('node:http');

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
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
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify(response ?? { jsonrpc: '2.0', id: request.id, result: {} }));
    });
  });

  server.listen(port, () => {
    log.info({ port }, 'MCP HTTP server listening');
    console.log(`NEXUS MCP server running at http://localhost:${port}`);
  });
}
