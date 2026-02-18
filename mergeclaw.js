#!/usr/bin/env bun

import { $ } from "bun";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

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
  console.log(`\n${BOLD}${BLUE}🚀 开始同步流程 (自动化合并 + 冲突报告)...${RESET}\n`);

  try {
    await $`git remote add upstream ${UPSTREAM_URL}`.quiet();
  } catch {}

  console.log(`${BOLD}📥 获取上游代码 (Fetching upstream)...${RESET}`);
  await $`git fetch upstream`;

  // --- 1. 获取上游根目录的版本号 ---
  let upstreamVersion = "";
  try {
    const upstreamRootPkgContent = await $`git show upstream/main:package.json`.text();
    upstreamVersion = JSON.parse(upstreamRootPkgContent).version;
    console.log(`${GREEN}✔ 检测到上游最新版本: ${BOLD}${upstreamVersion}${RESET}`);
  } catch {
    console.error(`${RED}❌ 无法读取上游版本号，请检查网络或 upstream/main 分支。${RESET}`);
    process.exit(1);
  }

  // --- 2. 使用 git merge-tree 预检测冲突并生成报告 ---
  console.log(`${YELLOW}🔍 使用 merge-tree 生成冲突报告...${RESET}`);
  await generateConflictReport(upstreamVersion);

  // --- 3. 执行真正的合并 (-X ours) ---
  console.log(`\n${BOLD}🔀 正在执行合并 (-X ours 策略)...${RESET}`);
  try {
    // 使用 -X ours 优先保留本地关于 node/pnpm 到 bun 的全局修改
    // 使用 -X ours 合并过程不会因为冲突而中断
    await $`git merge upstream/main --no-commit --no-ff -X ours`.quiet();
    console.log(`${GREEN}✔ 合并已完成 (冲突已自动按本地优先处理)。${RESET}`);
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

  // --- 4. 自动化后续处理 (版本号、清理、品牌同步) ---
  console.log(`\n${BOLD}${BLUE}🛠️  启动自动化清理与版本更新...${RESET}`);

  // 更新本地根目录 package.json
  const rootPkgPath = join(process.cwd(), "package.json");
  if (existsSync(rootPkgPath)) {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
    rootPkg.version = upstreamVersion;
    writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    await $`git add ${rootPkgPath}`;
    console.log(`  ${GREEN}✔${RESET} 根目录版本已同步为: ${BOLD}${upstreamVersion}${RESET}`);
  }

  // 清理本地已决定删除的文件/目录
  const deletedFiles = ["pnpm-lock.yaml", "packages/moltbot", "packages/clawdbot"];
  for (const file of deletedFiles) {
    if (existsSync(file)) {
      console.log(`  ${YELLOW}🗑️  移除残留文件:${RESET} ${file}`);
      await $`git rm -rf ${file}`.quiet().nothrow();
    }
  }

  // 处理 extensions 目录
  if (existsSync(EXTENSIONS_DIR)) {
    const extensions = (await $`ls ${EXTENSIONS_DIR}`.text()).split("\n").filter(Boolean);
    for (const ext of extensions) {
      const pkgPath = join(EXTENSIONS_DIR, ext, "package.json");
      if (existsSync(pkgPath)) {
        await handlePackageJsonConflict(pkgPath);
      }
    }
  }

  console.log(`\n${BOLD}${GREEN}✅ 同步与自动化修复已完成！${RESET}`);
  console.log(`${YELLOW}📝 剩余操作：${RESET}`);
  console.log(`   1. 查看冲突报告: ${BOLD}log/merge-${upstreamVersion}md${RESET}`);
  console.log(`   2. 手动确认冲突件`);
  console.log(`   3. 运行 ${BOLD}git add .${RESET}`);
  console.log(
    `   4. 运行 ${BOLD}git commit -m "chore: sync upstream to version ${upstreamVersion}"${RESET}\n`,
  );
  console.log(`   5. 上传代码 ${BOLD}git push${RESET}`);
}

/**
 * 使用 git merge-tree 模拟合并并提取冲突内容
 */
async function generateConflictReport(version) {
  const logDir = join(process.cwd(), "log");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  const logFilePath = join(logDir, `merge-${version}.md`);

  // 1. 获取冲突文件列表 (通过 merge-tree 的标准输出解析)
  // 我们使用 git merge-tree --write-tree 来获取更详细的冲突列表
  const mergeTreeOutput = await $`git merge-tree HEAD upstream/main`.text();

  // 匹配所有 "changed in both" 或存在冲突标识的文件
  const conflictFileRegex = /^\s+our\s+\d+\s+[a-f0-9]+\s+(.*)$/gm;
  const conflictFiles = new Set();
  let match;
  while ((match = conflictFileRegex.exec(mergeTreeOutput)) !== null) {
    conflictFiles.add(match[1].trim());
  }

  if (conflictFiles.size === 0) {
    writeFileSync(logFilePath, `# Merge Report - ${version}\n\n✅ 本次合并无代码冲突。`);
    return;
  }
  let mdContent = `# ⚠️ 冲突报告 (已被 -X ours 自动覆盖) - ${version}\n\n`;
  mdContent += `> 自动同步时间: ${new Date().toLocaleString()}\n`;
  mdContent += `> **注意**：以下冲突已在合并时自动选择了本地代码，上游的对应修改已被丢弃。\n\n`;

  // 2. 为了获取带标记的冲突内容，我们临时进行一次标准合并并读取
  // 这样做比解析复杂的 merge-tree 原始输出更准确
  try {
    await $`git merge upstream/main --no-commit --no-ff`.quiet().nothrow();

    for (const file of conflictFiles) {
      // 强制转换为 string 避免 lint 报错
      const fileName = String(file);
      if (!existsSync(fileName)) {
        continue;
      }

      const content = readFileSync(fileName, "utf8");
      const conflictBlocks = content.match(/^<<<<<<<[\s\S]*?^>>>>>>>/gm);

      if (conflictBlocks) {
        const lang = extname(fileName).slice(1) || "text";
        mdContent += `### 📄 文件: \`${fileName}\`\n\n`;
        conflictBlocks.forEach((block, i) => {
          mdContent += `#### 冲突块 #${i + 1}\n\`\`\`${lang}\n${block}\n\`\`\`\n\n`;
        });
        mdContent += `---\n\n`;
      }
    }
  } catch (e) {
    mdContent += `*无法读取文件内容: ${e.message}*\n\n`;
  } finally {
    // 无论如何都要中止这个临时合并，为后面的 -X ours 让路
    await $`git merge --abort`.quiet().nothrow();
  }

  writeFileSync(logFilePath, mdContent);
  console.log(
    `${GREEN}✔ 报告已生成: ${logFilePath} (共计 ${conflictFiles.size} 个文件存在冲突)${RESET}`,
  );
}

async function handlePackageJsonConflict(filePath) {
  try {
    // 获取上游内容
    const upstreamContent = await $`git show upstream/main:${filePath}`.text();
    const upstreamPkg = JSON.parse(upstreamContent);

    let localPkg;
    try {
      // 优先从本地文件读取，如果不存在则从 HEAD 读取
      const localContent = existsSync(filePath)
        ? readFileSync(filePath, "utf8")
        : await $`git show HEAD:${filePath}`.text();
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

    // peerDependencies: openclaw -> moltbot (>=Version)
    if (updatedPkg.peerDependencies) {
      if (updatedPkg.peerDependencies.openclaw) {
        delete updatedPkg.peerDependencies.openclaw;
        // 自动设置为 >= 当前同步的版本号
        updatedPkg.peerDependencies.moltbot = `>=${upstreamPkg.version}`;
      }
    }

    // 5. 转换配置块名称 (openclaw -> moltbot)
    if (upstreamPkg.openclaw) {
      updatedPkg.moltbot = localPkg.moltbot || upstreamPkg.openclaw;
      delete updatedPkg.openclaw;
    }

    // 写入文件并暂存
    writeFileSync(filePath, JSON.stringify(updatedPkg, null, 2) + "\n");
    await $`git add ${filePath}`;
    console.log(
      `  ${GREEN}✔${RESET} 已同步插件: ${filePath} -> ${BLUE}${upstreamPkg.version}${RESET}`,
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
