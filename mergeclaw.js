#!/usr/bin/env bun

import { $ } from "bun";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";

/**
 * MoltBot 同步工具 - mergeclaw.js
 * 功能：
 * 1. 自动获取上游 (OpenClaw) 最新版本。
 * 2. 模拟合并以检测冲突并生成 Markdown 报告。
 * 3. 过滤预期内的 package.json 自动修复冲突，提取实质性冲突。
 * 4. 使用 -X ours 策略自动完成合并，避免手动处理冲突。
 * 5. 自动修正品牌命名空间与依赖路径。
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
        // 🌟 屏蔽 pnpm-lock.yaml 的冲突日志
        if (line.includes("pnpm-lock.yaml")) {
          continue;
        }
        // 🌟 屏蔽根目录 package.json 的冲突日志 (因为我们要手工处理)
        if (line.includes("package.json") && !line.includes("extensions")) {
          continue;
        }

        if (line.startsWith("Auto-merging")) {
          console.log(`${GREEN}  [自动合并] ${RESET}${line.replace("Auto-merging ", "")}`);
        } else if (line.startsWith("CONFLICT")) {
          console.log(
            `${RED}${BOLD}  [需处理冲突] ${RESET}${RED}${line.replace("CONFLICT ", "")}${RESET}`,
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
  console.log(`   2. 手工比对并修复根目录的 package.json 文件`);
  console.log(
    `   3. 确认无误后运行: ${BOLD}git commit -m "chore: sync to version ${upstreamVersion}"${RESET}`,
  );
  console.log(`   4. 上传代码 ${BOLD}git push${RESET}`);
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
  let logFilePath;
  try {
    const syncDir = join(process.cwd(), "sync");
    if (!existsSync(syncDir)) mkdirSync(syncDir, { recursive: true });

    // --- 自动计算文件名 (如 2026.2.18-2.md) ---
    let logFileName = `${version}.md`;
    logFilePath = join(syncDir, logFileName);
    let counter = 1;
    while (existsSync(logFilePath)) {
      counter++;
      logFileName = `${version}-${counter}.md`;
      logFilePath = join(syncDir, logFileName);
    }

    let conflictFiles = [];
    console.log(`${YELLOW}🔍 正在检测冲突并过滤自动修复项...${RESET}`);

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
        mdContent += `> **注意**：以下内容在合并中已按本地优先处理。若需上游逻辑，请手动参考下方代码块。\n`;
        mdContent += `> *(注：已自动过滤 package.json 中 name、version 等自动修复项)*\n\n`;

        let totalReportableFiles = 0;

        for (const file of conflictFiles) {
          const fileName = String(file);
          if (!existsSync(fileName)) continue;

          // 忽略 pnpm-lock.yaml 写入冲突报告
          if (fileName === "pnpm-lock.yaml") continue;

          // 🌟 忽略根目录的 package.json 写入冲突报告（交由开发者手工处理）
          if (fileName === "package.json") continue;

          let fileMdContent = `### 文件: \`${fileName}\`\n\n`;
          let hasReportableBlocks = false;

          // 🌟 修改点 1：精准匹配，仅当文件路径以 extensions/ 开头且以 package.json 结尾时为 true
          const isExtensionPackageJson =
            fileName.startsWith("extensions/") && fileName.endsWith("package.json");

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
                      localPart.push({ num: i, text: lines[i] });
                    } else {
                      upstreamPart.push({ num: i, text: lines[i] });
                    }
                  }
                  i++;
                }

                // 🌟 修改点 2：应用新的严格判断变量进行行级别过滤
                if (isExtensionPackageJson) {
                  const isIgnorableLine = (lineText) => {
                    const clean = lineText.trim();
                    if (!clean) return true;
                    // 过滤掉我们不关心的常规变动，包含了 defaultChoice 和 npmSpec 等新字段
                    if (/^"?(version|devDependencies|defaultChoice|localPath)"?\s*:/.test(clean))
                      return true;
                    if (clean.includes('"file:../../"')) return true;

                    // 匹配仅包含括号、逗号等语法的行
                    if (/^[{}[\],"\s]+$/.test(clean)) {
                      return true;
                    }

                    return false;
                  };

                  localPart = localPart.filter((l) => !isIgnorableLine(l.text));
                  upstreamPart = upstreamPart.filter((l) => !isIgnorableLine(l.text));

                  // 如果过滤后两边剩下的内容一模一样，或者全空，则直接忽略该冲突块
                  const localStr = localPart.map((l) => l.text.trim()).join("\n");
                  const upstreamStr = upstreamPart.map((l) => l.text.trim()).join("\n");

                  if (localStr === upstreamStr) {
                    i++;
                    continue;
                  }
                }

                hasReportableBlocks = true;
                const ext = extname(fileName).slice(1) || "text";
                const lang =
                  ext === "ts" || ext === "tsx" ? "typescript" : ext === "js" ? "javascript" : ext;

                fileMdContent += `#### 冲突块 #${blockIndex++}\n`;
                fileMdContent += `\`\`\`${lang}\n`;
                fileMdContent += `<<<<<<< 本地修改 (起始行: ${startLine})\n`;
                localPart.forEach((l) => {
                  const lineNum = l.num.toString().padStart(4, " ");
                  fileMdContent += `${lineNum} | ${l.text}\n`;
                });
                fileMdContent += `=======\n`;
                upstreamPart.forEach((l) => {
                  fileMdContent += `${l.text}\n`;
                });
                fileMdContent += `>>>>>>> 上游修改\n`;
                fileMdContent += `\`\`\`\n`;
              }
              i++;
            }
          } catch (e) {
            fileMdContent += `*无法读取冲突详情: ${e.message}*\n\n`;
            hasReportableBlocks = true;
          }

          if (hasReportableBlocks) {
            mdContent += fileMdContent + `---\n\n`;
            totalReportableFiles++;
          }
        }

        if (totalReportableFiles === 0) {
          writeFileSync(
            logFilePath,
            `# Sync Report - ${version}\n\n✅ 本次合并仅包含 package.json 的自动修复项冲突，无实质性代码冲突。`,
          );
          console.log(`${GREEN}✔ 已过滤自动修复项，本次合并无实质性代码冲突！${RESET}`);
        } else {
          writeFileSync(logFilePath, mdContent);
          console.log(
            `${GREEN}✔ 已检测到 ${totalReportableFiles} 个实质性冲突文件，报告已生成: ${logFilePath}${RESET}`,
          );
        }
      }
    } finally {
      // --- 3. 清理现场，准备执行真正的 -X ours 合并 ---
      await $`git merge --abort`.quiet().nothrow();
    }
  } catch (e) {
    console.error(`  ${RED}✘ 冲突报告失败 ${version}: ${e.message}${RESET}`);
  }

  return logFilePath;
}

async function handlePackageJsonConflict(filePath) {
  try {
    // 获取上游内容
    const upstreamContent = await $`git show upstream/main:${filePath}`.text();
    const upstreamPkg = JSON.parse(upstreamContent);

    // 🌟 修复依赖丢失 Bug：以上游最新配置(upstreamPkg)为基准，确保不错过任何新增的 dependencies
    const updatedPkg = {
      ...upstreamPkg,
    };

    // 🌟 修正依赖：将 devDependencies 中的 openclaw 替换为 moltbot 并指向物理路径
    if (updatedPkg.devDependencies && updatedPkg.devDependencies.openclaw) {
      updatedPkg.devDependencies.openclaw = "file:../../";
      updatedPkg.devDependencies.moltbot = "file:../../";
    }

    // 🌟 默认包为 local
    if (updatedPkg.moltbot && updatedPkg.moltbot.install) {
      if (updatedPkg.moltbot.install.defaultChoice === "npm") {
        updatedPkg.moltbot.install.defaultChoice = "local";
      }
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
