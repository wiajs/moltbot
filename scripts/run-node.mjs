#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const compiler = "tsdown";
const compilerArgs = ["x", compiler, "--no-clean"];

export const runNodeWatchedPaths = ["src", "tsconfig.json", "package.json"];

const statMtime = (filePath, fsImpl = fs) => {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

const isExcludedSource = (filePath, srcRoot) => {
  const relativePath = path.relative(srcRoot, filePath);
  if (relativePath.startsWith("..")) {
    return false;
  }
  return (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test.tsx") ||
    relativePath.endsWith(`test-helpers.ts`)
  );
};

const findLatestMtime = (dirPath, shouldSkip, deps) => {
  let latest = null;
  const queue = [dirPath];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries = [];
    try {
      entries = deps.fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (shouldSkip?.(fullPath)) {
        continue;
      }
      const mtime = statMtime(fullPath, deps.fs);
      if (mtime == null) {
        continue;
      }
      if (latest == null || mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
};

const runGit = (gitArgs, deps) => {
  try {
    const result = deps.spawnSync("git", gitArgs, {
      cwd: deps.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) {
      return null;
    }
    return (result.stdout ?? "").trim();
  } catch {
    return null;
  }
};

const resolveGitHead = (deps) => {
  const head = runGit(["rev-parse", "HEAD"], deps);
  return head || null;
};

const hasDirtySourceTree = (deps) => {
  const output = runGit(
    ["status", "--porcelain", "--untracked-files=normal", "--", ...runNodeWatchedPaths],
    deps,
  );
  if (output === null) {
    return null;
  }
  return output.length > 0;
};

const readBuildStamp = (deps) => {
  const mtime = statMtime(deps.buildStampPath, deps.fs);
  if (mtime == null) {
    return { mtime: null, head: null };
  }
  try {
    const raw = deps.fs.readFileSync(deps.buildStampPath, "utf8").trim();
    if (!raw.startsWith("{")) {
      return { mtime, head: null };
    }
    const parsed = JSON.parse(raw);
    const head = typeof parsed?.head === "string" && parsed.head.trim() ? parsed.head.trim() : null;
    return { mtime, head };
  } catch {
    return { mtime, head: null };
  }
};

const hasSourceMtimeChanged = (stampMtime, deps) => {
  const srcMtime = findLatestMtime(
    deps.srcRoot,
    (candidate) => isExcludedSource(candidate, deps.srcRoot),
    deps,
  );
  return srcMtime != null && srcMtime > stampMtime;
};

// 动态检测入口文件
// 优先寻找 entry.js/mjs (CLI入口)，其次寻找 index.js/mjs
const detectDistEntry = (distRoot, fsImpl = fs) => {
  const candidates = ["entry.js", "entry.mjs", "index.js", "index.mjs"];
  for (const file of candidates) {
    const fullPath = path.join(distRoot, file);
    try {
      // 检查文件是否存在且是文件
      if (fsImpl.statSync(fullPath).isFile()) {
        return fullPath;
      }
    } catch {
      // ignore missing files
    }
  }
  // 如果都没找到，返回默认值 entry.js (这将导致后续 shouldBuild 返回 true，触发构建)
  return path.join(distRoot, "entry.js");
};

const shouldBuild = (deps) => {
  if (deps.env.OPENCLAW_FORCE_BUILD === "1") {
    console.log("Force build triggered by OPENCLAW_FORCE_BUILD=1");
    return true;
  }
  const stamp = readBuildStamp(deps);

  // 1. 没有构建时间戳 -> 必须构建
  if (stamp.mtime == null) {
    console.log("No build stamp found. Need to build.");
    return true;
  }

  // 2. 产物文件不存在 (detectDistEntry 没找到任何有效文件) -> 必须构建
  if (statMtime(deps.distEntry, deps.fs) == null) {
    console.log(`Dist entry not found at ${deps.distEntry}. Need to build.`);
    return true;
  }

  // 3. 配置文件变动 -> 必须构建
  for (const filePath of deps.configFiles) {
    const mtime = statMtime(filePath, deps.fs);
    if (mtime != null && mtime > stamp.mtime) {
      console.log(`Config file ${filePath} has changed since last build. Need to build.`);
      return true;
    }
  }

  // 4. Git 状态与源码变动检查
  const currentHead = resolveGitHead(deps);
  if (currentHead && !stamp.head) {
    const r = hasSourceMtimeChanged(stamp.mtime, deps);
    if (r) {
      console.log("Git HEAD changed or no previous HEAD recorded. Need to build.");
      return true;
    }
  }
  if (currentHead && stamp.head && currentHead !== stamp.head) {
    const r = hasSourceMtimeChanged(stamp.mtime, deps);
    if (r) {
      console.log("Git HEAD changed. Need to build.");
      return true;
    }
  }
  if (currentHead) {
    const dirty = hasDirtySourceTree(deps);
    if (dirty === true) {
      console.log("Git working tree has uncommitted changes. Need to build.");
      return true; // 代码有未提交的修改 -> 重新构建
    }
    if (dirty === false) {
      console.log("Git working tree is clean. No need to build based on Git status.");
      return false; // 代码干净且 commit 未变 -> 跳过构建
    }
  }

  // 5. 保底源码时间戳检查
  if (hasSourceMtimeChanged(stamp.mtime, deps)) {
    console.log("Source files have changed since last build. Need to build.");
    return true;
  }

  console.log("No changes detected since last build. Skipping build.");

  return false;
};

const logRunner = (message, deps) => {
  if (deps.env.OPENCLAW_RUNNER_LOG === "0") {
    return;
  }
  deps.stderr.write(`[moltbot] ${message}\n`);
};

// 直接运行 distEntry
const run = async (deps) => {
  const nodeProcess = deps.spawn(deps.execPath, [deps.distEntry, ...deps.args], {
    cwd: deps.cwd,
    env: deps.env,
    stdio: "inherit",
  });

  const res = await new Promise((resolve) => {
    nodeProcess.on("exit", (exitCode, exitSignal) => {
      resolve({ exitCode, exitSignal });
    });
  });

  if (res.exitSignal) {
    return 1;
  }
  return res.exitCode ?? 1;
};

const writeBuildStamp = (deps) => {
  try {
    deps.fs.mkdirSync(deps.distRoot, { recursive: true });
    const stamp = {
      builtAt: Date.now(),
      head: resolveGitHead(deps),
    };
    deps.fs.writeFileSync(deps.buildStampPath, `${JSON.stringify(stamp)}\n`);
  } catch (error) {
    // Best-effort stamp; still allow the runner to start.
    logRunner(`Failed to write build stamp: ${error?.message ?? "unknown error"}`, deps);
  }
};

export async function runNodeMain(params = {}) {
  const deps = {
    spawn: params.spawn ?? spawn,
    spawnSync: params.spawnSync ?? spawnSync,
    fs: params.fs ?? fs,
    stderr: params.stderr ?? process.stderr,
    execPath: params.execPath ?? process.execPath,
    cwd: params.cwd ?? process.cwd(),
    args: params.args ?? process.argv.slice(2),
    env: params.env ? { ...params.env } : { ...process.env },
    platform: params.platform ?? process.platform,
  };

  deps.distRoot = path.join(deps.cwd, "dist");
  deps.distEntry = detectDistEntry(deps.distRoot, deps.fs); // 初始检测：看看现在有哪个文件
  deps.buildStampPath = path.join(deps.distRoot, ".buildstamp");
  deps.srcRoot = path.join(deps.cwd, "src");
  deps.configFiles = [path.join(deps.cwd, "tsconfig.json"), path.join(deps.cwd, "package.json")];

  if (!shouldBuild(deps)) {
    // 命中缓存，直接启动！
    return await run(deps);
  }

  logRunner("Building TypeScript (dist is stale)...", deps);

  // [Bun适配] 构建命令
  const buildCmd = deps.platform === "win32" ? "cmd.exe" : "bun";
  const buildArgs =
    deps.platform === "win32" ? ["/d", "/s", "/c", "bun", ...compilerArgs] : compilerArgs;

  const build = deps.spawn(buildCmd, buildArgs, {
    cwd: deps.cwd,
    env: deps.env,
    stdio: "inherit",
  });

  const buildRes = await new Promise((resolve) => {
    build.on("exit", (exitCode, exitSignal) => resolve({ exitCode, exitSignal }));
  });

  if (buildRes.exitSignal) {
    return 1;
  }
  if (buildRes.exitCode !== 0 && buildRes.exitCode !== null) {
    return buildRes.exitCode;
  }

  // [关键] 构建完成后再次检测：确保 distEntry 指向最新生成的文件
  // 如果之前是空的，现在这里会找到 entry.js 或 entry.mjs
  deps.distEntry = detectDistEntry(deps.distRoot, deps.fs);

  writeBuildStamp(deps);
  return await run(deps);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNodeMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
