#!/usr/bin/env bun
import { $ } from "bun";
import { writeFileSync, existsSync } from "node:fs";
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
    console.log("⚠️ 检测到冲突，开始自动化清理与修复...", err);
  }

  // --- 自动处理 modify/delete 冲突 (解决你看到的报错) ---
  const deletedFiles = ["pnpm-lock.yaml", "packages/moltbot", "packages/clawdbot"];
  for (const file of deletedFiles) {
    if (existsSync(file)) {
      console.log(`  🗑️  清理本地已删除但上游修改的文件: ${file}`);
      await $`git rm -rf ${file}`;
    }
  }

  // --- 处理 extensions ---
  if (existsSync(EXTENSIONS_DIR)) {
    const extensions = (await $`ls ${EXTENSIONS_DIR}`.text()).split("\n").filter(Boolean);

    for (const ext of extensions) {
      const pkgPath = join(EXTENSIONS_DIR, ext, "package.json");
      if (existsSync(pkgPath)) {
        await handlePackageJsonConflict(pkgPath);
      }
    }
  }

  console.log("✅ 自动化处理完成。");
  console.log("📝 剩余冲突请手动执行 git add . 和 git commit");
}

async function handlePackageJsonConflict(filePath) {
  try {
    // 获取上游内容
    const upstreamContent = await $`git show upstream/main:${filePath}`.text();
    const upstreamPkg = JSON.parse(upstreamContent);

    let localPkg;
    try {
      // 尝试获取本地 HEAD 内容
      const localContent = await $`git show HEAD:${filePath}`.text();
      localPkg = JSON.parse(localContent);
    } catch {
      // 如果 HEAD 里没有（说明是上游新增的插件），直接基于上游内容进行初始化修改
      localPkg = { ...upstreamPkg };
    }

    const newVersion = upstreamPkg.version;

    // 应用你的命名规则：保留本地的 @moltbot 命名
    const updatedPkg = {
      ...localPkg,
      name: (localPkg.name || upstreamPkg.name).replace("@openclaw", "@moltbot"),
      version: newVersion,
      description: (localPkg.description || upstreamPkg.description)?.replace(
        /Open[Cc]law/g,
        "Moltbot",
      ),
    };

    // 转换配置块名称
    if (upstreamPkg.openclaw) {
      updatedPkg.moltbot = localPkg.moltbot || upstreamPkg.openclaw;
      delete updatedPkg.openclaw;
    }

    writeFileSync(filePath, JSON.stringify(updatedPkg, null, 2));
    await $`git add ${filePath}`;
    console.log(`  ✔️ 已处理: ${filePath} -> ${newVersion}`);
  } catch (e) {
    console.error(`  ❌ 处理失败 ${filePath}: ${e.message}`);
  }
}

runSync().catch(console.error);

// try {
//   await $`grep "TODO" ${fileName} | wc -l`;
// } catch (err) {
//   console.log("未找到 TODO 或命令出错", err);
// }

// await $`rm -rf ./dist`;
