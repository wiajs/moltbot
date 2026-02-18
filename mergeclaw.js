#!/usr/bin/env bun

import { $ } from "bun";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * MoltBot 同步工具 - mergeclaw.js
 * 功能：
 * 1. 自动获取上游 (OpenClaw) 最新版本。
 * 2. 模拟合并以检测冲突并生成 Markdown 报告。
 * 3. 使用 -X ours 策略自动完成合并，避免手动处理冲突。
 * 4. 自动修正品牌命名空间与依赖路径。
 */

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

  // 确保 remote 存在
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
  console.log(`${YELLOW}🔍 生成冲突报告...${RESET}`);
  const finalLogPath = await generateConflictReport(upstreamVersion);

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
  console.log(`   1. 查看冲突报告: ${BOLD}${finalLogPath}${RESET}`);
  console.log(
    `   2. 确认无误后运行: ${BOLD}git commit -m "chore: sync to version ${upstreamVersion}"${RESET}`,
  );
  console.log(`   3. 上传代码 ${BOLD}git push${RESET}`);
  // 自动在编辑器中打开报告
  if (finalLogPath && existsSync(finalLogPath)) {
    await $`code ${finalLogPath}`.quiet().nothrow();
  }
}

/**
 * 生成冲突报告
 * 采用“模拟合并-提取-撤销”策略，兼容不同 Git 版本
 */
async function generateConflictReport(version) {
  let R;
  try {
    const syncDir = join(process.cwd(), "sync");
    if (!existsSync(syncDir)) mkdirSync(syncDir, { recursive: true });

    // --- 自动计算文件名 (如 2026.2.18-2.md) ---
    let logFileName = `${version}.md`;
    let logFilePath = join(syncDir, logFileName);
    let counter = 1;
    while (existsSync(logFilePath)) {
      counter++;
      logFileName = `${version}-${counter}.md`;
      logFilePath = join(syncDir, logFileName);
    }

    R = logFilePath;

    let conflictFiles = [];
    console.log(`${YELLOW}🔍 正在检测冲突...${RESET}`);
    // --- 1. 模拟合并以获取冲突列表 ---
    try {
      // 使用 --no-commit --no-ff 执行一次标准合并（不带 -X ours）
      // .nothrow() 确保即使失败（有冲突）脚本也继续运行
      await $`git merge upstream/main --no-commit --no-ff`.quiet().nothrow();

      // 获取处于冲突状态 (Unmerged) 的文件列表
      const diffOutput = await $`git diff --name-only --diff-filter=U`.text();
      conflictFiles = diffOutput.split("\n").filter((f) => f.length > 0);

      if (conflictFiles.length === 0)
        writeFileSync(logFilePath, `# Sync Report - ${version}\n\n✅ 本次合并无代码冲突。`);
      else {
        // --- 2. 提取冲突内容并写入 Markdown ---
        let mdContent = `# ⚠️ 冲突报告 (已被 -X ours 自动覆盖) - ${version}\n\n`;
        mdContent += `> 自动同步时间: ${new Date().toLocaleString()}\n`;
        mdContent += `> **注意**：以下内容在合并中已按本地优先处理。若需上游逻辑，请手动参考下方代码块。\n\n`;

        for (const file of conflictFiles) {
          const fileName = String(file);
          if (!existsSync(fileName)) continue;

          mdContent += `### 文件: \`${fileName}\`\n\n`;

          try {
            const fileContent = readFileSync(fileName, "utf8");
            const lines = fileContent.split("\n");
            let blockIndex = 1;
            let i = 0;
            while (i < lines.length) {
              // 检测冲突开始
              if (lines[i].startsWith("<<<<<<<")) {
                let localPart = [];
                let upstreamPart = [];
                let mode = "local";
                const startLine = i + 1; // 记录冲突块开始的行号

                i++; // 跳过 <<<<<<< HEAD
                while (i < lines.length && !lines[i].startsWith(">>>>>>>")) {
                  if (lines[i].startsWith("=======")) {
                    mode = "upstream";
                  } else {
                    if (mode === "local") {
                      // 为本地修改部分添加行号前缀
                      const lineNum = i.toString().padStart(4, " ");
                      localPart.push(`${lineNum} | ${lines[i]}`);
                    } else {
                      upstreamPart.push(lines[i]);
                    }
                  }
                  i++;
                }
                const ext = extname(fileName).slice(1) || "text";
                const lang =
                  ext === "ts" || ext === "tsx" ? "typescript" : ext === "js" ? "javascript" : ext;

                mdContent += `#### 冲突块 #${blockIndex++}\n`;
                mdContent += `\`\`\`${lang}\n`;
                mdContent += `<<<<<<< 本地修改 (起始行: ${startLine})\n`;
                mdContent += localPart.join("\n") + "\n";
                mdContent += `=======\n`;
                mdContent += upstreamPart.join("\n") + "\n";
                mdContent += `>>>>>>>\n`;
                mdContent += `\`\`\`\n`; // 去掉这里原本多余的 \n
              }
              i++;
            }
          } catch (e) {
            mdContent += `*无法读取冲突详情: ${e.message}*\n\n`;
          }
          mdContent += `---\n\n`;
        }

        writeFileSync(logFilePath, mdContent);
        console.log(
          `${GREEN}✔ 已检测到 ${conflictFiles.length} 个冲突文件，报告已生成: ${logFilePath}${RESET}`,
        );
      }
    } finally {
      // --- 3. 清理现场，准备执行真正的 -X ours 合并 ---
      await $`git merge --abort`.quiet().nothrow();
    }
  } catch (e) {
    console.error(`  ${RED}✘ 冲突报告失败 ${version}: ${e.message}${RESET}`);
  }

  return R;
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

// 执行主程序
runSync().catch((err) => {
  console.error(`\n${RED}💥 程序异常终止:${RESET}`, err);
});
