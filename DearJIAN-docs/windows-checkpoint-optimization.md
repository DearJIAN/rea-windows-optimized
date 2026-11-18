# Windows Checkpoint 与优化原理

这篇笔记解释本仓库相较原版 REA 所做的 Windows Ghidra 优化，以及它在什么情况下能减少等待。配置、验收细节和最新技术约束以 [Windows Checkpoint 技术文档](../docs/windows/checkpoints.md)为准；历史变更见 [Windows 变更记录](WINDOWS_CHANGELOG.md)。

**后续更新：** 下文固定快照描述的是最初的双目标实现。当前代码支持固定总容量 2～5（默认 2），也支持不设固定数量上限的 `auto` 模式：目标按需保留，内存压力或闲置时间触发后，优先释放最久未使用的备用目标。配置、资源和租约约束见 [Windows 技术文档](../docs/windows/checkpoints.md#reusing-a-loaded-target)。历史比较与文件清单仍保留其原始快照，不代表当前版本完整差异。

## 对照基线与范围

下文固定比较两个 Git 快照，而不是假定今天的上游主分支与当时相同：

- 基线 `675287517c98c702ee88ad036c5e3b8dd4bcc7a7`：本仓库首次 Windows Checkpoint 提交的父提交，作为本次“原版”比较对象。它是仓库历史中的上游基线；这里没有另行验证它是否仍等于上游当前主分支。
- 优化端 `94435cae974aeeb9b0b6b7e0e07c0fbab1ef0f95`：这次文档修订之前本仓库的已提交版本。本文和移动后的变更记录在此之后，尚不包含在该快照中。
- 核心提交：`a0c47b3a6c74207f0ef7fcfb2f06f5c947456a1b` 启用 Windows Checkpoint；`5179a39f93e5966c198b20031775746e43e9b2c9` 增加会话复用；`f1163e5ef7081269258005e87575ffd9cb1c6f52` 增加 Ghidra 专用 JDK 配置等。其间还有测试、验收、文档和工作流提交，不能只摘取这三笔就假定完整。

查看全部提交及精确差异（在已有本仓库历史的克隆中执行）：

```powershell
git log --reverse --oneline 675287517c98c702ee88ad036c5e3b8dd4bcc7a7..94435cae974aeeb9b0b6b7e0e07c0fbab1ef0f95
git diff --name-status 675287517c98c702ee88ad036c5e3b8dd4bcc7a7 94435cae974aeeb9b0b6b7e0e07c0fbab1ef0f95
git diff 675287517c98c702ee88ad036c5e3b8dd4bcc7a7 94435cae974aeeb9b0b6b7e0e07c0fbab1ef0f95 -- src/ghidra src/windows src/application/binary src/ports/AnalysisProvider.ts bridge/ghidra/ReaGhidraBridge.java
```

文末列出这两个快照之间所有变化文件，含与优化无直接关系的发布、CI 和 README 改动。实际移植时应根据目标版本重新审查差异、依赖和权限边界，不要盲目复制文件或覆盖现有修改。

## 实现地图：从哪些文件开始

| 位置                                                                                                                                                                                                                                                                                                                                             | 关键改动和复用时应核对的关系                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [src/config/environment.ts](../src/config/environment.ts)                                                                                                                                                                                                                                                                                        | Checkpoint 配置由仅接受 POSIX 绝对路径改为本平台绝对路径；新增 `REA_GHIDRA_JAVA_HOME` 校验。                                                                                                                 |
| [src/ghidra/GhidraProvider.ts](../src/ghidra/GhidraProvider.ts) 与 [GhidraProviderCapabilities.ts](../src/ghidra/GhidraProviderCapabilities.ts)                                                                                                                                                                                                  | 去掉原先拒绝 Windows Checkpoint 的平台门槛，仍限制可接受的目标和配置；声明 Windows 只读能力。符合条件时提供会话保留许可及排他键。                                                                            |
| [src/ghidra/GhidraCheckpoint.ts](../src/ghidra/GhidraCheckpoint.ts) 与 [src/windows/WindowsCheckpointDirectory.ts](../src/windows/WindowsCheckpointDirectory.ts)                                                                                                                                                                                 | 复用身份、清单、哈希、发布和租约流程；加入 Windows 目录 ACL 检查及私有目录建立、Windows 临时目录和损坏清单隔离。已有非空且不安全的用户目录会被拒绝；空的专用根目录可能被收紧权限。                           |
| [src/ghidra/GhidraClient.ts](../src/ghidra/GhidraClient.ts)、[GhidraLauncher.ts](../src/ghidra/GhidraLauncher.ts)、[GhidraJavaLaunch.ts](../src/ghidra/GhidraJavaLaunch.ts)、[桥接代码](../bridge/ghidra/ReaGhidraBridge.java)                                                                                                                   | 客户端取得 Checkpoint 和租约后把授权传给启动描述符；Java 桥接按显式 `checkpoint_authority` 而不是 Unix socket 判断保存权限。恢复仍走原有 packed Program 与 `-noanalysis` 路径。                              |
| [src/ports/AnalysisProvider.ts](../src/ports/AnalysisProvider.ts)、[BinarySession.ts](../src/application/binary/BinarySession.ts)、[CompositeProvider.ts](../src/application/binary/CompositeProvider.ts) 及相邻路由文件                                                                                                                         | Provider 给出可保留标记、排他键和客户端资格；共享会话层拥有 active/parked 两个绑定、切换、健康检查、淘汰和失败清理。复合 Provider 仅在尚未关闭、已有配置且已创建的客户端都属于该配置的 Provider 时允许保留。 |
| [src/config/ghidraJavaHome.ts](../src/config/ghidraJavaHome.ts)、[GhidraInstallation.ts](../src/ghidra/GhidraInstallation.ts)、[GhidraDoctor.ts](../src/ghidra/GhidraDoctor.ts)                                                                                                                                                                  | 为 Ghidra 单独选择 JDK，优先于 `JAVA_HOME`；这属于环境配置便利性，并非 Checkpoint 算法本身。                                                                                                                 |
| [scripts/build-windows-native.mjs](../scripts/build-windows-native.mjs)、[package.json](../package.json)                                                                                                                                                                                                                                         | Windows 原生组件的构建入口和验收脚本命令；组件需在目标环境自行构建和校验。                                                                                                                                   |
| [GhidraCheckpoint.test.ts](../src/ghidra/GhidraCheckpoint.test.ts)、[WindowsCheckpointDirectory.test.ts](../src/windows/WindowsCheckpointDirectory.test.ts)、[BinarySessionRetainedSwitch.test.ts](../src/application/binary/BinarySessionRetainedSwitch.test.ts)、[真实 Ghidra 验收脚本](../scripts/verify-real-ghidra-windows-checkpoints.mjs) | 分别覆盖快照、目录权限、切换生命周期与真实工具工作流；模拟测试不等同于真实 Ghidra 验收。                                                                                                                     |

## 最初双目标版本的核心改动怎样串起来

### 1. 从 Windows 配置到 Checkpoint 准入

原版 `src/config/environment.ts` 对 Checkpoint 路径要求以 `/` 开头，`src/ghidra/GhidraProvider.ts` 在平台为 Windows 时拒绝启用 Checkpoint。优化后前者采用本机的绝对路径判断并拒绝空字符；后者去掉 Windows 整体拒绝，但仍按目标类型、格式和分析配置决定是否支持，Windows 原有能力边界仍然存在。

选中支持的目标后，Provider 解析目标和分析配置，使用原有内容摘要及 profile 确定 Checkpoint 身份。不同内容或影响分析的配置不会被当作同一个结果。`GhidraProviderCapabilities.ts` 为 Windows 的 owned-checkpoint 场景补充只读和目录权限限制，避免将其他平台的数据库编辑能力直接宣称为 Windows 支持。

### 2. Windows 目录、租约及快照恢复

原版 `GhidraCheckpoint.ts` 以 POSIX 所有者和权限位判断私有目录，并把租约目录放在 `/tmp`。优化后新增 `ensurePrivateCheckpointDirectory` 平台分支：Windows 使用新增的 `WindowsCheckpointDirectory.ts` 读取并检查 ACL；REA 新建的目录会收紧继承权限。调用者指定的非空目录如果不安全则拒绝；空目录在满足实现条件时可被收紧。租约目录在 Windows 改用系统临时目录，底层 Windows 租约使用命名管道。这个改动解决的是目录和独占所有权适配，不是把校验直接关掉。

相同文件也加入损坏清单的隔离处理：格式异常、缺失快照文件或摘要不匹配时，按相应分支隔离清单并回到重新分析，不能把损坏结果当成有效快照；隔离失败等情况仍可能报错。原有的快照身份、摘要验证、发布流程被保留。详细实现看 `readSource`、`quarantineManifest`、`acquire` 和 `publish`。

`GhidraClient.ts` 在准备启动时获取 Checkpoint，并把 `checkpointAuthority` 交给 `GhidraLauncher.ts` 写入会话描述符。原版 Java 桥接以 Unix socket 作为保存资格条件，Windows 不能满足；现在 `bridge/ghidra/ReaGhidraBridge.java` 检查由 REA 写入的显式 `checkpoint_authority`，同时仍禁止已有项目会话获得该保存能力。恢复时继续使用原有 Ghidra 打包 Program 和 `-noanalysis` 流程；这项改动是打通 Windows 的受控保存与恢复，而不是替换 Ghidra 分析算法。

### 3. A → B → A 为什么可以更快

原版切换目标时通常关闭前一个客户端；即使之后能从磁盘恢复 A，仍需重新启动 Ghidra 并载入 Program。优化后，`GhidraProvider.ts` 在可用的 Windows Checkpoint 场景提供 `retainOnTargetSwitch` 和以 Checkpoint 目录为依据的 `targetSwitchExclusionKey`。这些事实经 `AnalysisProviderEvaluation.ts` 和 `AnalysisProviderRegistry.ts` 传到会话层，字段定义位于 `src/ports/AnalysisProvider.ts`。

`BinarySession.ts` 增加一个 `#parked` 绑定：A 切到 B 时，只有双方允许保留、排他键不同、没有不适用的 snapshot 等条件成立，才把 A 暂存。B 切回 A 时，通过 `BinarySessionOpen.ts` 的 `sameSessionTarget` 及分析配置比较确认匹配，再检查客户端健康；成功后交换 active 与 parked。否则清理旧备用会话，再按正常流程打开。`CompositeProvider.ts` 还检查复合客户端的资格，避免把已经使用其他 Provider 的资源一并错误保留。

在该固定快照的默认容量下，选择第三个目标前先淘汰备用客户端；若关闭失败，会保留清理所有权以便重试，而不是丢掉进程或租约的责任。显式关闭、重置和失败恢复同样处理备用资源。不同路径可能指向相同 Checkpoint：排他键相同时不能同时保留，需先关闭旧客户端再打开。当前多目标版本的完整分支及取消、失败处理以 `BinarySession.ts` 为准，相关回归见 `BinarySessionRetainedSwitch.test.ts`。

### 4. 其他配套变化

`GhidraJavaLaunch.ts` 把 JVM 参数 `-XX:CICompilerCount=2` 改为 `4`，以增加启动时 JIT 编译线程；代码注释将其与启动开销相关联。这项变化不等于 Checkpoint 或会话复用，且并非仅对 Windows 生效；这里没有单独的对照数据证明它的独立收益。`src/config/ghidraJavaHome.ts` 及相关配置、安装检查则增加 Ghidra 专用 JDK 选择，与性能机制分开。

`scripts/build-windows-native.mjs` 允许在 Windows 主机使用 MinGW 构建，并在该平台选择无前缀的 `dlltool`。验收脚本、测试与文档随功能同步扩展；文末完整差异还包括一些发布和仓库维护改动，它们不应被误认为实现这两项优化都必需。

## Checkpoint 是什么

Ghidra 首次打开一个程序时，需要导入文件并执行自动分析，建立函数、符号和交叉引用等分析结果。Checkpoint 是这份**已经完成自动分析的 Ghidra Program 的持久化快照**，由 REA 管理并保存在磁盘上。它不是原始 DLL 的备份，也不是在分析中途记录进度的断点。

第一次分析符合条件的目标时，REA 完成自动分析后保存 Program；以后遇到内容及分析配置匹配的目标，可以验证并恢复保存的 Program，跳过重复的自动分析。恢复仍要启动 Ghidra、加载快照并建立连接；新目标的第一次分析仍需完整执行。保存的快照和原始目标文件各自独立，分析不会改写原始 DLL。

## 相较原版改了什么

原版 REA 已有受管理 Program 的 Checkpoint 设计，本仓库复用其快照、清单、完整性验证和恢复方式，并使符合条件的 Windows x64 Ghidra 工作流可用。它不是重新发明 Checkpoint。原版 Windows 路径、权限、租约和平台准入条件不能直接满足这一工作流；本版本增加 Windows 绝对路径处理、目录 ACL 检查、Windows 租约及相应的会话授权，支持符合条件的标准 PE 导入。具体差异见[技术文档的对照表](../docs/windows/checkpoints.md#what-windows-support-adds)。

此外，本仓库针对符合条件的 Windows 只读 Checkpoint 会话加入**已加载目标复用**。磁盘恢复和会话复用是两个不同层次：

| 场景                  | 工作方式                                                        | 主要省去的工作                 | 仍然需要                        |
| --------------------- | --------------------------------------------------------------- | ------------------------------ | ------------------------------- |
| 第一次分析 A          | 导入并完成自动分析，保存 Checkpoint                             | 无已有结果可复用               | 完整分析及保存                  |
| 新 REA 进程再次打开 A | 校验并从磁盘恢复已保存的 Program                                | 再次自动分析                   | 启动 Ghidra、导入快照和建立连接 |
| 同一会话中 A → B → A  | 符合条件时保留 A 的活动 Ghidra 客户端，切回前检查身份和健康状态 | 再次启动 Ghidra 和从磁盘恢复 A | 持有额外进程、内存和租约        |

切换复用要求同一路径、文件内容和分析配置匹配，且备用会话健康；默认保留当前和一个备用 Ghidra 客户端，可配置更大容量。默认容量下选择第三个目标会先释放备用目标；关闭分析会话也会释放。不同路径即使内容相同，也不能同时持有同一 Checkpoint 的独占租约。具体释放与异常处理见[已加载目标复用](../docs/windows/checkpoints.md#reusing-a-loaded-target)。

### 三个及更多 DLL 怎么切换

以下是默认容量 2 的行为：上限是同一个 REA 会话中**同时驻留的数量**，不是允许分析的 DLL 总数。假设各目标都符合复用条件、各自已有有效 Checkpoint：

- `A → B → A`：A 作为备用会话仍在，切回时可以复用；之后继续 A、B 之间切换也可以复用。
- `A → B → C`：打开 C 前，备用的 A 被释放；完成后 C 为当前目标，B 可作为备用。接着回到 B 可以复用；如果改为回到 A，则需重新启动 Ghidra 并从磁盘恢复 A。
- `A → B → C → A → B → C`：每次回到之前已被淘汰的目标，无法命中已加载会话；有效磁盘 Checkpoint 仍可避免重复自动分析，但不能省去 Ghidra 启动和恢复开销。4、5 个或更多目标的循环同理。

实际是否命中还取决于路径、内容、配置、健康状态和排他租约。将容量配置为 3～5 后，符合条件的更多目标可驻留；每个目标都可能占用 Ghidra 进程、内存和租约，不能把两目标的测量结果直接推广到多目标。

## 快照如何保持可用和隔离

REA 使用目标内容及影响分析结果的配置区分快照；内容或配置发生变化时，不能把旧结果当作匹配结果。快照以 Ghidra 打包 Program（`.gzf`）及清单形式保存；恢复前检查身份和完整性，恢复时使用 `-noanalysis`。发布采用原子方式，避免把未完成的写入当成可用快照。

同一目标的 Checkpoint 由独占租约保护，另一个 REA 进程竞争时会收到冲突结果。Windows 下还检查缓存目录权限；已有非空目录不满足隐私要求时会拒绝；空的专用根目录在符合条件时可能被收紧权限。损坏快照的处理与故障恢复见[技术文档](../docs/windows/checkpoints.md#run-and-verify)。这些机制保护缓存的适用性和使用权，不意味着所有运行环境或所有输入都能使用 Checkpoint。

## 验证证据与局限

源码测试分别覆盖 Checkpoint 身份、目录权限、会话复用及关闭失败等行为；具体运行和真实 Ghidra 验收方法见[技术文档](../docs/windows/checkpoints.md#run-and-verify)。2026-11-18 的一次 A → B → A 对照中，两组均已有 Checkpoint：未使用会话复用的基线为 26.364 秒，使用复用为 0.335 秒。条件、样本及结果比较范围见[性能记录](../docs/windows/checkpoints.md#retained-session-comparison-2026-11-18)；该记录不代表所有机器或所有分析结果。

## 使用边界

- 首次自动分析不能从中途断点续跑；首次分析没有保证加速。
- Windows Checkpoint 会话中的数据库编辑仍受限制；不支持的配置继续使用各自既有工作流。
- 备用 Ghidra 客户端持续占用进程、内存和租约；配置的客户端数量上限不是固定内存上限。
- 不同 REA 进程不能同时持有同一目标的独占租约。恢复仍有 Ghidra 启动开销，时间随机器、目标和工作负载变化。

## 固定快照的完整文件清单

以下由上述两个提交的 `git diff --name-status` 生成，A = 新增，M = 修改，D = 删除。历史路径按优化端快照记载；之后 `WINDOWS_CHANGELOG.md` 已移到 `DearJIAN-docs/`。这份清单包含文档和仓库维护变更，不表示每个文件都是移植功能所必需。

- **M** `.agents/skills/reverse-engineer-anything/references/native-and-artifacts.md`
- **M** `.cursor-plugin/skills/reverse-engineer-anything/references/native-and-artifacts.md`
- **D** `.github/dependabot.yml`
- **M** `.github/workflows/release.yml`
- **A** `.github/workflows/windows-checkpoint.yml`
- **M** `.gitignore`
- **M** `README.md`
- **A** `README.original.md`
- **A** `WINDOWS_CHANGELOG.md`
- **M** `bridge/ghidra/ReaGhidraBridge.java`
- **M** `docs/getting-started/installation.md`
- **M** `docs/providers/ghidra-provider.md`
- **M** `docs/readme/README_ar.md`
- **M** `docs/readme/README_bg.md`
- **M** `docs/readme/README_de.md`
- **M** `docs/readme/README_el.md`
- **M** `docs/readme/README_es.md`
- **M** `docs/readme/README_fa.md`
- **M** `docs/readme/README_fr.md`
- **M** `docs/readme/README_id.md`
- **M** `docs/readme/README_it.md`
- **M** `docs/readme/README_ja.md`
- **M** `docs/readme/README_ko.md`
- **M** `docs/readme/README_ml.md`
- **M** `docs/readme/README_pl.md`
- **M** `docs/readme/README_pt-BR.md`
- **M** `docs/readme/README_ro.md`
- **M** `docs/readme/README_ru.md`
- **M** `docs/readme/README_th.md`
- **M** `docs/readme/README_tr.md`
- **M** `docs/readme/README_uk.md`
- **M** `docs/readme/README_ur-Latn.md`
- **M** `docs/readme/README_vi.md`
- **M** `docs/readme/README_zh-TW.md`
- **M** `docs/readme/README_zh.md`
- **A** `docs/windows/checkpoints.md`
- **M** `package.json`
- **M** `scripts/build-windows-native.mjs`
- **M** `scripts/lib/docs-facts.mjs`
- **A** `scripts/verify-real-ghidra-windows-checkpoints.mjs`
- **M** `scripts/website_i18n.py`
- **M** `src/application/binary/AnalysisProviderEvaluation.ts`
- **M** `src/application/binary/AnalysisProviderRegistry.ts`
- **M** `src/application/binary/BinarySession.ts`
- **M** `src/application/binary/BinarySessionOpen.ts`
- **A** `src/application/binary/BinarySessionRetainedSwitch.test.ts`
- **M** `src/application/binary/CompositeProvider.test.ts`
- **M** `src/application/binary/CompositeProvider.ts`
- **M** `src/config.test.ts`
- **M** `src/config/environment.ts`
- **A** `src/config/ghidraJavaHome.ts`
- **M** `src/config/parseConfig.ts`
- **M** `src/ghidra/GhidraCheckpoint.test.ts`
- **M** `src/ghidra/GhidraCheckpoint.ts`
- **M** `src/ghidra/GhidraClient.ts`
- **M** `src/ghidra/GhidraDoctor.ts`
- **M** `src/ghidra/GhidraInstallation.ts`
- **M** `src/ghidra/GhidraJavaLaunch.ts`
- **M** `src/ghidra/GhidraLauncher.ts`
- **M** `src/ghidra/GhidraProvider.ts`
- **M** `src/ghidra/GhidraProviderCapabilities.ts`
- **M** `src/ports/AnalysisProvider.ts`
- **A** `src/windows/WindowsCheckpointDirectory.test.ts`
- **A** `src/windows/WindowsCheckpointDirectory.ts`
- **M** `tests/boundary/filesystem/documentationFacts.test.ts`
- **M** `tests/boundary/filesystem/releaseWorkflow.test.ts`
- **M** `tests/conformance/readmeConsistency.test.ts`
- **M** `website/locales/languages.json`
