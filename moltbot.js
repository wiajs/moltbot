#!/usr/bin/env bun
import path from "node:path";

// 1. 直接使用 bun 的 runtime，Shebang 设为 bun
// 2. 移除了 module.enableCompileCache 检查，因为 Bun 内部自带优化，且该 API 是 Node 特有的 V8 优化

const isModuleNotFoundError = (err) => {
  if (!err || typeof err !== "object") return false;
  // Node.js
  if (err.code === "ERR_MODULE_NOT_FOUND") return true;
  // Bun
  const message = err.message || "";
  return message.includes("Cannot find module") || message.includes("not found");
};

const installProcessWarningFilter = async () => {
  const filters = ["./dist/warning-filter.js", "./dist/warning-filter.mjs"];

  for (const specifier of filters) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) continue;
      // 输出非找不到模块的致命错误
      console.error(`[moltbot] 加载警告过滤器失败: ${err.message}`);
      process.exit(1);
    }
  }
};

// 预加载过滤器
await installProcessWarningFilter();

const tryImport = async (specifier) => {
  try {
    // 🌟 修正 argv[1] 的路径，确保被导入的 entry.js 能正确解析命令行参数
    process.argv[1] = path.resolve(specifier);

    const mod = await import(specifier);

    // 🌟 修复 2：如果底层模块没有自执行，而是导出了 run 或 main 函数，这里主动执行它
    if (mod && typeof mod.run === "function") {
      await mod.run();
    } else if (mod && typeof mod.default === "function") {
      await mod.default();
    } else if (mod && typeof mod.main === "function") {
      await mod.main();
    }

    return true;
  } catch (err) {
    if (isModuleNotFoundError(err)) return false;
    // 如果文件存在但由于语法错误或内部依赖崩溃，必须报告出来
    console.error(`[moltbot] 加载 ${specifier} 时发生致命错误:`);
    console.error(err);
    process.exit(1);
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
