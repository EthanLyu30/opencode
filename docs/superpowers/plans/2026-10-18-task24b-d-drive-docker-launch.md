# Task24B D-Drive Docker Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为已安装 Docker Desktop 提供版本锁定的 D 盘专用启动档案，先证明无迁移复用既有数据盘的条件，再以单独授权执行启动/只读核查；不把启动成功冒充 Linux 验收。

**Architecture:** 新增 benchmark 专用 `sandbox/desktop/`，组合既有路径身份、managed-storage 观察和有界进程传输；旧 Windows profile、原存储分支与生产默认连接保持不变。兼容审计、D profile 准备和真实启动分门控；未知行为返回 blocked，不新建空盘或退回 C。

**Tech Stack:** 现有 Bun 1.3.14、TypeScript、Effect Schema、Windows PowerShell 固定只读查询与 parser、固定版本 Docker CLI；不新增运行依赖，不修改 Docker 安装包。

**Spec:** [D 盘启动档案规格](../specs/2026-10-18-task24b-d-drive-docker-launch-design.md)。按用户要求，规格和计划本轮同时成文，**两者均待确认**，不是已批准的执行记录。

## Global Constraints

- 基线 `d437c4bd90f05f17a6fa894b31ea2606ada6307b`，直接既有 `dev`；保留用户改动，不建新分支。
- Desktop `4.79.0.230596`、CLI `29.5.3`、SettingsVersion `44`，任何安装身份变化均 blocked，不扩大支持范围。
- 真实根 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479`；profileID `oc-task24-dd479`；home basename `home-oc-task24-dd479`；诊断根 `D:\OpenCode-Benchmark\Task24\reports\desktop-launch\<launchID>`。
- 仅复用 `D:\Applications\DockerWSL\main\ext4.vhdx` 和 `D:\Applications\DockerWSL\disk\docker_data.vhdx` 及原 `docker-desktop` 注册。不得迁移、重置、复制、压缩、创建替代盘或注销。
- 旧 C 盘三棵 Docker 目录不迁移、不删除、不覆盖、不改 ACL、不换链接；真实 `.wslconfig` 保留原 `swap=0` 及已记录 SHA256。本项目不新增 C 盘配置或缓存例外。
- 不读 Key、`.env.local`、Docker credential/Cookies；不做 provider 或 `/models` 调用，不拉镜像/建容器/卷/prune。
- 不改 Server/Core/生产 CLI、旧视觉合同、租约/重试/预算算法、现有部署/dist/seal/receipt；default 一致性断言不能放宽。
- 计划确认后先 DL1–DL5 的代码、只读审计和无 Docker 测试；真实 profile 准备、Docker 启停/活动盘查询留在 DL6，另行确认。真实验收、校准、付费跑分仍不做。
- 授权最长 15 分钟、单次消费；启动等待上限 120 秒，停止上限 30 秒；未归属资源不操作。不自动关闭其他 Docker/WSL。
- 沿用本会话 native 顺序实施（executing-plans），最后一次整体审查；本轮不派实现代理。后续全套验证通过才普通提交/push `fork/dev`，不绕过 hooks、不部署。

## Review Focus

1. 安装升级或内部 home override 改变 WSL 名称/服务环境：必须在启动前 blocked，不能让 fixture 消除真实缺项；DL1 的 `unknown propagation or registration blocks native start`。
2. D 盘路径中间 junction、发布竞态或同名他人目录：不得越界或接管；DL2 的 `parent exchange and foreign owner never publish`，DL3 的启动前重查。
3. 把 D Docker profile 冒充真实 Windows 用户，导致读错 `.wslconfig`/接受任意 settings：新旧来源必须分离；DL4 的 `D settings cannot authorize a fake Windows profile`。
4. PID 重用、服务接管、同用户已有实例或取消后重放授权：不得误停他人进程或重启；DL3 的 `reused PID and consumed grant never stop or spawn`。
5. profile runner 看似可用但原生产 default 指向另一个引擎：单独报告不兼容，不能签发就绪/伪造 default；DL4/DL5 的 `profile endpoint cannot stand in for production default`。

---

## 1. 文件与执行约定

新文件相对 `packages/benchmark`；不把专用命令加入默认 `opencode` 入口。

| 文件                                                                                | 职责                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/sandbox/desktop/contracts.ts`                                                  | 严格输入、报告、计划、授权类型；不签发真实运行能力            |
| `src/sandbox/desktop/compatibility.ts`                                              | 固定安装规则、路径/命名空间证据和不启动兼容审计               |
| `src/sandbox/desktop/profile.ts`                                                    | D 路径派生、环境白名单、新档案排他发布与身份重查              |
| `src/sandbox/desktop/platform.ts`                                                   | 固定 Windows 观察、准确启动/停止适配；真实与 fixture 来源隔离 |
| `src/sandbox/desktop/launch.ts`                                                     | 授权消费、进程归属、session 与生命周期                        |
| `src/sandbox/desktop/inspection.ts`                                                 | 组合 session、专用只读 CLI 与活动存储证据，不签发验收能力     |
| `src/sandbox/desktop/command.ts` / `script/desktop-launch.ts`                       | 独立显式命令；默认不启动、无验收副作用                        |
| `src/sandbox/storage-source.ts`                                                     | 仅增加显式 launch 分支，复用活动盘校验；旧分支语义不变        |
| `test/linux-host/desktop-{compatibility,profile,storage,launch,command}.test.ts`    | 五组无 daemon 回归；必要的合成数据放 `desktop-fixture.ts`     |
| `test/linux-host/{managed-storage,docker,preflight,command}.test.ts`                | 只追加兼容性断言，不放宽原断言                                |
| `docs/superpowers/reports/2026-10-18-task24b-d-drive-docker-launch-verification.md` | 实施后实际软件证据、环境缺项与未运行项；本轮不提前创建        |

所有测试 cwd `D:\OpenCode-Audit\packages\benchmark`。实施时新建 D 盘 owner 临时根，**不得复用旧已清理目录**。为现有 `hostFixture()` 写入其要求的测试 owner nonce `bprep2-0786b1f11abc`，同时另记本次随机 run owner；清理只认本次随机 owner 和精确路径，不因固定 fixture nonce 删除目录。

以下命令中的 `$DesktopBun` 仅在未来实施时设为 `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` 并核验既有 hash。父/子进程 HOME、XDG、APPDATA、TEMP/TMP/TMPDIR、Bun/npm/Node/PowerShell cache 全在该 D 临时根；清除 provider/integration/update/discovery 开关。PATH 含可信 Bun 和已有无 dotenv 嵌套包装，不读取真实 env 文件。Windows helper 隐藏运行。

既有 `tsconfig.json` 只含 `src`；DL5 还须在临时根生成扩展它的 scoped config，显式纳入新测试和脚本，从包内用 `typecheck --project` 检查，不直接调 tsc、不从 repo 根跑测试。

## 2. 跨任务接口

DL1 在 `contracts.ts` 定义以下严格类型，后续任务沿用名称；所有 JSON 使用 Effect Schema、拒绝多余字段。复用现有 `FileIdentity`、`Gate<T>`、`HostRequest`、`StorageProof`、`DockerRunner`；C 盘 `.wslconfig` 使用独立有界读取，不调用强制 D 路径的 `fileIdentity()`。

- `DesktopLaunchSpec`：schemaVersion `1`、profileID、源码/规格/计划 hash、真实 `windowsProfile`、`profileRoot`/`dataRoot`、版本/设置格式、`install:{desktop,frontend,backend,asar,cli:FileIdentity}`、`.wslconfig` 的 path/hash/fileID、原注册身份及两个 VHD 的 path/fileID/volumeID。解码检查规范路径/完整字段；native 审计与命令入口还必须锁定规格的全部路径、版本和已知 hash。测试可在专用 fixture platform 上使用 D 临时根与合成文件身份，不能把真实路径的限制从 native 路径移除。未知值不能以空值或假 hash 通过真实审计。
- `DesktopPaths = Readonly<{root:string;home:string;frontend:string;cli:string;temp:string}>`，仅由 profileRoot 派生，不接受单独外部覆盖。
- `DesktopCompatibilityReport`：`assurance:"fixture"|"native-static"`、spec hash、已核对安装身份、路径/环境传递/注册复用/停止证据（每条含 source/hash/定位/结论）、CLI context 观察、`missing:readonly string[]`。无 daemon 的 `native-static` 也不是活动引擎证明；真实来源由 platform 的私有登记决定，不信任 JSON 的 assurance。
- `DesktopLaunchPlan`：schemaVersion `1`、`assurance:"fixture"|"native-static"`、spec hash、兼容报告 hash、派生 paths、最小 child env、独立设置内容及其 hash。plan hash 不依赖尚未创建的文件身份。只有本进程登记、无缺项的准确 native-static 报告可产生真实可准备计划；重新读取报告文件须重新审计，不能凭 JSON 自报来源。fixture 计划只准在本轮测试 owner 根使用，禁止访问固定真实根。
- `DesktopPreparedProfile`：`assurance:"fixture"|"native-static"`、`plan:DesktopLaunchPlan`、plan/manifest hash、profileRoot 身份、owner nonce、各正式文件身份、原注册/VHD 身份；只是准备凭据。准备时才计算包含实际文件身份的 manifest hash，manifest 不包含自身文件身份或自身 hash，避免循环依赖。
- `DesktopLaunchApproval`：严格 phase union。共同字段为 schemaVersion `1`、launchID、nonce、SID、plan/compatibility hash、原注册/VHD 身份、issuedAt/expiresAt；`phase:"prepare-profile"` 仅有 `operations:["prepare-profile"]`，绑定 expectedProfileRoot，不要求尚不存在的 manifest hash；`phase:"start-readonly"` 必须绑定实际 manifest hash，operations 仅为 `["start-readonly","stop-owned"]`。控制器核对用户确认来源，不由磁盘 JSON 自行签发能力。
- `DesktopProcessIdentity = Readonly<{pid:number;createdAt:number;ownerSID:string;image:FileIdentity;parentPID:number}>`。session 内还保留已核对的进程关系和专用控制通道身份，不把单独父 PID 当归属证明。
- `DesktopLaunchSession = Readonly<{launchID:string}>`：进程内不透明能力，内部 WeakMap 保留权限、准确进程/pipe/profile 绑定、是否 fixture；不能反序列化，也不能凭一个 launchID 构造。
- `DesktopLaunchInventory`：launchID、`assurance:"fixture"|"native"`、`status:"inventory_observed_not_accepted"|"blocked"|"cleanup_uncertain"`、missing、安装/profile/pipe/进程/注册/盘位观察 hash、nullable `StorageProof`、profile endpoint、原生产 default endpoint、`production_default_compatible:boolean|null`；后三项 readiness 固定 false，不含 `EngineSession`。
- `DesktopPlatform`：固定操作接口 `audit(spec:DesktopLaunchSpec):Promise<DesktopCompatibilityReport>`、`observe(spec:DesktopLaunchSpec):Promise<unknown>`、`start(plan:DesktopLaunchPlan):Promise<DesktopProcessIdentity>`、`stop(process:DesktopProcessIdentity):Promise<"stopped"|"uncertain">`。observe 的 raw 数据严格解码；固定 native 适配器没有任意 argv/shell/URL 入口。fixture 实现只能产生 fixture session/report；生产工厂登记 native 来源，不能由调用方参数升格。

## Task 1: DL1 — 固定版本兼容审计与启动阻断

**Files:** 新建 `desktop/contracts.ts`、`desktop/compatibility.ts`、`desktop/platform.ts`（仅审计/观察能力）；新建 `desktop-compatibility.test.ts`、`desktop-fixture.ts`。路径前缀分别为 `src/sandbox/` 和 `test/linux-host/`。

**Interfaces:** Consumes 既有 `fileIdentity(file:string):Promise<FileIdentity>`、`Gate<T>`；Produces `decodeDesktopLaunchSpec(raw:unknown):DesktopLaunchSpec`、`auditDesktopCompatibility(spec:DesktopLaunchSpec,platform:DesktopPlatform):Promise<Gate<DesktopCompatibilityReport>>`、`makeWindowsDesktopPlatform():DesktopPlatform`。尚未实现的 start/stop 必须显式拒绝，不落到真实进程调用。

- [ ] **RED：** 在真实 D 临时文件上构造安装与注册夹具，新增下列实际断言；fixture 模块只供测试，不从 script 导入。

  ```ts
  test("unknown propagation or registration blocks native start", async () => {
    const report = await auditDesktopCompatibility(f.spec, f.unknownPropagation)
    expect(report.kind).toBe("blocked")
    expect(report.kind === "blocked" && report.missing).toContain("backend_environment_unproved")
    expect(f.calls.start).toBe(0)
  })
  ```

  另精确覆盖 `4.80.0`、SettingsVersion45、asar 单字节变化、假 native-static 字段、变更 WSL 注册名、未证实停止通道、未知应用写入路径均 blocked；审计无 Desktop/后端启动调用，未捕获固定 CLI/hash 时不运行 CLI。

- [ ] **运行 RED：** `& $DesktopBun --no-env-file test ./test/linux-host/desktop-compatibility.test.ts --timeout 30000`。Expected：新行为缺失导致失败，无真实 daemon。
- [ ] **实现：** 锁定规格中的两个已知 hash 和完整版本；先只读捕获其余可执行文件身份。静态审计只读取安装公开资源/固定注册/白名单设置字段，逐条证明路径、服务环境、原盘发现、singleton 与停止。CLI context 特性只在全新 D fixture 配置内无 daemon 查询，记录真实输出，不跑 Desktop `--help`。无法证明返回具体 missing，不把“实现后再看”设为兼容。
- [ ] **GREEN：** 同一测试命令及包内 `& $DesktopBun --no-env-file run typecheck`。Expected：全过；实际兼容审计如 blocked，后续继续完成可独立验证的软件，但禁止 native 准备/启动。若复用必须改注册/初始化新盘，报告不可行并停止该环境路线，不做替代系统改造。
- [ ] **提交：** 仅 stage 本任务新文件；`git commit -m "feat(benchmark): audit pinned desktop launch compatibility"`。

## Task 2: DL2 — 安全 D profile 计划与排他准备

**Files:** 新建 `src/sandbox/desktop/profile.ts`、`test/linux-host/desktop-profile.test.ts`，复用 `src/offline/atomic.ts` 的不可变发布规则和 storage 路径身份检查，不改公共语义。

**Interfaces:** Consumes DL1 类型/审计；Produces `planDesktopProfile(spec:DesktopLaunchSpec,report:DesktopCompatibilityReport):Gate<DesktopLaunchPlan>`、`prepareDesktopProfile(input:{spec:DesktopLaunchSpec;plan:DesktopLaunchPlan;approval:DesktopLaunchApproval;platform:DesktopPlatform}):Promise<Gate<DesktopPreparedProfile>>`、`revalidateDesktopProfile(profile:DesktopPreparedProfile):Promise<void>`。prepare 必须经受信任控制器核对授权来源，fixture 只能准备夹具根，不能使用固定真实根。

- [ ] **RED：** `parent exchange and foreign owner never publish`：真实临时文件系统中交换中间父目录/放入同名 foreign owner，断言拒绝且目标外 sentinel 内容/身份未变。再测链接/hardlink、ADS、`..`、短路径、同盘别名、配置读取漂移、重复准备、过期/错 manifest/无用户确认来源的 prepare 授权；缺权限时 writes=0。

  ```ts
  const result = await prepareDesktopProfile(f.foreignOwnerRequest)
  expect(result.kind).toBe("blocked")
  expect(await Bun.file(f.sentinel).text()).toBe("user-owned")
  expect(f.calls.publish).toBe(0)
  ```

- [ ] **运行 RED：** `& $DesktopBun --no-env-file test ./test/linux-host/desktop-profile.test.ts --timeout 30000`。Expected：缺少安全发布/授权行为而失败。
- [ ] **实现：** 按规格派生五路径和确切五字段设置，不复制原档案/许可字段。只构造子进程最小环境，不改父环境/全局变量；拒绝继承 `DOCKER_HOST`、provider、Electron 注入。确认授权及目标后可先排他创建 owner/消费账本，其他 profile 写入前须持久消费 nonce；身份重查、不可变 manifest 发布；已存在完整匹配 owner 才可只读重入，其他一律拒绝且保留。真实 Windows profile 与子进程 home 分字段保存。
- [ ] **GREEN：** 同一测试命令。断言设置仅有规格五键、所有应用写入路径 D、`.wslconfig` 仍为真实 C 来源；fixture 准备前后无真实目录访问。Expected：全过，无真实 profile 准备。
- [ ] **提交：** 仅 stage 本任务文件；`git commit -m "feat(benchmark): stage isolated D-drive desktop profiles"`。

## Task 3: DL3 — 单次授权、准确进程归属与可取消生命周期

**Files:** 新建 `src/sandbox/desktop/launch.ts`、`test/linux-host/desktop-launch.test.ts`；完成 `desktop/platform.ts` 的 guarded start/stop。DL3 session 查询在此接到私有 WeakMap，不能加入接受 JSON 即签发的捷径。

**Interfaces:** Consumes DL1/2；Produces `startDesktopReadonly(input:{spec:DesktopLaunchSpec;profile:DesktopPreparedProfile;approval:DesktopLaunchApproval;platform:DesktopPlatform;signal:AbortSignal}):Promise<Gate<DesktopLaunchSession>>`、`stopDesktopLaunch(session:DesktopLaunchSession):Promise<Gate<"stopped">>`、`revalidateDesktopLaunchSession(session:DesktopLaunchSession):Promise<Readonly<{spec:DesktopLaunchSpec;profile:DesktopPreparedProfile;platform:DesktopPlatform;assurance:"fixture"|"native"}>>`。后者先重查权限与进程/pipe/profile 身份，再提供只读上下文供 DL4 观察；不能只凭 session 的字段返回。session 只由通过的控制器签发，fixture 来源永不产出 native 观察。

- [ ] **RED：** `reused PID and consumed grant never stop or spawn`：同 PID 换创建时间、已有同用户 Docker、外部服务接管、错 SID、超期/重放 grant 均拒绝；断言 foreign stop=0、重复 spawn=0。启动前交换父目录/安装文件再测一次，spawn=0。

  ```ts
  expect((await startDesktopReadonly(f.replayedRequest)).kind).toBe("blocked")
  expect(f.calls.start).toBe(0)
  expect(f.calls.stop).toBe(0)
  ```

- [ ] **运行 RED：** `& $DesktopBun --no-env-file test ./test/linux-host/desktop-launch.test.ts --timeout 30000`。Expected：归属和状态机缺失失败；使用可控时钟/合成 Windows 观察，不等真实 120 秒。
- [ ] **实现：** 固定隐藏启动入口只能来自 DL1 证据充分的规则；启动前再验安装、profile/父目录、原注册/VHD、`.wslconfig`、无运行中 Docker/WSL、授权范围/来源/nonce。首次 spawn 前在 `state\grants` 排他持久消费 nonce，控制器重启后也不允许重放；消费后未启动即失败也需新授权。进程 PID/创建时间/SID/映像/关系与 pipe owner 同时绑定；服务不继承或无法归属就 blocked，不自动提升/重配。按 120 秒启动、30 秒停止上限和 signal 驱动状态机，不自动重试/恢复启动授权。
- [ ] **GREEN：** 同一命令。覆盖每一 await 边界取消、进程提前退出、pipe 身份变化、重复 stop、超时及控制器崩溃后只读调和；未知残留为 cleanup_uncertain，不杀未知进程，不注销 WSL。platform 未能证明作用域正确的停止机制时 native start 永远拒绝，不能用 `kill(pid)` 当未审计的默认后备。Expected：全过，无真实进程启动。
- [ ] **提交：** 仅 stage 本任务变更；`git commit -m "feat(benchmark): guard desktop launch lifecycle and ownership"`。

## Task 4: DL4 — profile 专用只读连接与活动盘来源分离

**Files:** 新建 `src/sandbox/desktop/inspection.ts`；修改 `src/sandbox/storage-source.ts`；扩充 `desktop/platform.ts`；新建 `desktop-storage.test.ts`；在旧 `managed-storage.test.ts`、`docker.test.ts`、`preflight.test.ts` 追加回归。不修改 `contracts.ts` 的旧 Host/StorageProof schema 或生产 `docker-config.ts`。

**Interfaces:** Consumes DL1–3；Produces `makeDesktopProfileRunner(input:{request:HostRequest;session:DesktopLaunchSession}):DockerRunner`、`inspectDesktopLaunch(session:DesktopLaunchSession):Promise<DesktopLaunchInventory>`、`decodeDesktopStorageObservation(raw:unknown,context:{spec:DesktopLaunchSpec;profile:DesktopPreparedProfile}):StorageProof`。最后一个仅做严格数据校验/转换，不登记真实来源。runner 仅只读，plan 从已验证 session 的 profile.plan 取得，不接受任意外部环境。`StorageSource` 新增 `{kind:"desktop-wsl-managed-launch",...SourceFields,settingsFile:string,profileManifest:string}`；`makeStorageProbe` 仅增加可选 `launch?:DesktopLaunchSession`，旧调用兼容。新增 native probe 分支没有真实 session 必须拒绝；fixture 通过共享纯解码和 fixture inventory 测同样校验，不签发 native 证据。

- [ ] **RED：** `D settings cannot authorize a fake Windows profile`：旧 reader 仍拒绝 D settings；新分支拒绝假 session、错 manifest、C/D 来源混淆或晚于 backend 启动的 settings/真实 `.wslconfig`。`profile endpoint cannot stand in for production default`：专用 CLI 与原生产环境观察为两个 endpoint，兼容字段为 false，原 default 校验仍失败。

  ```ts
  const inventory = await inspectDesktopLaunch(f.sessionWithDefaultConflict)
  expect(inventory.production_default_compatible).toBe(false)
  expect(inventory.engine_verified).toBe(false)
  expect(inventory.missing).toContain("production_default_endpoint_mismatch")
  ```

- [ ] **运行 RED：** `& $DesktopBun --no-env-file test ./test/linux-host/desktop-storage.test.ts ./test/linux-host/managed-storage.test.ts ./test/linux-host/docker.test.ts ./test/linux-host/preflight.test.ts --timeout 30000`。Expected：新来源/连接缺失失败，旧测试仍保留。
- [ ] **实现：** 为新来源新增明确的 profile 权限校验接缝；提取共享的盘位/UUID 核对时不改变旧导出函数的输入和拒绝条件。固定 Windows helper 对新分支读取已核对的 D settings，对 WSL 一律用真实 Windows profile；保留 runtime VHD、实际设备/ext4 UUID/dockerd mount/server ID 和有效 swap 观察。专用 runner 绑定 session 实际管道与 D config，每次查询前后调用 DL3 的 revalidate；不得给旧 `makeDockerRunner` 添加自由 host 覆盖，不能登记为验收用真实 runner。原生产 default 在无用户 credential 的独立 D config 中按原环境合同逐字查询，与专用环境分别记录；不能只复制专用值。
- [ ] **GREEN：** 同一命令；准确 PowerShell parser 只解析两种脚本，不执行。覆盖两块盘身份替换、未被使用的附加盘、错误 engine ID、多 dockerd/缺工具都 blocked；容器/volume/image/desktop start 等 argv 全部拒绝。Expected：全过，未发布就绪或调用生产入口。
- [ ] **提交：** 仅 stage 本任务变更；`git commit -m "feat(benchmark): bind desktop profile storage observations"`。

## Task 5: DL5 — 独立命令、零 Docker 联合验证与交付

**Files:** 新建 `src/sandbox/desktop/command.ts`、`script/desktop-launch.ts`、`test/linux-host/desktop-command.test.ts`；追加旧 `command.test.ts` 的不可接受新报告断言；创建规格规定的 verification 报告。

**Interfaces:** Consumes DL1–4；Produces `runDesktopLaunchCommand(argv:readonly string[]):Promise<{exitCode:0|1|2;output:unknown}>`。操作只限 `audit`、`plan`、`prepare-profile`、`start-readonly`、`inspect`、`stop-owned`；未知/重复参数拒绝。`inspect/stop-owned` 只能操作本次 controller 还持有的 session，磁盘 launchID 仅允许查记录、不重建能力。一个 `start-readonly` 调用包含 observe 和 finally stop，不留待另一进程猜测停止。

固定语法：`audit --spec <D-json>`、`plan --spec <D-json>`、`prepare-profile --spec <D-json> --approval <D-json>`、`start-readonly --spec <D-json> --approval <D-json>`、`inspect --launch-id <id>`、`stop-owned --launch-id <id>`。不接受其他 flags 或位置参数。audit/plan 只向 stdout 输出有界诊断/计划，不创建真实 profile；prepare/start 内重做审计及 plan，核对授权中的准确 hash。launchID 沿用已有 ID 字符/长度规则；新进程的 inspect 仅查固定 D 诊断根中的记录并明确 stale/not_live，stop-owned 无本进程能力则拒绝，不从记录重建停止权限。

- [ ] **RED：** 严格命令测试：无参数 exit2；默认 audit/plan 不调用 start；`prepare-profile`/`start-readonly` 无单独用户确认来源 exit2、writes/spawn=0；`accept/calibrate/run/--yes` 拒绝；fixture inventory 不被旧 `openLinuxSession`/readiness 路径接受。生产 default 冲突保留 missing，后三 readiness 逐项 false。

  ```ts
  const result = await runDesktopLaunchCommand(["start-readonly"])
  expect(result.exitCode).toBe(2)
  expect(result.output).toMatchObject({
    engine_verified: false,
    tool_capability_verified: false,
    corpus_engine_ready: false,
  })
  ```

- [ ] **运行 RED：** `& $DesktopBun --no-env-file test ./test/linux-host/desktop-command.test.ts ./test/linux-host/command.test.ts --timeout 30000`。Expected：入口和证明隔离缺失失败。
- [ ] **实现：** 独立脚本组合上述接口；所有输入文件限受保护 D 控制器根、严格解码/有界稳定读取，不输出完整环境/用户设置。audit/plan 为诊断退出2，只有软件单测、授权准备或安全停止可用 exit0；只读观察成功仍输出 `inventory_observed_not_accepted`、readiness=false，不调用既有 accept/calibrate/verify 发布器。首次 onboarding/许可/联网/新盘需求只记录并停止。
- [ ] **联合 GREEN：** 包目录运行下面三条命令，Expected：退出0、全断言通过、旧10项 skip 逐名保留、不新增 skip。再用临时 scoped tsconfig 执行 `& $DesktopBun --no-env-file run typecheck --project <本次D临时根中的scoped-tsconfig.json>`，纳入 src、五组测试/fixture 和新脚本；Expected：退出0。该参数路径只由本轮 owner 根派生，不复制历史配置。

  ```powershell
  & $DesktopBun --no-env-file test ./test/linux-host/desktop-compatibility.test.ts ./test/linux-host/desktop-profile.test.ts ./test/linux-host/desktop-storage.test.ts ./test/linux-host/desktop-launch.test.ts ./test/linux-host/desktop-command.test.ts --timeout 30000
  & $DesktopBun --no-env-file test --timeout 30000 --only-failures
  & $DesktopBun --no-env-file run typecheck
  ```

  记录真实次数、命令、退出码和缺项，不把此前345项通过当新证据。核对部署 exe hash 仍为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`、`.wslconfig` 和旧 C 目录元数据未由本任务更改。元数据不是绝对无写入证明，不能冒充系统审计。

- [ ] **一次整体审查与交付：** 覆盖本轮完整源码范围和规格边界；重要问题做 RED→GREEN 后重跑相关及全套验证。精确清理本任务临时材料，保留正式源码/报告，外来和不确定文件不动。`git diff --check`、文档格式检查、仅 stage 已验证任务文件；`git commit -m "feat(benchmark): expose guarded desktop launch diagnostics"`。按既有远端配置普通 push `fork dev`，保留 pre-push hooks，复核本地/远端 commit；未批准 DL6 时直接报告其 not_run，不能暗中执行。

## Task 6: DL6 — 单独批准后的真实准备与启动只读核查（默认不执行）

这是软件交付后的环境阶段，**不是本轮或计划确认自动开启的动作**。不要求为等待该授权而扣住已验证的软件提交/push，也不能把 DL6 标成通过。

- [ ] **形成准确操作清单并请求一次环境确认：** 基于最终提交重新只读 audit，给出全部安装 hash/身份、注册/VHD 身份、所有计划新增 D 路径、配置字节、预计新增空间及停止方式。兼容证据不足则只报告 blocked，不请求带缺项启动。列明是否存在生产 default 不兼容；这不会授权修生产代码。
- [ ] **获准 prepare 后发布真实 profile：** 使用受保护 D 控制器内的准确 spec/plan/prepare 授权文件；调用 `desktop-launch.ts prepare-profile`，只产生规格所列 D 文件，记录 manifest/owner/身份。Expected：`profile_prepared`，没有 Docker/WSL 启动。若用户只批准准备，停在此处。
- [ ] **获准 start-readonly/stop-owned 后单次观察：** 再审计身份/时序/冲突；单次调用隐藏启动→固定 context/version/info/pipe/注册/VHD/有效 swap 查询→finally 准确停止。中途不得拉镜像、创建/运行容器或读真实凭据；取消/异常只收尾本次归属资源。Expected：真实观察链成立才有 native 的 `inventory_observed_not_accepted`；缺项非零退出并报告，绝不变成 Linux-ready。
- [ ] **复核并记录：** 旧 C 树与必要 `.wslconfig` 保留、原注册和 VHD 身份仍一致；允许正常启动导致 D VHD 内容/size/mtime 变化，不做数据回滚。停止不确定则列准确残留和建议，不自动删/恢复；新正式 profile 与最终报告保留，临时材料按 owner 清理。
- [ ] **文档提交/push：** 只提交实际环境报告，不记录授权秘密、完整用户设置或伪造成功。真实验收、工具能力、120次校准、付费跑分和部署替换继续保持未运行；后续需要各自的明确确认。

## 3. 完成定义与自审映射

DL1–DL5 是软件交付，DL6 是额外授权的环境观察；两者分开报告。未知内部规则、注册复用或停止机制无法证明时，兼容审计为 blocked 是正确安全结果，但不宣称 D 盘启动目标已实现。

规格覆盖：§1–3 由 DL1 及全局约束落实；§4–5 的路径/准备由 DL2，启动授权由 DL3；§6 的来源/活动盘/连接由 DL4；§7 的生命周期与准确清理由 DL3/DL5/DL6；§8 的全套验证与状态由 DL5，真实只读证据由 DL6。五项 Review Focus 均有所属 RED 负例，不留到真实环境才发现。

计划不承诺基于 override 实现操作系统级禁止一切 C 写入；应用路径证据不能补齐就不启动。若需要改生产 default 接入、使用新 WSL 注册/数据盘或改变系统隔离来继续，超出本计划，先提出最小补充设计并等待用户决定。

**交接：** 请用户一起审阅配套规格和本计划；确认后才按保留的 native 执行方式开始 DL1–DL5。当前没有实施授权，未创建真实 D profile、未启动 Docker、未替换部署。
