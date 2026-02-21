/**
 * Canvas Host Server
 * 负责提供一个独立的 HTTP 服务来托管 Canvas 相关资源（如 index.html 和静态文件），
 * 并通过 WebSocket 实现与 Canvas 的实时通信（如 live reload）。
 * 同时，Canvas Host 也会注册到主 Gateway 中，允许 Gateway 将来自 Canvas 的请求（如用户操作事件）
 * 转发到对应的插件处理。
 * 剥离 ws 库依赖，完全改用 Bun.serve 实现独立的 Canvas 调试服务，并支持主 Gateway 注册客户端
 */
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { detectMime } from "../media/mime.js";
import type { RuntimeEnv } from "../runtime.js";
import { ensureDir, resolveUserPath } from "../utils.js";
import {
  CANVAS_HOST_PATH,
  CANVAS_WS_PATH,
  handleA2uiHttpRequest,
  injectCanvasLiveReload,
} from "./a2ui.js";
import { normalizeUrlPath, resolveFileWithinRoot } from "./file-resolver.js";
// 引入 Bun 类型
import type { ServerWebSocket } from "bun";

export type CanvasHostOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  port?: number;
  listenHost?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
};

export type CanvasHostServerOpts = CanvasHostOpts & {
  handler?: CanvasHostHandler;
  ownsHandler?: boolean;
};

export type CanvasHostServer = {
  port: number;
  rootDir: string;
  close: () => Promise<void>;
};

export type CanvasHostHandlerOpts = {
  runtime: RuntimeEnv;
  rootDir?: string;
  basePath?: string;
  allowInTests?: boolean;
  liveReload?: boolean;
};

export type CanvasHostHandler = {
  rootDir: string;
  basePath: string;
  // 保持向下兼容的伪 HTTP 签名
  handleHttpRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  // 为 Bun 原生 WebSocket 新增的客户端管理接口
  addClient: (ws: ServerWebSocket<unknown>) => void;
  removeClient: (ws: ServerWebSocket<unknown>) => void;
  close: () => Promise<void>;
};

function defaultIndexHTML() {
  return `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MoltBot Canvas</title>
<style>
  html, body { height: 100%; margin: 0; background: #000; color: #fff; font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }
  .wrap { min-height: 100%; display: grid; place-items: center; padding: 24px; }
  .card { width: min(720px, 100%); background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 18px 18px 14px; }
  .title { display: flex; align-items: baseline; gap: 10px; }
  h1 { margin: 0; font-size: 22px; letter-spacing: 0.2px; }
  .sub { opacity: 0.75; font-size: 13px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  button { appearance: none; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.10); color: #fff; padding: 10px 12px; border-radius: 12px; font-weight: 600; cursor: pointer; }
  button:active { transform: translateY(1px); }
  .ok { color: #24e08a; }
  .bad { color: #ff5c5c; }
  .log { margin-top: 14px; opacity: 0.85; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; white-space: pre-wrap; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); padding: 10px; border-radius: 12px; }
</style>
<div class="wrap">
  <div class="card">
    <div class="title">
      <h1>MoltBot Canvas</h1>
      <div class="sub">Interactive test page (auto-reload enabled)</div>
    </div>
    <div class="row">
      <button id="btn-hello">Hello</button>
      <button id="btn-time">Time</button>
      <button id="btn-photo">Photo</button>
      <button id="btn-dalek">Dalek</button>
    </div>
    <div id="status" class="sub" style="margin-top: 10px;"></div>
    <div id="log" class="log">Ready.</div>
  </div>
</div>
<script>
(() => {
  const logEl = document.getElementById("log");
  const statusEl = document.getElementById("status");
  const log = (msg) => { logEl.textContent = String(msg); };

  const hasIOS = () =>
    !!(
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.openclawCanvasA2UIAction
    );
  const hasAndroid = () =>
    !!(
      (window.openclawCanvasA2UIAction &&
        typeof window.openclawCanvasA2UIAction.postMessage === "function")
    );
  const hasHelper = () => typeof window.openclawSendUserAction === "function";
  statusEl.innerHTML =
    "Bridge: " +
    (hasHelper() ? "<span class='ok'>ready</span>" : "<span class='bad'>missing</span>") +
    " · iOS=" + (hasIOS() ? "yes" : "no") +
    " · Android=" + (hasAndroid() ? "yes" : "no");

  const onStatus = (ev) => {
    const d = ev && ev.detail || {};
    log("Action status: id=" + (d.id || "?") + " ok=" + String(!!d.ok) + (d.error ? (" error=" + d.error) : ""));
  };
  window.addEventListener("openclaw:a2ui-action-status", onStatus);

  function send(name, sourceComponentId) {
    if (!hasHelper()) {
      log("No action bridge found. Ensure you're viewing this on an iOS/Android MoltBot node canvas.");
      return;
    }
    const sendUserAction =
      typeof window.openclawSendUserAction === "function"
        ? window.openclawSendUserAction
        : undefined;
    const ok = sendUserAction({
      name,
      surfaceId: "main",
      sourceComponentId,
      context: { t: Date.now() },
    });
    log(ok ? ("Sent action: " + name) : ("Failed to send action: " + name));
  }

  document.getElementById("btn-hello").onclick = () => send("hello", "demo.hello");
  document.getElementById("btn-time").onclick = () => send("time", "demo.time");
  document.getElementById("btn-photo").onclick = () => send("photo", "demo.photo");
  document.getElementById("btn-dalek").onclick = () => send("dalek", "demo.dalek");
})();
</script>
`;
}

function isDisabledByEnv() {
  if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CANVAS_HOST)) return true;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return true;
  return false;
}

function normalizeBasePath(rawPath: string | undefined) {
  const trimmed = (rawPath ?? CANVAS_HOST_PATH).trim();
  const normalized = normalizeUrlPath(trimmed || CANVAS_HOST_PATH);
  if (normalized === "/") {
    return "/";
  }
  return normalized.replace(/\/+$/, "");
}

async function prepareCanvasRoot(rootDir: string) {
  await ensureDir(rootDir);
  const rootReal = await fs.realpath(rootDir);
  try {
    const indexPath = path.join(rootReal, "index.html");
    await fs.stat(indexPath);
  } catch {
    try {
      await fs.writeFile(path.join(rootReal, "index.html"), defaultIndexHTML(), "utf8");
    } catch {
      // ignore; we'll still serve the "missing file" message if needed.
    }
  }
  return rootReal;
}

function resolveDefaultCanvasRoot(): string {
  const candidates = [path.join(resolveStateDir(), "canvas")];
  const existing = candidates.find((dir) => {
    try {
      return fsSync.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  return existing ?? candidates[0];
}

export async function createCanvasHostHandler(
  opts: CanvasHostHandlerOpts,
): Promise<CanvasHostHandler> {
  const basePath = normalizeBasePath(opts.basePath);
  if (isDisabledByEnv() && opts.allowInTests !== true) {
    return {
      rootDir: "",
      basePath,
      handleHttpRequest: async () => false,
      addClient: () => {},
      removeClient: () => {},
      close: async () => {},
    };
  }

  const rootDir = resolveUserPath(opts.rootDir ?? resolveDefaultCanvasRoot());
  const rootReal = await prepareCanvasRoot(rootDir);

  const liveReload = opts.liveReload !== false;
  const testMode = opts.allowInTests === true;
  const reloadDebounceMs = testMode ? 12 : 75;
  const writeStabilityThresholdMs = testMode ? 12 : 75;
  const writePollIntervalMs = testMode ? 5 : 10;

  // 🔥 Bun 专属：移除 ws 库，直接用 Set 管理 WebSocket 客户端
  const sockets = new Set<ServerWebSocket<unknown>>();

  let debounce: NodeJS.Timeout | null = null;
  const broadcastReload = () => {
    if (!liveReload) {
      return;
    }
    for (const ws of sockets) {
      try {
        ws.send("reload");
      } catch {
        // ignore
      }
    }
  };
  const scheduleReload = () => {
    if (debounce) {
      clearTimeout(debounce);
    }
    debounce = setTimeout(() => {
      debounce = null;
      broadcastReload();
    }, reloadDebounceMs);
    debounce.unref?.();
  };

  let watcherClosed = false;
  const watcher = liveReload
    ? chokidar.watch(rootReal, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: writeStabilityThresholdMs,
          pollInterval: writePollIntervalMs,
        },
        usePolling: testMode,
        ignored: [
          /(^|[\\/])\../, // dotfiles
          /(^|[\\/])node_modules([\\/]|$)/,
        ],
      })
    : null;
  watcher?.on("all", () => scheduleReload());
  watcher?.on("error", (err) => {
    if (watcherClosed) {
      return;
    }
    watcherClosed = true;
    opts.runtime.error(
      `canvasHost watcher error: ${String(err)} (live reload disabled; consider canvasHost.liveReload=false or a smaller canvasHost.root)`,
    );
    void watcher.close().catch(() => {});
  });

  const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const urlRaw = req.url;
    if (!urlRaw) return false;

    try {
      const url = new URL(urlRaw, "http://localhost");
      if (url.pathname === CANVAS_WS_PATH) {
        res.statusCode = liveReload ? 426 : 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(liveReload ? "upgrade required" : "not found");
        return true;
      }

      let urlPath = url.pathname;
      if (basePath !== "/") {
        if (urlPath !== basePath && !urlPath.startsWith(`${basePath}/`)) {
          return false;
        }
        urlPath = urlPath === basePath ? "/" : urlPath.slice(basePath.length) || "/";
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Method Not Allowed");
        return true;
      }

      const opened = await resolveFileWithinRoot(rootReal, urlPath);
      if (!opened) {
        if (urlPath === "/" || urlPath.endsWith("/")) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(
            `<!doctype html><meta charset="utf-8" /><title>OpenClaw Canvas</title><pre>Missing file.\nCreate ${rootDir}/index.html</pre>`,
          );
          return true;
        }
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("not found");
        return true;
      }

      const { handle, realPath } = opened;
      let data: Buffer;
      try {
        data = await handle.readFile();
      } finally {
        await handle.close().catch(() => {});
      }

      const lower = realPath.toLowerCase();
      const mime =
        lower.endsWith(".html") || lower.endsWith(".htm")
          ? "text/html"
          : ((await detectMime({ filePath: realPath })) ?? "application/octet-stream");

      res.setHeader("Cache-Control", "no-store");
      if (mime === "text/html") {
        const html = data.toString("utf8");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(liveReload ? injectCanvasLiveReload(html) : html);
        return true;
      }

      res.setHeader("Content-Type", mime);
      res.end(data);
      return true;
    } catch (err) {
      opts.runtime.error(`canvasHost request failed: ${String(err)}`);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("error");
      return true;
    }
  };

  return {
    rootDir,
    basePath,
    handleHttpRequest,
    // 🔥 暴露给 Bun 调用的 WS 注册方法
    addClient: (ws) => sockets.add(ws),
    removeClient: (ws) => sockets.delete(ws),
    close: async () => {
      if (debounce) {
        clearTimeout(debounce);
      }
      watcherClosed = true;
      await watcher?.close().catch(() => {});
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {}
      }
      sockets.clear();
    },
  };
}

// 供独立测试使用的 Canvas 服务器，同样升级为 Bun.serve
export async function startCanvasHost(opts: CanvasHostServerOpts): Promise<CanvasHostServer> {
  if (isDisabledByEnv() && opts.allowInTests !== true) {
    return { port: 0, rootDir: "", close: async () => {} };
  }

  const handler =
    opts.handler ??
    (await createCanvasHostHandler({
      runtime: opts.runtime,
      rootDir: opts.rootDir,
      basePath: CANVAS_HOST_PATH,
      allowInTests: opts.allowInTests,
      liveReload: opts.liveReload,
    }));
  const ownsHandler = opts.ownsHandler ?? opts.handler === undefined;
  const bindHost = opts.listenHost?.trim() || "127.0.0.1";
  const listenPort =
    typeof opts.port === "number" && Number.isFinite(opts.port) && opts.port > 0 ? opts.port : 0;

  // 使用 Bun.serve 替代 http.createServer
  const server = Bun.serve({
    port: listenPort,
    hostname: bindHost,
    async fetch(req, srv) {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (new URL(req.url).pathname === CANVAS_WS_PATH) {
          if (srv.upgrade(req, { data: { isCanvas: true } })) return new Response();
        }
        return new Response("WebSocket Upgrade Failed", { status: 500 });
      }

      return new Promise<Response>((resolve) => {
        void (async () => {
          let hasResolved = false;
          const pseudoReq = {
            method: req.method,
            url: new URL(req.url).pathname + new URL(req.url).search,
          } as unknown as IncomingMessage;
          const pseudoRes = {
            statusCode: 200,
            _headers: new Headers(),
            setHeader(k: string, v: string) {
              this._headers.set(k, v);
            },
            end(data?: unknown) {
              if (hasResolved) return;
              hasResolved = true;
              resolve(
                new Response(data as BodyInit | null | undefined, {
                  status: this.statusCode,
                  headers: this._headers,
                }),
              );
            },
          } as unknown as ServerResponse;

          try {
            if (await handleA2uiHttpRequest(pseudoReq, pseudoRes)) return;
            if (await handler.handleHttpRequest(pseudoReq, pseudoRes)) return;
            if (!hasResolved) {
              pseudoRes.statusCode = 404;
              pseudoRes.end("Not Found");
            }
          } catch (err) {
            opts.runtime.error(`canvasHost request failed: ${String(err)}`);
            if (!hasResolved) {
              pseudoRes.statusCode = 500;
              pseudoRes.end("error");
            }
          }
        })();
      });
    },
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        const data = ws.data as { isCanvas?: boolean } | undefined;
        if (data?.isCanvas) handler.addClient(ws);
      },
      message() {},
      close(ws: ServerWebSocket<unknown>) {
        const data = ws.data as { isCanvas?: boolean } | undefined;
        if (data?.isCanvas) handler.removeClient(ws);
      },
    },
  });

  opts.runtime.log(
    `canvas host listening on http://${bindHost}:${server.port} (root ${handler.rootDir})`,
  );

  return {
    port: server.port,
    rootDir: handler.rootDir,
    close: async () => {
      if (ownsHandler) await handler.close();
      void server.stop(true);
    },
  };
}
