/**
 * 网关服务器核心逻辑，包含 HTTP 请求处理和 WebSocket 连接管理
 * 1. createBunGatewayHandlers: 创建适用于 Bun 的 HTTP 和 WebSocket 处理器，替代原有的 createGatewayHttpServer 和 attachGatewayUpgradeHandler
 * 2. 授权检查工具函数：提供鉴权相关的辅助函数，如 authorizeCanvasRequest 等
 * 3. Bun 原生 WebSocket 到传统 'ws' 库的兼容封装：定义 BunWs 和 BunWebSocketServer 类，模拟 'ws' 的接口以复用现有逻辑
 * 4. 效率比 node.js 高几倍，但需要适配 Bun 的 Request/Response 模型和 WebSocket 事件
 */
import type { Server as BunServer, ServerWebSocket } from "bun";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import {
  A2UI_PATH,
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
} from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { loadConfig } from "../config/config.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { handleSlackHttpRequest } from "../slack/http/index.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { CANVAS_CAPABILITY_TTL_MS } from "./canvas-capability.js";
import {
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
  type ControlUiRootState,
} from "./control-ui.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  isHookAgentAllowed,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import { getBearerToken } from "./http-utils.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import { GATEWAY_CLIENT_MODES, normalizeGatewayClientMode } from "./protocol/client-info.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

// ============================================================================
// 1. Bun 原生 WebSocket 到传统 'ws' 库的兼容封装
// ============================================================================
export class BunWs extends EventEmitter {
  public _socket: { remoteAddress?: string };
  constructor(public rawWs: ServerWebSocket<unknown>) {
    super();
    const data = rawWs.data as { req?: { socket?: { remoteAddress?: string } } } | undefined;
    this._socket = { remoteAddress: data?.req?.socket?.remoteAddress };
  }
  send(data: string | Buffer) {
    this.rawWs.send(data);
  }
  close(code?: number, reason?: string) {
    this.rawWs.close(code, reason);
  }
  terminate() {
    this.rawWs.close();
  }
  get readyState() {
    return this.rawWs.readyState; // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
  }
}

export class BunWebSocketServer extends EventEmitter {
  public clients = new Set<BunWs>();

  handleOpen(rawWs: ServerWebSocket<unknown>) {
    const shim = new BunWs(rawWs);
    const data = rawWs.data as
      | { shim?: BunWs; req?: IncomingMessage & { remoteAddress?: string } }
      | undefined;
    if (data) {
      data.shim = shim;
    }
    this.clients.add(shim);
    this.emit("connection", shim, data?.req);
  }
  handleMessage(rawWs: ServerWebSocket<unknown>, message: string | Buffer) {
    const data = rawWs.data as { shim?: BunWs } | undefined;
    data?.shim?.emit("message", message);
  }
  handleClose(rawWs: ServerWebSocket<unknown>, code: number, reason: string) {
    const data = rawWs.data as { shim?: BunWs } | undefined;
    if (data?.shim) {
      this.clients.delete(data.shim);
      data.shim.emit("close", code, reason);
    }
  }
}

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// ============================================================================
// 鉴权工具函数
// ============================================================================
function isCanvasPath(pathname: string): boolean {
  return (
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`) ||
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === CANVAS_WS_PATH
  );
}

function isNodeWsClient(client: GatewayWsClient): boolean {
  if (client.connect.role === "node") {
    return true;
  }
  return normalizeGatewayClientMode(client.connect.client.mode) === GATEWAY_CLIENT_MODES.NODE;
}

function hasAuthorizedNodeWsClientForCanvasCapability(
  clients: Set<GatewayWsClient>,
  capability: string,
): boolean {
  const nowMs = Date.now();
  for (const client of clients) {
    if (!isNodeWsClient(client)) {
      continue;
    }
    if (!client.canvasCapability || !client.canvasCapabilityExpiresAtMs) {
      continue;
    }
    if (client.canvasCapabilityExpiresAtMs <= nowMs) {
      continue;
    }
    if (safeEqualSecret(client.canvasCapability, capability)) {
      // Sliding expiration while the connected node keeps using canvas.
      client.canvasCapabilityExpiresAtMs = nowMs + CANVAS_CAPABILITY_TTL_MS;
      return true;
    }
  }
  return false;
}

async function authorizeCanvasRequest(params: {
  req: IncomingMessage; // 适配 pseudoReq
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  clients: Set<GatewayWsClient>;
  canvasCapability?: string;
  malformedScopedPath?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<GatewayAuthResult> {
  const {
    req,
    auth,
    trustedProxies,
    allowRealIpFallback,
    clients,
    canvasCapability,
    malformedScopedPath,
    rateLimiter,
  } = params;
  if (malformedScopedPath) {
    return { ok: false, reason: "unauthorized" };
  }
  if (isLocalDirectRequest(req, trustedProxies, allowRealIpFallback)) {
    return { ok: true };
  }

  let lastAuthFailure: GatewayAuthResult | null = null;
  const token = getBearerToken(req);
  if (token) {
    const authResult = await authorizeHttpGatewayConnect({
      auth: { ...auth, allowTailscale: false },
      connectAuth: { token, password: token },
      req,
      trustedProxies,
      allowRealIpFallback,
      rateLimiter,
    });
    if (authResult.ok) {
      return authResult;
    }
    lastAuthFailure = authResult;
  }

  if (canvasCapability && hasAuthorizedNodeWsClientForCanvasCapability(clients, canvasCapability)) {
    return { ok: true };
  }
  return lastAuthFailure ?? { ok: false, reason: "unauthorized" };
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, bindHost, port, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });

  const resolveHookClientKey = (req: IncomingMessage): string => {
    return normalizeRateLimitClientIp(req.socket?.remoteAddress);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      if (!throttle.allowed) {
        const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const runId = dispatchAgentHook({
        ...normalized.value,
        sessionKey: sessionKey.value,
        agentId: resolveHookTargetAgentId(hooksConfig, normalized.value.agentId),
      });
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source: "mapping",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            agentId: resolveHookTargetAgentId(hooksConfig, mapped.action.agentId),
            wakeMode: mapped.action.wakeMode,
            sessionKey: sessionKey.value,
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

// ============================================================================
// 统一网关处理器 (替代原有的 createGatewayHttpServer 和 attachGatewayUpgradeHandler)
// ============================================================================
export function createBunGatewayHandlers(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler; // 建议后续重构为接收 Request 返回 Response
  handlePluginRequest?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  wss: BunWebSocketServer; // 传入 Bun WebSocket
}) {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth,
    rateLimiter,
    wss,
  } = opts;

  return {
    async fetch(req: Request, server: BunServer): Promise<Response> {
      const url = new URL(req.url ?? "/", "http://localhost");

      // 1. WebSocket 升级与鉴权拦截
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        // 🔥 核心修复：将构造带有完整 headers 的伪装请求提取到最外层！
        // 这样不仅 Canvas，底部的核心网关连接也能正确拿到 Host 和 Origin
        const pseudoWsReq = {
          headers: Object.fromEntries(req.headers.entries()),
          socket: { remoteAddress: server.requestIP(req)?.address },
          url: url.pathname + url.search,
          method: req.method,
        } as unknown as IncomingMessage;

        if (canvasHost) {
          if (url.pathname === CANVAS_WS_PATH) {
            const configSnapshot = loadConfig();
            const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];

            const ok = await authorizeCanvasRequest({
              req: pseudoWsReq,
              auth: resolvedAuth,
              trustedProxies,
              clients,
              rateLimiter,
            });

            if (!ok.ok) {
              if (ok.rateLimited) {
                const retryAfter =
                  ok.retryAfterMs && ok.retryAfterMs > 0
                    ? Math.ceil(ok.retryAfterMs / 1000)
                    : undefined;
                return new Response(
                  JSON.stringify({
                    error: {
                      message: "Too many failed authentication attempts.",
                      type: "rate_limited",
                    },
                  }),
                  {
                    status: 429,
                    headers: {
                      "Content-Type": "application/json; charset=utf-8",
                      ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
                    },
                  },
                );
              }
              return new Response("Unauthorized", { status: 401 });
            }

            // 挂载 Canvas 专属标识，并交由 Bun 升级
            if (server.upgrade(req, { data: { req: pseudoWsReq, isCanvas: true } })) {
              return new Response();
            }
          }
        }

        // 交由 Bun 原生引擎接管 WebSocket
        if (server.upgrade(req, { data: { req: pseudoWsReq, isCanvas: false } })) {
          return new Response();
        }
        return new Response("WebSocket Upgrade Failed", { status: 500 });
      }

      // ======================================================================
      // 2. HTTP 路由 (通过 Promise 包装，完美模拟 Node.js Req/Res 模型)
      // ======================================================================
      return new Promise<Response>((resolve) => {
        void (async () => {
          let hasResolved = false;

          // 预读取 Body 以支持旧版 req.on('data') 流式读取
          let bodyBuffer = Buffer.alloc(0);
          if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
            try {
              bodyBuffer = Buffer.from(await req.arrayBuffer());
            } catch {}
          }

          // 构造高度逼真的 Node.js 模拟对象
          const pseudoReq = {
            headers: Object.fromEntries(req.headers.entries()),
            socket: { remoteAddress: server.requestIP(req)?.address },
            url: url.pathname + url.search,
            method: req.method,
            on(event: string, callback: (...args: unknown[]) => void) {
              if (event === "data") {
                if (bodyBuffer.length > 0) callback(bodyBuffer);
              } else if (event === "end") {
                callback();
              }
              return this;
            },
          } as unknown as IncomingMessage;

          // 构造高度逼真的 Node.js 模拟响应对象
          const pseudoRes = {
            statusCode: 200,
            headersSent: false,
            _headers: new Headers(),
            setHeader(name: string, value: string | string[]) {
              if (Array.isArray(value)) {
                this._headers.delete(name);
                value.forEach((v) => this._headers.append(name, v));
              } else {
                this._headers.set(name, value);
              }
            },
            writeHead(code: number, hdrs?: Record<string, string | string[]>) {
              this.statusCode = code;
              if (hdrs) Object.entries(hdrs).forEach(([k, v]) => this.setHeader(k, v));
            },
            end(data?: unknown) {
              if (hasResolved) return;
              hasResolved = true;
              this.headersSent = true;
              resolve(
                new Response(data as BodyInit | null | undefined, {
                  status: this.statusCode,
                  headers: this._headers,
                }),
              );
            },
          } as unknown as ServerResponse;

          try {
            const configSnapshot = loadConfig();
            const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
            const requestPath = url.pathname;

            if (await handleHooksRequest(pseudoReq, pseudoRes)) return;
            if (
              await handleToolsInvokeHttpRequest(pseudoReq, pseudoRes, {
                auth: resolvedAuth,
                trustedProxies,
                rateLimiter,
              })
            )
              return;
            if (await handleSlackHttpRequest(pseudoReq, pseudoRes)) return;

            // 🔥 鉴权与插件 🔥
            if (handlePluginRequest) {
              // Channel HTTP endpoints are gateway-auth protected by default.
              // Non-channel plugin routes remain plugin-owned and must enforce
              // their own auth when exposing sensitive functionality.
              if (requestPath.startsWith("/api/channels/")) {
                const token = getBearerToken(pseudoReq);
                const authResult = await authorizeGatewayConnect({
                  auth: resolvedAuth,
                  connectAuth: token ? { token, password: token } : null,
                  req: pseudoReq,
                  trustedProxies,
                  rateLimiter,
                });
                if (!authResult.ok) {
                  // 内部会调用 pseudoRes.end()，从而 resolve Promise
                  sendGatewayAuthFailure(pseudoRes, authResult);
                  return;
                }
              }
              if (await handlePluginRequest(pseudoReq, pseudoRes)) {
                return;
              }
            }

            if (openResponsesEnabled) {
              if (
                await handleOpenResponsesHttpRequest(pseudoReq, pseudoRes, {
                  auth: resolvedAuth,
                  config: openResponsesConfig,
                  trustedProxies,
                  rateLimiter,
                })
              )
                return;
            }

            if (openAiChatCompletionsEnabled) {
              if (
                await handleOpenAiHttpRequest(pseudoReq, pseudoRes, {
                  auth: resolvedAuth,
                  trustedProxies,
                  rateLimiter,
                })
              )
                return;
            }

            if (canvasHost) {
              if (isCanvasPath(requestPath)) {
                const ok = await authorizeCanvasRequest({
                  req: pseudoReq,
                  auth: resolvedAuth,
                  trustedProxies,
                  clients,
                  rateLimiter,
                });
                if (!ok.ok) {
                  sendGatewayAuthFailure(pseudoRes, ok);
                  return;
                }
              }

              if (await handleA2uiHttpRequest(pseudoReq, pseudoRes)) return;
              if (await canvasHost.handleHttpRequest(pseudoReq, pseudoRes)) return;
            }

            if (controlUiEnabled) {
              if (
                handleControlUiAvatarRequest(pseudoReq, pseudoRes, {
                  basePath: controlUiBasePath,
                  resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot, agentId),
                })
              )
                return;
              if (
                handleControlUiHttpRequest(pseudoReq, pseudoRes, {
                  basePath: controlUiBasePath,
                  config: configSnapshot,
                  root: controlUiRoot,
                })
              )
                return;
            }

            if (!hasResolved) {
              pseudoRes.statusCode = 404;
              pseudoRes.end("Not Found");
            }
          } catch {
            if (!hasResolved) {
              pseudoRes.statusCode = 500;
              pseudoRes.end("Internal Server Error");
            }
          }
        })(); // <--- 结束自执行 async 函数
      });
    },

    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        const data = ws.data as { isCanvas?: boolean } | undefined;
        if (data?.isCanvas) canvasHost?.addClient(ws);
        else wss.handleOpen(ws);
      },
      message(ws: ServerWebSocket<unknown>, message: string | Buffer) {
        const data = ws.data as { isCanvas?: boolean } | undefined;
        if (!data?.isCanvas) wss.handleMessage(ws, message);
      },
      close(ws: ServerWebSocket<unknown>, code: number, reason: string) {
        const data = ws.data as { isCanvas?: boolean } | undefined;
        if (data?.isCanvas) canvasHost?.removeClient(ws);
        else wss.handleClose(ws, code, reason);
      },
    },
  };
}
