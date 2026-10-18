# Task24B DL6 Native Adapter and Interactive CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐固定版本 Docker Desktop 的原生只读诊断和交互式 CLI 确认边界，以无 Docker 回归验证软件；未知原生行为继续阻断真实准备和启动。

**Architecture:** 复用 benchmark 的 DesktopPlatform、profile 和 lifecycle，分离稳定兼容证据、瞬时主机观察和进程内授权。控制器按“预检 → 显示准确范围 → 本地一次性确认 → 再验证 → 原有持久消费/操作 → finally 收尾 → 历史报告”串联；不新增常驻服务，不开放未经证明的 native start/stop。

**Tech Stack:** 既有 Bun 1.3.14、TypeScript、Effect Schema、Windows PowerShell 5.1 与内嵌 C# Win32 查询、固定 Docker CLI。无新增运行依赖，不采用实验 FFI、不下载工具或修改安装包。

**Spec:** [已获用户确认的补充规格](../specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md)，继承[原规格](../specs/2026-10-18-task24b-d-drive-docker-launch-design.md)。当前仅批准编写本计划，**尚未批准执行**。规格中的“待审”是其形成时状态，用户随后已确认；本计划审阅不构成实际准备或启动许可。

## Global Constraints

- 代码起点 `dev` / `ed7bd7d752c2c66ef3f61eb9d60f2972c3f02b8e`，直接既有 dev，不建隔离分支，不覆盖外来修改。不重做 DL1–DL5、B-Prep1/2，不改题目、评分或试跑次数。
- Desktop `4.79.0.230596`、CLI `29.5.3`、SettingsVersion `44`；原规格安装路径和两个 pin 不变，任何身份漂移 blocked。
- profile 根 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479`，profileID `oc-task24-dd479`，home `home-oc-task24-dd479`；原12个目录、准备4文件及 grant/active 规则保留。
- native 控制根 `D:\OpenCode-Benchmark\Task24\control\desktop-launch\<launchID>`；历史报告 `D:\OpenCode-Benchmark\Task24\reports\desktop-launch\<launchID>\inventory.json`。本计划执行只用新 D 夹具，不创建这些真实目标。
- 旧 C Docker 目录不复制、迁移、删除、恢复、覆盖、改 ACL 或替换为链接。真实 `.wslconfig` 不改，新应用配置和缓存不落 C。不改全局环境、PATH、服务或注册。
- 不启动/停止真实 Docker 或 WSL 发行版，不读 VHD 盘内数据、不挂载/复制/改造旧盘，不重装/升级、不恢复旧容器；真实准备和启动分别另行确认。
- 不读真实 Key、`.env.local`、credential、登录/许可状态，不做模型/发现调用、镜像/容器/卷操作或 prune；真实验收、校准、付费和部署替换仍先不做。
- 不改生产 `docker-config.ts`、Server/Core/生产 CLI、旧视觉流程、租约/重试/预算；不动部署、旧 dist、seal/receipt。生产 default 地址冲突只报告，不放宽原合同。
- 提示最多60秒且不超过请求剩余有效期；授权最长15分钟；启动120秒、收尾30秒不变。普通 JSON、任意 true 回调、伪 TTY、历史记录和 --yes 均非 native 许可。
- 软件回归不以 fixture 解锁 native；当前不证明启动参数、设置可变性、自动恢复或完整停止链。未知项继续 blocked，不以试启动补证。
- 沿用本会话 native 顺序执行及最后一次整体审查，不派逐任务实现代理；待本计划获批且软件验证通过后提交/push `fork/dev`，保留 hooks，不部署。旧断言、时限和 skip 不放宽。

## Review Focus

1. 等待确认时控制文件或安装被换成相同内容的新文件：必须按身份漂移取消，不能只重算文本 hash；NC5 的 `same bytes replacement during prompt invalidates confirmation`。
2. 系统工具只返回部分进程/发行版信息或本地化错误行：不得把空结果当 idle；NC2 的 `partial and localized observations never imply idle`。
3. 直接调用导出 prepare/start，绕过 CLI 的真假 console 工厂：底层也拒绝通用 true 回调产生的 native 授权；NC4 的 `native provenance cannot be manufactured by fixture callbacks`。
4. nonce 已消费后启动或报告失败，同时确认已过期/输入已取消：仍须使用原有收尾能力，不重新提示、不丢残留诊断；NC6 的 `failed attempts retain cleanup authority and historical diagnostics`。
5. Windows 标准句柄被重定向，或者提示只写出一部分：不能借 CONIN$ 或成功 exit code 假装完成可读确认；NC4 的 `redirected or truncated console confirmation cannot issue authority`。

---

## 文件和验证约定

下表源码路径相对 `D:\OpenCode-Audit\packages\benchmark`，文档路径相对仓库根。保持原公开 Host/StorageProof/Gate schema；新类型仅在 desktop 子目录使用。

| 文件                                                                                                                   | 职责                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 新 `src/sandbox/desktop/planning.ts`                                                                                   | 从 profile 原样迁出 plan 派生和私有 plan 登记，加入显式单实例锁；旧导出保留转发   |
| 新 `src/sandbox/desktop/bindings.ts`                                                                                   | 两份规格/两份计划摘要与真实源码状态绑定，区分文档摘要和 runtime plan 摘要         |
| 新 `src/sandbox/desktop/native-query.ts`、`src/sandbox/desktop/native-script.ts`                                       | 固定只读 Windows/WSL 查询和严格快照解码；无任意命令入口                           |
| 新 `src/sandbox/desktop/native-audit.ts`；改 `src/sandbox/desktop/platform.ts`、`src/sandbox/desktop/compatibility.ts` | 固定安装/离线 CLI 证据、可见 blocked 诊断；native 工厂继续封闭启停                |
| 改 `src/sandbox/desktop/contracts.ts`                                                                                  | 只为 desktop 的 audit/observe 增加可选取消信号，不改旧 Host/StorageProof schema   |
| 新 `src/sandbox/desktop/approval.ts`、`src/sandbox/desktop/console.ts`                                                 | 请求校验、fixture/native 来源隔离、可信控制台提示与私有 native 授权登记           |
| 改 `src/sandbox/desktop/profile.ts`、`src/sandbox/desktop/launch.ts`                                                   | 转发旧 API、底层来源检查、持久消费可查询事实；保留原发布、租约/重试及生命周期算法 |
| 改 `src/sandbox/desktop/command.ts`、`script/desktop-launch.ts`                                                        | 严格 --interactive 解析、两次预检、取消传播、仅诊断默认入口                       |
| 新 `src/sandbox/desktop/inventory.ts`；改 `src/sandbox/desktop/publication.ts`                                         | 仅已消费操作的排他历史报告；复用 handle-bound 保护，不采用路径写入后备            |
| 新 `test/linux-host/desktop-{bindings,native-query,native-audit,confirmation,interactive-command,inventory}.test.ts`   | 六组增量无 Docker 回归；已有 desktop 测试仅追加断言或准确新语法                   |
| 新 `test/linux-host/desktop-native-fixture.ts`                                                                         | NC2 定义的非 native 合成快照/传输；只在测试中导入                                 |
| 新 `docs/superpowers/reports/2026-10-18-task24b-dl6-native-cli-verification.md`                                        | NC7 执行后才写真实验证结果、剩余门禁与未运行项                                    |

实施时用本计划自己的 `.superpowers/sdd/2026-10-18-task24b-dl6-native-cli-confirmation` 工作日志；不写旧计划日志。日志第一行绑定本计划，任务通过/commit 和每项 Ruling 同步记录，复续先读日志和 git，避免重复实现。

所有测试 cwd 为 `D:\OpenCode-Audit\packages\benchmark`。`$NativeCliBun` 固定为 `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`，实施前核 SHA256 `0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`。执行者在 NC1 创建本轮独有 `D:\OpenCode-Benchmark\Task24\tmp\bprep1-native-cli-<随机值>`，记为 `$NativeCliTemp`；owner 包含既有 fixture nonce `bprep2-0786b1f11abc` 和新随机 runOwner。只按本次 runOwner、解析后的准确路径和文件身份清理。

本计划工作目录内的测试启动脚本统一清理 provider/integration/update/discovery 环境，HOME/USERPROFILE/XDG/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR 与全部 Bun/npm/Node 缓存在 `$NativeCliTemp`；`PSModuleAnalysisCachePath=NUL`，`NODE_DISABLE_COMPILE_CACHE=1`。可信 Bun、Node 和无 dotenv 的嵌套包装放 PATH 前；不复制旧临时根、不读真实 env、不下载依赖。日志有界写 D，不能只输出长命令的 .output 而丢掉 session ID。

每任务 GREEN 后从包目录跑 `& $NativeCliBun --no-env-file run typecheck`，Expected：退出0。每任务测试用例的 `--timeout 30000` 不改变旧测试时限；提示/生命周期超时用受控时钟和屏障测，不真实等待60/120秒。所有新增源码 helper 只通过测试夹具或自有 helper 验证；本轮不执行已安装 Docker CLI、真实 WSL list 或 native 主机审计来替代无 Docker 验收。

## Task 1: NC1 稳定文档源码绑定和计划派生

**Files:** 新建 `src/sandbox/desktop/bindings.ts`、`planning.ts`、`test/linux-host/desktop-bindings.test.ts`；修改 `profile.ts`、`desktop-profile.test.ts`。建立本计划工作日志和隔离测试环境，归入本任务，不另作交付任务。

**Interfaces:** Consumes `canonicalJson`、`sha256Text`、`requireDesktopReport` 和现有 Desktop 类型。Produces `desktopDocumentDigest(entries:readonly {path:string;sha256:string}[]):string`、`readDesktopBindings(repoRoot:string,signal?:AbortSignal):Promise<{sourceSha256:string;specSha256:string;planSha256:string}>`；`planDesktopProfile(spec,report):Gate<DesktopLaunchPlan>`、`requireDesktopPlan(plan,platform?):DesktopPlatform` 的名称和语义保留，由 planning 实现、profile 命名转发，私有 map 不导出注册函数。

- [ ] **RED 编写测试。** `document bindings include both approved documents and distinguish runtime hashes` 断言摘要按相对路径排序，改变任一文档的实际字节都会改变摘要；拒绝重复路径、绝对路径、链接、读取中漂移和旧单文档 hash。`planning preserves authority and explicitly enables singleton lock` 断言 `plan.env.PINATA_SINGLE_INSTANCE_LOCK === "true"`，五字段 settings 完全不变、旧 hash 不能授权新 plan、克隆 plan 不能通过 require。

  ```ts
  expect(desktopDocumentDigest(entries)).toBe(desktopDocumentDigest([...entries].reverse()))
  expect(plan.env.PINATA_SINGLE_INSTANCE_LOCK).toBe("true")
  expect(() => requireDesktopPlan({ ...plan }, platform)).toThrow()
  ```

- [ ] **运行 RED。** `& $NativeCliBun --no-env-file test ./test/linux-host/desktop-bindings.test.ts ./test/linux-host/desktop-profile.test.ts --timeout 30000`。Expected：新摘要/锁行为缺失失败，而不是夹具路径或依赖初始化失败。
- [ ] **实现。** 清单条目固定为 `{path,sha256}`，路径使用仓库相对 POSIX 路径、区分大小写排序；分别绑定基础/补充两份规格和原/本补充两份计划，准确路径为本计划及 Spec 链接的四个仓库文件。native 调用的 repoRoot 由当前模块位置派生，不能接受命令行改仓库；测试可用其 owner 根中的独立小仓库。源码摘要沿用 `SHA256(UTF8("git-tree:" + HEAD_treeOID))`，固定 Git 只读 rev-parse/status、禁用 fsmonitor/外部注入和可选锁，拒绝源码/文档工作区不干净或查询前后漂移，不对 dirty 状态伪称已绑定。Git 每次5秒、输出64 KiB，文档每份最大1 MiB并稳定读取；未知/截断就失败。忽略项不充当新源码入口，运行模块必须来自该受检 checkout。将 plan 逻辑和 map 原样迁至 planning，只有上述锁字段改变 plan 内容。
- [ ] **GREEN。** 重跑 RED 命令及包内 typecheck。Expected：新测试与旧 profile 断言全过；没有 native 工厂、真实控制文件或真实 profile 的创建。
- [ ] **提交。** 仅 stage 本任务文件；`git commit -m "feat(benchmark): bind native desktop plans to approved documents"`。

## Task 2: NC2 固定只读 Windows 查询和严格快照

**Files:** 新建 `src/sandbox/desktop/native-query.ts`、`native-script.ts`、`test/linux-host/desktop-native-query.test.ts`、`desktop-native-fixture.ts`。

**Interfaces:** Produces `DesktopNativeSnapshot`：严格结构含 `schemaVersion:1`、`sampledAt:number`、真实 `sid/windowsProfile`、注册 GUID/名称/basePath/version/build、两块盘身份、相关进程列表、相关 pipe 存在性、`installedWsl:readonly string[]` 和 `runningWsl:readonly string[]`。进程项含 PID/创建时间/SID/imagePath/parentPID/role，role 为 desktop/backend/service/vm；无权限的相关项不能省略。Produces `decodeDesktopNativeSnapshot(raw:unknown,spec:DesktopLaunchSpec):DesktopNativeSnapshot`、`decodeWslNames(bytes:Uint8Array,known:readonly string[]):readonly string[]`、`queryDesktopWindows(spec:DesktopLaunchSpec,signal:AbortSignal):Promise<DesktopNativeSnapshot>`、`desktopNativeQueryScript():string`。查询函数不接受 transport 参数。测试 helper `nativeQueryFixture(spec:DesktopLaunchSpec):{snapshot:DesktopNativeSnapshot;all:Uint8Array;running:Uint8Array}` 仅造合成数据，不登记 native 来源；真实临时物的 owner/close 沿用 desktopFixture。

- [ ] **RED 编写测试。** `partial and localized observations never imply idle` 覆盖错误/缺字段、权限失败、截断、未知本地化错误行、无 BOM UTF16LE/UTF8 的严格解码、重复/未知发行版；未知不能输出空 running。`services never confer engine ownership` 断言仅既有 service 不产生 process/session/pipe owner，注册 State 不作为 running。`snapshot drift and swapped disks are rejected` 精确断言 SID/profile、GUID/basePath、盘 fileID/volumeID、PID 创建时间冲突均拒绝。`fixed native query has no launch verbs` 用真实 PowerShell Parser 解析，断言无 distro exec、shutdown、terminate、mount、desktop start 或自由 argv。
- [ ] **运行 RED。** `& $NativeCliBun --no-env-file test ./test/linux-host/desktop-native-query.test.ts --timeout 30000`。Expected：严格解码和固定脚本尚不存在导致失败。
- [ ] **实现。** 固定 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`、NoLogo/NoProfile/NonInteractive、内嵌固定源码和严格数据协议；最小 D 环境，输出 JSON 上限256 KiB、stderr8 KiB、总15秒。公开 query 函数先核对 spec 与原规格固定 native 路径及当前 SID 的绑定，不能用直接调用传入任意 registry、profile、pipe 或文件路径。通过实际 token/注册读取 SID 和真实 profile，不用环境推断。只查白名单注册/进程/pipe 存在性/VHD 元数据；不连接未知管道。WSL 仅固定 `C:\Windows\System32\wsl.exe --list --quiet` 和 `--list --running --quiet`，每次5秒，非零退出/有错误/歧义失败；names 与只读注册名称集合对应，不解析英文 Running 文本。编码不确定就拒绝，不更新 WSL。系统 exe 身份/路径在调用处绑定，超时回收本次 helper 及其准确已登记子进程，身份不明不杀；无权限或不支持返回明确错误，不兜底 idle。list 的 quiet/running 选项语义依据 [WSL 官方命令文档](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)，不能因此扩展到发行版 exec。
- [ ] **GREEN。** 重跑本任务测试和包内 typecheck。使用自有普通 helper 验证流量上限、取消、子进程回收；对真实 PowerShell 仅作 parser 检查，不调用 queryDesktopWindows。本任务没有 Docker/WSL 执行记录。Expected：退出0。
- [ ] **提交。** `git commit -m "feat(benchmark): add bounded native desktop observations"`。

## Task 3: NC3 原生兼容证据和 blocked 诊断

**Files:** 新建 `src/sandbox/desktop/native-audit.ts`、`test/linux-host/desktop-native-audit.test.ts`；修改 `src/sandbox/desktop/contracts.ts`、`platform.ts`、`compatibility.ts`、`desktop-compatibility.test.ts`。

**Interfaces:** Consumes NC1 bindings 和 NC2 snapshot。Produces `decodeDesktopCliEndpoint(bytes:Uint8Array):string`、`describeDesktopNativeEvidence(spec:DesktopLaunchSpec,snapshot:DesktopNativeSnapshot,cli:{production:string;profile:string}):DesktopCompatibilityReport`（纯数据，不登记能力）；`readDesktopNativeDiagnostics(platform:DesktopPlatform):DesktopNativeDiagnostics|undefined`。其中 diagnostics 为 `{checks:DesktopCompatibilityReport["checks"];missing:readonly string[];productionEndpoint:string|null;profileEndpoint:string|null;production_default_compatible:boolean|null;observationSha256:string}`。native 工厂私有执行的 audit 返回既有 Compatibility 类型；外部构造的数据描述器不能登记 native。仅 desktop 内部 `audit(spec:DesktopLaunchSpec,signal?:AbortSignal):Promise<DesktopCompatibilityReport>`、`observe(spec:DesktopLaunchSpec,signal?:AbortSignal):Promise<unknown>` 和 `auditDesktopCompatibility(raw:unknown,platform:DesktopPlatform,signal?:AbortSignal)` 增加可选 signal，旧调用与 fixture 方法兼容；start/stop 签名、Host/StorageProof/Gate 不改。

- [ ] **RED 编写测试。** `known CLI resolution is evidence but not a launch permit` 断言准确两个 endpoint 被记录、`cli_default` 可 proved、production compatible=false，而其他未知项保持 blocked。`stable evidence excludes ephemeral observations` 将采样时间/helper PID/temp nonce 改变但事实不变，compatibility hash 相同，独立诊断 hash 不同；安装/规则/endpoint 变化则不同。`serialized evidence never registers native authority` 断言假来源不能 plan，所有未知必要项不得触发 spawn/stop。`partial static rules cannot prove complete routing` 断言名称/构建号/ASAR 局部标记不解锁另外四项。`cancelled audit never registers late evidence` 在探针屏障取消或推进45秒时钟，断言只回收自有 helper、后续查询0、延迟返回不登记 ready。

  ```ts
  expect(diagnostics.production_default_compatible).toBe(false)
  expect(report.checks.find((c) => c.id === "cli_default")?.conclusion).toBe("proved")
  expect(report.missing).toContain("existing_workload_restart_unproved")
  expect(calls.start).toBe(0)
  ```

- [ ] **运行 RED。** `& $NativeCliBun --no-env-file test ./test/linux-host/desktop-native-audit.test.ts ./test/linux-host/desktop-compatibility.test.ts --timeout 30000`。Expected：新诊断/稳定摘要行为缺失失败。
- [ ] **实现。** native audit 总上限45秒，包含 bindings/安装身份/snapshot/CLI，与调用方 signal 共同取消；observe 也透传到 NC2，不在超时后继续派生能力。先重核 bindings、全部安装身份和 snapshot。固定 CLI 用两组独立 D 配置来源执行 `--config <不存在的探针叶子> --context default context inspect default --format {{json .Endpoints.docker.Host}}`。production 清空 HOST，profile 设置准确 npipe endpoint；配置叶子不得创建，HOME/TEMP 均用已核 D 探针 owner 根，不读用户 config。每次5秒、stdout8 KiB、stderr8 KiB，检查前后准确 CLI 身份，native 工厂无自由 runner 注入。
- [ ] **完成适配。** 保留五项 checks 的单一来源/hash/位置约束；证据部分已知也要可见，但 blocked report 不登记可信 map。不把上次报告字面值当实测。对未知 backend、路径、注册复用、设置重写、自动行为/旧工作负载和停止链保留具体 missing。native observe 只用 NC2：安全无实例时返回真实 idle，foreign Docker/WSL 存在则冲突、不给归属；未知则 throw。native start/stop 在本计划保持明确 `TASK24_DESKTOP_NATIVE_RULES_UNPROVED`，不实现猜测 argv 或调用候选 quit。
- [ ] **GREEN。** 重跑本任务测试、NC2 测试和包内 typecheck。真实 native 工厂仅作“直接 start/stop 拒绝且零系统调用”的检查；离线 CLI 传输本身由非 native 合成 transport/自有 helper 测，不执行安装的 CLI。Expected：全部通过，仍无法真实准备或启动。
- [ ] **提交。** `git commit -m "feat(benchmark): expose evidence-backed native desktop diagnostics"`。

## Task 4: NC4 可信 console 确认和底层授权来源

**Files:** 新建 `src/sandbox/desktop/approval.ts`、`console.ts`、`test/linux-host/desktop-confirmation.test.ts`；修改 `profile.ts`、`planning.ts`、`desktop-profile.test.ts`、`desktop-launch.test.ts`。

**Interfaces:** 将现有 `confirmDesktopApproval(raw,verify):Promise<DesktopLaunchApproval>` 和 `requireDesktopApproval(approval,plan,phase,sid):void` 的实现与私有 map 迁至 approval，由 profile 命名转发。Consumes NC1 `requireDesktopPlan`、NC2 query 和现有 `DesktopApproval` 严格 schema。Produces `checkDesktopApprovalRequest(raw:unknown,plan:DesktopLaunchPlan,sid:string,manifestSha256?:string):DesktopLaunchApproval`（只验证，不登记）；`confirmDesktopInteractive(input:{raw:unknown;plan:DesktopLaunchPlan;profile?:DesktopPreparedProfile;signal:AbortSignal}):Promise<DesktopLaunchApproval>`。后者不接受 verifier/transport/clock 参数。`readDesktopConsoleDecision(packet:{panel:string;panelSha256:string;requestSha256:string;controllerID:string;launchID:string;phase:"prepare-profile"|"start-readonly";expiresAt:number},signal:AbortSignal):Promise<"confirmed"|"cancelled"|"unavailable">` 仅由可信固定模块调用，返回字符串本身不是能力。共享纯判定 `isDesktopApprovalSourceAllowed(source:"fixture-callback"|"native-console"|undefined,required:"fixture"|"native"):boolean` 只测规则，不登记来源。

- [ ] **RED 编写测试。** `native provenance cannot be manufactured by fixture callbacks` 覆盖 async true、克隆 approval、伪造 assurance 和直接 prepare/start，断言写入/真实 query 前拒绝，writes/spawn=0；共享规则精确断言 fixture-callback/native 为 false、undefined/native 为 false，native registry 没有测试注册入口；fixture 原合法路径仍可用但不能升格。`redirected or truncated console confirmation cannot issue authority` 覆盖三个标准流分别重定向、伪 isTTY、unsupported、partial panel 和 helper 异常退出。`single-use challenge rejects generic or stale input` 覆盖 PREPARE/START、launchID、96位随机 challenge、错误/空/yes/额外行/EOF/Ctrl+C/超时/已过期，一次正确输入才 confirmed。共享纯输入状态机用 fixture 测，不能向 native registry 塞入通过记录。
- [ ] **运行 RED。** `& $NativeCliBun --no-env-file test ./test/linux-host/desktop-confirmation.test.ts ./test/linux-host/desktop-profile.test.ts ./test/linux-host/desktop-launch.test.ts --timeout 30000`。Expected：来源隔离/交互行为缺失失败。
- [ ] **实现来源与面板。** authority 私有登记区分 fixture-callback 与 native-console，绑定原 plan 对象、请求 hash、阶段和本控制器实例。泛用 callback 永远不能登记 native；require 依据 plan 的真实工厂来源检查，不依据调用参数自报。prepare/start 及 grant 消费前都调用底层检查，不留导出函数绕过。confirmDesktopInteractive 本身也检查 requireDesktopPlan、实际 SID/请求及需要时的真实 profile/manifest，不能只依赖 CLI 外层。面板完全由当前 plan/实际 profile/真实观察派生，不接受调用方提供展示文案；包括规格全部摘要、目标、五设置、准备新增物/预算或启动/观察/停止规则。预算分别列12目录/4文件、设置实际字节和保守 payload 上界：复用现有每文件1 MiB限制，其他3文件最多3 MiB加设置字节，不冒充 NTFS实际占用或运行增长；native 设置必须仍为144字节。字段含控制字符/双向覆盖即拒绝；正文最多12 KiB、数据 packet16 KiB，不截断后继续。native 启动规则未知时不构造可执行面板。
- [ ] **实现 console。** 固定 PowerShell/C# helper 继承当前三个标准流，真实 GetStdHandle/GetConsoleMode 都通过后才显示；不打开 CONIN$/CONOUT$，不启动新窗口或附加别的 console。不用实验 bun:ffi。固定源码通过 EncodedCommand，packet 仅作有界数据经子进程专用环境传递，不作为授权；最小 D 环境及 helper 身份绑定，不继承用户 profile。stderr 完整输出面板后 helper 从系统随机源生成12字节 challenge，读最多256个 ASCII 字符，匹配完整短语；使用可取消的 console 输入事件/有界等待，不用无法终止的 ReadLine，也不更改共享 console 模式。最长 min(60秒,剩余有效期)，退出/超时只回收本次 helper，不触及父终端。仅被本次私有 native 调用链确认且面板/请求不变后登记能力；helper exit0 或外部 decision 字符串不能单独授予权限。
- [ ] **GREEN。** 重跑本任务测试和包内 typecheck；实际 helper 仅验证 parser、无 console/重定向拒绝和自有输入状态机。不得在真实伪终端自动输入短语来生成 native 授权；未支持的实际交互环境明确 unavailable。Expected：全过，确认等待无 profile/report/grant/Docker 副作用。
- [ ] **提交。** `git commit -m "feat(benchmark): require trusted interactive desktop confirmation"`。

## Task 5: NC5 CLI 预检再验证和取消串联

**Files:** 修改 `src/sandbox/desktop/command.ts`、`script/desktop-launch.ts`、`profile.ts`、`launch.ts`；新建 `test/linux-host/desktop-interactive-command.test.ts`；更新 `desktop-command.test.ts` 中需要新语法的 fixture 调用，保留其全部原断言。

**Interfaces:** 保持 `makeDesktopLaunchController(platform,verifyHumanConfirmation?)`：第二参数仅对 fixture 有效，native 传入泛用回调不能开启权限。controller 函数增加可选第二参数 `signal?:AbortSignal`；`runDesktopLaunchCommand(argv:readonly string[],signal?:AbortSignal):Promise<{exitCode:0|1|2;output:unknown}>` 向后兼容。Consumes NC1–4，内部输入快照保留准确 FileIdentity/hash，不公开发布能力。旧 audit/plan/inspect/stop-owned 不接受 --interactive。

- [ ] **RED 编写测试。** `explicit interactive syntax cannot be replaced by yes or callbacks` 精确覆盖无开关、重复/带值开关、未知参数、错误根和文件名、native 泛用回调；拒绝时提示/写入/执行次数0。`blocked or mismatched requests never prompt` 覆盖 SID/phase/plan/manifest/到期/运行实例及 NC3 missing。`same bytes replacement during prompt invalidates confirmation` 在屏障中替换 spec/approval/manifest/安装文件/父目录/注册/盘身份，文本相同也取消。`confirmation cancellation precedes durable side effects` 断言 nonce/active/profile/report 不存在，start/stop均0。
- [ ] **运行 RED。** `& $NativeCliBun --no-env-file test ./test/linux-host/desktop-interactive-command.test.ts ./test/linux-host/desktop-command.test.ts --timeout 30000`。Expected：新布尔参数、预检顺序或取消行为缺失失败。
- [ ] **实现顺序。** 严格解析后，native 仅读取该 launchID 控制目录的 spec.json 及对应 phase 文件；fixture 使用其 owner 下等价布局。无开关直接 human_confirmation_required；有开关但 audit blocked 返回包含 NC3 诊断的 exit2，不提示。生成当前 plan、真实观察、输入文件快照，load/revalidate 启动 manifest，再用 check 校验请求。fixture callback 也只能在这些前提后调用；native 只能走 confirmDesktopInteractive。
- [ ] **完成再验证。** 输入后重读原输入身份、bindings、安装、profile/parent/manifest、SID/注册/VHD、WSL/进程/pipe 状态，并确认仍是同一 plan/compatibility；漂移取消，不续期、不换 nonce、不套用旧输入。profile 继续完整字节/hash/身份校验，设置重写仍失败。prepare 也须在首次发布前核对 idle/无冲突，而非仅检查 SID；start 沿用原持久消费和 finally，关键 await 取消检查不得移除。脚本将 SIGINT/取消传到同一个 signal，不能 process.exit 跳过已开始操作的收尾。预检/audit/启动观察传入业务 signal；finally 的观察另用原30秒收尾 deadline，不沿用已取消或已到期的业务 signal。
- [ ] **GREEN。** 重跑本任务测试、NC4、旧 profile/launch 测试及包内 typecheck。原 fixture command 准备/启动调用只补 --interactive，若需文件布局迁入 owner 下控制目录，保留所有成功/拒绝/收尾断言；不改非 desktop 旧测试。Expected：全过，合成流程可准备/观察/停止，native 仍 blocked，后三 readiness=false。
- [ ] **提交。** `git commit -m "feat(benchmark): gate interactive desktop commands on fresh preflight"`。

## Task 6: NC6 排他历史报告和失败收尾

**Files:** 新建 `src/sandbox/desktop/inventory.ts`、`test/linux-host/desktop-inventory.test.ts`；修改 `profile.ts`、`publication.ts`、`command.ts`、`desktop-publication.test.ts`。

**Interfaces:** Produces `requireDesktopConsumedGrant(profile:DesktopPreparedProfile,approval:DesktopLaunchApproval):void`，只接受当前进程实际观察到持久消费成功的私有登记，不从磁盘恢复权限；在原消费成功点登记，不改消费算法。Produces `DesktopLaunchRecord`：`schemaVersion:1`、launchID、spec/plan/compatibility/manifest 摘要、`status:"inventory_observed_not_accepted"|"blocked"|"cleanup_uncertain"`、code/missing、`inventory:DesktopLaunchInventory|null`、`cleanup:"stopped"|"uncertain"|"not_needed"`、三项 readiness=false。`publishDesktopLaunchRecord(input:{profile:DesktopPreparedProfile;approval:DesktopLaunchApproval;record:DesktopLaunchRecord}):Promise<FileIdentity>` 验证来源/消费/绑定后派生固定路径，不接收任意输出根。

- [ ] **RED 编写测试。** `cancelled and unconsumed attempts publish nothing` 断言没有报告目录。`failed attempts retain cleanup authority and historical diagnostics` 断言消费后启动失败/确认到期或取消仍收尾一次，报告是 blocked/uncertain，不二次提示、不恢复 start。`report publication failure never bypasses finally cleanup` 强制发布失败，stop仍1、exit2明确报告失败。`record publication pins parents and never adopts foreign files` 用真实 D 夹具交换父目录/放 junction、hardlink、同名目录/文件，外侧 sentinel 身份/内容不变。`stale records cannot restore a live session` 断言新控制器只读历史、stop拒绝、旧验收入口拒绝。
- [ ] **运行 RED。** `& $NativeCliBun --no-env-file test ./test/linux-host/desktop-inventory.test.ts ./test/linux-host/desktop-publication.test.ts --timeout 30000`。Expected：缺少历史发布和消费来源检查失败。
- [ ] **实现。** 记录消费事实只对应当前 profile/原 approval 及其真实来源，独立于过期后的 start 权限；publisher 只接受已消费的 start-readonly，prepare grant 不能用来发布启动记录，不扩大新启动许可。record 输出上限64 KiB，不含 challenge、原始 env/approval、秘密或 capability。native 只派生固定 reports 根；fixture 只派生 `path.join(path.dirname(profile.plan.paths.root),"reports","desktop-launch",launchID)`，并重核 owner，不能触及真实根。固定诊断 base 的缺失父节点及新的 launchID 目录只经 handle-bound 相对创建；普通共享 base 仅作为已审核父目录，不能接管同名 launchID。扩展 publication 的 record 布局仅允许 inventory.json，默认 profile 布局/既有 API/删除规则不变；不使用 mkdir+路径 write 作为后备。
- [ ] **完成控制器收尾。** 成功 session 先 finally stop，再排他发布最终记录。已确认消费但返回 blocked 的启动尝试也可发布其已知失败/收尾状态；消费结果不可证明时只输出 uncertain，不假造记录许可。取消前/未消费不创建报告。发布失败不能盖掉 cleanup_uncertain，也不能跳过 stop。新进程 inspect 严格读有界记录并永远 stale；不反序列化 session。真实部署目录仍不访问。
- [ ] **GREEN。** 重跑本任务测试、NC5、旧 command/publication/profile/launch 回归及包内 typecheck。Expected：全过；所有文件在新 owner 根，真实 profile/报告/控制根未创建。
- [ ] **提交。** `git commit -m "feat(benchmark): publish non-authoritative desktop attempt records"`。

## Task 7: NC7 无 Docker 联合验证和软件交付

**Files:** 仅按发现修复本增量覆盖的文件；生成 `docs/superpowers/reports/2026-10-18-task24b-dl6-native-cli-verification.md`。不要提前填通过计数，不增加独立宿主、额外模型调用或真实 Linux 验收步骤。

**Interfaces:** Consumes NC1–6 软件与原无 Docker 套件；Produces 实际验证报告、普通 dev 提交/push及仍 blocked 的准确清单，不签发任何 readiness/acceptance。

- [ ] **联合测试。** 从包目录执行下列命令；每条 Expected：退出0、零失败，新增测试全跑、原10项 skip 名称与[既有报告](../reports/2026-10-18-task24b-d-drive-docker-launch-verification.md)一致。失败先定位，不删断言、不扩大旧时限，不引入实际 Docker。

  ```powershell
  & $NativeCliBun --no-env-file test ./test/linux-host/desktop-bindings.test.ts ./test/linux-host/desktop-native-query.test.ts ./test/linux-host/desktop-native-audit.test.ts ./test/linux-host/desktop-confirmation.test.ts ./test/linux-host/desktop-interactive-command.test.ts ./test/linux-host/desktop-inventory.test.ts --timeout 30000
  & $NativeCliBun --no-env-file test --timeout 30000 --only-failures
  & $NativeCliBun --no-env-file run typecheck
  ```

- [ ] **Scoped 类型检查。** 在本次 owner 根生成扩展包内 tsconfig 的 `tsconfig.native-cli.json`，纳入 `src/**/*.ts`、`test/linux-host/**/*.ts` 及 desktop-launch/linux-host/accept-linux-host 三脚本；types 为 bun，typeRoots 显式为包内和 repo 的 node_modules/@types。包内运行 `& $NativeCliBun --no-env-file run typecheck --project "$NativeCliTemp\tsconfig.native-cli.json"`。Expected：退出0，不直接调用 tsc，不关闭检查。
- [ ] **零额度联合证明。** 用合成控制输入贯穿 audit blocked/拒绝提示、fixture 准备/启动/观察/finally/历史读取；统计真实 Docker/WSL/provider transport 调用数为0，所有 fixture 状态不升格。核对代码中 native start/stop 仍拒绝，没有真实 prepare、单实例解锁、自动接受许可或付费逻辑。独立脚本无参只返回 operation_required、exit2、三 readiness=false；stdin/stdout/stderr 重定向无权执行。
- [ ] **保护对象核查。** 只读对比本轮前后部署 EXE SHA256 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`、`.wslconfig` SHA256 `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`，以及旧 C 目录元数据、注册/VHD 身份；若出现外部变化只报告，不恢复。此项允许只读文件/注册元数据，不执行 native audit、WSL list 或盘内查询；元数据相同不称 OS 零写入证明。Expected：本任务无改动且真实目标未创建。
- [ ] **一次整体审查。** 对本计划完整提交范围、规格和 Review Focus 作一次独立审查；保留顺序实现方式，不增加逐任务代理。重要问题一次 RED→GREEN 修复并重跑相关及全套测试，次要项明确记录，不用重复审查代替验证。Expected：无未处置的重要问题，不将 native blocked 当软件测试失败来解锁。
- [ ] **报告与清理。** 写真实命令/次数/退出码、helper/parser 和未验证交互边界、各 missing、production default 状态；分开列出软件完成、native 兼容阻断、真实准备/启动未运行、Linux 验收/校准/付费/部署未运行。保留正式源码/报告与授权状态；验证后仅清理本次精确 owner 临时物，拒绝时列残留，不绕接口清理旧目录。文档格式/本地链接、`git diff --check`、暂存清单校验均须通过。
- [ ] **提交并 push。** 仅 stage 已验证任务文件，最终提交 `docs(benchmark): record native CLI verification boundaries`；普通 `git push fork dev`，保留正常 pre-push。所有 hook 的运行环境同样使用无 dotenv 包装及 D 缓存；网络日志有界写本次 D 日志，不打印认证 trace。用 ls-remote 核对远端 dev 与本地 HEAD，检查工作区。Expected：hooks通过、本地远端一致；不 force、不 no-verify、不部署。网络或 hook 失败如实记录，不冒充已 push。

## 规格覆盖和交接

授权顺序/保护边界贯穿 Global Constraints 和 NC7；文档绑定、plan/锁为 NC1；真实观察与系统边界为 NC2；兼容证据、可见 blocked 和封闭启停为 NC3；输入短语、可信来源与底层不可绕过为 NC4；控制路径、两次预检及取消为 NC5；报告、消费后失败和历史非权威性为 NC6；完整回归、保护对象、审查、清理及提交/push 为 NC7。Review Focus 五项均已落到对应 RED 用例。

本计划不承诺关闭所有原生启动缺项，也不偷偷安排真实主机试跑；完成定义是软件边界和无 Docker 证据可交付。若必须支持设置自动重写、改变旧容器恢复边界、修生产连接或开放未经证明的启停操作，停止相关路径并另提最小变更。

**待用户审阅：** 请确认本计划是否准确。执行方式沿用当前会话逐步 native 实施、现有 dev；本轮不实施，不派代理，不准备真实输入/profile，不启动或停止 Docker/WSL，不做验收、付费或部署替换。
