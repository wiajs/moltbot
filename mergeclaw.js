#!/usr/bin/env bun

import { $ } from "bun";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// --- 颜色配置 ---
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const UPSTREAM_URL = "https://github.com/openclaw/openclaw.git";
const EXTENSIONS_DIR = "extensions";

async function runSync() {
  console.log(`\n${BOLD}${BLUE}🚀 开始同步流程...${RESET}\n`);

  try {
    await $`git remote add upstream ${UPSTREAM_URL}`.quiet();
  } catch {}

  console.log(`${BOLD}📥 获取上游代码 (Fetching upstream)...${RESET}`);
  await $`git fetch upstream`;

  console.log(`\n${BOLD}🔀 正在尝试合并 upstream/main...${RESET}`);
  try {
    // 使用 -X ours 优先保留本地关于 node/pnpm 到 bun 的全局修改
    await $`git merge upstream/main --no-commit --no-ff -X ours`.quiet();
    console.log(`${GREEN}✔ 合并成功，未发现明显冲突。${RESET}`);
  } catch (err) {
    // 处理合并时的输出
    if (err.stdout) {
      console.log(`\n${BOLD}${YELLOW}⚠️  合并详情及冲突报告：${RESET}`);
      const lines = err.stdout.toString().split("\n");

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        if (line.startsWith("Auto-merging")) {
          console.log(`${GREEN}  [自动合并] ${RESET}${line.replace("Auto-merging ", "")}`);
        } else if (line.startsWith("CONFLICT")) {
          console.log(
            `${RED}${BOLD}  [严重冲突] ${RESET}${RED}${line.replace("CONFLICT ", "")}${RESET}`,
          );
        } else if (line.includes("Automatic merge failed")) {
          console.log(`\n${RED}${BOLD}  ❌ ${line}${RESET}`);
        } else {
          console.log(`  ${BLUE}ℹ${RESET} ${line}`);
        }
      }
    }
  }

  // --- 自动化冲突修复 ---
  console.log(`\n${BOLD}${BLUE}🛠️  启动自动化清理、品牌同步与依赖修正...${RESET}`);

  // 1. 清理本地已决定删除的文件/目录
  const deletedFiles = ["pnpm-lock.yaml", "packages/moltbot", "packages/clawdbot"];
  for (const file of deletedFiles) {
    if (existsSync(file)) {
      console.log(`  ${YELLOW}🗑️  移除残留文件:${RESET} ${file}`);
      await $`git rm -rf ${file}`.quiet();
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

  console.log(`\n${BOLD}${GREEN}✅ 自动化处理流程已完成！${RESET}`);
  console.log(`${YELLOW}📝 剩余操作：${RESET}`);
  console.log(`   1. 手动确认 ${BOLD}scripts/run-node.mjs${RESET} 等文件的冲突`);
  console.log(`   2. 运行 ${BOLD}git add .${RESET}`);
  console.log(`   3. 运行 ${BOLD}git commit${RESET}\n`);
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
      // 若 HEAD 没有（说明是上游新增），基于上游内容创建
      localPkg = { ...upstreamPkg };
    }

    // --- 核心逻辑：更新 package.json 内容 ---
    const updatedPkg = {
      ...localPkg,
      // 1. 更新名称命名空间
      name: (localPkg.name || upstreamPkg.name).replace("@openclaw", "@moltbot"),
      // 2. 同步上游版本
      version: upstreamPkg.version,
      // 3. 更新描述
      description: (localPkg.description || upstreamPkg.description)?.replace(
        /Open[Cc]law/g,
        "Moltbot",
      ),
    };

    // 4. 修正依赖：将 devDependencies 中的 openclaw 替换为 moltbot 并指向物理路径
    if (updatedPkg.devDependencies) {
      if (updatedPkg.devDependencies.openclaw) {
        delete updatedPkg.devDependencies.openclaw;
        updatedPkg.devDependencies.moltbot = "file:../../";
      }
    }

    // 5. 转换配置块名称 (openclaw -> moltbot)
    if (upstreamPkg.openclaw) {
      updatedPkg.moltbot = localPkg.moltbot || upstreamPkg.openclaw;
      delete updatedPkg.openclaw;
    }

    // 写入文件并暂存
    writeFileSync(filePath, JSON.stringify(updatedPkg, null, 2));
    await $`git add ${filePath}`;
    console.log(
      `  ${GREEN}✔${RESET} 已同步并修正依赖: ${filePath} -> ${BLUE}${upstreamPkg.version}${RESET}`,
    );
  } catch (e) {
    console.error(`  ${RED}✘ 处理失败 ${filePath}: ${e.message}${RESET}`);
  }
}

runSync().catch(console.error);

// try {
//   await $`grep "TODO" ${fileName} | wc -l`;
// } catch (err) {
//   console.log("未找到 TODO 或命令出错", err);
// }

// await $`rm -rf ./dist`;
