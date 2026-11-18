# REA Windows Optimized

基于 [REA: Reverse Engineer Anything](https://github.com/morluto/rea) 的 Windows 优化版本，重点减少使用 Ghidra 分析已处理过的 DLL 时的重复等待。REA 可由 AI 客户端通过 MCP 调用，也提供命令行工作流；本优化位于 REA 的共享会话层，并不专属于某一个客户端。

感谢原项目作者和贡献者。本项目保留原项目的许可证和版权声明，是独立维护的优化版本，并非原项目官方发布。

- 原项目：<https://github.com/morluto/rea>
- [查看原 README（英文，保留的原始版本）](README.original.md)
- [查看原 README 中文版](docs/readme/README_zh.md)
- [Windows Ghidra 优化的实现、测试与性能记录](docs/windows/checkpoints.md)
- [REA 安装与配置](docs/getting-started/installation.md) · [MCP 工具目录](docs/reference/mcp-contracts.md#generated-catalog)

## 优化前后

原始测试中，Windows 上切换已分析 DLL 后再次打开目标，可能需要重新启动 Ghidra 并重复分析；当 REA 进程结束后，内存中的分析状态也会消失。等待时间主要来自 Ghidra 的启动和自动分析，而不是每次查询本身。

本项目为 Windows Ghidra 增加持久 Checkpoint 和同一会话内的目标复用：分析完成后保存可恢复的 Program，再次启动 REA 时可从磁盘恢复；同一会话在两个已分析目标间切换时，可保留上一个目标的 Ghidra 会话，切回时复用。

以下是 2026-11-18 在 Windows 11 x64、Ghidra 12.1.4、JDK 21 和两个 DLL 样本上的实测，时间不是速度承诺：

| 测试场景                                               |           优化前 |      优化后 | 说明                                                                             |
| ------------------------------------------------------ | ---------------: | ----------: | -------------------------------------------------------------------------------- |
| A → B → A，切回 A 并反编译：早期原始测试与热切换测试   |         66.94 秒 |  约 0.32 秒 | 分别测得；测试负载并非严格相同，可看作实际案例，不是严格对照。                   |
| A → B → A，切回 A 并反编译：相同已有 Checkpoint 的对照 |        26.364 秒 |    0.335 秒 | 相同样本、缓存与验证流程，约减少 26.03 秒；基线已有 Checkpoint，但尚无会话复用。 |
| REA 重启后恢复已分析目标                               | 原始测试约 66 秒 | 约 13–34 秒 | 不同测试负载下的记录，并非严格同条件对照；恢复仍需启动 Ghidra。                  |

上述切换时间针对**已经分析过的目标**。新文件第一次仍需完整分析并生成 Checkpoint；首次分析不保证加速。对照测量覆盖选定查询及分析指纹，不代表所有文件、机器和工作负载都会得到相同结果。实测条件、样本、CPU 与内存的测量口径见[性能记录](docs/windows/checkpoints.md#retained-session-comparison-2026-11-18)。

## 具体做了什么

1. **Windows 持久 Checkpoint**：在 Windows x64 支持保存和恢复受 REA 管理的 Ghidra Program。依据文件内容与分析配置区分缓存，并通过校验、原子发布和独占租约保护缓存；缓存不可用时保留错误信息和恢复路径。
2. **多 DLL 会话复用**：对符合条件的只读 Ghidra Checkpoint 会话，除当前目标外最多保留一个已加载目标。切回相同路径、内容和分析配置的目标前检查会话健康状态；关闭会话或选择第三个目标时释放相应资源。
3. **Windows 路径与目录权限**：支持 Windows 绝对路径，检查缓存目录 ACL、独占租约和本地文件系统约束，避免将其他用户可写的已有目录直接当作私有缓存。
4. **Ghidra 专用 JDK 配置**：可用 `REA_GHIDRA_JAVA_HOME` 为 Ghidra 选择 JDK；设置后它优先于 `JAVA_HOME`，不要求更改其他 Java 程序的设置。
5. **真实 Ghidra 验证**：提供 Windows 验收脚本，覆盖缓存恢复、双 DLL 切换、选定分析结果比较以及错误恢复等场景。脚本和覆盖边界见[验证说明](docs/windows/checkpoints.md#run-and-verify)。

保留的会话会占用额外进程、内存和 Checkpoint 租约；最多两个 Ghidra 客户端不等于固定内存上限。不同 REA 进程不能同时持有同一目标的独占租约。Windows Checkpoint 会话的数据库编辑能力仍受限制，原始可执行文件不会因分析而被改写。

## 使用

准备兼容的 Node.js、Ghidra 和 JDK。Ghidra 与 JDK 需要自行安装；Windows 原生组件的构建前提见 [Windows 构建说明](docs/windows/checkpoints.md#build)。在 Windows PowerShell 中，可为启动 REA 的进程设置：

```powershell
$env:GHIDRA_INSTALL_DIR = 'C:\path\to\ghidra'
$env:REA_GHIDRA_JAVA_HOME = 'C:\path\to\jdk-21'
$env:REA_GHIDRA_CHECKPOINT_DIR = 'C:\path\to\private-rea-checkpoints'
node scripts/rea.mjs --mcp
```

路径请替换为本机实际位置；缓存目录必须是供当前用户使用的本地私有目录。上面的命令启动与 MCP 客户端通信的后台服务，通常由客户端配置启动；修改启动环境后需要重启对应的 REA 服务或客户端。若通过源码运行，请先按构建说明安装依赖并构建所需产物。正式使用时可依据[客户端配置指南](docs/getting-started/client-configuration.md)接入 Codex、Trae 或其他兼容 MCP 的客户端。

更多信息：[支持的客户端](docs/getting-started/installation.md#supported-agents) · [MCP 注册与配置](docs/getting-started/installation.md#mcp-registry) · [![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5)](docs/reference/mcp-contracts.md#generated-catalog) · [原项目许可证](LICENSE)。
