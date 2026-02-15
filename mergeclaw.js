#!/usr/bin/env bun

import { $ } from "bun";

// 1. 像写 Shell 一样执行命令
await $`echo "开始合并OpenClaw..."`;

// 2. 变量穿透 (JavaScript 变量直接在 Shell 中使用)
const branch = "main";
const fileName = "README.md";

// 3. 获取输出结果 (text())
const content = await $`git show ${branch}:${fileName}`.text();
console.log(`文件前10个字符: ${content.substring(0, 10)}`);

// 4. 管道操作 (Piping) 和 错误处理
try {
  // 查找包含 "TODO" 的行，并统计行数
  await $`grep "TODO" ${fileName} | wc -l`;
} catch (err) {
  console.log("未找到 TODO 或命令出错", err);
}

// 5. 跨平台命令 (rm -rf 在 Windows 上也能用 Bun Shell 跑)
// await $`rm -rf ./dist`;
