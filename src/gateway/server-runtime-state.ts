/**
 * Gateway Runtime State
 * 负责创建和维护 Gateway 运行时的全局状态，包括 HTTP/WebSocket 服务器实例、连接管理、广播机制、聊天状态等。
 * 通过 createGatewayRuntimeState 函数初始化，并在主 Gateway 启动时注入到上下文中，供各个模块使用。
 * 同时，Gateway Runtime State 也会处理一些与运行时相关的逻辑，如动态监听地址解析、服务优雅退出等。
 * 剥离 node:http 和 ws 库，通过 Bun.serve 启动多个网卡的监听，并注入 .close() 兼容方法
 */
import type { Server as BunServer } from "bun";
import { CANVAS_HOST_PATH } from "../canvas-host/a2ui.js";
import { type CanvasHostHandler, createCanvasHostHandler } from "../canvas-host/server.js";
import type { CliDeps } from "../cli/deps.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { RuntimeEnv } from "../runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import type { ControlUiRootState } from "./control-ui.js";
import type { HooksConfigResolved } from "./hooks.js";
import { resolveGatewayListenHosts } from "./net.js";
import {
  createGatewayBroadcaster,
  type GatewayBroadcastFn,
  type GatewayBroadcastToConnIdsFn,
} from "./server-broadcast.js";
import {
  type ChatRunEntry,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";
import { MAX_PAYLOAD_BYTES } from "./server-constants.js";
import type { DedupeEntry } from "./server-shared.js";
import { createGatewayHooksRequestHandler } from "./server/hooks.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import type { GatewayTlsRuntime } from "./server/tls.js";
import type { GatewayWsClient } from "./server/ws-types.js";

// 引入 Bun WebSocket
import { BunWebSocketServer, createBunGatewayHandlers } from "./server-http.js";

export async function createGatewayRuntimeState(params: {
  cfg: import("../config/config.js").OpenClawConfig;
  bindHost: string;
  port: number;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  gatewayTls?: GatewayTlsRuntime;
  hooksConfig: () => HooksConfigResolved | null;
  pluginRegistry: PluginRegistry;
  deps: CliDeps;
  canvasRuntime: RuntimeEnv;
  canvasHostEnabled: boolean;
  allowCanvasHostInTests?: boolean;
  logCanvas: { info: (msg: string) => void; warn: (msg: string) => void };
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  logHooks: ReturnType<typeof createSubsystemLogger>;
  logPlugins: ReturnType<typeof createSubsystemLogger>;
}): Promise<{
  canvasHost: CanvasHostHandler | null;
  httpServer: HttpServer;
  httpServers: HttpServer[];
  httpBindHosts: string[];
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  broadcast: GatewayBroadcastFn;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  agentRunSeq: Map<string, number>;
  dedupe: Map<string, DedupeEntry>;
  chatRunState: ReturnType<typeof createChatRunState>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  addChatRun: (sessionId: string, entry: ChatRunEntry) => void;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  toolEventRecipients: ReturnType<typeof createToolEventRecipientRegistry>;
}> {
  let canvasHost: CanvasHostHandler | null = null;
  if (params.canvasHostEnabled) {
    try {
      const handler = await createCanvasHostHandler({
        runtime: params.canvasRuntime,
        rootDir: params.cfg.canvasHost?.root,
        basePath: CANVAS_HOST_PATH,
        allowInTests: params.allowCanvasHostInTests,
        liveReload: params.cfg.canvasHost?.liveReload,
      });
      if (handler.rootDir) {
        canvasHost = handler;
        params.logCanvas.info(
          `canvas host mounted at http://${params.bindHost}:${params.port}${CANVAS_HOST_PATH}/ (root ${handler.rootDir})`,
        );
      }
    } catch (err) {
      params.logCanvas.warn(`canvas host failed to start: ${String(err)}`);
    }
  }

  const clients = new Set<GatewayWsClient>();
  const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({ clients });

  const handleHooksRequest = createGatewayHooksRequestHandler({
    deps: params.deps,
    getHooksConfig: params.hooksConfig,
    bindHost: params.bindHost,
    port: params.port,
    logHooks: params.logHooks,
  });

  const handlePluginRequest = createGatewayPluginRequestHandler({
    registry: params.pluginRegistry,
    log: params.logPlugins,
  });

  // 1. 初始化 Bun WebSocket Server
  const wss = new BunWebSocketServer();

  // 2. 创建 Bun 统一处理器
  const bunHandlers = createBunGatewayHandlers({
    canvasHost,
    clients,
    controlUiEnabled: params.controlUiEnabled,
    controlUiBasePath: params.controlUiBasePath,
    controlUiRoot: params.controlUiRoot,
    openAiChatCompletionsEnabled: params.openAiChatCompletionsEnabled,
    openResponsesEnabled: params.openResponsesEnabled,
    openResponsesConfig: params.openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth: params.resolvedAuth,
    rateLimiter: params.rateLimiter,
    wss, // 传入bun wss
  });

  const bindHosts = await resolveGatewayListenHosts(params.bindHost);
  const httpServers: BunServer[] = [];
  const httpBindHosts: string[] = [];

  // 3. 启动 Bun 原生服务，每个bind host一个服务
  for (const host of bindHosts) {
    try {
      const server = Bun.serve({
        hostname: host,
        port: params.port,
        tls: params.gatewayTls?.enabled ? params.gatewayTls.tlsOptions : undefined,
        // 👇 修复 unbound-method: 包装成箭头函数
        fetch: (req, srv) => bunHandlers.fetch(req, srv),
        websocket: {
          ...bunHandlers.websocket,
          maxPayloadLength: MAX_PAYLOAD_BYTES,
        },
      });
      httpServers.push(server);
      httpBindHosts.push(host);
    } catch (err) {
      if (host === bindHosts[0]) {
        throw err;
      }
      params.log.warn(
        `gateway: failed to bind loopback alias ${host}:${params.port} (${String(err)})`,
      );
    }
  }

  const httpServer = httpServers[0];
  if (!httpServer) {
    throw new Error("Gateway HTTP server failed to start");
  }

  // ==========================================================
  // 为服务注入 close() 兼容补丁，确保优雅退出时不出错
  // ==========================================================
  for (const srv of httpServers) {
    (srv as unknown as { close: (cb?: () => void) => void }).close = (cb?: () => void) => {
      srv.stop(true);
      if (cb) cb();
    };
  }
  (
    wss as unknown as { close: (cb?: () => void) => void; clients: Set<{ terminate: () => void }> }
  ).close = (cb?: () => void) => {
    for (const client of wss.clients) {
      client.terminate();
    }
    if (cb) cb();
  };

  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, DedupeEntry>();
  const chatRunState = createChatRunState();
  const chatRunRegistry = chatRunState.registry;
  const chatRunBuffers = chatRunState.buffers;
  const chatDeltaSentAt = chatRunState.deltaSentAt;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const toolEventRecipients = createToolEventRecipientRegistry();

  return {
    canvasHost,
    httpServer,
    httpServers,
    httpBindHosts,
    wss, // 这里的 wss 已经是bun 封装对象，外部调用无感知
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  };
}
