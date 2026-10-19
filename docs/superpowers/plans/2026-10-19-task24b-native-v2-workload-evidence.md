# Task24B Native v2 and Offline Workload Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不启动旧负载、不改旧 C 档案的前提下，建立可审查的离线证据读取与原生 v2 权限接入；任何证据、只读性或安全交接不足均继续阻断。

**Architecture:** 先验证读取器、准确存储布局及原生交接的可行性，再按两个相依工作包实现：离线读取/证据 broker，以及 native-v2-r1 admission/确认/文件/运行接入。不可变规则摘要与当前采集事实分开；空状态快照、读盘许可、准备许可和启动/收尾能力不互换。新原生分支复用 v2 数据校验和已验证生命周期规则，不把 fixture 能力改标为 native。

**Tech Stack:** TypeScript、Effect Schema、Bun test、现有 Windows 精确身份/相对句柄/真实控制台设施；解析器及依赖必须经 NW1 选型门槛确定，不预设安装新工具、挂载驱动或使用 Docker/WSL。当前实施计划不批准新增依赖下载。

**Spec:** [已确认补充规格](../specs/2026-10-19-task24b-native-v2-workload-evidence-design.md)，SHA256 `807f7054d221b65bcafbea9abf68e721496786f42b324cbe0c920aad0f62950f`；继承其所引三份规格。规格页首是成文时状态；用户现已确认规格，**仅允许编写本计划，尚未允许实施**。

本轮仅新增本文、作文档检查及本文本地提交，不 push，不运行产品测试或原生探针，不创建测试/运行目录。后续执行方式沿用在现有 dev 本会话串行执行、使用 executing-plans，不另建 worktree、不逐任务分派代理；整段审查按执行时适用技能进行。本计划审阅不触发执行。

## Global Constraints

- 基线 `dev / baea6976ba892fab16b4ae292186b2937ceb2742`；Desktop `4.79.0.230596`、CLI `29.5.3`、设置格式 `44`。引擎/containerd 版本须另据固定安装证明，不能用 CLI 版本替代。
- 原盘仅为 `D:\Applications\DockerWSL\main\ext4.vhdx` 和 `D:\Applications\DockerWSL\disk\docker_data.vhdx`；profile 固定 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479`，home basename 为 `home-oc-task24-dd479`。不换空引擎。
- 旧 C 盘三棵 Docker 目录不迁移、复制、删除、恢复、覆盖、改 ACL 或改链接；真实 `C:\Users\Administrator\.wslconfig` 不修改。不新增 C 应用配置/缓存例外，必要新增例外另批。
- 软件实施只使用新 D owner 根、合成安装/磁盘/数据及本次自有 helper；不读取原 VHD 内容、真实 Key、`.env.local`、credential、账号或许可，不启动安装的 Desktop/backend/服务或 WSL 发行版。
- 不挂载、日志回放、修复、转换、复制、压缩、合并或回滚原盘；不改服务、全局环境/PATH/注册，不提权、重装/升级、导入/注销、停止 Ubuntu 或全局 shutdown。
- 旧容器、Swarm、Kubernetes 自动恢复也属于禁止运行。首版只接纳完整空状态；非空、未知、缺范围、损坏或不新鲜均无权限，不接受风险旁路。
- 不改旧视觉流程、workflow 租约/重试/预算、生产 `packages/server/src/workflow/docker-config.ts`、default/endpoint/daemon 合同、题目/分组/次数、部署/dist/seal/receipt；不做真实验收、模型发现、付费跑分或部署替换。
- v1 的2+2文档/身份/历史语义、fixture-v2 的3+3文档/行为保持；native-v2-r1 使用独立且准确4+4集合。本文是第4份计划，不修改已确认规格或旧 registry 来伪造通过。
- 离线采集 `120000ms`、解析工作集 `268435456` 字节、两盘物理读取合计 `536870912` 字节，重读计入；逻辑元数据单文件 `1048576`、合计 `16777216` 字节、结构节点 `100000`、脱敏报告 `262144` 字节。超限拒绝，不缩小覆盖或自动放大。
- 采集发生在原 `45000ms` 兼容核查之外；确认 `60000ms`、请求最长 `900000ms`、面板 `12288` 字节；启动 `120000ms`、轮询 `200ms`、停止 `30000ms`，不刷新阶段时限。
- 设置 intent `16384` 字节；三运行文件各 `1048576`、合计 `3145728`；深度 `32`；临时文件最多 `3` 个、各 `1048576`，最终及临时合计 `6291456`。profile 13目录/5文件、保守 payload `3162256` 字节不扩大；17目录/8文件不包含独立取证输出、动态 helper 或运行增长。
- `empty_at_capture` 不等于运行许可；历史报告、普通 JSON/hash、复制对象、verify 回调或环境 flag 不能签发能力。证据不足，尤其 `workload_handoff_unproved`，native prepare/start 必须为0。
- 保留未跟踪 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md`，SHA256 `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07`；不 stage、隐藏、ignore、删除或恢复它。它造成的 clean-tree 阻断另获明确文档处理授权。
- 代码实施、依赖准备、每次原盘内容取证、实际准备、实际启动及其已归属收尾是独立授权阶段；本地真实确认不能由代理代输。保留旧断言、时限、skip，不顺手修未经批准的基线业务问题。

## Review Focus

1. 原盘有脏日志/未知特性，读取器却按“没找到对象”判空：预期 `unsupported/inconsistent` 且0许可——NW4、NW5。
2. 准备时为空，但下一进程/下一次 start 借旧报告放行：预期重新采集，克隆/历史能力一律拒绝——NW6、NW12。
3. 第二盘打开失败或取消后 helper 晚返回，留下第一盘读锁/晚到 writer：预期取得阶段完整 join、仅释放自有资源；交接未证明 start=0——NW3、NW6、NW10。
4. 索引目录名/数据库页夹带 Env、secret、代理值，异常路径把它们打到 stderr：预期固定原因码与脱敏输出，原始内容不落盘——NW4、NW5、NW11。
5. `.wslconfig` C 路径或新 native 域被当作扩大任意路径/旧 fixture 权限的理由：预期仅固定只读例外、严格域分流和旧回归不变——NW2、NW3、NW8、NW12。

## 分期与停止条件

本计划有13个独立可验证任务，不代表已批准一次性执行13项。**未来首次实施建议仅批准 NW1。** NW1 提供 `ready_for_implementation`、`needs_dependency_approval` 或 `blocked` 三种结论；只有准确读取器、完整布局、安全交接和必要原生规则均有可审查来源时，才进入 NW2–NW13 的启用路线。

若当前安装没有可证明的交接机制，提交 NW1 的软件/证据结论并停止，NW2–NW13 标为未执行，不宣称全部完成。用户可再单独选择仅离线诊断工作包（NW2–NW6、NW9、NW11 的报告部分及 NW12–NW13 的诊断/拒绝验证），但它始终禁用 prepare/start；不能在执行中自行选择这个范围变更。

缺依赖先报准确工具、版本/hash、来源/许可证、D 落点、下载量及缓存预算，等待授权；不以“实施已批准”推定可下载。独立原盘诊断仍另行批准，不因软件完成自动执行。实际准备与启动均在本计划的软件验证之外。

## 文件结构与共享接口约定

以下仅是拟创建/修改清单。源码前缀 `S = packages/benchmark/src/sandbox/desktop/`，测试前缀 `T = packages/benchmark/test/linux-host/`；Files 字段中的路径均相对于仓库，不使用运行目标作测试目录。

| 单元           | 文件及责任                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 固定规则与合同 | 新建 `S/native-v2/rules.ts`、`contracts.ts`、`authority.ts`；分别负责 pin/完整性、native 域 schema/数据类型、私有批准/读取权限登记，不接受外部规则注册                                    |
| 只读平台与读取 | 新建 `S/native-v2/handles.ts`、`probe.ts`、`reader.ts`；分别负责精确句柄/双盘保护、固定元数据/进程协议、有界格式解析适配                                                                  |
| 负载事实       | 新建 `S/native-v2/workload.ts`、`broker.ts`；分别负责完整范围的纯分类/脱敏和私有 snapshot/permit/交接生命周期                                                                             |
| 业务接入       | 新建 `S/native-v2/admission.ts`、`publication.ts`、`console.ts`、`platform.ts`、`inspection.ts`、`command.ts`；分别负责规则/计划、准确发布、真人确认、已归属启停、只读观察/报告、操作顺序 |
| 现有门面       | 仅在各任务列明的旧文件添加明确 native 分流/内部适配；旧 fixture/v1 分支及公开 HostRequest/StorageProof/EngineSession 不扩权                                                               |
| 合成设施       | 按任务新建 `T/desktop-nw-*.test.ts`、`desktop-nw-fixture.ts` 与自有 helper；二进制格式样本只能是确定的合成非业务数据                                                                      |
| 最终证据       | 实施时新增 `docs/superpowers/reports/2026-10-19-task24b-native-v2-workload-evidence-verification.md`；如跨日期仅调整报告名，不改变本计划 registry 路径                                    |

NW2 定义 `NativeSpec/NativePlan/NativeProfile/NativeRequest/NativeApproval/NativeSession` 的严格 native-v2-r1 变体及只读数据类型；后续任务只使用这些名字。`Gate<T>` 沿用 `packages/benchmark/src/sandbox/contracts.ts`。`NativeSession` 是进程内权限，磁盘 schema 不含它。新建函数/类型均由下述任务生产；不为缺实现增加“总返回 true”的接口。

跨任务数据键在 NW1/NW2 一次固定：`NativeRuleDescriptor={installSha256,readerSha256,layoutSha256,settingsSha256,lifecycleSha256,handoffSha256,evidenceSha256}`，全为准确SHA256；install摘要是实际受核安装成员清单的canonical摘要，不是任一EXE hash。descriptor内部再绑定NW1选定实现的固定版本与入口，不接受调用者提供可执行命令。`WorkloadScan={status,complete,containers,swarm,kubernetes,otherActivation,missing}`，后四范围为 `empty/nonempty/unknown`，status取规格六种值。`OfflineMetadata={formatSha256,layoutSha256,coverage,indexes,counters}`，coverage逐项列固定规则要求的存储/namespace/激活来源及是否完整，indexes仅传脱敏后分类所需计数与状态，counters精确为 `physicalBytes,logicalBytes,nodes,peakWorkingSetBytes,elapsedMs`。这些是可测试数据；NativeReadPermit/Approval/Audit/Plan/Profile/Snapshot/WorkloadPermit/Session/ConfirmationContext 均另有私有来源登记，形状或hash相同不互认。

## 未来测试命令与环境

所有 Run 命令都只在实施获批后执行；本轮不执行。统一 CWD 为 `D:\OpenCode-Audit\packages\benchmark`，`$NativeBun` 为 `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`，每次用 `--no-env-file`。

NW1 将现有 owner 协议用于新的 `D:\OpenCode-Benchmark\Task24\tmp\bprep1-native-v2-<run-id>`，owner 的 nonce 固定 `bprep2-0786b1f11abc`、runOwner 为本次准确 ID；父链/身份核对后排他创建，将核实后的该绝对路径赋给任务变量 `$NativeTemp`。HOME/USERPROFILE、APPDATA/LOCALAPPDATA、TEMP/TMP/TMPDIR、XDG、Bun/npm/Go/Turbo 缓存全部指向该根的明确子目录；父进程环境白名单，不加载真实 Key。禁模型拉取、工具链下载和遥测。测试脚本/日志/scoped tsconfig 仅在这个自有根内，不能借旧政策拒绝清理目录复用为本次根。

每个任务遵循 RED → 最小实现 → GREEN → 精确提交。每个Step 1的主测试名固定为 `NW<n> boundary`（例如 `NW3 boundary`），其分支按该步列出的输入分别断言。下文代码为必须实现的断言，额外夹具构造/返回的命名case使用 `T/desktop-nw-fixture.ts` 及该任务列出的worker；在所属任务中精确补齐夹具，不能把断言留成伪代码，合成case绝不签发native权限。具体数量据真实结果记录，不复用上轮462/10/0作为本计划结果。

## Task 1: NW1 可行性记录与最早停止关口

**Files:** 新建 `S/native-v2/rules.ts`、`T/desktop-nw-rules.test.ts`、`T/desktop-nw-fixture.ts`；实施时新增上述最终报告的首轮可行性章节，不改安装、依赖清单或 lockfile。

**Interfaces:** `assessNativePrerequisites(): Readonly<{status:"ready_for_implementation"|"needs_dependency_approval"|"blocked"; missing:readonly string[]; evidence:readonly {id:string; source:string; sha256:string; location:string}[]}>`；纯函数仅检查编译期固定记录。`selectNativeRuleDescriptor(installSha256:string): Gate<NativeRuleDescriptor>`；descriptor 为本文件只读数据类型，固定 reader/布局/设置/启停/交接来源/hash，不可由调用者注册。只有本模块私有完整性校验可选择；数据 descriptor 本身不授予操作权。

- [ ] **Step 1 RED：** 测试 `partial_record_never_enables_native`、`fixture_descriptor_cannot_select_native`；缺交接、缺 reader、字段或安装 hash 不符均 blocked；初始现场 pin 保留 `workload_handoff_unproved`，不以假值补齐。夹具只生产规则数据和副作用计数，不生产 native 权限。
  ```ts
  expect(assessNativePrerequisites().status).not.toBe("ready_for_implementation")
  expect(selectNativeRuleDescriptor("0".repeat(64)).kind).toBe("blocked")
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-rules.test.ts --timeout 30000`；预期缺模块/选择器或错误放行导致失败。
- [ ] **Step 3 实现：** 只读检查已有仓库、固定安装静态资源及官方源码/文档，不执行 Docker/WSL或读原盘；记录准确 reader 方案/来源/依赖/只读 API/格式特性与完整布局来源，并逐项论证交接/启停，不凭支持字符串推断实现。现有材料不能证明的项明确 missing；需要下载则生成依赖请求，不下载。无合格记录时 catalog 不启用，不提供外部 proof 导入。
- [ ] **Step 4 GREEN 与决策：** 重跑本测试及包内 typecheck；报告准确 pin、缺项和继续/停止结论。若 blocked 或待依赖批准，停止后续任务并向用户报告；仅规则拒绝测试通过不表示现场规则已证明。
- [ ] **Step 5 Commit：** 精确 stage 本任务文件，提交 `feat(benchmark): gate native v2 work on verified prerequisites`；不 push，不碰旧未跟踪报告，除非该次实施另有明确发布授权。

## Task 2: NW2 native 域合同与准确4+4文档绑定

**Files:** 新建 `S/native-v2/contracts.ts`、`S/native-v2/authority.ts`；修改 `S/bindings.ts` 仅增加新域函数；新建 `T/desktop-nw-contracts.test.ts`。旧 `v2-contracts.ts` 的 fixture 解码含义不改。

**Interfaces:** `decodeNativeSpec(raw:unknown): NativeSpec`、`decodeNativeRequest(raw:unknown): NativeRequest`；NativeSpec 是旧 v2 明确字段加 `authorityDomain:"native-v2-r1"` 的严格变体，NativeRequest 按 `capture-workload/prepare-profile/start-readonly` 判别。`readNativeBindings(root:string,signal?:AbortSignal): Promise<{sourceSha256:string;specSha256:string;planSha256:string}>`。定义 `ReadAt={read(offset:bigint,length:number,signal:AbortSignal):Promise<Uint8Array>}`，无 write/openPath；`WorkloadScan` 包含完整性、三个范围与额外激活来源的 `empty/nonempty/unknown`，均为数据，不是能力。

`authority.ts` 生产 `requireNativeApproval(approval:NativeApproval,request:NativeRequest):void`、`takeNativeReadPermit(approval:NativeApproval,spec:NativeSpec):Gate<NativeReadPermit>`、`requireNativeReadPermit(permit:NativeReadPermit,spec:NativeSpec):void`；私有WeakMap没有公开注册器，NW9接入固定console之前不能签发任何批准，故当前所有外来对象必拒绝。NativeReadPermit单次取得双盘，只在当次会话存活，不是可解析schema。NW3必须在打开任一原盘前验证它，不仅依赖CLI。

- [ ] **Step 1 RED：** 缺域/删域回落/额外键/错阶段/超900000ms请求均拒绝；准确4+4通过，成员替换/重复/缺本计划或 dirty 失败；旧2+2、3+3测试原样通过。NativePlan/Profile/Approval/Session 只由各自任务签发，JSON decoder 不构造运行权限。
  ```ts
  expect(() => decodeNativeSpec({ ...fixtureSpec, authorityDomain: "fixture" })).toThrow()
  expect(() => decodeNativeRequest({ authorityDomain: "native-v2-r1", phase: "accept-risk" })).toThrow()
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-contracts.test.ts ./test/linux-host/desktop-bindings.test.ts ./test/linux-host/desktop-v2-contracts.test.ts --timeout 30000`；新增 native 合同缺失应失败。
- [ ] **Step 3 实现：** Effect Schema 严格判别，定义 NativePlan/Profile 的原 v2字段及 native规则/域摘要、NativeApproval 的私有来源标记、NativeSession 不透明类型；新 registry 成员为原3+3加批准补充规格与本文，排序/实际字节hash绑定。原注册/SID/盘/输入有效期字段不可省略；capture 请求绑定预算/输出/reader/layout，不能当 prepare/start 请求。
- [ ] **Step 4 GREEN：** 重跑本任务、typecheck；变更 runtime session 随机值不改变固定规则摘要，改变域/文档/安装会改变或拒绝绑定；真实脏仓库不绕过，正向绑定只在合成干净小仓库测。
- [ ] **Step 5 Commit：** `feat(benchmark): add isolated native v2 contracts and bindings`，仅本任务文件。

## Task 3: NW3 精确只读双盘保护与固定探针协议

**Files:** 新建 `S/native-v2/handles.ts`、`S/native-v2/probe.ts`、`T/desktop-nw-handles.test.ts`、自有句柄 helper `T/desktop-nw-handles-worker.ts`；复用 `S/identity-v2.ts` 的 D 身份，不修改 v1 probe/publication 协议。

**Interfaces:** `withOfflineHandles<T>(spec:NativeSpec,permit:NativeReadPermit,signal:AbortSignal,use:(disks:OfflineDisks)=>Promise<T>):Promise<T>`；`OfflineDisks={runtime:ReadAt;data:ReadAt;revalidate():Promise<void>}` 仅在 callback 内有效、私有登记。`readNativeWindowsState(spec:NativeSpec,signal:AbortSignal):Promise<NativeWindowsState>`；NativeWindowsState 在 contracts.ts 定义准确SID、原注册、双盘身份、进程/管道/WSL元数据，不含启动方法。精确C只读工具/`.wslconfig`例外由本模块固定，不接受任意C路径。

- [ ] **Step 1 RED：** 自有 D 普通文件双盘：读锁阻止竞争写/删除/父目录交换；第二盘取得失败、取得中取消/晚返回时已取资源全部 join/释放，callback=0；相邻大整数不混同。C任意文件/硬链接/差分外部路径/假owner/已运行状态拒绝。
  ```ts
  expect(await ownFiles.canWriteWhileLeased()).toBe(false)
  expect(await ownFiles.canWriteAfterRelease()).toBe(true)
  expect(secondAcquireFailure.useCalls).toBe(0)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-handles.test.ts ./test/linux-host/desktop-v2-identity.test.ts ./test/linux-host/desktop-native-query.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 在任何原盘open前调用NW2许可守卫；新版固定 helper 使用 OPEN_EXISTING/只读/无写删除共享、精确 FILETIME/file ID 和绑定父链；取得双盘后再核查，资源产生操作确认取消并 join，禁止未观察晚返回丢失锁。ReadAt 拒绝失效callback、负offset、越界/过大长度；新探针只运行固定系统只读元数据/list命令，保留真实stderr/编码/限额/超时，不能执行 `-d/import/terminate/shutdown`。
- [ ] **Step 4 GREEN：** 重跑本组，真实自有 helper 的创建/退出和句柄保护有断言；CI测试工厂先拒绝所有原安装/原盘路径，不以测试参数登记 native 来源。既有服务不成为本次归属。
- [ ] **Step 5 Commit：** `feat(benchmark): contain native v2 read-only handles and probes`。

## Task 4: NW4 固定只读格式适配与预算

**Files:** 新建 `S/native-v2/reader.ts`、`T/desktop-nw-reader.test.ts` 及合成格式样本生成器 `T/desktop-nw-image-fixture.ts`；只有 NW1 已选定且经另批取得的成熟解析能力才可被固定适配。

**Interfaces:** `readOfflineMetadata(disks:OfflineDisks,descriptor:NativeRuleDescriptor,signal:AbortSignal):Promise<Gate<OfflineMetadata>>`；OfflineMetadata 在 contracts.ts 定义有界、已验证的映射/索引结构及计数，不含原始业务值或权限。生产适配器只走 ReadAt，不能自己开路径；所有实际/重读字节由 broker 计数，错误只返回固定blocked原因，不回显parser原文。

- [ ] **Step 1 RED：** 用独立已知预期的合成VHDX/ext4/索引真字节，测有效冗余头、校验、offset/循环/边界及空索引；dirty VHDX/ext4、外部journal/差分父盘、未知特性/加密、截断拒绝；写/挂载/回放调用计数必须为0。样本生成器不调用被测parser作oracle。
  ```ts
  expect(dirtyImage.result.code).toBe("offline_recovery_required")
  expect(unsupportedFeature.result.kind).toBe("blocked")
  expect(readerCalls).toMatchObject({ writes: 0, mounts: 0, replays: 0, externalOpens: 0 })
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-reader.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 固定 NW1 adapter/pin，先头和日志一致性再metadata；不实现恢复视图。计入512MiB物理读取/重读、1MiB单逻辑文件/16MiB合计、100000节点、120秒和256MiB工作集限制；工具无法落实内存/I/O限制就拒绝启动读取器。逻辑路径来自固定目录，异常仅固定原因码；无通用脚本/SQL/路径输入。没有合格adapter直接 blocked，不自研临时修复器兜底。
- [ ] **Step 4 GREEN：** 每种预算在边界可用、越界拒绝，不需真的耗满512MiB或等待120秒：用生产计数/限额核心及受限测试额度验证，生产常量仍精确相等；另用自有helper验证内存/取消约束。索引页注入敏感哨兵，stdout/stderr/报告不出现。
- [ ] **Step 5 Commit：** `feat(benchmark): add bounded offline metadata reader`。

## Task 5: NW5 完整布局分类与最小化报告

**Files:** 新建 `S/native-v2/workload.ts`、`T/desktop-nw-workload.test.ts`；布局固定记录仍在 rules.ts，不接受外部目录注册。

**Interfaces:** `classifyWorkload(metadata:OfflineMetadata,rules:NativeRuleDescriptor):WorkloadScan`；`describeWorkload(scan:WorkloadScan,context:OfflineDiagnosticContext):OfflineDiagnostic`。NW2的 contracts.ts 定义 `OfflineDiagnosticContext={spec:NativeSpec;rules:NativeRuleDescriptor;counters:OfflineMetadata["counters"];readSetSha256:string}`；当前broker负责取受保护的实际值。OfflineDiagnostic含 schemaVersion/域、reader/layout/安装/源码/文档/注册/双盘摘要、状态/完整性/范围和预算计数，`historical_not_live:true`，最大262144字节；不含读块、名字、Env、许可或 session。

- [ ] **Step 1 RED：** 三范围与所有额外来源完整为空才判 `empty_at_capture`；多namespace/containerd根、Swarm成员但无本地task、旧Kubernetes/provisioner、模块启动来源、残留/损坏/少页/未知DB均不判空；只存在镜像或卷且已排除激活来源不等于负载。
  ```ts
  expect(completeEmpty.scan.status).toBe("empty_at_capture")
  expect(swarmMemberWithoutTasks.scan.status).not.toBe("empty_at_capture")
  expect(missingNamespace.scan.status).toBe("unsupported")
  expect(JSON.stringify(secretSentinel.diagnostic)).not.toContain(secretSentinel.value)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-workload.test.ts ./test/linux-host/desktop-workload-boundary.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 覆盖范围是固定布局支持集与实际存储/启动映射的交叉验证，不以常见路径或JSON字段推断完整；区分 nonempty/unsupported/inconsistent/budget_exceeded/cancelled。只读合格数据输出纯分类，**本函数不签发 snapshot/permit**；报告无原始错误堆栈、secret/etcd/任务正文，遇未知格式保守拒绝。
- [ ] **Step 4 GREEN：** 重跑本组及NW4；验证格式化/错误路径均脱敏，旧fixture空状态门禁与三范围断言不变；不能导入OfflineDiagnostic当原生事实。
- [ ] **Step 5 Commit：** `feat(benchmark): classify complete offline workload evidence`。

## Task 6: NW6 私有证据 broker 与安全交接

**Files:** 新建 `S/native-v2/broker.ts`、`T/desktop-nw-broker.test.ts`、自有竞争writer helper `T/desktop-nw-writer-worker.ts`；不修改 fixture `S/workload-boundary.ts` 的锁算法。

**Interfaces:** `withNativeWorkloadCapture<T>(spec:NativeSpec,approval:NativeApproval,signal:AbortSignal,use:(snapshot:OfflineWorkloadSnapshot)=>Promise<T>):Promise<Gate<T>>`；内部调用NW2的takeNativeReadPermit及NW3–5，仅capture权限可读。`admitNativeWorkload(snapshot:OfflineWorkloadSnapshot,request:NativeRequest,approval:NativeApproval):Gate<NativeWorkloadPermit>`；`withNativeWorkloadPermit<T>(permit:NativeWorkloadPermit,use:()=>Promise<T>):Promise<T>`；snapshot/permit 在本模块私有WeakMap登记，不提供注册/恢复函数。prepare/start用途分别验证对应批准，start用途必须通过 NW1 固定交接实现，而非普通 use 回调本身获得权限。

- [ ] **Step 1 RED：** JSON/hash/克隆/另一controller/请求/nonce/阶段/过期/已消费permit拒绝；空快照独立会话结束即失效，准备完成不能被start复用；未证明交接时启动及写入=0。
  ```ts
  expect(noHandoff.result.missing).toContain("workload_handoff_unproved")
  expect(noHandoff.calls.start).toBe(0)
  expect(admitNativeWorkload(JSON.parse(savedDiagnostic), request, approval).kind).toBe("blocked")
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-broker.test.ts ./test/linux-host/desktop-workload-boundary.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 固定broker取得双盘保护、调用真实解析/分类、登记只读事实；reader返回blocked时不能调用分类/签发snapshot，只有完整有效metadata才进入空判定。固定规则摘要不含采集随机值，当前fact/context绑定具体请求。交接机制只能来自NW1准确规则及句柄级实现；要求移交无未保护间隙并绑定本次writer，不能先释放读锁再start/看通知。无机制就返回blocked，不发permit、不调用use。取消后实际已调用效果仍按其返回/已归属收尾完成资源join，不用外层计时提前撤保护或续发使用权。
- [ ] **Step 4 GREEN：** 用自有D文件/竞争writer验证锁冲突、被迫关锁的错误实现会被测试捕获；正向纯状态机可测但不注册native权限。真实厂商交接未证明确列blocked，不能拿合成helper通过关闭missing。
- [ ] **Step 5 Commit：** `feat(benchmark): bind workload permits to guarded native admission`。

## Task 7: NW7 原生规则审计、设置与计划接缝

**Files:** 新建 `S/native-v2/admission.ts`、`T/desktop-nw-admission.test.ts`；仅修改 `S/compatibility-v2.ts`、`S/planning-v2.ts`、`S/settings-policy.ts` 的明确 native 分流及必要纯校验适配，不重写 fixture 逻辑。

**Interfaces:** `auditNativeDesktop(spec:NativeSpec,signal:AbortSignal,snapshot?:OfflineWorkloadSnapshot):Promise<Gate<NativeAudit>>`；`planNativeDesktop(spec:NativeSpec,audit:NativeAudit):Gate<NativePlan>`；`requireNativePlan(plan:NativePlan):void`。NativeAudit 私有绑定固定规则和当前broker事实；audit无snapshot不读取原盘，只报缺项。native完整设置目录由NW1规则给出，不能沿用fixture策略。

另生产 `makeNativeConfirmationContext(input:{spec:NativeSpec;request:NativeRequest;plan?:NativePlan;profile?:NativeProfile;snapshot?:OfflineWorkloadSnapshot},signal:AbortSignal):Promise<Gate<NativeConfirmationContext>>`，由本模块私有登记；capture只要求该次读取必须满足的规则/元数据，准备和启动须原有全部兼容门槛及当前事实。按phase严格要求相应plan/profile/snapshot，不能用可选参数绕过；每个opaque对象须同域、同spec和当前请求。它不是调用者可自报的context；NW9在提示前核对同一来源及请求。

- [ ] **Step 1 RED：** 七类规则任缺一项、设置字段/临时模式不完整、错误专用endpoint、dirty/source/文档/原盘漂移均拒绝；生产默认地址差异必须原样标记不兼容，不能冒充生产验收，但不改成所有独立诊断都不可输出。audit/plan全路径raw读盘=0；回调与伪native报告不能产生plan。
  ```ts
  expect(auditWithoutCapture.calls.rawReads).toBe(0)
  expect(auditWithoutCapture.result.missing).toContain("existing_workload_restart_unproved")
  expect(planNativeDesktop(spec, clonedAudit).kind).toBe("blocked")
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-admission.test.ts ./test/linux-host/desktop-compatibility.test.ts ./test/linux-host/desktop-settings-policy.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 固定NativeRuleDescriptor选择完整设置/自动行为/路径/环境/注册复用/停止规则，使用私有broker上下文逐项证明；保持设置三目标、五意图与全部限额。计划摘要仅纳入固定规则/域/intent等，短期fact单独绑定；同一保护上下文前后再核查不因新采样时间产生伪漂移，但任何真实规则变化使请求失效。native报告与fixture map不得互认。
- [ ] **Step 4 GREEN：** 重跑本组、NW2/NW6、typecheck；现有默认endpoint合同不变，不为生产地址不匹配提供自动配置修复；没有完整native目录时软件测试成功仍blocked。
- [ ] **Step 5 Commit：** `feat(benchmark): admit native plans from verified rule and workload sources`。

## Task 8: NW8 准确目标发布与原生档案账本

**Files:** 新建 `S/native-v2/publication.ts`、`T/desktop-nw-publication.test.ts`；修改 `S/profile-v2.ts`、`S/publication-v2.ts` 仅添加不互认的新域接缝。必要共享的是相对句柄操作核心，不放宽原fixture根检查。

**Interfaces:** `prepareNativeProfile(plan:NativePlan,approval:NativeApproval,snapshot:OfflineWorkloadSnapshot,signal:AbortSignal):Promise<Gate<NativeProfile>>`；`requireNativeProfile(profile:NativeProfile):void`；`withNativePublication<T>(plan:NativePlan,approval:NativeApproval,use:(io:DesktopPublicationV2)=>Promise<T>):Promise<T>`。NativeProfile由本任务私有登记，manifest native变体落同一5文件清单；prepare许可及snapshot均须当前。

- [ ] **Step 1 RED：** 无批准/错误域/旧manifest/同名外来根/源dirty/父链交换/硬链接/错误C路径拒绝且树与账本不变；仅准确13目录/5文件可准备，超3162256 payload/单文件限额拒绝，不写daemon文件或可恢复permit。
  ```ts
  expect(rejectedPrepare.filesAfter).toEqual(rejectedPrepare.filesBefore)
  expect(ownSyntheticPublication.createdCounts).toEqual({ directories: 13, files: 5 })
  expect(ownSyntheticPublication.savedPermit).toBe(false)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-publication.test.ts ./test/linux-host/desktop-v2-publication.test.ts ./test/linux-host/desktop-v2-profile.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 独立准确目标cap固定profile/control/report路径及物理父链，使用NT相对句柄与排他发布；每种phase/mode还有准确文件名及read/write/remove操作白名单，不能因取得profile根cap就删除intent/账本或写任意子文件，更不能凭D前缀启用。native manifest绑定规则/域/4+4摘要，保留owner/intent/seed/单次grant/active及只移除已验证本次active。正向文件操作只在合成域测，不能由该域产native能力或接触真实根。
- [ ] **Step 4 GREEN：** 新旧publication/profile全组与typecheck；取消/部分发布保持错误与准确自有残留，不接管已有目录、不恢复用户文件；准备成功结束并销毁当次负载使用权。
- [ ] **Step 5 Commit：** `feat(benchmark): constrain native profile publication to approved targets`。

## Task 9: NW9 独立读盘与准备启动的原生控制台确认

**Files:** 新建 `S/native-v2/console.ts`、`T/desktop-nw-console.test.ts`；扩展NW2的 `S/native-v2/authority.ts` 固定console签发路径；修改 `S/approval-v2.ts` 仅分流 native 来源，不改变旧 console.ts phase/packet/helper。

**Interfaces:** `confirmNativeOperation(request:NativeRequest,context:NativeConfirmationContext,signal:AbortSignal):Promise<Gate<NativeApproval>>` 从authority.ts导出，在其私有WeakMap登记批准，console.ts只负责固定真实控制台协议。NativeConfirmationContext字段含只读spec/规则/输出清单/预算/当前controller及prepare/start对应plan/profile，且必须由NW7私有登记，不能自报TTY或来源。NW6消费capture批准，NW8消费prepare批准，NW10消费start批准。

- [ ] **Step 1 RED：** capture专用短语以 `CAPTURE` 开头，prepare/start保持操作区分；面板必含结构页隐私、阻止writer、读取/输出预算和准确目标。无真实控制台、任一标准流重定向、错误/额外/过期输入、Ctrl+C/EOF/60秒、12289字节/控制字符拒绝；确认前原盘读取/nonce消费/profile创建=0。
  ```ts
  expect(cancelledConfirmation.calls).toMatchObject({ rawReads: 0, consume: 0, prepare: 0, start: 0 })
  expect(callbackYes.result.kind).toBe("blocked")
  expect(oversizedPanel.result.code).toBe("TASK24_DESKTOP_PANEL_UNSAFE")
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-console.test.ts ./test/linux-host/desktop-confirmation.test.ts ./test/linux-host/desktop-interactive-command.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 新版packet/固定helper，挑战绑定域、controller/request/panel摘要、phase、nonce、到期；C系统可执行文件仅精确只读例外。prepare/start缺规则不提示；capture可以独立诊断但须已证读取器与真实读取授权。不分配/伪造TTY、不回调代批、不代输；确认前后再验证SID/安装/父链/文档/当前事实，single-use登记先于await。
- [ ] **Step 4 GREEN：** 可测试helper真实标准流判定和纯输入/packet，不在回归中人工代输成功短语；正向业务确认用合成域，不能登记native-console。失败后不自动请求下一阶段或重放同一能力。
- [ ] **Step 5 Commit：** `feat(benchmark): separate native capture prepare and start confirmations`。

## Task 10: NW10 已归属原生启停与设置生命周期

**Files:** 新建 `S/native-v2/platform.ts`、`T/desktop-nw-lifecycle.test.ts`、自有进程/pipe helper `T/desktop-nw-lifecycle-worker.ts`；修改 `S/platform.ts`、`S/launch-v2.ts`、`S/settings-runtime.ts`、`S/settings-lease.ts` 的明确native分流，不改workflow或旧fixture算法。

**Interfaces:** `makeNativeV2Platform(): DesktopPlatform`，由固定工厂标记native来源，无可注入transport；`isNativeV2Platform(platform:DesktopPlatform):boolean` 与 `isNativeSession(value:unknown):boolean` 仅查询私有登记供旧门面分流，没有注册setter。`startNativeReadonly(profile:NativeProfile,approval:NativeApproval,permit:NativeWorkloadPermit,signal:AbortSignal):Promise<Gate<NativeSession>>`；`stopNativeOwned(session:NativeSession):Promise<Gate<"stopped">>`。用当前plan/request/进程内登记绑定；NativeSession字段形状不承担可反序列化权限。观察由本模块内部按该登记查真实state，不能将对象cast成fixture session后调用旧WeakMap。

另生产 `withNativeRuntimeObservation<T>(session:NativeSession,signal:AbortSignal,use:(view:NativeRuntimeView)=>Promise<T>):Promise<T>` 及 `requireNativeRuntimeView(view:NativeRuntimeView):void`；NativeRuntimeView是本任务私有登记、限该次callback的观察上下文，含 `spec/profile/intentSha256/policySha256/runtimeSealSha256/sequence/semantics`，语义字段沿用已验证v2设置快照但不假冒旧seal能力。函数持有三文件同组租约及当前native session检查，覆盖use和前后再核查；返回即失效，守卫拒绝克隆/跨租约/过期对象。NW11据此读当前事实，不通过公开register或强制cast共享fixture权限。

- [ ] **Step 1 RED：** 缺可靠交接/stop规则绝不spawn；自有进程测试精确创建时间/PID复用/SID/映像/pipe server/父子链/换连接/外来service；实际归属晚返回/取消、设置损坏且许可过期仍按已消费能力收尾，不能为收尾先恢复设置。
  ```ts
  expect(unprovedLifecycle.calls.start).toBe(0)
  expect(damagedSettings.calls.stopOwned).toBe(1)
  expect(damagedSettings.result.failureCode).not.toBeNull()
  expect(foreignPipe.calls.stopOwned).toBe(0)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-lifecycle.test.ts ./test/linux-host/desktop-v2-review.test.ts ./test/linux-host/desktop-settings-runtime.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 只采用NW1准确launcher/argv/env/交接/stop规则，全部过程在实际已归属链；准备/starting/observed/stopping/stopped/stale与三文件租约/raw seal遵守SW合同。默认拒绝保留在缺任何原生规则的路径，而非删除throw后试跑。start等待120秒、200ms轮询、stop30秒；已开始效果的资源保护和join不因调用者停止等待提前结束，不延长使用许可。
- [ ] **Step 4 GREEN：** 自有helper退出/保护/真实pipe身份断言与旧整组通过；停止必须验证backend/engine/WSL全收尾，不以HTTP成功替代，未知归属cleanup_uncertain，不名杀/全局shutdown/停既有service。禁止已安装目标和原盘进入测试。
- [ ] **Step 5 Commit：** `feat(benchmark): execute only owned verified native v2 lifecycles`。

## Task 11: NW11 只读观察与不可恢复历史发布

**Files:** 新建 `S/native-v2/inspection.ts`、`T/desktop-nw-inspection.test.ts`；修改 `S/inspection-v2.ts`、`S/inventory-v2.ts` 的native来源分流，不扩大通用Docker只读白名单。

**Interfaces:** `inspectNativeSession(session:NativeSession,signal:AbortSignal):Promise<DesktopLaunchInventory>`；`publishNativeDiagnostic(approval:NativeApproval,diagnostic:OfflineDiagnostic,signal:AbortSignal):Promise<FileIdentity>`；`publishNativeInventory(session:NativeSession,record:DesktopLaunchRecord,signal:AbortSignal):Promise<FileIdentity>`；报告读取函数只返回 `{historical_not_live:true, ...data}`，不签发cap。

`decodeNativeStorageObservation(raw:unknown,view:NativeRuntimeView):StorageProof` 仅在NW10的withNativeRuntimeObservation内使用，先验证当前view私有来源/租约，再作原v2实际盘/UUID/daemon/swap与摘要检查。复用纯数据校验可作最小抽取，但旧decoder的session/seal守卫和返回语义不变，不把native view传给fixture WeakMap。

- [ ] **Step 1 RED：** 只允许固定version/info/context和获批当前实例的盘/UUID/daemon/swap观察；settings租约/活动盘/UUID/daemon/default任错不成功。guest退出竞态不允许由 `wsl -d` 自动重启；原输出敏感哨兵不落报告。报告已有目标/父链交换/权限错误/262145字节拒绝，记录克隆不恢复停止权。
  ```ts
  expect(stoppedGuest.calls.autoStart).toBe(0)
  expect(inventory.engine_verified).toBe(false)
  expect(inventory.tool_capability_verified).toBe(false)
  expect(inventory.corpus_engine_ready).toBe(false)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-inspection.test.ts ./test/linux-host/desktop-v2-storage.test.ts ./test/linux-host/desktop-inventory.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 每次用途受当前session、同组设置租约和前后身份保护；native观察digest绑定intent/policy/runtime seal/manifest/实际观察，不能用seed。固定CLI二进制和无注入env，不允许任意插件；guest探针须非自动启动且绑定本次VM，否则blocked。取证报告固定 `reports/desktop-workload/<evidenceID>/evidence.json`；inventory仍 `reports/desktop-launch/<launchID>/inventory.json`，准确cap排他发布，diagnostic只用capture批准不冒充已消费start grant。
- [ ] **Step 4 GREEN：** 本组、NW5/NW8及typecheck；发布失败仍执行已归属finally，保留原失败；历史读取永远not_live，不签发EngineSession/Linux receipt。非运行阶段不访问daemon。
- [ ] **Step 5 Commit：** `feat(benchmark): publish bounded native observations without restoring authority`。

## Task 12: NW12 CLI 域分流与阶段顺序

**Files:** 新建 `S/native-v2/command.ts`、`T/desktop-nw-command.test.ts`；修改 `S/command.ts`、`S/command-v2.ts`、`packages/benchmark/script/desktop-launch.ts` 仅必要分流。保留旧参数集合的行为；新capture只在明确native域支持。

**Interfaces:** `makeNativeDesktopController(): (argv:readonly string[],signal?:AbortSignal)=>Promise<{exitCode:0|1|2;output:unknown}>`，每个controller有独立session map和controllerID；新增 `capture-workload --spec <准确D输入> --evidence-id <严格ID> --interactive`。capture不使用prepare/start approval文件，固定broker生成当前读取请求和独立新nonce；prepare/start仍使用各自spec/approval/control布局，在同一controller内先单独取得当前读盘许可/事实，再各自业务确认。inspect/stop只认该controller live session；不提供证据JSON导入。

- [ ] **Step 1 RED：** 重复/未知flag、错误域、无interactive、fixture回调、stale报告、错阶段、过期/重放/等待中漂移拒绝；audit/plan原盘读取=0，capture后start=0，prepare后start=0，start必须重新capture。input取消不创建profile或消费start许可；保存历史不使下一进程能stop。
  ```ts
  expect(captureOnly.calls.start).toBe(0)
  expect(prepareOnly.calls.start).toBe(0)
  expect(reloadedHistory.output.code).toBe("session_not_live")
  expect(auditOnly.calls.rawReads).toBe(0)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-command.test.ts ./test/linux-host/desktop-v2-command.test.ts ./test/linux-host/desktop-command.test.ts --timeout 30000`。
- [ ] **Step 3 实现：** 先严格输入/域分流及最低规则检查，缺证据不进入业务确认；capture阶段60秒确认→独立120秒受保护采集，退出/错误完整释放。prepare/start若读取范围未另获批准，不用业务短语代授权；45秒兼容审计只再验证同一私有上下文，业务确认前后再核查后才单次消费。取证完成后的只读保护横跨确认及可信交接，其保持时间必须在实际授权面板另列，不将“读取器120秒”说成锁总共只保持120秒；既有各阶段时限不增加，未完成实效仅按既定join/收尾规则保持必要保护。CLI不增加force/accept-risk/learn/导入proof选项，不打印带未知argv的START示例。
- [ ] **Step 4 GREEN：** 新旧CLI整组及typecheck，校验完整输出树/账本与calls；退出码1为错误输入，2为缺项/取消/历史/观察非验收，0只用于完成本次获准capture或准备/已归属停止，不把0当readiness。捕获取证报告明确historical_not_live。
- [ ] **Step 5 Commit：** `feat(benchmark): sequence native capture and launch admissions in CLI`。

## Task 13: NW13 整段无 Docker 验证与诚实交付

**Files:** 新建 `T/desktop-nw-e2e.test.ts`；完成最终验证报告，只有必要时补本次test helper。scoped tsconfig/日志只在本次临时根，不留产品目录中间物。

**Interfaces:** 只消费NW1–12接口，不新增native旁路；正向纯逻辑/文件/自有helper生命周期均标合成，原生完整性缺失仍为native_blocked。

- [ ] **Step 1 RED：** 全链合成读取→空分类→报告not_live、三阶段独立确认、准备→合法设置替换→完整观察→退出，及损坏/取消/父链竞争/报告失败/控制器崩溃的拒绝收尾；安装Docker/WSL/模型/API/原盘内容调用计数全为0。测试必须揭露缺finally、旧证据复用、释放保护过早三类故障，不能仅内存假模型全绿。
  ```ts
  expect(e2e.calls).toMatchObject({ installedDocker: 0, installedWsl: 0, modelApi: 0, originalDiskReads: 0 })
  expect(e2e.history.historical_not_live).toBe(true)
  expect(e2e.reloadedStop.output.code).toBe("session_not_live")
  expect(e2e.originalFailurePreserved).toBe(true)
  ```
- [ ] **Step 2 RED run：** `& $NativeBun --no-env-file test ./test/linux-host/desktop-nw-e2e.test.ts --timeout 30000`；记录能复现实际接缝缺口的失败，再只修所属任务代码，保留scope。
- [ ] **Step 3 GREEN：** 在隔离环境及包目录依次运行以下命令，记录真实通过/失败/skip、断言、退出码、时长，不使用历史结果：
  ```powershell
  & $NativeBun --no-env-file test ./test/linux-host --timeout 30000 --only-failures
  & $NativeBun --no-env-file test --timeout 30000 --only-failures
  & $NativeBun --no-env-file run typecheck
  & $NativeBun --no-env-file run typecheck --project "$NativeTemp\tsconfig.native-v2.json"
  ```
  scoped config extends 包tsconfig，纳入绝对 `src/**/*.ts`、`test/linux-host/**/*.ts` 与 desktop-launch/linux-host/accept-linux-host三脚本及新增helper；types/typeRoots显式包含本地Bun/Node类型。不靠漏收、加skip、放宽旧时限/断言或改业务算法消除失败。只对本次文件作本地Prettier与git diff检查。
- [ ] **Step 4 审查及证据闭合：** 对完整实施范围按适用执行技能审查；将下表映射到实际测试名与结果。报告分别列软件、reader/布局/交接、原生兼容、真实读盘、准备、启动、Linux验收、付费、部署状态。任一条件任务未执行或native规则仍缺均明确未完成，不把合成成功写成真实启停可用。
- [ ] **Step 5 Commit与交付：** `test(benchmark): verify native v2 evidence and authority boundaries`，仅stage本次文件。push须该次明确授权并保留hooks；不含读盘/准备/启动。部署与旧C不动；旧报告dirty仍明确记阻断。完整交付验证后仅清理本轮准确owner/父链/无链接且归属明确的临时物，不动旧残留/正式产物；政策拒绝不换工具绕过，列残留。

## 规格覆盖与审阅门槛

| 规格部分               | 任务与必须交付的验证                                                       |
| ---------------------- | -------------------------------------------------------------------------- |
| 一/二 目标、边界、路线 | NW1停止关口、NW12拒绝顺序、NW13分层状态，不做非空/恢复/换盘后备            |
| 三 读取器及隐私        | NW1选型/pin、NW3句柄端口、NW4敏感哨兵/限制、NW5脱敏                        |
| 四 一致性/预算         | NW3双盘稳定性、NW4日志/特性/全预算与无写入                                 |
| 五 完整空证明          | NW5全部存储/namespace/容器/Swarm/Kubernetes/激活来源，不以未知判空         |
| 六 交接/能力           | NW1厂商可行性、NW6锁/permit、NW10晚到归属；无证据即停止                    |
| 七 域/接缝             | NW2严格native合同/4+4；NW7–NW12明确分流，旧回归不扩权                      |
| 八 七门槛/运行         | NW7七项逐项证据，NW9真实确认，NW10安全启停，NW11非启动观察                 |
| 九 新授权              | NW9独立capture，NW12捕获/准备/启动分别确认；依赖/真实读盘/运行均不自动执行 |
| 十 输出/顺序           | NW8精确13/5与17/8适用范围、NW11两类报告、NW12顺序                          |
| 十一/十二 交付         | NW13全量/审查/安全清理与未放行清单，用户审阅后才谈执行                     |

本计划自审重点是类型/来源、时间与预算、锁交接、历史重放、完整覆盖和真实操作授权。没有把尚缺的厂商交接、完整布局或解析器能力写成已存在的实现；这些由NW1给出可审查结论，缺证据就停。

请审阅任务分解与条件范围。**确认本计划前不实施；建议下一次只启动 NW1 的可行性与拒绝回归。** 即使后续全部软件通过，实际读盘、准备、启动各自另行确认；旧 C 盘不迁移不删除，真实验收、付费跑分与部署替换继续不做。
