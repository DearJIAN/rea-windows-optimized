# REA Windows Optimized

基于 [REA: Reverse Engineer Anything](https://github.com/morluto/rea) 的 Windows 优化版本，重点减少使用 Ghidra 分析已处理过的 DLL 时的重复等待。REA 可由 AI 客户端通过 MCP 调用，也提供命令行工作流；本优化位于 REA 的共享会话层，并不专属于某一个客户端。

感谢原项目作者和贡献者。本项目保留原项目的许可证和版权声明，是独立维护的优化版本，并非原项目官方发布。

- 原项目：<https://github.com/morluto/rea>
- [查看原 README（英文，保留的原始版本）](README.original.md)
- [查看原 README 中文版](docs/readme/README_zh.md)
- [Windows Ghidra 优化的实现、测试与性能记录](docs/windows/checkpoints.md)
- [DearJIAN 的 Windows 优化变更记录](DearJIAN-docs/WINDOWS_CHANGELOG.md)
- [Checkpoint 与优化原理详解](DearJIAN-docs/windows-checkpoint-optimization.md)
- [auto 自动模式：规则、原理和本机验证](DearJIAN-docs/auto-memory-retention.md)
- [REA 安装与配置](docs/getting-started/installation.md) · [MCP 工具目录](docs/reference/mcp-contracts.md#generated-catalog)

本优化版的后续笔记与变更记录统一保存在 [DearJIAN-docs 文件夹](DearJIAN-docs/)。

## auto 自动模式与默认值

**本机状态（2026-11-18）：** 作者的 Windows 用户环境和 Codex REA 启动配置均已设置 `REA_GHIDRA_RETAINED_TARGETS=auto`，因此读取这些配置的新全局 REA 进程默认采用自动模式。已经运行的旧进程需要重新连接或重启才能读取新代码和配置。其他机器不会因克隆本仓库自动获得该设置；**项目未配置时的默认容量仍是 2**。

`auto` 不设固定目标数量上限，也不会自己寻找或分析文件。你提出任务后，AI 选择文件并调用 REA；REA 在符合条件的 Windows 只读 Ghidra Checkpoint 会话中按需保留目标。整机物理内存占用达到 **90%**，或后台目标闲置 **30 分钟**时，REA 优先释放最久未使用的后台目标；当前目标不会被后台维护主动关闭。检查在切换目标时和有后台目标时约每 30 秒进行，忙碌时会等待，因而 90% 是回收触发线，不是硬上限。内存读数不可用时，新保留目标会保守回退至总容量 2。

完整触发流程、涉及的代码文件、失败处理以及本机全局测试见 [auto 自动模式的详细原理](DearJIAN-docs/auto-memory-retention.md)。

## Checkpoint 是什么？

Checkpoint（检查点）是 REA 保存的、已经完成 Ghidra 自动分析的 Program 快照。下次分析相同内容且配置匹配的目标时，REA 可以从磁盘恢复这份结果，避免重新执行自动分析；这不是对原 DLL 的修改，也不能从首次分析中途断点续跑。恢复仍需启动 Ghidra，因此并非瞬间完成。原版已有 Checkpoint 设计，本项目扩展了 Windows 支持，并另行优化同一会话内的目标切换。流程与限制见 [Checkpoint 和优化原理详解](DearJIAN-docs/windows-checkpoint-optimization.md)。

## 快速开始：在 Windows 上使用优化版

下面以 **Windows x64 和 Codex** 为例，从本仓库源码构建并接入；Trae 等其他 MCP 客户端也可指向同一份构建产物。克隆需要网络连接；如果使用的仓库是私有仓库，还需要相应访问权限。不要用 `npm install -g rea-agents` 代替下面的构建步骤：该命令安装 npm 上的包，不保证包含本仓库的优化。

> **下面的路径是作者 DearJIAN 的本机示例，不是你的电脑路径。不要直接复制执行！** `D:\TOOLS\...`、`C:\msys64\...`、`C:\Windows\System32` 和 Node.js 路径来自作者环境；`D:\rea-checkpoints` 是为了演示而填写的缓存路径，不是作者当前全局缓存路径。它们不会自动适配你的电脑。请先确认本机位置，将示例换成自己的真实路径；若本机某项路径恰好相同，可以保留。构建命令和 Codex 配置中指向同一位置的路径必须一起修改，不要覆盖已有数据。

### 让 AI 协助搭建（可复制）

在能够访问你本机文件和终端的 AI 客户端中，复制下面的提示词。路径由 AI 按当前机器检查，示例不应原样套用：

```text
请阅读 https://github.com/DearJIAN/rea-windows-optimized 的 README 和 Windows 构建说明，帮我在本机搭建这个优化版并接入 Codex，启用 Checkpoint 和 auto 模式。先检查操作系统、现有 Git、Node.js、Ghidra、JDK、MSYS2 工具链、仓库位置和 Codex 配置，使用本机真实路径；不要照搬作者示例路径。保留现有 REA、配置和缓存，修改配置前先备份；不要自行安装或升级无关软件，也不要自动安装 Ghidra 或 JDK。按项目的权限要求执行，缺少必须的信息或依赖时说明并向我确认。完成后验证配置和实际连接；若能用我提供的样本测试 Checkpoint，就报告恢复证据与耗时，否则明确说明未验证的部分。
```

### 1. 准备并构建

自行准备 Git、Node.js 24.22.1（见 [.nvmrc](.nvmrc)）、npm 11.16.0（见 `package.json` 的 `packageManager`）、JDK 21、Ghidra 12.x，以及用于构建 Windows 原生组件的 MSYS2 UCRT64 MinGW 工具链。Ghidra 和 JDK 不由 REA 自动安装；具体要求见 [Windows 构建说明](docs/windows/checkpoints.md#build)。

**下面的 PowerShell 代码块是作者 DearJIAN 电脑上的路径示例，不是你的实际路径，不能直接照抄执行。**其中 `D:\TOOLS\rea-windows-optimized` 是示例仓库目录，`C:\msys64\ucrt64\bin`、`C:\msys64\usr\bin` 是示例 MSYS2 路径，`C:\Windows\System32` 是示例 Windows 系统目录；请逐项确认并按你的电脑修改。克隆目标应是可用的新目录。先用 `node --version` 和 `npm --version` 核对工具版本，并确认所需工具存在，再执行：

全新克隆没有预生成 Windows 原生组件：**先构建并校验原生组件，再运行 `build:cached`**，否则运行时构建会因缺少原生组件而失败。依赖安装和原生组件构建还需要访问 npm 包源和 `nodejs.org`，请确保网络可用。

```powershell
# 作者 DearJIAN 的路径示例：先按本机实际路径修改，再执行！
& {
git clone https://github.com/DearJIAN/rea-windows-optimized.git D:\TOOLS\rea-windows-optimized
if ($LASTEXITCODE -ne 0) { throw '克隆失败，请检查仓库权限和目标目录。' }
Set-Location -LiteralPath 'D:\TOOLS\rea-windows-optimized' -ErrorAction Stop
npm ci
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败，请先检查错误。' }

# 指向本机 MSYS2 UCRT64 工具链，再构建和验证 Windows 原生组件
$env:PATH = 'C:\msys64\ucrt64\bin;C:\Windows\System32;C:\msys64\usr\bin;' + $env:PATH
npm run build:windows-native
if ($LASTEXITCODE -ne 0) { throw 'Windows 原生组件构建失败，请先检查工具链。' }
npm run verify:windows-native:artifact
if ($LASTEXITCODE -ne 0) { throw 'Windows 原生组件校验失败。' }
npm run build:cached
if ($LASTEXITCODE -ne 0) { throw 'REA 构建失败，请先检查错误。' }
node scripts/rea.mjs --version
if ($LASTEXITCODE -ne 0) { throw 'REA 入口检查失败。' }
}
```

最后的版本号仅确认入口可以运行，**不能单凭版本号区分优化版和原版**。后续客户端配置必须指向上面克隆目录中的 `scripts/rea.mjs`；保留该目录及构建产物。更新源码后需重新构建；原生组件的完整要求和验证方式以 [Windows 构建说明](docs/windows/checkpoints.md#build)为准。

### 2. 接入 Codex 并启用 Checkpoint

Codex 默认的用户配置文件是 `%USERPROFILE%\.codex\config.toml`；PowerShell 中可用 `Join-Path $env:USERPROFILE '.codex\config.toml'` 查看该路径。如果你为 Codex 指定了其他配置目录，请以实际配置为准。修改前先备份文件，保留原有配置和其他 MCP 服务；如果已有同名 `[mcp_servers.rea-windows-optimized]`，不要重复添加同名表，应检查并修改现有条目或选择不同的服务名。

**下面的 TOML 代码块是作者 DearJIAN 电脑上的接入路径示例，不是你的实际配置，不能直接复制使用。**其中 `D:\rea-checkpoints` 为演示缓存路径。请先把每个路径换为自己电脑的实际绝对路径；如果恰好一致可保留。特别是 `args` 和 `cwd` 必须与第 1 步构建的仓库位置一致，且 `cwd` 目录必须存在：

```toml
# 作者 DearJIAN 的路径示例：先按本机实际路径修改，再写入配置！
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
REA_GHIDRA_RETAINED_TARGETS = 'auto'
```

| 配置项                                     | 需要填写什么                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `command`                                  | 本机 `node.exe` 的完整路径；PowerShell 可用 `(Get-Command node -CommandType Application).Source` 查看。 |
| `args`                                     | 自己第 1 步仓库中的 `scripts\rea.mjs` 完整路径，以及启动参数 `mcp`。                                    |
| `cwd`                                      | 自己第 1 步的仓库目录；必须存在，并保留构建产物。                                                       |
| `startup_timeout_sec` / `tool_timeout_sec` | Codex 等待服务启动及单次工具调用的超时秒数；`120` 和 `450` 是示例值。                                   |
| `GHIDRA_INSTALL_DIR`                       | 本机 Ghidra 安装根目录，不是其 `support` 子目录。                                                       |
| `REA_GHIDRA_JAVA_HOME`                     | 本机 Ghidra 使用的 JDK 根目录，示例中的版本目录名不一定与你相同。                                       |
| `REA_GHIDRA_CHECKPOINT_DIR`                | 当前用户专用的本地缓存目录；`D:\rea-checkpoints` 只是演示，不要选公共临时目录。                         |
| `REA_GHIDRA_RETAINED_TARGETS`              | `auto` 启用自动模式；也可选择固定容量 `2`～`5`。                                                        |

此示例显式启用 `auto`；如果删除该行且启动环境也没有设置这一变量，项目默认容量为 2。保存后重启或重新连接 Codex，使新配置生效。如果安装了 Codex CLI，可运行 `codex mcp list` 检查是否列出了 `rea-windows-optimized`；**列表中出现服务不等于连接和分析已成功**，还需要执行下方第 3 步。Codex 配置格式另见 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp/)；其他客户端的配置方式见 [MCP 客户端配置](docs/getting-started/client-configuration.md)和 [Trae 配置示例](docs/windows/checkpoints.md#connecting-trae-cn-manual-opt-in)。不同 REA 进程不能同时持有同一目标的 Checkpoint 租约，因此测试另一服务前先关闭正在使用该目标的会话。

### 3. 分析并确认优化生效

在 Codex 中请它使用 `rea-windows-optimized` 服务和 Ghidra 打开自己的 DLL、对指定函数反编译，完成后关闭分析会话。第一次分析新文件仍需完整分析；正常关闭后，再打开同一文件并反编译。检查返回的 Evidence：恢复成功时会说明已恢复保存的 Program，且没有重新运行自动分析。若未看到该证据，不要仅凭耗时判断恢复成功。

如果服务没有出现在 Codex 中、无法连接，或没有可用样本，应分别报告该状态；单独在终端启动 REA 成功不代表 Codex 内的连接已经验证成功。

在同一 REA 会话内分析已处理的 A、B 后切回 A，可以体验符合条件的会话复用；它与重启后的磁盘 Checkpoint 恢复是两个不同场景。测试完成后关闭分析会话。恢复依赖目标内容和分析配置匹配，其他限制和排错方法见 [Windows Checkpoint 说明](docs/windows/checkpoints.md)。

默认最多同时保留 2 个目标（包括当前目标）。可在 MCP 服务的环境配置中将 `REA_GHIDRA_RETAINED_TARGETS` 设置为 `'3'`、`'4'`、`'5'`，或使用 `'auto'` 自动模式，然后重新连接服务。自动模式不设固定目标数量上限：符合条件的目标按需保留，后台目标闲置 30 分钟或整机物理内存占用达到 90% 时按最久未使用顺序释放。当前目标不会因自动回收被关闭；采样有延迟，90% 不是内存硬上限。更多进程仍会消耗内存并持有各自的 Checkpoint 租约。详见[配置与生命周期](docs/windows/checkpoints.md#reusing-a-loaded-target)。

其中内存占用怎么算、何时检查、压力解除后如何恢复，见 [auto 的触发规则和实现](DearJIAN-docs/auto-memory-retention.md#触发规则)。

3～5 个真实 DLL 的切换与资源实测见 [DearJIAN 的测试记录](DearJIAN-docs/multi-target-pool-results.md)。

关于恢复与复用分别节省了哪些步骤，以及已有验证的范围，见[优化原理和验证证据](DearJIAN-docs/windows-checkpoint-optimization.md#验证证据与局限)。

## 优化前后

原始测试中，Windows 上切换已分析 DLL 后再次打开目标，可能需要重新启动 Ghidra 并重复分析；当 REA 进程结束后，内存中的分析状态也会消失。等待时间主要来自 Ghidra 的启动和自动分析，而不是每次查询本身。

本项目为 Windows Ghidra 增加持久 Checkpoint 和同一会话内的目标复用：分析完成后保存可恢复的 Program，再次启动 REA 时可从磁盘恢复；同一会话在两个已分析目标间切换时，可保留上一个目标的 Ghidra 会话，切回时复用。

这两种方式的适用条件和相较原版的变化，详见[优化原理与对照](DearJIAN-docs/windows-checkpoint-optimization.md#相较原版改了什么)。

2026-11-19 使用三个相同 DLL 副本对旧版与优化版完成了真实 MCP 对照：包括首次分析、两轮切换、磁盘恢复及内存代价，详见[三 DLL 旧版对照报告](DearJIAN-docs/real-baseline-comparison-20261119.md)。

以下是 2026-11-18 在 Windows 11 x64、Ghidra 12.1.4、JDK 21 和两个 DLL 样本上的实测，时间不是速度承诺：

| 测试场景                                               |           优化前 |      优化后 | 说明                                                                             |
| ------------------------------------------------------ | ---------------: | ----------: | -------------------------------------------------------------------------------- |
| A → B → A，切回 A 并反编译：早期原始测试与热切换测试   |         66.94 秒 |  约 0.32 秒 | 分别测得；测试负载并非严格相同，可看作实际案例，不是严格对照。                   |
| A → B → A，切回 A 并反编译：相同已有 Checkpoint 的对照 |        26.364 秒 |    0.335 秒 | 相同样本、缓存与验证流程，约减少 26.03 秒；基线已有 Checkpoint，但尚无会话复用。 |
| REA 重启后恢复已分析目标                               | 原始测试约 66 秒 | 约 13–34 秒 | 不同测试负载下的记录，并非严格同条件对照；恢复仍需启动 Ghidra。                  |

上述切换时间针对**已经分析过的目标**。新文件第一次仍需完整分析并生成 Checkpoint；首次分析不保证加速。对照测量覆盖选定查询及分析指纹，不代表所有文件、机器和工作负载都会得到相同结果。实测条件、样本、CPU 与内存的测量口径见[性能记录](docs/windows/checkpoints.md#retained-session-comparison-2026-11-18)。

### 多个 DLL 切换与内存实测

2026-11-18 在同一台 Windows 11 x64 机器上使用真实 Ghidra 测试，样本为两个作者的 DLL 和三个 Windows 系统 DLL 副本；各目标已有隔离的 Checkpoint，表中时间为**第二轮**每个目标的打开与反编译耗时之和。固定容量的含义是同时可保留的目标总数，包括当前目标。

| 固定容量 | 测试目标数 | 第二轮切换＋反编译合计 | 采样最大私有提交内存 |
| -------- | ---------: | ---------------------: | -------------------: |
| 默认 2   |          5 |             104.709 秒 |            1,452 MiB |
| 3        |          3 |               0.556 秒 |            1,840 MiB |
| 4        |          4 |               0.753 秒 |            2,192 MiB |
| 5        |          5 |               1.096 秒 |            2,620 MiB |

容量 2 与容量 5 使用**相同的五个目标和两轮任务**，可作这一次的对照；容量 3、4 的目标数量不同，不能直接与五目标任务比较。两次五目标对照的完整场景分别为 196.074 秒和 97.843 秒，包含启动、两轮调用、采样等待及关闭；第二轮结果与完整场景不是同一个计时范围。所有结果是单次热缓存测试，内存为进程家族的采样私有提交，不等于实际物理驻留，短时峰值可能漏采。选定函数的结果摘要一致，不代表所有函数均已验证。样本、CPU 及更详细限制见[多目标实测记录](DearJIAN-docs/multi-target-pool-results.md)。

`auto` 是按内存和闲置时间管理会话，不等于固定容量 5；[六目标自动模式测试](DearJIAN-docs/multi-target-pool-results.md#自动模式的六目标验证后续工作区修改)和 [Codex 客户端三目标隔离验证](DearJIAN-docs/multi-target-pool-results.md#codex-客户端隔离验证2026-11-18)的过程及限制见实测记录。

### Codex 全局安装验证

2026-11-18 在同一台 Windows 11 x64 机器上，从 Codex 聊天直接调用全局安装的 REA 6.9.0 MCP 服务，使用 Ghidra 12.1.4 打开真实的 x86 PE DLL `vl3vpn.dll`，并反编译地址 `0x10041eb0`。服务进程的启动路径指向用户 npm 全局目录中的 `rea-agents/scripts/rea.mjs`；运行中的进程链同时确认该服务由 Codex 启动，并由其启动 Ghidra。两次均返回 `array_vpn_set_authinfo` 的伪代码，分析会话均已正常关闭。

| Codex 调用 | 打开 DLL | 首次反编译 | 两次调用耗时之和 |
| ---------- | -------: | ---------: | ---------------: |
| 第一次     | 1.827 秒 |  14.953 秒 |        16.780 秒 |
| 第二次     | 0.196 秒 |  19.397 秒 |        19.593 秒 |

两次测试使用已有的磁盘 Checkpoint；第二次在同一个 REA 服务中、关闭上一次分析会话后执行。反编译 Evidence 明确记录从指定 Checkpoint 恢复 Program，且没有重新运行自动分析；第二次运行中的 Ghidra 启动参数也包含恢复文件和 `-noanalysis`。计时为客户端分别等待两次工具调用的时间之和，不含调用间隔和关闭时间；它们是两次实测，不是性能保证或冷启动对照。

## 具体做了什么

1. **Windows 持久 Checkpoint**：在 Windows x64 支持保存和恢复受 REA 管理的 Ghidra Program。依据文件内容与分析配置区分缓存，并通过校验、原子发布和独占租约保护缓存；缓存不可用时保留错误信息和恢复路径。
2. **多 DLL 会话复用**：对符合条件的只读 Ghidra Checkpoint 会话，默认最多保留 2 个已加载目标，可配置为 3～5 个或按内存自动管理。切回相同路径、内容和分析配置的目标前检查会话健康状态；回收时优先淘汰最久未使用的备用目标。
3. **Windows 路径与目录权限**：支持 Windows 绝对路径，检查缓存目录 ACL、独占租约和本地文件系统约束，避免将其他用户可写的已有目录直接当作私有缓存。
4. **Ghidra 专用 JDK 配置**：可用 `REA_GHIDRA_JAVA_HOME` 为 Ghidra 选择 JDK；设置后它优先于 `JAVA_HOME`，不要求更改其他 Java 程序的设置。
5. **真实 Ghidra 验证**：提供 Windows 验收脚本，覆盖缓存恢复、双 DLL 切换、选定分析结果比较以及错误恢复等场景。脚本和覆盖边界见[验证说明](docs/windows/checkpoints.md#run-and-verify)。

保留的会话会占用额外进程、内存和 Checkpoint 租约；目标数量上限不等于固定内存上限。不同 REA 进程不能同时持有同一目标的独占租约。Windows Checkpoint 会话的数据库编辑能力仍受限制，原始可执行文件不会因分析而被改写。

实现细节、资源代价及性能数据的适用范围见 [DearJIAN 的详细笔记](DearJIAN-docs/windows-checkpoint-optimization.md)。

自动模式相较固定容量的代码变化见 [auto 实现与涉及文件](DearJIAN-docs/auto-memory-retention.md#实现涉及哪些文件)。

更多信息：[支持的客户端](docs/getting-started/installation.md#supported-agents) · [MCP 注册与配置](docs/getting-started/installation.md#mcp-registry) · [![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5)](docs/reference/mcp-contracts.md#generated-catalog) · [原项目许可证](LICENSE)。
