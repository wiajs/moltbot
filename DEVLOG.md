## 插件系统

1. 如何单独发布@openclaw/bluebubbles? 项目代码中有单独发布 插件的功能吗?  
    2. 手动执行 npm install @openclaw/bluebubbles,后,系统加载时,会有限加载手动安装库吗?哪里实现的?  
    3. "defaultChoice": "npm",“未找到该插件，是否执行 npm install @openclaw/bluebubbles？”, moltbot 的运行环境是bun,安装插件,需改为 bun add ,这部分代码需要修改  
   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
   ✦ 针对这三个深入的发布与安装机制问题，我进行了代码层面的深度调研，以下是架构层面的详细回答：

1. 如何单独发布插件？项目中是否有相关功能？
   结论：项目中存在同步插件版本和构建的脚本，但“发布到 NPM”的操作通常是手动的或通过 CI/CD 完成。

- 同步工具：我在 package.json 中发现了一个脚本：
  1 "plugins:sync": "bun scripts/sync-plugin-versions.ts"
  这个脚本的作用是将根目录 package.json 的版本号同步到所有 extensions/\*/package.json 中，确保整个项目版本一致。
- 发布流程：
  由于每个插件目录都有自己的 package.json，你可以直接进入插件目录执行发布：

```bash
1     cd extensions/bluebubbles
2     npm publish --access public
```

目前项目中没有看到一个“一键发布所有插件到 NPM”的自动化脚本。这通常是为了防止误发布，因为并非每个插件在每次核心更新时都需要重新发布。

2. 手动安装库是否会优先加载？在哪里实现的？

结论：是的，系统会根据“来源优先级”进行冲突处理。逻辑实现在 `src/plugins/loader.ts` 中。

在 loadOpenClawPlugins 函数中（约 460-490 行），系统维护了一个 seenIds 映射：

```js
1 const seenIds = new Map<string, PluginRecord["origin"]>();
2
3 for (const candidate of discovery.candidates) {
4   const pluginId = manifestRecord.id;
5   const existingOrigin = seenIds.get(pluginId);
6   if (existingOrigin) {
7     // 如果已经看到了同一个 ID 的插件，且当前这个来源优先级更低，则跳过
8     // ...
9     continue;
10   }
11   // ...
12   seenIds.set(pluginId, candidate.origin);
13 }
```

### 加载优先级顺序（由 discoverOpenClawPlugins 的调用顺序决定）：

1. `extraPaths` (用户通过配置手动指定的路径 - 最高优先级)
2. `workspace` (项目本地 .moltbot/extensions 目录)
3. `global` (用户系统全局 ~/.moltbot/extensions 目录)
4. `bundled` (项目自带的 extensions/ 目录 - 最低优先级)

这意味着：如果你执行了 npm install @openclaw/bluebubbles，该插件会被安装到 node_modules
中。如果你的配置将其路径加入到了加载路径中，或者它作为全局/工作区插件被发现，它将覆盖掉项目内置（bundled）的同名插件。

3. 安装指令是否需要从 npm install 改为 bun add？

结论：是的，非常有必要。

目前项目中处理“自动安装”逻辑的代码主要集中在 src/infra/npm-pack-install.ts 和相关的测试文件中。虽然系统内部使用的是编程方式调用（如 npm
pack），但如果涉及到给用户的交互提示或自动执行脚本，确实应该适配 bun。

我找到了负责安装逻辑的核心代码。我将搜索 npm install 字符串，看看哪里需要修改。

✦ 修改建议与深度分析

通过搜索发现，项目中使用了多种包管理器（npm, pnpm, bun）。为了让 moltbot 在 bun 环境下表现更佳，我们需要对安装逻辑进行针对性优化。

1. 单独发布插件 (NPM Publish)
   正如之前所说，目前是通过进入插件目录手动发布的。如果你想自动化，可以在根目录添加一个脚本，遍历 extensions/ 并执行发布。但由于你希望保持与上游 openclaw
   的兼容，建议不要轻易发布同名的 `@openclaw/...` 包（除非你有发布权限），而是作为 moltbot 的一部分分发。

2. 插件加载优先级 (Implementation)
   验证了 src/plugins/loader.ts 中的逻辑。它确实通过 seenIds 确保了“先到先得”。如果你想改变这种行为（比如让 node_modules 里的插件强制覆盖内置插件），你需要调整
   discoverOpenClawPlugins 中目录扫描的返回顺序。

- 当前顺序：extraPaths -> workspace -> global -> bundled。
- 结论：如果你通过 npm install 将插件装到了 node_modules，且该路径在 extraPaths 或 workspace 中被包含，它就会优先于 bundled 被加载。

3. 将 npm install 改为 bun add
   这是最紧迫的修改。在 src/infra/install-package-dir.ts 等文件中，系统调用了 npm 命令。

我将修改 src/infra/package-manager.ts（或者类似的包管理器检测逻辑），使其在检测到 bun 运行时优先使用 bun。

✦ 架构师总结

我已经完成了以下关键修正，确保 moltbot 在 Bun 环境下拥有原生的插件安装体验：

1.  修复了环境检测逻辑：detectPackageManager 现在可以正确识别 bun.lock 文件（Bun 1.2+ 的主流格式）。
2.  重构了插件安装指令：在 installPackageDir.ts 中，我们告别了硬编码的 npm install。
    - 在 Bun 环境下：系统会自动执行 bun install --production --ignore-scripts。
    - 在 pnpm 环境下：使用 pnpm install --prod。
    - 兜底逻辑：依然保留了对 npm 的支持。

现在，当你运行 `moltbot` 并在 `bun` 环境下安装插件时，它将使用更快速的 `bun install` 且完全遵循生产环境的最佳实践。

### 1. 如何关闭通过安装脚本运行的后台服务？

由于你之前通过 install.sh 或 onboard 命令安装了后台守护进程（Daemon），它会一直占用 18789 端口，导致你本地开发时报 EADDRINUSE（端口被占用）错误。

关闭它的方法：

如果你是在 macOS 上：

```Bash

# 停止当前正在运行的后台服务
launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist
# （可选）如果你不想它开机自启了，可以把这个文件删掉
# rm ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

如果你是在 Linux 上：

```Bash
systemctl --user stop openclaw-gateway
# （可选）取消开机自启
# systemctl --user disable openclaw-gateway
```

或者，如果你本地的旧版 CLI 还能用，你可以直接运行：

```Bash

moltbot daemon stop
# 或
openclaw daemon stop
```
