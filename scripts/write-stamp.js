#!/usr/bin/env bun
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const distRoot = join(process.cwd(), "dist");
const buildStampPath = join(distRoot, ".buildstamp");

try {
  mkdirSync(distRoot, { recursive: true });

  // 获取当前 Git HEAD
  let head = null;
  try {
    head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    // 非 Git 环境忽略
  }

  const stamp = {
    builtAt: Date.now(),
    head: head,
  };

  writeFileSync(buildStampPath, JSON.stringify(stamp, null, 2) + "\n");
  console.log(`✅ Build stamp generated at ${buildStampPath}`);
} catch (error) {
  console.error(`❌ Failed to write build stamp: ${error.message}`);
  process.exit(1);
}
