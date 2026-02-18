#!/usr/bin/env bun
import { $ } from "bun";

/**
 * 作用：统一工具运行器
 * 逻辑：直接使用 bun x (相当于 npx) 运行本地或远程工具
 */

const args = Bun.argv.slice(2);

if (args.length < 1) {
  console.error("usage: run-node-tool <tool> [args...]");
  process.exit(2);
}

const [tool, ...toolArgs] = args;

try {
  // $.nothrow() 允许工具报错时不直接让当前脚本崩溃，而是返回 exit code
  const result = await $`bun x ${tool} ${toolArgs}`.nothrow();

  // 将工具的退出码透传出去
  process.exit(result.exitCode);
} catch (error) {
  console.error(`Failed to run tool: ${tool}`, error);
  process.exit(1);
}
