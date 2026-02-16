#!/usr/bin/env bun
import { $ } from "bun";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 配置常量
const EXTENSIONS_DIR = "extensions";

async function runSync() {
  console.log("🚀 开始从 OpenClaw 同步更新...");

  // 2. 获取最新上游代码
  console.log("📥 Fetching upstream...");
  await $`git fetch upstream`;

  // 3. 尝试合并
  console.log("🔀 尝试合并 upstream/main...");
  try {
    // 使用 -X ours 优先保留本地关于 node/pnpm 到 bun 的全局修改
    await $`git merge upstream/main --no-commit --no-ff -X ours`;
  } catch (err) {
    console.log("⚠️ 检测到冲突，准备自动处理 extensions 目录...");
  }

  // 4. 自动处理 extensions 目录中的冲突
  if (existsSync(EXTENSIONS_DIR)) {
    const extensions = await $`ls ${EXTENSIONS_DIR}`.text();
    const extList = extensions.split("\n").filter(Boolean);

    for (const ext of extList) {
      const pkgPath = join(EXTENSIONS_DIR, ext, "package.json");

      if (existsSync(pkgPath)) {
        await handlePackageJsonConflict(pkgPath);
      }
    }
  }

  console.log("✅ 自动合并与冲突处理完成。");
  console.log("📝 请手动检查代码并运行: git commit");
}

async function handlePackageJsonConflict(filePath) {
  // 从 git 获取上游和本地的版本内容
  const localContent = await $`git show HEAD:${filePath}`.text();
  const upstreamContent = await $`git show upstream/main:${filePath}`.text();

  try {
    const localPkg = JSON.parse(localContent);
    const upstreamPkg = JSON.parse(upstreamContent);

    // 规则 1: 自动更新 version 为 openclaw (upstream) 的版本
    const newVersion = upstreamPkg.version;

    // 规则 2: 保留本地的 @moltbot 命名空间和 Moltbot 描述
    const updatedPkg = {
      ...localPkg,
      version: newVersion, // 使用上游版本号
      // 显式保留本地已改名的字段 (以防被覆盖)
      name: localPkg.name.replace("@openclaw", "@moltbot"),
      description: localPkg.description?.replace(/Open[Cc]law/g, "Moltbot"),
    };

    // 如果存在 moltbot/openclaw 对象的 key 名冲突，确保使用 moltbot
    if (localPkg.moltbot && upstreamPkg.openclaw) {
      updatedPkg.moltbot = { ...localPkg.moltbot };
      delete updatedPkg.openclaw;
    }

    writeFileSync(filePath, JSON.stringify(updatedPkg, null, 2));
    await $`git add ${filePath}`;
    console.log(`  ✔️ 已处理: ${filePath} (同步版本至 ${newVersion})`);
  } catch (e) {
    console.error(`  ❌ 无法自动处理 ${filePath}, 请手动检查。`);
  }
}

runSync().catch(console.error);

// const branch = "main";
// const fileName = "README.md";
// const content = await $`git show ${branch}:${fileName}`.text();
// console.log(`文件前10个字符: ${content.substring(0, 10)}`);

// try {
//   await $`grep "TODO" ${fileName} | wc -l`;
// } catch (err) {
//   console.log("未找到 TODO 或命令出错", err);
// }

// await $`rm -rf ./dist`;
