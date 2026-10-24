import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { INTERNAL_MCP_TOKEN_PREFIX } from './internal-mcp-capabilities.js';
import { SEND_TO_TARGET_TOOL_NAME } from '@line-agent/contracts';
import { REQUEST_PERMISSION_TOOL_NAME, type McpService } from './mcp-service.js';

export const MCP_HTTP_HOST = '127.0.0.1' as const;
export const DEFAULT_MCP_HTTP_PORT = 38471;
export const MAX_MCP_BODY_BYTES = 64 * 1024;
export const MAX_MCP_OPEN_SOCKETS = 32;
export const MCP_REQUEST_TIMEOUT_MS = 5_000;
export const MCP_SHUTDOWN_TIMEOUT_MS = 2_000;
/** Backstop for the internal permission prompt: the policy's maximum approval timeout (900 s) plus margin. */
export const MCP_APPROVAL_REQUEST_TIMEOUT_MS = 905_000;

export interface McpHttpServerOptions {
  onDiagnostic?: () => void;
  port?: number;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  approvalRequestTimeoutMs?: number;
  sendRequestTimeoutMs?: number;
  unref?: boolean;
}

/** Backstop for an internal send_to_target call, which waits for a paced queue of LINE sends (budget 600 s) plus margin. */
export const MCP_SEND_REQUEST_TIMEOUT_MS = 605_000;

function isInternalToolCall(body: unknown, toolName: string): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const rpc = body as { method?: unknown; params?: unknown };
  return rpc.method === 'tools/call' && !!rpc.params && typeof rpc.params === 'object'
    && (rpc.params as { name?: unknown }).name === toolName;
}
const isPermissionPromptCall = (body: unknown): boolean => isInternalToolCall(body, REQUEST_PERMISSION_TOOL_NAME);
const isSendToTargetCall = (body: unknown): boolean => isInternalToolCall(body, SEND_TO_TARGET_TOOL_NAME);

export class McpHttpServer {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private closing = false;
  /** Identifies this listener generation; internal capabilities are bound to it. */
  private readonly instanceId = randomUUID();
  private shutdownPromise: Promise<void> | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly inFlightResponses = new Set<ServerResponse>();
  private readonly inFlightControllers = new Set<AbortController>();
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly approvalRequestTimeoutMs: number;
  private readonly sendRequestTimeoutMs: number;

  constructor(
    private readonly mcpService: McpService,
    private readonly options: McpHttpServerOptions = {},
  ) {
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_MCP_BODY_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    this.approvalRequestTimeoutMs = options.approvalRequestTimeoutMs ?? MCP_APPROVAL_REQUEST_TIMEOUT_MS;
    this.sendRequestTimeoutMs = options.sendRequestTimeoutMs ?? MCP_SEND_REQUEST_TIMEOUT_MS;
  }

  /** Opaque listener-instance id for binding built-in Agent capabilities. */
  get endpointInstance(): string { return this.instanceId; }

  status(): {
    running: boolean;
    endpoint: string | null;
    host: '127.0.0.1';
    port: number | null;
  } {
    const running = this.server !== null && !this.closing && this.boundPort !== null;
    return {
      running,
      endpoint: running ? `http://${MCP_HTTP_HOST}:${this.boundPort}/mcp` : null,
      host: MCP_HTTP_HOST,
      port: running ? this.boundPort : null,
    };
  }

  async start(): Promise<void> {
    if (this.server || this.closing) return;
    const preferredPort = this.options.port ?? DEFAULT_MCP_HTTP_PORT;
    try {
      await this.listenOnPort(preferredPort);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (this.options.port === undefined && code === 'EADDRINUSE') {
        await this.listenOnPort(0);
        return;
      }
      throw error;
    }
  }

  private listenOnPort(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      srv.maxConnections = MAX_MCP_OPEN_SOCKETS;
      srv.keepAliveTimeout = 1_000;
      srv.headersTimeout = Math.min(this.requestTimeoutMs, 5_000);
      srv.requestTimeout = this.requestTimeoutMs;

      const onConnection = (socket: Socket) => {
        if (this.closing || this.sockets.size >= MAX_MCP_OPEN_SOCKETS) {
          socket.destroy();
          return;
        }
        this.sockets.add(socket);
        socket.once('close', () => {
          this.sockets.delete(socket);
        });
      };
      srv.on('connection', onConnection);

      const onError = (error: Error) => {
        srv.removeListener('listening', onListening);
        srv.removeListener('connection', onConnection);
        // Failed bind attempts still own a Server object; explicitly close it
        // so startup rollback does not leave a pending handle behind.
        try { srv.close(() => reject(error)); }
        catch { reject(error); /* server never reached listening */ }
      };
      const onListening = () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        this.boundPort = typeof addr === 'object' && addr ? addr.port : port;
        this.server = srv;
        if (this.options.unref) {
          srv.unref();
        }
        resolve();
      };

      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, MCP_HTTP_HOST);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closing) {
      this.sendJson(res, 503, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'MCP server is shutting down.' },
      });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${MCP_HTTP_HOST}`);
    if (url.pathname !== '/mcp') {
      this.sendJson(res, 404, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32601, message: 'Not Found. Use POST /mcp.' },
      });
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      this.sendJson(res, 405, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Method Not Allowed. Use POST /mcp.' },
      });
      return;
    }

    this.inFlightResponses.add(res);
    const controller = new AbortController();
    this.inFlightControllers.add(controller);
    res.once('close', () => {
      this.inFlightResponses.delete(res);
      if (!res.writableEnded) controller.abort(new Error('MCP client disconnected'));
      this.inFlightControllers.delete(controller);
    });
    req.once('aborted', () => controller.abort(new Error('MCP client disconnected')));

    const onTimeout = () => {
      timer = undefined;
      if (!res.writableEnded) {
        controller.abort(new Error('MCP request timed out'));
        this.sendJson(res, 504, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'MCP request timed out.' },
        });
      }
      req.destroy();
    };
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(onTimeout, this.requestTimeoutMs);

    try {
      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader) {
        const declaredLength = Number(contentLengthHeader);
        if (Number.isFinite(declaredLength) && declaredLength > this.maxBodyBytes) {
          this.sendJson(res, 413, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32600, message: 'Request payload exceeds 64 KiB limit.' },
          });
          req.resume();
          return;
        }
      }

      const rawBody = await this.readBoundedBody(req);
      if (rawBody === null) {
        this.sendJson(res, 413, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Request payload exceeds 64 KiB limit.' },
        });
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        this.sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON.' },
        });
        return;
      }

      const authHeader = req.headers.authorization;
      const bearerMatch =
        typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader.trim()) : null;
      const bearerToken = bearerMatch?.[1]?.trim() ?? null;

      // A built-in Agent permission prompt waits for the operator, bounded by the broker's policy timeout (<= 900 s);
      // only that internal call gets the longer backstop. Every other request keeps the short deadline.
      if (bearerToken?.startsWith(INTERNAL_MCP_TOKEN_PREFIX) && isPermissionPromptCall(parsedBody) && timer) {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, this.approvalRequestTimeoutMs);
      } else if (bearerToken?.startsWith(INTERNAL_MCP_TOKEN_PREFIX) && isSendToTargetCall(parsedBody) && timer) {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, this.sendRequestTimeoutMs);
      }

      const response = bearerToken?.startsWith(INTERNAL_MCP_TOKEN_PREFIX)
        ? await this.mcpService.handleInternalJsonRpc(bearerToken, this.instanceId, parsedBody, controller.signal)
        : await this.mcpService.handleExternalJsonRpc(bearerToken, parsedBody, controller.signal);
      if (res.writableEnded) return;
      if (response.body === null) {
        res.statusCode = response.httpStatus;
        res.end();
        return;
      }
      this.sendJson(res, response.httpStatus, response.body);
    } catch {
      if (!res.writableEnded) {
        try { this.options.onDiagnostic?.(); } catch { /* Transport results cannot depend on observation. */ }
        this.sendJson(res, 500, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'Internal MCP transport error.' },
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlightResponses.delete(res);
      this.inFlightControllers.delete(controller);
    }
  }

  private readBoundedBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let overflowed = false;

      const onData = (chunk: Buffer | string) => {
        if (overflowed) return;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        totalBytes += buf.byteLength;
        if (totalBytes > this.maxBodyBytes) {
          overflowed = true;
          chunks.length = 0;
          resolve(null);
          return;
        }
        chunks.push(buf);
      };

      const onEnd = () => {
        if (overflowed) return;
        resolve(Buffer.concat(chunks).toString('utf8'));
      };

      const onError = (error: Error) => {
        if (overflowed) return;
        reject(error);
      };

      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
    });
  }

  private sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
    if (res.writableEnded) return;
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
    res.end(body);
  }

  shutdown(): Promise<void> {
    this.closing = true;
    return (this.shutdownPromise ??= (async () => {
      const srv = this.server;
      this.server = null;
      this.boundPort = null;
      for (const controller of this.inFlightControllers) controller.abort(new Error('MCP HTTP server shutting down'));
      if (!srv) return;

      for (const res of this.inFlightResponses) {
        if (!res.writableEnded) {
          res.destroy();
        }
      }
      this.inFlightResponses.clear();

      let forceDestroyTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          srv.close(() => resolve());
          for (const socket of this.sockets) {
            socket.destroy();
          }
        }),
        new Promise<void>((resolve) => {
          forceDestroyTimer = setTimeout(() => {
            for (const socket of this.sockets) {
              socket.destroy();
            }
            resolve();
          }, MCP_SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
      if (forceDestroyTimer) clearTimeout(forceDestroyTimer);
      this.sockets.clear();
    })());
  }
}
