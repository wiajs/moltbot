#!/usr/bin/env bun

// 1. 直接使用 bun 的 runtime，Shebang 设为 bun
// 2. 移除了 module.enableCompileCache 检查，因为 Bun 内部自带优化，且该 API 是 Node 特有的 V8 优化

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

const installProcessWarningFilter = async () => {
  // 保持警告过滤逻辑，这在生产环境很重要，避免日志被垃圾信息淹没
  const filters = ["./dist/warning-filter.js", "./dist/warning-filter.mjs"];

  for (const specifier of filters) {
    try {
      // Bun 的 import() 速度非常快，几乎无开销
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) continue;
      // 如果是其他错误（如语法错误），必须抛出，不能吞掉
      throw err;
    }
  }
};

// 预加载过滤器
await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    await import(specifier);
    return true;
  } catch (err) {
    if (isModuleNotFoundError(err)) return false;
    throw err;
  }
};

// --- 核心启动逻辑 ---
// Bun 会自动处理 ESM/CJS 互操作，这里只需按优先级加载
if (await tryImport("./dist/entry.js")) {
  // 成功启动 (通常是 CJS 或 TSDown 编译产物)
} else if (await tryImport("./dist/entry.mjs")) {
  // 成功启动 (ESM 产物)
} else {
  // 生产环境致命错误：产物缺失
  console.error("\n❌ [moltbot] 启动失败：未找到构建产物。");
  console.error("   请确保已在开发环境执行 'bun run build' 并将 dist/ 目录包含在发布包中。\n");
  process.exit(1);
}
