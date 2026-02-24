# 项目上下文

当前项目名为 MoltBot，是对原始 Node.js 项目 Openclaw 的重构。
目标运行环境是 **Bun.js**，不再使用传统的 Node.js 运行时。

# 编码规范与迁移原则

在生成代码、重构文件或回答问题时，请严格遵守以下规则：

1. **模块化标准**：强制使用 ES Modules (`import`/`export`)，彻底淘汰 CommonJS (`require`/`module.exports`)。
2. **包管理**：所有的依赖安装、脚本运行必须使用 `bun` 命令（如 `bun install`, `bun run`，取代 `npm` 或 `yarn`）。
3. **原生 API 替换**：
   - 优先使用 `Bun.file()` 和 `Bun.write()` 替代 Node 的 `fs` 模块。
   - 优先使用 `Bun.serve()` 替代 Node 的 `http` 模块。
   - 优先使用全局的 `fetch` API 进行网络请求，替代 `axios` 或 `node-fetch`。
4. **测试框架**：如果涉及到测试代码的重构，请默认使用 `bun test` 提供的方法（如 `describe`, `expect`, `test`），移除 Jest 或 Mocha 等旧依赖。
5. **性能优先**：在编写或修改核心逻辑时，充分利用 Bun 的内置优化（如需要用到数据库，优先考虑原生 SQLite 支持 `bun:sqlite`）。

# 回复要求

请直接输出重构后的代码或精准的修改建议，减少不必要的背景解释，保持代码的简洁和高性能。
