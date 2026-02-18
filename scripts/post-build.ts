import { $ } from "bun";

console.time("Post-build tasks");

// 这里放那些必须串行，或者依赖 d.ts 生成的脚本
await $`bun scripts/write-plugin-sdk-entry-dts.ts`;

// 并行执行剩余的元数据写入任务
await Promise.all([
  $`bun scripts/canvas-a2ui-copy.ts`,
  $`bun scripts/copy-hook-metadata.ts`,
  $`bun scripts/write-build-info.ts`,
  $`bun scripts/write-cli-compat.ts`,
]);

console.timeEnd("Post-build tasks");
