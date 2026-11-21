# Task24B A 臂原生 4551 归档与解耦交接

日期：2026-11-16（Asia/Shanghai）
范围：仅归档 A 臂 Windows 原生端到端阻塞与交接条件；不改变生产默认行为，不重试原生启动，不发布 readiness。

> **更新（2026-11-21）**：Linux 16 题/120 次校准已在 calibration-only authority 下完成，120/120 real、120/120 matched、120/120 stable，`corpusEngineReady: true`，但 `readinessEligible: false`。证据见 `2026-11-21-task24b-linux-120-calibration.md` 和 `D:\OpenCode-Benchmark\Task24\reports\task24b-linux-calibration-20261121\`。A 臂仍为 `component-verified, native-blocked`；下面第 7 节记录的 4551 条件、禁止项和重开步骤不变。

## 1. 结论

A 臂的 Windows 原生端到端链路在 `CreateProcessW` 处以 Win32 `4551` 被宿主应用控制策略拒绝，发生在任何模型 fixture 调用之前。组件级证据（隔离原语、生产命令桥、浏览器协议、静态预览、Git 有限传输、原生 ACL 有界读取）已分别验证，但不能替代完整 A 运行、16/120 校准或 Task 10 readiness。

该阻塞属于宿主安全策略/签名资源问题，不是评测器业务逻辑回归。按 2026-11-16 用户批准，将 A 原生保真与 Linux 真实 120 校准解耦：A 保留为 `component-verified, native-blocked`，不以降低 Linux 门槛的方式宣称完成。

## 2. 证据链

### 2.1 已定位的 4551（probe 工件）

`D:\OpenCode-Benchmark\Task24\reports\model-snapshot-20261024-71c4\native-blocker.json` 记录：

- 失败：`CreateProcessW Win32 4551: application control policy blocked the file`，`nativeFinalExitCode` 1，`nativePassed` false。
- 被拒工件：`D:\OpenCode-Benchmark\Task24\workspaces\acl-authority-live-ZASkaf\control\native-isolation-a5tpts\runtime\probe.exe`，99,857,408 bytes，SHA256 flat `ff345f189d0f3e781ec99f298b00edaabdec28f0ad3c210c3ef41ef567eeade5`。
- Authenticode：`NotSigned`，无 signer certificate，事件后哈希仍匹配。
- CodeIntegrity（批准的有界精确路径/哈希查询，窗口 2026-10-24T06:45:00Z–06:49:59Z）：
  - event 3033 / record 41863 / 2026-10-24T06:47:15.6671715Z
  - event 3077 / record 41865 / 2026-10-24T06:47:16.1751409Z
  - policy `VerifiedAndReputableDesktop`，status `0xc0e90002`，requested signing level 2，validated 1。
- 支持的解除路径是可信代码签名（Microsoft Smart App Control 文档）；Smart App Control 不提供单个应用例外，detection dispute 也不保证建立信誉或允许该二进制。当前无可用可信签名资源。

### 2.2 后续 R3 普通 CLI 的 4551

账本 2026-10-24 顶部段记录：普通验收 CLI `git-memory-build-r3/opencode-windows-x64/bin/opencode.exe`，version `0.0.0-task24-20261024-memory-71c4`，SHA256 `3526eb1c711d2b9efe08ef8a4821134985d1330dbee984a1440625299dcc0102`；隔离外 version smoke 通过，真实原生启动在任何模型 fixture 调用前返回 `AppContainer CreateProcess win32=4551`。精确副本：

`joint-session-eWmLLZ/temp/production-agent-mLrEp8/control/native-isolation-AWDIOR/runtime/opencode.exe`

日志 `production-visual-joint-scratch.log`。随后对该精确路径/时间窗口的有界 CodeIntegrity 查询未返回匹配事件；因此不把 probe 事件的原因直接套到这次 CLI 失败上，也不臆造新事件或原因。

### 2.3 清理/retirement 的边界

`blocked-r3-policy-inspect.log`：jobName `Global\opencode-task24-policy-e234c69f736f47b9a49772fee96e6c5f`，jobState `absent`，supervisorPID 17808 dead，persistentPolicyRetired=true，retirementPerformed=false，WFP sublayer/IPv4/IPv6 全 false。该 inspect 的 `recoveryScope` 仅为 network-policy；**不证明** DACL/profile 完整恢复。

### 2.4 必须保留的 uncertain 资源

`acl-authority-live-ZNJ7WV`、`acl-authority-live-ZASkaf` 及同类 `native-acl-*` / `acl-authority-live-*` uncertain fixture 不得删除、不得重试、不得用于恢复或清理推断。禁止再次原生启动、换路径/哈希、probe exe、签名、白名单、策略/ACL/端口变更或部分发布。

## 3. 解耦依据

- 计划 Task 9 的 16 题/120 次评测使用 Linux evaluator，零模型调用；候选在 Linux 容器内评测，不依赖 Windows A 臂原生进程。
- Task 10 `verifyLinuxReadiness` 要求 engine / capabilities / corpus 三组同身份全通过；A 的 Windows 原生保真不是这三组的替代或前置。
- 因此先把 Linux 真实 120 跑通，再把 A 原生作为独立的、被宿主策略阻塞的验收项交接，不降低任何 Linux 断言、不伪造 readiness receipt。
- 生产默认行为、B–E 路径、浏览器/租约/重试/预算均未因解耦改变。

## 4. 已证组件（不等于完整 A）

以下为账本已记录、可复核的组件证据，归档供后续复用：

- Windows 隔离原语：真实 LPAC worker 读写/拒绝；Chromium 147.0.7727.15 私有副本以受限 primary token + low integrity 渲染；WFP 持久 DENY + 动态 PERMIT，杀 supervisor 后 permit 消失、deny 生效、canary 0 命中；崩溃恢复仅 network-policy。
- 生产 MCP 桥：named pipe + 单 IPv4 loopback、5 个枚举操作、12MiB 边界、16 并发、Origin 拒绝、5s drain。
- A 臂 WSL 生产命令桥：`runOwned` / `Docker.production` / `CodingCheckLauncher`，controller-frozen 命令、owner labels、image digest、D 盘 workspace。
- 浏览器协议 v2：冻结 Node/Chromium/helper 私有副本、三视口、controller-branded 观察。
- 同端口有限 HTTP：冻结 hash 绑定的公开静态预览、有限 Git 识别/Snapshot、lease/retirement。
- 原生 ACL：有界精确读取、单次 1MiB completion buffer 复用、5s deadline；19 个 native-ACL/authority 测试 60 assertions 通过（账本 `acl-scratch-green.log`）。
- Coding joint：1 pass / 0 fail / 62 assertions / 177.49s（`production-coding-joint-bounded-stream.log`），但仅为 coding microcase，不是完整 A。

## 5. 重新开启 A 原生的条件

满足任一条件后才重新评估，不得绕过：

1. 获得可信代码签名资源（如受信任 CA 的 OV/EV 证书或 Microsoft Trusted Signing），对**确切发布工件**签名；保持源码、argv、grant、镜像 digest 不变。
2. 在由宿主管理员管理、明确允许该工件的受支持主机/策略上运行；不得由本任务自行关闭/放宽 Smart App Control、导入信任、改策略或加白名单。
3. 取得 Microsoft 支持的明确处置结论（非“提交样本”即视为允许）。

重开步骤：签名 → 核验 Authenticode 与 SHA → 复用现有 opt-in 原生测试（`packages/benchmark/test/linux-host/production-workflow-cli.test.ts`、`production-workflow-joint-live.test.ts`，以仓库当前版本为准）→ 完整 A / A–E 矩阵 → 新的 BuildRecord/readiness。任何一步失败都回到 blocked，不发布部分结果。

## 6. 交接清单

- 归档提交：`60ac15d49`（core）、`537e0ab69`（server）、`be9fcab8e`（benchmark）、`c53da8bfd`（docs）；基于 `6a978e2167feb93ddb3b3f0c91483d6ef9130fc2`。
- 证据：`reports/model-snapshot-20261024-71c4/native-blocker.json`、`source-freeze.json`、`verification.json`；`reports/acl-authority-20261024-71c4`、`reports/native-acl-20261024-3d91`、`reports/production-*`。
- 日志：`production-visual-joint-scratch.log`、`blocked-r3-policy-inspect.log`、`acl-scratch-green.log`、`production-coding-joint-bounded-stream.log`。
- 保留：上述 uncertain fixtures、旧 policy-denied 根、旧盘/部署/.wslconfig/用户 report/Git wrapper 哈希基线。
- 禁止：再次原生启动、签名/策略变更、删除 uncertain 资源、把组件证据写成 readiness。

## 7. 120 校准的当前外部条件

Linux 真实 120 在本文写作时为 0/120（2026-11-21 更新：calibration-only 已补齐 120/120，见上）。除宿主条件外，本次核查还发现**生产接线缺口**，不能把 120 归因于环境一项；该缺口本身仍然存在：

- `packages/benchmark/src/sandbox/dependencies.ts:420` 的 `finalizeHostManifest` 在整个仓库中没有任何调用点；唯一使用者是它自己。
- 没有任何生产代码写出 `phase: "prepare"` 或 `phase: "accept"` 的 `HostManifest`。`command.ts` 的 `prepare` 分支只发布 `dependencies-<sha>.json` 后退出；进程内 `issuedImages` WeakSet 随进程消失，因此后续独立进程无法合法 `finalize`。
- `inspect` 只返回 inventory，`plan-preparation` 只返回 plan；两者都不签发 prepare manifest。当前 `D:\OpenCode-Benchmark\Task24\reports`/`runs` 下也没有任何 accept manifest。
- 因此 `accept`/`calibrate` 按现有 CLI 不可达；手工编造 manifest/approval 会绕过 `issuedImages` 与 `finalizeHostManifest` 的保证，不能用来宣称 120 或 readiness。

本文写作时的宿主条件（历史）：Docker 后端未运行（无 `dockerDesktopLinuxEngine` 管道、无 docker/vmmem/wsl 进程），`wsl --status`/`wsl -l -v` 在该受限会话返回 `Wsl/E_ACCESS_DENIED`；evidence/root 位于 `D:\OpenCode-Benchmark\Task24` 下，当前 DSH workspace-write 沙箱拒绝写入该树，full-access 审批在本会话两次超时未获应答。2026-11-21 更新：后续会话获得 full-access，Docker/WSL2 Linux guest 可用，上述宿主限制已不适用于该次 calibration-only 运行；但它们仍适用于本报告描述的受限原生 A 会话。

要跑 120，必须先补齐“prepare manifest 签发 → 准备产物在同一可信进程内 finalize → accept manifest/approval 发布”的生产路径并测试，再解除宿主/沙箱限制；两者缺一不可。历史 `linux-real-acceptance-20261021-a83e/live-preflight.json` 只提供旧 request/inventory 形状参考，其 source/plan hash 已过期，不能直接复用。
