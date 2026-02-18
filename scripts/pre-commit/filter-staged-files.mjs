#!/usr/bin/env bun
import { extname } from "node:path";

/**
 * 作用：根据 lint 或 format 模式过滤文件列表，并强制忽略所有 vendor 目录下的文件。
 * 输出：以 NUL (\0) 分隔的文件名流
 */

/**
 * Prints selected files as NUL-delimited tokens to stdout.
 *
 * Usage:
 *   node scripts/pre-commit/filter-staged-files.mjs lint -- <files...>
 *   node scripts/pre-commit/filter-staged-files.mjs format -- <files...>
 *
 * Keep this dependency-free: the pre-commit hook runs in many environments.
 */

// 跳过前两个参数 (bun executable 和 script path)
const args = Bun.argv.slice(2);
// 处理可能的 "--" 分隔符
const separatorIndex = args.indexOf("--");
const mode = separatorIndex > -1 ? args[0] : args[0];
const files = separatorIndex > -1 ? args.slice(separatorIndex + 1) : args.slice(1);

if (mode !== "lint" && mode !== "format") {
  console.error("usage: filter-staged-files.ts <lint|format> [files...]");
  process.exit(2);
}

// 定义需要处理的后缀
const lintExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const formatExts = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".mdx",
  ".css",
  ".html",
]);

const shouldSelect = (filePath) => {
  // 1. 检查是否在任何名为 vendor 的目录下
  // 匹配根目录 vendor/ 或任何子目录中的 /vendor/
  const isVendor = filePath.startsWith("vendor/") || filePath.includes("/vendor/");
  if (isVendor) {
    return false;
  }

  // 2. 后缀过滤
  const ext = extname(filePath).toLowerCase();
  return mode === "lint" ? lintExts.has(ext) : formatExts.has(ext);
};

// 过滤并构建输出内容
const filteredFiles = files.filter(shouldSelect);

if (filteredFiles.length > 0) {
  // 使用 NUL 字符连接输出
  process.stdout.write(filteredFiles.join("\0"));
}
