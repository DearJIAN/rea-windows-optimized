# REA Windows Optimized

基于 [REA: Reverse Engineer Anything](https://github.com/morluto/rea) 的 Windows 优化版本，重点减少使用 Ghidra 分析已处理过的 DLL 时的重复等待。REA 可由 AI 客户端通过 MCP 调用，也提供命令行工作流；本优化位于 REA 的共享会话层，并不专属于某一个客户端。

感谢原项目作者和贡献者。本项目保留原项目的许可证和版权声明，是独立维护的优化版本，并非原项目官方发布。

- 原项目：<https://github.com/morluto/rea>
- [查看原 README（英文，保留的原始版本）](README.original.md)
- [查看原 README 中文版](docs/readme/README_zh.md)
- [Windows Ghidra 优化的实现、测试与性能记录](docs/windows/checkpoints.md)
- [本优化版变更记录](WINDOWS_CHANGELOG.md)
- [REA 安装与配置](docs/getting-started/installation.md) · [MCP 工具目录](docs/reference/mcp-contracts.md#generated-catalog)

## 快速开始：在 Windows 上使用优化版

下面以 **Windows x64 和 Codex** 为例，从本仓库源码构建并接入；Trae 等其他 MCP 客户端也可指向同一份构建产物。仓库公开前，克隆需要有仓库访问权限。不要用 `npm install -g rea-agents` 代替下面的构建步骤：该命令安装 npm 上的包，不保证包含本仓库的优化。

### 1. 准备并构建

自行准备 Git、Node.js 24.22.1（见 [.nvmrc](.nvmrc)）、JDK 21、Ghidra 12.x，以及用于构建 Windows 原生组件的 MSYS2 UCRT64 MinGW 工具链。Ghidra 和 JDK 不由 REA 自动安装；具体要求见 [Windows 构建说明](docs/windows/checkpoints.md#build)。

在 PowerShell 中执行（将目录改成自己的位置）：

```powershell
git clone https://github.com/DearJIAN/rea-windows-optimized.git D:\TOOLS\rea-windows-optimized
Set-Location D:\TOOLS\rea-windows-optimized
npm ci
npm run build:cached

# 指向本机 MSYS2 UCRT64 工具链，再构建和验证 Windows 原生组件
$env:PATH = 'C:\msys64\ucrt64\bin;C:\Windows\System32;C:\msys64\usr\bin;' + $env:PATH
npm run build:windows-native
npm run verify:windows-native:artifact
node scripts/rea.mjs --version
```

最后的版本号仅确认入口可以运行，**不能单凭版本号区分优化版和原版**。后续客户端配置必须指向上面克隆目录中的 `scripts/rea.mjs`；保留该目录及构建产物。更新源码后需重新构建；原生组件的完整要求和验证方式以 [Windows 构建说明](docs/windows/checkpoints.md#build)为准。

### 2. 接入 Codex 并启用 Checkpoint

在 Codex 配置文件 `%USERPROFILE%\.codex\config.toml` 中添加以下配置。将所有路径换成本机真实的绝对路径；其中 `cwd` 和 `args` 指向**第 1 步的优化版仓库**，`command` 指向本机 Node.js。Checkpoint 选择当前用户专用的本地目录，不要使用公共临时目录。

```toml
[mcp_servers.rea-windows-optimized]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\TOOLS\rea-windows-optimized\scripts\rea.mjs', 'mcp']
cwd = 'D:\TOOLS\rea-windows-optimized'
startup_timeout_sec = 120
tool_timeout_sec = 450

[mcp_servers.rea-windows-optimized.env]
GHIDRA_INSTALL_DIR = 'D:\TOOLS\ghidra\ghidra_12.1.4_PUBLIC'
REA_GHIDRA_JAVA_HOME = 'D:\TOOLS\jdk\jdk-21.0.13+9'
REA_GHIDRA_CHECKPOINT_DIR = 'D:\rea-checkpoints'
```

修改前先备份配置；如果已有 REA 配置，可先保留并用上面的独立名称测试。完成后重启或重新连接 Codex，使新的 MCP 配置生效。其他客户端的配置方式见 [MCP 客户端配置](docs/getting-started/client-configuration.md)和 [Trae 配置示例](docs/windows/checkpoints.md#connecting-trae-cn-manual-opt-in)。不同 REA 进程不能同时持有同一目标的 Checkpoint 租约，因此测试另一服务前先关闭正在使用该目标的会话。

### 3. 分析并确认优化生效

在 Codex 中请它使用 `rea-windows-optimized` 服务和 Ghidra 打开自己的 DLL、对指定函数反编译，完成后关闭分析会话。第一次分析新文件仍需完整分析；正常关闭后，再打开同一文件并反编译。检查返回的 Evidence：恢复成功时会说明已恢复保存的 Program，且没有重新运行自动分析。若未看到该证据，不要仅凭耗时判断恢复成功。

在同一 REA 会话内分析已处理的 A、B 后切回 A，可以体验符合条件的会话复用；它与重启后的磁盘 Checkpoint 恢复是两个不同场景。测试完成后关闭分析会话。恢复依赖目标内容和分析配置匹配，其他限制和排错方法见 [Windows Checkpoint 说明](docs/windows/checkpoints.md)。

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

### Codex 全局安装验证

2026-11-18 在同一台 Windows 11 x64 机器上，从 Codex 聊天直接调用全局安装的 REA 6.9.0 MCP 服务，使用 Ghidra 12.1.4 打开真实的 x86 PE DLL `vl3vpn.dll`，并反编译地址 `0x10041eb0`。服务进程的启动路径指向用户 npm 全局目录中的 `rea-agents/scripts/rea.mjs`；运行中的进程链同时确认该服务由 Codex 启动，并由其启动 Ghidra。两次均返回 `array_vpn_set_authinfo` 的伪代码，分析会话均已正常关闭。

| Codex 调用 | 打开 DLL | 首次反编译 | 两次调用耗时之和 |
| ---------- | -------: | ---------: | ---------------: |
| 第一次     | 1.827 秒 |  14.953 秒 |        16.780 秒 |
| 第二次     | 0.196 秒 |  19.397 秒 |        19.593 秒 |

两次测试使用已有的磁盘 Checkpoint；第二次在同一个 REA 服务中、关闭上一次分析会话后执行。反编译 Evidence 明确记录从指定 Checkpoint 恢复 Program，且没有重新运行自动分析；第二次运行中的 Ghidra 启动参数也包含恢复文件和 `-noanalysis`。计时为客户端分别等待两次工具调用的时间之和，不含调用间隔和关闭时间；它们是两次实测，不是性能保证或冷启动对照。

## 具体做了什么

1. **Windows 持久 Checkpoint**：在 Windows x64 支持保存和恢复受 REA 管理的 Ghidra Program。依据文件内容与分析配置区分缓存，并通过校验、原子发布和独占租约保护缓存；缓存不可用时保留错误信息和恢复路径。
2. **多 DLL 会话复用**：对符合条件的只读 Ghidra Checkpoint 会话，除当前目标外最多保留一个已加载目标。切回相同路径、内容和分析配置的目标前检查会话健康状态；关闭会话或选择第三个目标时释放相应资源。
3. **Windows 路径与目录权限**：支持 Windows 绝对路径，检查缓存目录 ACL、独占租约和本地文件系统约束，避免将其他用户可写的已有目录直接当作私有缓存。
4. **Ghidra 专用 JDK 配置**：可用 `REA_GHIDRA_JAVA_HOME` 为 Ghidra 选择 JDK；设置后它优先于 `JAVA_HOME`，不要求更改其他 Java 程序的设置。
5. **真实 Ghidra 验证**：提供 Windows 验收脚本，覆盖缓存恢复、双 DLL 切换、选定分析结果比较以及错误恢复等场景。脚本和覆盖边界见[验证说明](docs/windows/checkpoints.md#run-and-verify)。

保留的会话会占用额外进程、内存和 Checkpoint 租约；最多两个 Ghidra 客户端不等于固定内存上限。不同 REA 进程不能同时持有同一目标的独占租约。Windows Checkpoint 会话的数据库编辑能力仍受限制，原始可执行文件不会因分析而被改写。

更多信息：[支持的客户端](docs/getting-started/installation.md#supported-agents) · [MCP 注册与配置](docs/getting-started/installation.md#mcp-registry) · [![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5)](docs/reference/mcp-contracts.md#generated-catalog) · [原项目许可证](LICENSE)。
