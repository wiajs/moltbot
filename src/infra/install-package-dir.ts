import fs from "node:fs/promises";
import { runCommandWithTimeout } from "../process/exec.js";
import { fileExists } from "./archive.js";
import { detectPackageManager } from "./detect-package-manager.js";

function getInstallCommand(manager: "pnpm" | "bun" | "npm" | null): string[] {
  if (manager === "pnpm") {
    return ["pnpm", "install", "--prod", "--silent", "--ignore-scripts"];
  }
  if (manager === "bun") {
    return ["bun", "install", "--production", "--ignore-scripts"];
  }
  return ["npm", "install", "--omit=dev", "--silent", "--ignore-scripts"];
}

export async function installPackageDir(params: {
  sourceDir: string;
  targetDir: string;
  mode: "install" | "update";
  timeoutMs: number;
  logger?: { info?: (message: string) => void };
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: () => void | Promise<void>;
  root?: string; // Optional root to detect package manager from
}): Promise<{ ok: true } | { ok: false; error: string }> {
  params.logger?.info?.(`Installing to ${params.targetDir}…`);
  let backupDir: string | null = null;
  if (params.mode === "update" && (await fileExists(params.targetDir))) {
    backupDir = `${params.targetDir}.backup-${Date.now()}`;
    await fs.rename(params.targetDir, backupDir);
  }

  const rollback = async () => {
    if (!backupDir) {
      return;
    }
    await fs.rm(params.targetDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rename(backupDir, params.targetDir).catch(() => undefined);
  };

  try {
    await fs.cp(params.sourceDir, params.targetDir, { recursive: true });
  } catch (err) {
    await rollback();
    return { ok: false, error: `${params.copyErrorPrefix}: ${String(err)}` };
  }

  try {
    await params.afterCopy?.();
  } catch (err) {
    await rollback();
    return { ok: false, error: `post-copy validation failed: ${String(err)}` };
  }

  if (params.hasDeps) {
    params.logger?.info?.(params.depsLogMessage);
    const manager = await detectPackageManager(params.root ?? params.targetDir);
    const installCmd = getInstallCommand(manager);

    const npmRes = await runCommandWithTimeout(installCmd, {
      timeoutMs: Math.max(params.timeoutMs, 300_000),
      cwd: params.targetDir,
    });
    if (npmRes.code !== 0) {
      await rollback();
      return {
        ok: false,
        error: `${installCmd[0]} install failed: ${npmRes.stderr.trim() || npmRes.stdout.trim()}`,
      };
    }
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true };
}
