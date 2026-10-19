# Task24B Settings Lifecycle and Workload Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加可独立验证的 v2 设置生命周期与旧负载拒绝门禁，允许夹具中的合法保存，不把软件验证成功变成当前原盘的启动许可。

**Architecture:** v1 解码与运行语义保留；v2 使用不可变 intent、编译期固定策略、父目录绑定的三文件短租约和进程内生命周期。旧负载门禁与设置策略完整性分别判定；当前 native 两者证据均未闭合，不能产生成功兼容报告、可执行准备确认或启动。设置使用资格与已经消费的安全收尾资格分开。

**Tech Stack:** TypeScript、Effect Schema、Bun test；复用 benchmark 的 canonical/hash、Windows 句柄发布与进程归属设施，不增加运行依赖。

**Spec:** [已批准补充规格](../specs/2026-10-19-task24b-settings-workload-boundary-design.md)。同时继承 [D 盘启动规格](../specs/2026-10-18-task24b-d-drive-docker-launch-design.md) 和 [原生确认规格](../specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md)。补充规格页首保留其成文时的授权状态；用户于本轮批准规格，**仅授权编写本计划，尚未批准实施**。

执行方式沿用既定选择：后续获准后在现有 `dev` 上由本会话串行实施，使用 executing-plans，不新建 worktree、不逐任务分派代理；最后按既定方式做整体审查。本轮只新增本文，先交用户审阅，不运行产品测试、不创建测试根、不作环境操作或 push。

## Global Constraints

- 固定 Desktop `4.79.0.230596`、CLI `29.5.3`、设置格式 `44`；native profile 根为 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479`，home basename 为 `home-oc-task24-dd479`，数据根为 `D:\Applications\DockerWSL`。
- 旧 C 盘三棵 Docker 目录不复制、迁移、删除、恢复、覆盖、改 ACL 或转为链接；不新增 C 盘配置/缓存例外。本增量不修改真实 `.wslconfig`。
- 不重装/升级、改服务/全局环境/PATH/WSL 注册、导入/注销、挂载/复制/读取旧 VHD 内容、停止 Ubuntu 或全局 shutdown WSL；不读取秘密、`.env.local`、credential、账号或许可，不自动提权/下载/同意许可。
- 不操作容器/镜像/卷，不拉取/构建/prune；也不允许旧负载自动恢复。模型发现、付费跑分、真实 Linux 验收、现有部署/dist/seal/receipt 替换均不在本计划执行范围。
- 不改旧视觉流程、workflow 租约/重试/预算、生产 `packages/server/src/workflow/docker-config.ts`、default/endpoint/daemon 合同、题目/分组/评分/试跑次数。设置短租约不是 workflow 租约。
- native `platform.start/stop` 的 `TASK24_DESKTOP_NATIVE_RULES_UNPROVED` 拒绝及 native START 面板封闭保留。`settings_mutation_unproved` 与 `existing_workload_restart_unproved` 不因 fixture 成功而消失；其他原生缺项逐项保留。
- 不提供 native 策略学习、普通 JSON 证明导入、通用 transport/回调、assurance 布尔值或环境 flag 放行。当前没有获准的旧负载 native 采集器，本计划不实现它。
- 保护不可变文件、全部 13 个 profile 目录及祖先；fileID 无法精确表示仍拒绝。用户追加授权：仅 v2 和本轮测试设施使用 bigint 精确身份适配（SW0），不改变 v1 身份算法。v1 档案不升级、不覆盖、不接管已有根。
- intent 上限 `16384` 字节；运行文件各 `1048576`，三文件合计 `3145728`；JSON 容器深度上限 `32`；临时文件最多同时 `3` 个、各 `1048576`，最终与临时合计 `6291456`。这些是接纳上限，不是硬配额或完整启动写入预算。
- 每次采样最多 `3` 轮，不重置原启动 `120000ms`、轮询 `200ms`、收尾 `30000ms`；确认面板 `12288` 字节、确认等待 `60000ms`、请求有效期最长 `900000ms`、nonce 单次消费不扩大。
- 保留已有断言、skip、时限与外来修改。成文基线 `dev / ec7fd6d8b71112e517b08bee9d57cc365be6fc36`，保留未跟踪的 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md`，不通过 ignore、隐藏或删除报告取得 clean 绑定。
- 实施批准、实际准备批准、实际启动与本次已归属收尾批准是不同阶段。即使以下软件任务全部通过，真实准备和启动仍要新清单、独立批准和本地确认；证据不足继续阻断。

## Review Focus

1. 转义后的重复键及大小写别名：`AutoStart` 与 `\u0041utoStart` 或 `autostart` 不能利用解析器最后键覆盖绕过检查——SW2。
2. 第二/第三个文件取得失败、取消或 callback 抛错：释放所有已取租约，不能复用上次局部快照；窗口关闭后合法 Rename 也不能被悄悄吸收——SW4、SW6。
3. start 许可在设置损坏期间到期：阻断使用但保留本次已消费 stop-owned；不能要求恢复设置才能收尾，停止成功也不能抹去原失败——SW6。
4. seal/hash 看似相同但 session、阶段、序号或实际存储链不同：旧 seed、跨 session 对象、磁盘诊断都不能签发当前观察——SW7。
5. VHD 的 fileID/size/mtime 相同，或用户确认了风险：仍不能证明盘内状态完整且新鲜；native 在提示/创建/grant/start 前失败，副作用为零——SW3、SW8、SW9。

---

## 文件分工和接口约定

以下路径相对 `D:\OpenCode-Audit`。只在明确版本边界扩展旧文件，不重构无关代码。新增模块均位于 `packages/benchmark/src/sandbox/desktop/`：

| 文件                                                                                              | 职责                                                        | 任务          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------- |
| `v2-contracts.ts`（新增）                                                                         | v2 schema、版本联合、不可变 intent、manifest 和内部只读类型 | SW1           |
| `bindings.ts`（修改）                                                                             | 独立 v2 固定 3/3 文档成员与实际字节摘要；保留 v1 2/2        | SW1           |
| `settings-json.ts`、`settings-policy.ts`（新增）                                                  | 重复键可见的有界 JSON 解析、固定策略目录、严格字段/临时规则 | SW2           |
| `workload-boundary.ts`（新增）                                                                    | native 永远缺证据的门禁、仅 D 夹具的完整性/新鲜性检验       | SW3           |
| `settings-lease.ts`（新增）、`publication.ts`（修改）                                             | 相对父句柄三文件同组短租约、临时清单、v2 13 目录发布        | SW4           |
| `profile-v2.ts`（新增）；`contracts.ts`、`compatibility.ts`、`planning.ts`、`approval.ts`（修改） | 明确版本分流、v2 计划/授权/准备；旧 v1 分支不改语义         | SW1、SW3、SW5 |
| `settings-runtime.ts`（新增）、`launch.ts`（修改）                                                | 私有 session 绑定的阶段、seal 和独立收尾资格                | SW6           |
| `inspection.ts`、`inventory.ts`（修改）                                                           | v2 稳定观察与不可恢复历史诊断；保留 v1 与公开存储合同       | SW7           |
| `command.ts`、`native-audit.ts`、`platform.ts`（修改）                                            | CLI 版本分流、失败优先顺序和原生拒绝；不实现启停            | SW3、SW8      |

新增测试统一在 `packages/benchmark/test/linux-host/`：`desktop-v2-contracts.test.ts`、`desktop-settings-policy.test.ts`、`desktop-workload-boundary.test.ts`、`desktop-settings-lease.test.ts`、`desktop-v2-profile.test.ts`、`desktop-settings-runtime.test.ts`、`desktop-v2-storage.test.ts`、`desktop-v2-command.test.ts`、`desktop-v2-e2e.test.ts`；共用合成夹具为 `desktop-v2-fixture.ts`。按任务只扩充夹具所需能力；不在测试中复制被测校验逻辑。

类型决策：原 `DesktopLaunchSpec/Plan/PreparedProfile/Approval` 仍表示 v1。新增对应 `...V2`；仅分流入口使用 `DesktopSpecVersioned`、`DesktopPlanVersioned`、`DesktopProfileVersioned`、`DesktopApprovalVersioned` 联合。`DesktopLaunchSession` 仍是原不透明进程内对象，`StorageProof/HostRequest` 不变。`DesktopPlatform` 的 spec/plan 参数扩为上述联合，原 v1 实现分支先窄化；不将 v2 强转为 v1，不删版本字段以通过旧校验。

`Gate<T>`、`FileIdentity`、`DesktopProcessIdentity` 沿用现有定义。新增不透明 `DesktopSettingsPolicy`、`DesktopWorkloadFact`、`DesktopSettingsSeal` 都由模块私有 WeakMap 赋予来源；公开只读摘要/同形对象不是能力。fixture 来源必须由既有 owner 根、合成安装/盘身份和非 native 平台共同约束，不能靠 `assurance: "fixture"` 自报。

## 执行前约定（只在计划获准后准备）

用户已批准实施与验证后push，并单独批准 SW0：新增 `identity-v2.ts`、`desktop-v2-identity.test.ts`，身份字符串为 `v2:dev:ino:birthtimeNs`，从 bigint stat 全程保留精度；回归覆盖大整数相邻编号、D盘物理父链、硬链接和C目标拒绝。旧 `storage.ts`、v1 helper/probe 编号语义不变。所有native缺证据/操作授权边界仍有效。

未来每任务先 RED、再最小实现、再 GREEN 和包内 typecheck，最后仅提交本任务文件。新测试根必须是 `D:\OpenCode-Benchmark\Task24\tmp\bprep1-settings-workload-<本次新nonce>`，依原协议写 owner：`nonce=bprep2-0786b1f11abc`，`runOwner` 为本次 8–128 位小写字母/数字/连字符标识。先验证祖先/owner/精确 fileID；失败就阻断，不能放宽精度或反复建目录碰运气。不得复用此前被拒绝清理的目录。

将 HOME/USERPROFILE/XDG/APPDATA/LOCALAPPDATA/TEMP/TMP/TMPDIR、Bun/npm/Go 缓存全部定向到本次 owner 根；`NODE_DISABLE_COMPILE_CACHE=1`、`PSModuleAnalysisCachePath=NUL`、`OPENCODE_DISABLE_MODELS_FETCH=true`。测试启动器按环境变量**名称**剔除 provider/API key/token/secret、模型发现、integration、TASK24 外部控制、WSL/Electron、NODE_OPTIONS 和 Git trace 输入，不读值、不载入 dotenv、不下载依赖。沿用现有可信运行器；如需本次 wrapper/scoped tsconfig，仅用 apply_patch 写入 owner 根，不留作交付。

下文 `$SettingsBun` 为 `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`，使用前核对 SHA256 为 `0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`。测试命令工作目录一律为 `D:\OpenCode-Audit\packages\benchmark`，不是仓库根；`$SettingsTemp` 为上述新根。每个 GREEN 同时执行 `& $SettingsBun --no-env-file run typecheck`，预期退出 0。新增计时验证使用可控屏障/本地合成进程，不靠加长旧时限或等待真实 Docker。

## Task 1: SW1：独立 v2 数据合同、意图与文档绑定

**Files:** 新增 `v2-contracts.ts`；修改 `contracts.ts`、`bindings.ts`、`platform.ts`；新增 `desktop-v2-contracts.test.ts`，保留 `desktop-bindings.test.ts` 全部旧断言。

**Interfaces:**

- 产出 `DesktopLaunchSpecV2`（原固定安装字段、`schemaVersion: 2`），`decodeDesktopSpecV2(raw: unknown): DesktopLaunchSpecV2`。版本未知/多余字段拒绝；联合只用于显式分流，不改变旧 `decodeDesktopLaunchSpec`。
- 产出 `DesktopIntentV2`：`schemaVersion: 2`、`policyID: string`、`policySha256: string`、`expected` 五值。`decodeDesktopIntentV2(text: string, expected: { dataRoot: string; policyID: string; policySha256: string }): DesktopIntentV2`；native dataRoot 固定，纯数据解码不签发能力。SW2 接入重复键扫描。
- `DesktopLaunchPlanV2` 明确含 `spec`、assurance、原 paths/env/endpoint、spec/compatibility/plan 摘要、intent/intentSha256、policyID/policySha256、seedSha256、准确 runtimeTargets、phases、limits；**不含把 seed 冒充 live 的 settingsSha256**。prepared V2 分开 immutableFiles、seed、runtimeTargets、全部 directories 和外部 manifestSha256。approval V2 与原两阶段字段同义但版本为 2，并绑定 v2 plan/manifest。
- 产出 `desktopDocumentDigestV2(kind: "specs" | "plans", entries: readonly {path: string; sha256: string}[]): string` 和 `readDesktopBindingsV2(repoRoot: string, signal?: AbortSignal): Promise<{sourceSha256: string; specSha256: string; planSha256: string}>`。v1 的两个原函数不改成员/语义。

- [ ] **写 RED 测试。** 固定 v2 specs 为原两份规格加本补充规格；plans 为原两份计划加本文。测试从自有 Git 夹具读取真实文件字节，校验顺序无关、准确成员、缺项/重项/同数量替换/路径别名/占位 hash 拒绝、dirty/链接/读取漂移失败；纯意图测试如下（`policyHash` 为夹具编译目录真实摘要，不是 native 证据）：

  ```ts
  test("v2 intent binds five typed values and a concrete policy", () => {
    const expected = {
      dataRoot: "D:\\Applications\\DockerWSL",
      policyID: "fixture-settings-v2",
      policySha256: policyHash,
    }
    const text = canonicalJson({
      schemaVersion: 2,
      policyID: expected.policyID,
      policySha256: policyHash,
      expected: {
        SettingsVersion: 44,
        CustomWslDistroDir: expected.dataRoot,
        WslEngineEnabled: true,
        UseWindowsContainers: false,
        AutoStart: false,
      },
    })
    expect(decodeDesktopIntentV2(text, expected).expected.AutoStart).toBe(false)
    expect(() => decodeDesktopIntentV2(text.replace('"AutoStart":false', '"AutoStart":"false"'), expected)).toThrow()
    expect(() => decodeDesktopIntentV2(text.replace('"schemaVersion":2', '"schemaVersion":3'), expected)).toThrow()
  })
  ```

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-v2-contracts.test.ts ./test/linux-host/desktop-bindings.test.ts --timeout 30000`；预期新增接口/3 成员校验缺失导致失败，不是环境夹具失败。
- [ ] **最小实现。** 新建上述 v2 Schema/只读类型和固定 3/3 registry；digest 验证准确成员后按相对路径排序，对实际 byte SHA 的 canonical 清单取 hash。复用原稳定读取/clean tree 检查；缺本文时 v2 拒绝，不填预设摘要。扩大平台参数类型时，native audit/observe 先对 v2 明确拒绝，不把联合直接传给旧 v1 query/collector；SW3 再接 v2 缺证据诊断，任何中间提交都可独立 typecheck。既有未跟踪报告使真实源码绑定仍 blocked，不隐藏它。
- [ ] **GREEN。** 重跑本任务命令与包内 typecheck，预期全部通过；v1 原两项集合测试仍原样通过。
- [ ] **提交。** 仅添加本任务明确文件与获准实施的本文，提交 `feat(benchmark): define versioned desktop settings contracts`；不纳入已有报告、不 push。

## Task 2: SW2：严格 JSON 与固定设置目录

**Files:** 新增 `settings-json.ts`、`settings-policy.ts`、`desktop-settings-policy.test.ts`；补强 SW1 的 intent 解码，不改变旧 v1 JSON 语义。

**Interfaces:**

- `parseDesktopSettingsJson(bytes: Uint8Array, maxBytes: number): unknown`：fatal UTF-8、完整 JSON token 校验、解码后对象键重复/大小写冲突拒绝、容器根深度为 1，超过 32 拒绝；拒绝无效尾随输入，之后才交 Schema 解码。调用点固定 intent/runtime 上限，不能由用户传 maxBytes。
- `selectDesktopSettingsPolicy(spec: DesktopSpecVersioned, platform: DesktopPlatform): Gate<DesktopSettingsPolicy>`：native 当前返回 `settings_mutation_unproved`，不建立可调用的正向 native 工厂。夹具使用编译固定目录并核实 D owner/安装范围；不接受外部目录路径或 JSON policy。
- `validateDesktopSettingsSet(input: {policy: DesktopSettingsPolicy; intent: DesktopIntentV2; files: readonly DesktopSettingsBytes[]; temporary: readonly DesktopSettingsBytes[]; phase: "starting" | "observed" | "stopping"}): DesktopSettingsSemantics`。`DesktopSettingsBytes={target: "settings-store" | "daemon" | "windows-daemon"; relative: string; bytes: Uint8Array; identity: FileIdentity}`；`DesktopSettingsSemantics={files: readonly {target: DesktopSettingsBytes["target"]; identity: FileIdentity; rawSha256: string; semanticSha256: string}[]; crossFileSha256: string}`，恰好三个不同目标，无 live 权限。这些只读类型在本任务定义，不是调用方提供的通过结论。

- [ ] **写 RED 测试。** 夹具编译目录完整列出五值；合成 `FixtureEpoch` 为 1–9 整数并要求三文件相同，daemon 两文件另有 `features.fixture=false`。临时名闭合为各目标 basename 后追加 `.fixture-01.tmp`、`.fixture-02.tmp`、`.fixture-03.tmp` 的九个准确名字；最多同时三个。**这些全是合成规则，不推断 native 规则**。

  ```ts
  test("escaped duplicates cannot enable AutoStart", () => {
    for (const text of ['{"AutoStart":false,"\\u0041utoStart":true}', '{"AutoStart":false,"autostart":true}'])
      expect(() => parseDesktopSettingsJson(new TextEncoder().encode(text), 16384)).toThrow()
    expect(() => parseDesktopSettingsJson(new Uint8Array(16385), 16384)).toThrow()
  })
  ```

  同模块精确测：32/33 深度；已登记缩进+LF 语义一致但 raw 不同；三个文件均完整校验；缺五值、null/类型错、未知顶层/嵌套键、C 路径、相似 D 路径/别名、不同 Epoch、BOM/无效 UTF-8/尾随数据失败；单文件 1048576/1048577、三文件 3145728/3145729、临时数量 3/4、最终加临时 6291456/6291457 的边界。使用空白填充有效 JSON 测大小，不靠非法内容提前失败。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-settings-policy.test.ts ./test/linux-host/desktop-v2-contracts.test.ts --timeout 30000`；预期缺少重复键/目录校验而失败。
- [ ] **最小实现。** 先做有界 token/键/深度扫描再解码，不能 regex 扫键后直接信任 JSON.parse 的覆盖结果。目录固定字段出处、范围、阶段、可变性、安全影响、路径映射、安装5文件/hash、版本与临时规则，canonical 摘要进入 policy。native 未证明字段/临时规则保持明确 missing，不以空策略/通配符补齐；不新增 `settings-policy.json`。路径映射核对批准目标身份，不只比较 D 前缀。
- [ ] **GREEN。** 重跑本任务测试、SW1 与包内 typecheck；预期全部通过，native 策略仍 blocked。
- [ ] **提交。** 明确添加本任务文件，提交 `feat(benchmark): validate bounded desktop settings policies`。

## Task 3: SW3：启动前旧工作负载拒绝门禁

**Files:** 新增 `workload-boundary.ts`、`desktop-workload-boundary.test.ts` 和初版 `desktop-v2-fixture.ts`；修改 `compatibility.ts`、`native-audit.ts`、`platform.ts` 的版本分流/缺项拼接，不新增系统查询。

**Interfaces:**

- `auditDesktopWorkloadBoundary(spec: DesktopSpecVersioned, platform: DesktopPlatform, signal?: AbortSignal): Promise<Gate<DesktopWorkloadFact>>`；native 固定返回 `existing_workload_restart_unproved`，不查询旧盘/容器，也不导入外部证明。
- `requireDesktopWorkloadFact(fact: DesktopWorkloadFact, spec: DesktopSpecVersioned, platform: DesktopPlatform): Promise<void>`：只核实当前私有来源、准确身份、完整范围与受保护状态。`withDesktopWorkloadFact<T>(fact: DesktopWorkloadFact, spec: DesktopSpecVersioned, platform: DesktopPlatform, use: () => Promise<T>): Promise<T>` 在实际消费及启动调用区间保持合成状态稳定，不以一次检查取代持续保护。native 两接口都没有正向来源。fixture 的合成观察显式覆盖 `containers`、`swarm`、`kubernetes`，缺任何范围即拒绝；fact 不能由反序列化恢复。
- v2 `auditDesktopCompatibility` 版本分流产生现有 `Gate<DesktopCompatibilityReport>`，报告 WeakMap 内附带同次 policy/workload 来源。v1 native 同样受新拒绝边界约束，v1 fixture 保持原合同；不存在选 v1 的 native 旁路。
- 夹具 `desktopV2Fixture()` 复用既有 desktop owner/root 协议，返回 v2 spec、合成平台、`calls`（`start/stop/execute/confirm/prepare` 计数）、`close()`；负载事实只来自该 owner 下合成状态，不能登记到 native WeakSet。专用合成 data VHD 普通文件以 fixture 格式存 `{schemaVersion:1,fixtureKind:"task24-workload-state",scopes:{containers:[],swarm:[],kubernetes:[]}}`，只有已验证 owner 下的非 native 分支才读它；任何scope缺失或非空拒绝。最终消费用句柄读锁保护该合成内容并复核摘要，不用size/mtime代替；不在 `DesktopObservation` 夹带可自报的安全字段，也不读取真实旧VHD。

- [ ] **写 RED 测试。** 独立表驱动缺证据、缺容器/Swarm/K8s 任一范围、不同盘/安装、陈旧内容状态、克隆 fact、普通 JSON/布尔值/`acceptedRisk`、fixture→native 混用均拒绝；相同 fileID/size/mtime 下改合成盘内容不能复用旧 fact。native 无采集器时无条件 blocked，不实际扫描真实平台。

  ```ts
  test("same disk metadata and human acceptance are not workload proof", async () => {
    const result = await auditDesktopWorkloadBoundary(nativeSpec, nativePlatform)
    expect(result).toMatchObject({
      kind: "blocked",
      missing: expect.arrayContaining(["existing_workload_restart_unproved"]),
    })
    expect(() => decodeDesktopSpecV2({ ...nativeSpec, acceptedRisk: true })).toThrow()
  })
  ```

  `nativeSpec/nativePlatform` 使用现有无系统调用拒绝测试的固定构造；此函数必须在任何 query/spawn 前判定。future-native 正向证明格式不在本任务实现。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-workload-boundary.test.ts ./test/linux-host/desktop-compatibility.test.ts ./test/linux-host/desktop-native-audit.test.ts --timeout 30000`；预期新 gate/来源绑定缺失失败。
- [ ] **最小实现。** 在成功兼容报告签发前执行两项新 gate，保留其他 missing；native 分支先执行无需系统查询的缺证据判断，在任何 `platform.audit/observe` 或 query/spawn 之前返回 blocked，不能为了报告先试探旧盘或启动。`native-audit.ts` 保留既有只读审计能力但本计划测试不调用它；v2静态诊断明确两项缺证据，并保留其余已知missing，不能伪造proved。`requireDesktopReport` 和纯元数据 `revalidateDesktopSpec` 只扩展版本类型，身份校验不放宽；不改旧 native query 的解码合同。fixture 完整状态验证使用私有来源和内容稳定性保护，不把“有 hash”当安全结论。真实 prepare/start 的重复门禁分别由 SW5/SW8 接入。
- [ ] **GREEN。** 重跑本任务与包内 typecheck，旧 native start/stop 拒绝测试通过；不执行已安装 CLI、WSL 或审计命令。
- [ ] **提交。** 提交 `feat(benchmark): fail closed on existing workload restart risk`，仅本任务明确文件。

## Task 4: SW4：父目录绑定的三文件同组短租约

**Files:** 新增 `settings-lease.ts`、`desktop-settings-lease.test.ts`；修改 `publication.ts` 的 v2 专属 helper 协议；扩充 `desktop-v2-fixture.ts` 的普通文件/自有进程屏障。不改变原 publication/read/record/console 分支。

**Interfaces:**

- `withDesktopSettingsParents<T>(profile: DesktopPreparedProfileV2, use: (parents: DesktopSettingsParents, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T>`：不透明 parents 绑定所有既有祖先/13目录，在整个可变窗口保持；无任意 path 参数、无磁盘恢复。
- `withDesktopSettingsLease<T>(parents: DesktopSettingsParents, use: (lease: DesktopSettingsLease) => Promise<T>, signal: AbortSignal): Promise<T>`：固定三目标及编译目录允许的临时名，全部成功后 callback 恰好一次；lease 内含只读 files/temporary 快照与私有有效期，不能逃逸后使用。采样重试由 SW6 管理，此层一次尝试，不自行延长 deadline。
- `publication.ts` 增加固定 `profile-v2` layout：只多建 `.docker`，不接收自定义目录数组。settings helper 仅提供 bound-parent 打开、同组 acquire/read/recheck/release；不提供通用路径写入/删除接口。

- [ ] **写 RED 测试。** 在自有 D 文件上用真实 Windows 句柄 helper 验证：三目标取得后 callback 中写/删除/Rename 被拒绝；callback 完成后可在窗口内替换；第二/第三个 acquire 失败、取消、异常会释放前面全部句柄且 callback=0。可变窗口仅固定目录，不长期固定目标禁止 Docker Rename。父目录/祖先交换、符号链接/junction/硬链接、不同 volume、未知临时名及精度不准确均拒绝。

  ```ts
  test("partial acquisition cannot splice snapshots and releases held files", async () => {
    // f.holdTarget("daemon") 是 owner 根内的合成锁，不接触安装文件。
    const held = await f.holdTarget("daemon")
    try {
      await expect(f.acquireSettings()).rejects.toThrow()
    } finally {
      await held.release()
    }
    expect(f.calls.settingsUse).toBe(0)
    await expect(f.replaceTarget("settings-store")).resolves.toBeUndefined()
  })
  ```

  本任务夹具方法契约：`holdTarget(target): Promise<{release():Promise<void>}>`、`acquireSettings():Promise<void>`、`replaceTarget(target):Promise<void>`；target 使用 SW2 联合，方法内部调用真实接口，不复制验证逻辑。完整 lease 取得后重读三者、跨文件 Epoch 不一致则失败，不拼接上一轮文件。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-settings-lease.test.ts ./test/linux-host/desktop-publication.test.ts --timeout 30000`；预期新 layout/同组能力缺失失败。
- [ ] **最小实现。** 在现有 helper 中增加固定 v2 操作，用 `NtCreateFile` 相对受保护父句柄打开普通单链接目标；租约期间拒绝 write/delete 共享，读与身份核验都来自所持句柄。三文件及必要临时清单稳定后才允许 use；失败以 finally 释放整个组。父链在窗口期间固定；helper 进程退出自动释放，不能路径 fallback。逐目标仅关文件句柄不关父链。v2 settings 父链 helper 的存活受 SW6 当前私有生命周期 signal/绝对期限约束，不误套现有 publication 的固定30秒计时，也不改旧 helper 的30秒/console计时；不得由外部传时间延长窗口。
- [ ] **GREEN。** 重跑本任务、旧 publication/console/profile 测试与 typecheck；证明旧 v1 布局仍 12 目录、旧 record 仍只写 inventory。若系统不支持或新根 fileID 不精确，报告环境阻断，不改测试为 skip 或弱校验。
- [ ] **提交。** 提交 `feat(benchmark): acquire coherent desktop settings leases`。

## Task 5: SW5：v2 计划、授权与不可变准备档案

**Files:** 新增 `profile-v2.ts`、`desktop-v2-profile.test.ts`；修改 `planning.ts`、`approval.ts`、`compatibility.ts` 的显式 v2 分支；扩充夹具。原 `profile.ts` v1 字节/fileID 行为原样保留。

**Interfaces:**

- `planDesktopProfileV2(spec: DesktopLaunchSpecV2, report: DesktopCompatibilityReport): Gate<DesktopLaunchPlanV2>`；只消费 SW3 私有 report 中同次平台/policy/workload，不从调用方另收可伪造证明。`requireDesktopPlanV2(plan, platform?): DesktopPlatform` 保留对象来源检查。
- `checkDesktopApprovalRequestV2(raw: unknown, plan: DesktopLaunchPlanV2, sid: string, manifestSha256?: string): DesktopLaunchApprovalV2`；`confirmDesktopApprovalV2(raw, verify): Promise<DesktopLaunchApprovalV2>` 的 verify 仅 fixture 来源，native 仍只能已有 console 链，且在门禁前不能提示。
- `prepareDesktopProfileV2(input: {spec: DesktopLaunchSpecV2; plan: DesktopLaunchPlanV2; approval: DesktopLaunchApprovalV2; platform: DesktopPlatform; signal?: AbortSignal}): Promise<Gate<DesktopPreparedProfileV2>>`。
- `revalidateDesktopProfileV2(profile, mode: "prepared" | "immutable"): Promise<void>`；immutable 仅供当前 SW6 session 生命周期调用，不能替代启动前 prepared 校验。
- `loadDesktopPreparedProfileV2(plan: DesktopLaunchPlanV2): Promise<DesktopPreparedProfileV2>` 只恢复经过全套 prepared 校验的档案，不恢复 runtime/session/stop。`consumeDesktopGrantV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2): Promise<void>`、`requireDesktopConsumedGrantV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2): void`、`writeDesktopActiveLockV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2): Promise<FileIdentity>`、`removeDesktopActiveLockV2(profile: DesktopPreparedProfileV2, lock: FileIdentity): Promise<void>` 沿用既有单次消费/句柄策略，不重新定义算法。`readDesktopConsumedRecordAnchorV2(profile: DesktopPreparedProfileV2, approval: DesktopLaunchApprovalV2): DesktopRecordAnchor` 只读当前私有消费绑定，供原inventory发布边界使用。

- [ ] **写 RED 测试。** 准备准确 **13 目录/5 显式文件**，daemon2与 runtime seal 均不存在；完整祖先身份，owner/intent/manifest 替换/删除/字节变化、seed 漂移、目录交换、同根 v1/未知根都拒绝。manifest 只含不可变身份、seed、runtime 目标，自己的 hash 在外部能力绑定，不递归。账本消费、active 同形复制、重复 nonce、过期、跨 plan/manifest/policy 文档变化失败。

  ```ts
  test("v2 preparation separates immutable intent and seed from runtime targets", async () => {
    const profile = await f.prepareV2()
    expect(profile.plan.schemaVersion).toBe(2)
    expect(await f.profileOutputCounts()).toEqual({ directories: 13, files: 5 })
    expect(await f.runtimeTargetExists("daemon")).toBe(false)
    expect(await f.runtimeTargetExists("windows-daemon")).toBe(false)
    expect(await f.hasFile("settings-policy.json")).toBe(false)
    expect(await f.hasFile("runtime-seal.json")).toBe(false)
  })
  ```

  以上 f 方法在本任务实现并只派生自有 fixture root；native seed 的纯数据测试为 144 字节无 LF，fixture 的 dataRoot 较长不硬套144。面板精确显示 intent/policy/seed、三目标、阶段/限额、13/5 清单；控制+审计合计为条件成立时17目录8文件，profile payload `3162256`。12288 上限、转义、60秒、15分钟规则保持；超长拒绝而非删字段。native 缺工作负载/策略事实时 confirm/prepare/grant/目录创建计数均0。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-v2-profile.test.ts ./test/linux-host/desktop-profile.test.ts ./test/linux-host/desktop-confirmation.test.ts --timeout 30000`；预期 v2 准备合同缺失失败。
- [ ] **最小实现。** v2 使用 SW4 layout、SW1 版本/文档摘要与 SW2 编译目录，plan hash 包括全部新语义。准备前及确认前后重新检查 gate/身份/idle/SID，未消费请求不能写 grant。只写 owner、fresh prepare grant、intent、canonical seed、manifest；不造 daemon 默认文件。所有13目录及祖先纳入绑定，目标存在不接管。授权/active 的 v2 编码分支保持现有消费顺序和所有权清理语义，不删账本以重试。
- [ ] **GREEN。** 重跑本任务、SW1–4 和 typecheck；v1 原断言通过，native 仍无法得到可执行 prepare/START。
- [ ] **提交。** 提交 `feat(benchmark): prepare immutable desktop v2 profiles`。

## Task 6: SW6：受控设置阶段与独立 finally 收尾

**Files:** 新增 `settings-runtime.ts`、`desktop-settings-runtime.test.ts`；修改 `launch.ts` 只在 v2 路径接生命周期；扩充夹具屏障，不改原启动/停止算法和总时限。

**Interfaces:**

- `beginDesktopSettingsRuntime(input: {profile: DesktopPreparedProfileV2; approval: DesktopLaunchApprovalV2}): Promise<DesktopSettingsBootstrap>`：核实 SW5 私有已消费start事实与准确active lock后、**在 platform.start 前**固定父链并打开 bootstrap。`DesktopSettingsBootstrap` 为私有 WeakMap 签发的不透明句柄；不能仅凭 profile 或普通approval创建。
- `bindDesktopSettingsRuntime(bootstrap: DesktopSettingsBootstrap, session: DesktopLaunchSession): void` 只绑定当前启动链已验证的进程/session；`sealDesktopSettingsRuntime(session: DesktopLaunchSession, signal: AbortSignal): Promise<Gate<DesktopSettingsSeal>>`；`withDesktopRuntimeSettings<T>(session: DesktopLaunchSession, use: (seal: DesktopSettingsSeal) => Promise<T>, signal?: AbortSignal): Promise<T>`；`finishDesktopSettingsRuntime(subject: DesktopLaunchSession | DesktopSettingsBootstrap): Promise<void>`。最后一个接口只关闭自身句柄/窗口，不授予停止权限；未拿到session的启动失败同样必须关闭bootstrap。复制bootstrap/session、传stage/time/磁盘对象都不能创建窗口。
- `launch.ts` 内 `LaunchState` 明确区分 v1/v2，并添加实际内部阶段 `starting/observed/stopping/stopped/stale`、原绝对 deadline 和已消费 stop 权限。只读 `requireDesktopSettingsSession(session)` 返回 `{spec: DesktopLaunchSpecV2; profile: DesktopPreparedProfileV2; platform: DesktopPlatform; process: DesktopProcessIdentity; phase: DesktopSettingsPhase; startDeadline: number; stopDeadline: number | null; stopConsumed: boolean}` 的冻结当前上下文；它核实私有来源，**不提供注册/改阶段接口**。`DesktopSettingsPhase` 为本条阶段联合；stopConsumed 只是由私有状态导出的信息，不能被调用方提供的布尔值替代。stopping 窗口只在 stop-owned 已消费且归属再次核实之后打开。
- `DesktopSettingsSeal` 的公开只读视图为 `{intentSha256: string; policySha256: string; planSha256: string; manifestSha256: string; sequence: number; phase: "observed"; semantics: DesktopSettingsSemantics; sha256: string}`，自身 sha 对其余字段 canonical取hash。当前session、租约有效性及序号来源留在WeakMap，不从这个视图重建。设置失败写入私有状态；`readDesktopSettingsFailure(session): string | null` 只读供launch接入既有failureCode，不接受caller提供的错误当权限。
- 原 `startDesktopReadonly` 加明确版本联合重载；原 `stopDesktopLaunch(session): Promise<Gate<"stopped">>` 和 diagnostics 公开形状不变。v1 使用原 revalidate；v2 prepared/immutable/runtime 检查按阶段分离，不对 stop 前置配置正常条件。

- [ ] **写 RED 测试。** 用屏障控制合成保存：bootstrap 缺 daemon 文件为 pending、不封存，完整三文件后 seal；关键值错/稳定非法 JSON/未知键立即失败。单次最多3轮，三轮不稳定不能第四轮；pending/重试不重置120秒或30秒。observed 前后 raw/fileID 任意变更失败，即使 semantic相同；窗口内合法格式化/替换成功，immutable/父链漂移始终失败。stopped/stale/克隆 session/复制磁盘记录不能 reopen/reseal。

  ```ts
  test("corrupt settings block use but retain consumed cleanup after grant expiry", async () => {
    const session = await f.startV2()
    await f.corruptRuntime("settings-store")
    await expect(withDesktopRuntimeSettings(session, async () => "used")).rejects.toThrow()
    await f.waitForStartRequestExpiry()
    expect(await stopDesktopLaunch(session)).toEqual({ kind: "ready", value: "stopped" })
    expect(f.calls.stop).toBe(1)
    expect(f.primaryFailure()).not.toBeNull()
  })
  ```

  夹具 `startV2()` 真实调用本包流程但平台为合成。过期子用例先准备档案，紧邻启动才签发剩余5秒的fixture请求，断言启动返回时尚未过期；`waitForStartRequestExpiry()` 只等已签发 expiresAt 的剩余毫秒，上限5秒，不改全局Date/系统时钟或增加native可注入时钟。若环境过慢导致启动前过期，报告实际测试失败，不扩大旧时限。另测并发stop只调用一次；stop保存非法时仍执行已归属停止并保留配置失败；PID/创建时间/SID/映像/pipe任一不明时 cleanup_uncertain、无 name kill/service/global shutdown；保留主失败、收尾失败及残留，不把 stop 成功当原操作成功。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-settings-runtime.test.ts ./test/linux-host/desktop-launch.test.ts --timeout 30000`；预期缺窗口/seal/独立收尾接缝失败。
- [ ] **最小实现。** 顺序固定为prepared全校验→在SW3受保护事实区间内消费start→active lock→begin保护父链/开窗口→platform.start→验证进程→创建私有session并bind→完整seal→observed；进程身份未知则保留cleanup_uncertain，不能猜测停止。事实区间至少覆盖start消费至实际start调用返回，不能使用已经释放保护的旧fact。父目录跨窗口持有、目标仅短租约持有；observed signal不因start成功自动无限续期，继承当前请求期限，停止用独立原30秒期限。seal 包含 intent/policy/plan/manifest、三文件 raw/semantic/fileID、真实阶段和递增序号；invalid 立即记录失败并禁止后续观察。stop 使用内存中的原准确目标/通道，先重核归属，不读损坏配置寻找endpoint，不因 start过期取消收尾；设置校验失败须被捕获记录，不能抢在平台停止前 return。归属不明不扩大手段。窗口关闭释放父链，不能落地可恢复 seal。
- [ ] **GREEN。** 重跑本任务、SW4–5、旧 launch/confirmation 与 typecheck；120000/200/30000 保持原值，native platform start/stop 仍拒绝。
- [ ] **提交。** 提交 `feat(benchmark): bind desktop settings to launch lifecycle`。

## Task 7: SW7：v2 存储观察及不可恢复诊断

**Files:** 修改 `inspection.ts`、`inventory.ts`；新增 `desktop-v2-storage.test.ts`，扩充夹具。保留旧 `desktop-storage.test.ts`、StorageSource、公开 `StorageProof/HostRequest`。

**Interfaces:**

- `decodeDesktopStorageObservationV2(raw: unknown, context: {spec: DesktopLaunchSpecV2; profile: DesktopPreparedProfileV2; session: DesktopLaunchSession; seal: DesktopSettingsSeal}): StorageProof`；仅在 SW6 同组租约 use 内调用，并验证 session/seal 仍有效。内部 snapshot V2 明确 intentSha256、policySha256、runtimeSealSha256、manifestSha256、序号、registration、disks、实际设备/UUID/daemon/swap链，不收 `passed` 布尔值。
- 原 `inspectDesktopLaunch`、`makeDesktopProfileRunner`、`readDesktopLaunchStorage` 按当前私有 context 版本分流；每次实际 CLI/观察都由 `withDesktopRuntimeSettings` 包住，覆盖使用区间并前后核验，不能检查完释放后另作观察。runner 的只读命令白名单和默认连接判断不变。
- 诊断可写有界 v2 摘要，但 `readDesktopLaunchRecord` 仍仅 stale；不保存可导入的 settingsSeal/session/stop 能力，不新增 runtime seal 文件。

- [ ] **写 RED 测试。** v2 正向需合成的实际存储链；旧 seed hash、错误runtime seal、跨session/阶段/序号、过期lease、只改D路径声明、注册/VHD/设备UUID/daemon/swap任一漂移均失败。临时失去三文件租约时不执行观察；观察结果返回前漂移不得发布成功 inventory。

  ```ts
  test("v2 storage cannot reuse seed hash or another session seal", async () => {
    const first = await f.startV2()
    await expect(f.decodeStorageWithSeed(first)).rejects.toThrow()
    await expect(f.decodeStorageWithForeignSeal(first)).rejects.toThrow()
    const inventory = await inspectDesktopLaunch(first)
    expect([inventory.engine_verified, inventory.tool_capability_verified, inventory.corpus_engine_ready]).toEqual([
      false,
      false,
      false,
    ])
  })
  ```

  f 的两个 negative 方法只构造错内部 snapshot 并调用真实 decoder，不绕开 use；另测 default/endpoint不一致仍 blocked，相同字段的磁盘诊断复制不能恢复live。v1 decoder旧seed合同继续精确匹配。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-v2-storage.test.ts ./test/linux-host/desktop-storage.test.ts ./test/linux-host/desktop-inventory.test.ts --timeout 30000`；预期新 seal/context 接缝缺失失败。
- [ ] **最小实现。** 在明确 v2 schema 分支核对上述全部链；`StorageProof.settingsSha256 = sha256Text(canonicalJson({schemaVersion:2,intentSha256,policySha256,runtimeSealSha256,observation:value,planSha256}))`，其中 value 为已经验证的完整 V2实际观察，不用seed、不用调用方的success。runtimeSealSha256 为 SW6 全绑定摘要；decoder需验证 opaque来源，不只比字符串。原公开结构/生产配置不变，所有 readiness false。
- [ ] **GREEN。** 重跑本任务、SW6 与typecheck；原存储/默认连接门禁和历史记录断言通过，不产生 Linux receipt/EngineSession。
- [ ] **提交。** 提交 `feat(benchmark): bind v2 storage observations to runtime seals`。

## Task 8: SW8：CLI 版本分流与零副作用拒绝顺序

**Files:** 修改 `command.ts`、`approval.ts`、`native-audit.ts`、`platform.ts`；新增 `desktop-v2-command.test.ts`。既有 `script/desktop-launch.ts` 若只调用 controller 不改，禁止新增实际准备/START 示例脚本。

**Interfaces:** `makeDesktopLaunchController` 的原命令/参数集合不变，从严格 spec.schemaVersion 选择 v1/v2；approval/profile 版本必须一致。没有 `--accept-risk/--force/--learn-policy` 等参数。inspect/stop只认本控制器的 live session，stale记录不能恢复。native审计仍只报告缺项，不因传入一个 report/fact 清空 missing。

- [ ] **写 RED 测试。** 在 owner 根放合成 control 输入，按真实controller执行：

  ```ts
  test("unproved workload blocks before confirmation and all prepare/start effects", async () => {
    const result = await f.commandWithMissingWorkload("prepare-profile")
    expect(result.exitCode).toBe(2)
    expect(result.output.missing).toContain("existing_workload_restart_unproved")
    expect({ confirm: f.calls.confirm, prepare: f.calls.prepare, start: f.calls.start }).toEqual({
      confirm: 0,
      prepare: 0,
      start: 0,
    })
    expect(await f.profileExists()).toBe(false)
  })
  ```

  同测start-readonly、schema1 native不能旁路、错误版本/manifest/intent/policy、回调/JSON伪造native、重复/未知flag、取消/非交互、nonce重放、文档漂移。每条拒绝前后比对完整合成输出树/账本，不只检查start计数；真实native工厂只测无query的直接start/stop拒绝。固定面板超过12288必须拒绝，不能截断后提示。

- [ ] **运行 RED。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-v2-command.test.ts ./test/linux-host/desktop-command.test.ts ./test/linux-host/desktop-interactive-command.test.ts --timeout 30000`；预期v2分流/门禁优先顺序缺失失败。
- [ ] **最小实现。** 验输入版本/准确control布局/绑定后先判断兼容与旧负载门禁，只有具备全套同次事实才可确认；消费和任何写入前再核对。当前native返回准确missing，不执行已安装Docker/WSL以“试着证明”；既有显式start/stop拒绝及START面板封闭不动。fixture v2使用固定合成目录，不设置 native环境开关。
- [ ] **GREEN。** 重跑本任务、全部 desktop v1/v2 定向测试与typecheck；0真实环境副作用，旧CLI状态码/readiness/历史处理保持。
- [ ] **提交。** 提交 `feat(benchmark): enforce versioned desktop launch gates`。

## Task 9: SW9：全链无 Docker 验证、规格映射与交付

**Files:** 新增 `desktop-v2-e2e.test.ts`；必要时只补 `desktop-v2-fixture.ts`；新增 `docs/superpowers/reports/2026-10-19-task24b-settings-workload-boundary-verification.md`（实施后据实际日期调整报告名，不改变本计划 registry 路径）。本次 owner 根内的 scoped tsconfig/日志是中间物，不是交付。

**Interfaces:** 使用 SW1–8 的真实包内入口，不新增生产接口或 native collector。合成端到端必须区分 `software_fixture_verified` 与 `native_blocked`；文档不宣称“DL6已可启动”或“Linux已验收”。

- [ ] **写 RED 集成用例。** 使用新 D owner 根的非可执行合成安装、合成VHD、固定策略和自有文件句柄：v2准备→消费→bootstrap格式化/合法替换→完整seal→只读观察→有界退出保存→stopped，及损坏→禁止使用→独立finally；进程退出后重读诊断只能stale。加入native策略/负载缺失的全路径零副作用用例，fixture成功不能生成native能力。用自有子进程模拟崩溃，不杀真实进程，不让内存模型全过代替真实文件边界测试。

  ```ts
  test("fixture lifecycle succeeds without accepting a native engine", async () => {
    const outcome = await f.runV2Lifecycle()
    expect(outcome).toMatchObject({ status: "inventory_observed_not_accepted", cleanup: "stopped" })
    expect([outcome.engine_verified, outcome.tool_capability_verified, outcome.corpus_engine_ready]).toEqual([
      false,
      false,
      false,
    ])
    expect(f.calls.paid).toBe(0)
    expect(f.calls.nativeStart).toBe(0)
  })
  ```

- [ ] **运行集成 RED，再补最小接缝。** `& $SettingsBun --no-env-file test ./test/linux-host/desktop-v2-e2e.test.ts --timeout 30000`。应先证明用例能揭露遗漏（例如缺少 finally 或错误seal接受），再只修所属接口；不改旧视觉/算法/测试时限。若首次已绿，临时在本次改动中关闭一个被测保护验证测试会红，然后精确恢复，保留diff证据，不碰外来修改。
- [ ] **完整 GREEN。** 在前述已隔离环境、benchmark包目录运行，逐项保存实际退出码/通过失败skip数量/时长，不将历史414/10当新增结果：

  ```powershell
  & $SettingsBun --no-env-file test ./test/linux-host --timeout 30000 --only-failures
  & $SettingsBun --no-env-file test --timeout 30000 --only-failures
  & $SettingsBun --no-env-file run typecheck
  & $SettingsBun --no-env-file run typecheck --project "$SettingsTemp\tsconfig.settings-workload.json"
  ```

  scoped config extends 包内tsconfig，纳入绝对路径 `src/**/*.ts`、`test/linux-host/**/*.ts` 及 `script/desktop-launch.ts`、`script/linux-host.ts`、`script/accept-linux-host.ts`，types=bun，typeRoots显式指向包内及repo的node_modules/@types。先核对脚本存在；不通过漏收文件/关闭检查消除失败。原skip数不得减少覆盖或新增skip；旧失败先查基线，不直接顺手修未授权业务。

- [ ] **格式、审查与边界验证。** 使用 D Node/本地Prettier只检查本次文件，`git diff --check`；回看整个实施范围而非最后提交。按下表逐项记录测试名与结果；确认没有额外native事实、callback放行、真实系统调用、secret读取、C写入、旧断言/时限/skip变化、部署或算法修改。依既定执行方式做一次全范围审查；有未决高风险项不得交付完成。

  | 规格章节                                       | 主验证归属         |
  | ---------------------------------------------- | ------------------ |
  | 一/二/九：授权、范围、其余native缺项           | SW3、SW8、SW9      |
  | 三/八：版本、意图、manifest、准备和3/3文档绑定 | SW1、SW5           |
  | 四：严格字段、路径、同组租约、临时及预算       | SW2、SW4           |
  | 五：阶段、封存、过期与安全收尾                 | SW6                |
  | 六：真实存储接缝、默认连接及readiness          | SW7                |
  | 七：旧负载范围、来源、新鲜性与无旁路           | SW3、SW8           |
  | 十/十一：无Docker验收与交付边界                | SW9及所有RED/GREEN |

- [ ] **交付报告与本地提交。** 报告仅写实际证据、各任务commit、未完成原生证据/下一阶段准确条件，明确真实准备/启动/验收/付费/替换均0。既有未跟踪报告原样保留，若它仍使源码dirty，明确记为native绑定阻断，不隐匿。提交 `test(benchmark): verify desktop v2 settings safety boundaries`，只stage本次测试和报告；push及环境操作按后续明确授权，不因本文批准自动进行。
- [ ] **安全清理本次中间物。** 交付验证后核对本次owner、root/祖先物理身份及逐项清单，仅移除本次自有夹具/日志/scoped配置/缓存；不删除源测试、最终报告、用户输入、未知文件或此前被拒绝清理目录。清理失败报告准确残留，不换方式绕过拒绝，不递归处理仓库/宽泛D根。

## 审阅后的下一阶段

批准本文后只能进入 SW1–SW9 代码及无 Docker 回归。完成软件不等于补齐全部原生兼容证据；尤其**完整 native 字段/临时规则、旧负载可信采集方法、完整路径/自动行为/安全停止链及写入预算**仍是独立前提。任何实际准备与启动必须重新给出现场只读核查、准确目录/文件/argv/环境/预算/归属停止清单并另行确认；当前不提供可执行 START 命令。

本计划自审按已批准规格逐节映射，以上 Review Focus 五类均有归属测试。没有把未知证据替换为配置开关，也没有把真实环境操作夹带进软件任务。请用户审阅任务范围、接口和验收边界；**确认前不实施**。
