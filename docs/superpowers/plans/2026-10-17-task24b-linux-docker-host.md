# B-Prep2 Linux Docker Host and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目已选本会话顺序实施，沿用 executing-plans，不重新询问执行方式。

**Goal:** 为 B-Prep1 独立评测器接入真实 Linux Docker 执行宿主、受限预览及公开工具桥，并以真实安全矩阵、准确二进制能力验证和固定16题校准证明其就绪；全程零真实 provider 消费，不更新现有部署。

**Architecture:** Windows 受信任控制器持有 oracle、授权和裁决；不可信代码只在指定本机 Linux daemon 的一次性容器运行。新增 benchmark 专用 `sandbox/` 模块，复用生产入口但不改生产沙箱、租约、重试及预算算法；通过实际操作凭据接入 B-Prep1，而不是把 fixture 字段改名为 linux-attested。环境准备、真实验收和未来付费执行分别授权。

**Tech Stack:** 现有 Bun 1.3.14、TypeScript、Effect Schema、Node、Docker CLI、固定 Windows Chromium/Playwright 与 sharp；MCP 复用仓库已有依赖。镜像中的 Linux Node/Bun/PDF raster 工具由准备清单解析并锁定，不把 Windows 工具哈希冒充 Linux 哈希，不默认新增 npm 运行依赖。

**Spec:** [已确认 Task24B 就绪设计](../specs/2026-10-17-opencode-task24b-readiness-design.md)，重点第3–4、5.1、6节以及第7节的独立评测/Linux门槛；其余真实调度循环归 B-Prep3、候选制品封存归 B-Prep4。

**Baseline:** `f534e2de264922f5a9b8f479e0d058d1b76c30e2`，直接 `D:\OpenCode-Audit` 的 `dev`。B-Prep1 为272通过、10项原有skip、0失败；16题/65功能cases/104内容绑定controls/72交互断言/4严格guardrail bundles，见[验证报告](../reports/2026-10-17-task24b-independent-evaluator-verification.md)。这些是软件和材料证据，不是 Linux 已通过。

**Status:** 仅计划，等待用户审阅；本次未执行 Docker、真实候选、镜像准备或任何跑分。只读发现 Docker CLI 位于 `D:\Applications\Docker\resources\bin\docker.exe`；未据此推断 daemon、盘位或隔离能力就绪。

## Global Constraints

- 只用现有 dev，不新建工作树，不覆盖用户修改。每项 TDD→验证→本地提交；最终按获批实施范围正常 push fork/dev，不强推、不绕过 hooks。当前写计划不授权实施或推送。
- 不读真实 Key、`.env.local`、用户 Docker credential 配置或历史 grant；不请求真实生成、`/models` 或价格接口。未来本计划的假 provider 组合必须无真实 provider transport，不能靠一个环境开关切换 paid。
- 不替换 `D:\OpenCode-Local`、旧dist、回滚制品、旧语料/报告/seal/current pointer。现有部署 exe 保护哈希为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`。
- 只支持本机 Windows 控制器→明确本地 named-pipe endpoint→Linux daemon。远程 TCP/SSH daemon、自动安装/启动/迁移 Docker/WSL、创建账户、改 ACL/防火墙均无自动授权；需要时另提方案。
- 当前只写计划。未来批准实施后，代码/无daemon测试可先做；任何 build/pull/load/依赖准备与真实容器验收，分别需要记录明确范围的环境准备授权、真实执行授权。缺授权或环境即 blocked/not_run，不静默skip后算通过。
- 所有新增工作区、镜像/依赖存储、日志、缓存、浏览器profile和临时文件均按已核验D盘策略。必须核查实际 Docker VHDX/WSL数据和swap；CLI、DOCKER_CONFIG在D或Linux DockerRootDir不能代替盘位证据。必要系统C盘例外先列明确认，不承诺Windows本身零C盘活动。
- 生产策略原值：`--pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges=true --user 65532:65532`；PID64、CPU1.5、内存1GiB、最大输出1MiB、引擎操作15秒、清理5秒、生产命令上限10分钟；`/tmp`64MiB、HOME16MiB，均nosuid/nodev/noexec。具体调用仍取生产配置的更小deadline，不改生产值。
- 独立评测使用另行哈希绑定、各组相同的资源档案：首版同CPU/内存/PID/tmpfs限制，构建每命令至多300秒、probe至多30秒、preview至多30秒。若不兼容，报告具体task/资源，不自动增额、放宽noexec或联网安装。
- 候选及公开输入可进入容器；oracle、期望值、隐藏参考路径、私有canary、broker grant和Docker socket不得进入。只把必要被测输入送入候选进程，控制器比较，候选自报pass无效。
- 固定12个primary和4个guardrail，不换题、不降类。保持视觉75/各视口65，35/20/25/10/10及45/30/10/10/5权重；390×844、768×1024、1440×900、DPR1。guardrail四个视觉/总分字段仍null。
- 不改旧视觉生产流程、Core/Server公开接口、事件/租约/重试/预算/模型路由、默认CLI和v1评测；不生成客户端。仅允许本计划列出的 benchmark v2 assurance、dependency、browser接缝改动，旧fixture测试继续有效。
- 不在Windows主进程运行/导入真实候选、库build、项目插件或服务。Windows浏览器只运行被隔离的页面；项目Node/Bun服务必须在Linux容器。宿主脚本/MCP只处理受控公开文件与协议，不eval项目代码。
- 不做15-cell pilot或4×A/B/C调度矩阵；本段的五组能力微测试不是B-Prep3执行闭环，也不是有效性跑分。不继承历史512等额度许可。
- 清理仅按准确路径/容器ID/nonce/owner记录，在身份复核后执行；不prune、不删共享镜像卷、不处理B-Prep1已被策略拦截的残留。策略阻断即报告，不换API绕过。

## Review Focus

1. 同一CLI连接了另一daemon、VHDX转移或default context与显式context分叉：Task1/2/8在派发前复核，旧receipt必须stale，不能沿用路径字符串。
2. 候选向stdout写合法假JSON、修改驱动/依赖、用旧dist冒充新构建：Task3/4/6用独立控制通道、受保护worker/只读依赖和完整源码/构建绑定；不能把语法正确当成可信观察。
3. HTTP走私、双重解码/重定向/浏览器旁路及恶意PDF：Task5/6拒绝协议逃逸和跨run访问，PDF解析也在Linux，Windows不直接解析候选PDF。
4. 官方/修改版的内置工具、启动插件绕过MCP并访问gold或互联网：Task7真实准确exe验证；环境变量/工具deny是防御层，不是OS隔离证明，做不到即blocked。
5. 创建容器响应丢失、PID/名称重用、旧owner晚清理：Task2/8按daemon+ID+labels+nonce+generation校验；第三方和新owner资源必须存活。

---

## 1. 授权、证据和完成口径

四个独立状态：`software_verified`、`engine_verified`、`tool_capability_verified`、`corpus_engine_ready`。只有后3者对相同身份组合全为true，才可宣称 B-Prep2 真实验收完成。只做无daemon回归时，后三者保持false并逐项列missing；不能用“环境问题”掩盖未实现功能或未编写检查。

执行采用两遍：先顺序完成Task1–10的软件实现和自建夹具回归，再冻结准确源码commit、exe、helper、资源与artifact清单，在另获环境许可后运行Task8真实矩阵→Task9真实120次评测→Task10联合verify。Task8/9的软件可先提交，但真实验收步骤保持未完成；不因没有环境而停掉后续可独立完成的代码，也不把软件完成算作本段全完成。早期调试receipt仅作诊断；任何后续源码/制品变更都要求在最终冻结身份上重跑矩阵，不能复用旧receipt。

`fixture`永不晋升为`linux-attested`。实际宿主证明也不等于模型效果、整个OpenCode跨平台或绝对防内核逃逸。信任根为受保护控制器及其只读身份记录；普通hash不是抵抗可信存储整体替换的签名。

未来实施的门槛顺序：

1. 用户审阅本计划后才做代码及无daemon测试。
2. 只读勘验后提交准备清单：context/endpoint、D盘实址、可复用或缺少的镜像/依赖/准确exe/浏览器、digest/字节数或明确有上限的下载与解压估算、峰值磁盘上限、允许操作与回滚边界。未知大小不能直接下载；先解析元数据。仅有写计划许可时不做这一步的系统探测。
3. 用户单独批准准备操作后才能pull/load/build/复制私有新制品；daemon未运行仍不得自动启动。镜像准备不包含验收许可；需要启动或系统调整则再单独确认。
4. 准备满足后，用户确认准确环境的真实零额度验收，才允许accept、容器创建和真实项目执行。全部运行`--pull never`，运行期无依赖安装。

环境授权记录只在受保护控制器读取，含`planSha256,acceptanceID,scope:prepare|accept,contextFingerprint,artifactManifestSha256,allowedOperations,storageRoots,maxDiskBytes,expiresAt`；它不是provider消费许可，不传给模型/容器。布尔env开关、候选文件或自报receipt不能构造授权。

## 2. 实际接缝与文件分工

源码核查发现不能只新增一个Docker适配器：

- `independent/host.ts`的WeakSet只签发fixture，`result.ts`/`publication.ts`固定fixture；`index.ts`写死assurance且阻断全部dependency。这些接缝要有安全的Linux分支，不能全局放开字符串。
- `evaluation-profile.ts`已有locked/resolved两种不同合同；严格profile保留locked，控制器另传经证明的resolution，不把公开需求改成随意image字符串。
- `visual.ts`目前把attemptID直接当previewID；现有browser协议实际要求64位hex capability。生成独立preview capability，保留原attempt身份绑定，不放宽旧协议。
- Chart/marked的功能驱动需要浏览器上下文，PDF需实际renderer与PDF解析；不能把全部module都交Node导入。B-Prep1中72项交互与继承需求需要真正的执行计划和观察，不能只有名称。
- 生产`DockerConfig.invocationEnvironment()`固定default。benchmark可显式选context，但准确A生产能力验收还必须证明default解析到相同endpoint/daemon；不自动改用户current context或修改生产配置。

新文件均相对`packages/benchmark`：

| 单元           | 文件                                                                                                                                                                                                | 职责                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 合同/前置核查  | `src/sandbox/contracts.ts`, `preflight.ts`, `storage.ts`                                                                                                                                            | 严格环境/授权/盘位合同与只读观察                         |
| 引擎与生命周期 | `src/sandbox/docker.ts`, `ownership.ts`, `receipt.ts`                                                                                                                                               | 有界CLI传输、准确资源所有权、受信任证明链                |
| 离线准备       | `src/sandbox/dependencies.ts`, `image-recipes.ts`                                                                                                                                                   | digest/锁文件/只读依赖卷及工具链准备、校验               |
| Linux执行      | `src/sandbox/linux-backend.ts`, `archive.ts`, `worker.ts`                                                                                                                                           | 一次性候选副本、build/probe、严格导出                    |
| 预览           | `src/sandbox/relay-protocol.ts`, `relay-worker.ts`, `preview.ts`                                                                                                                                    | 受限HTTP over stdio与静态产物服务                        |
| 真实评测连接   | `src/sandbox/evaluation-host.ts`, `browser.ts`, `browser-helper.ts`, `controller-facts.ts`                                                                                                          | 验证后的EvaluationHost、页面probe/捕获与控制器事实       |
| 公开工具       | `src/sandbox/public-tools.ts`, `mcp-server.ts`, `capability.ts`                                                                                                                                     | 有限公开能力、stdio MCP、准确版本能力验证                |
| 验收/校准      | `src/sandbox/acceptance.ts`, `calibration.ts`; `src/corpus/evaluation-finalize.ts`                                                                                                                  | 矩阵、16题实测、生成新严格bundle                         |
| 显式入口       | `script/linux-host.ts`, `test/linux-host/fixture.ts`                                                                                                                                                | 独立命令及自建合成夹具，不扩写旧offline/CLI              |
| 测试           | `test/linux-host/{contracts,preflight,storage,docker,ownership,receipt,dependencies,archive,backend,relay,preview,authority,browser,facts,tools,capability,acceptance,calibration,command}.test.ts` | 无daemon回归，共19入口                                   |
| 真实验收入口   | `script/accept-linux-host.ts`                                                                                                                                                                       | 必需显式accept授权，缺环境非零退出，不是可skip的默认单测 |

允许最小修改：`src/evaluator/independent/{host,index,visual,result,publication}.ts`及其现有测试，必要的v2 profile附加合同放新增模块组合，不改v1。现有`evaluator/browser-{protocol,runtime,node-helper}.ts`只读复用，不就地改行为；新helper是单独版本化benchmark制品。准确A入口复用`packages/server/src/workflow/{command-sandbox,docker-config,production-host-runtime}.ts`，这些生产文件不改。

数据落点全部是未来实施的新目录：

- 输入只读：`assets\tasks`和`assets\evaluation-v2`；B-Prep1汇总hash为`9a2154567568201a8e83e4d1ee2626d2b86763899a8b00ec9eb03504f8d774de`。
- 已验证依赖/工具：`toolchain\linux\<content-sha>\`；准确修改版能力探针exe为`toolchain\modified\<source-sha>\`，官方exe为`toolchain\upstream\<release-sha>\`。这里只做能力候选，不激活B-Prep4 seal或部署。
- 新严格语料：`assets\evaluation-v2-linux\<acceptanceID>\`，不覆盖B-Prep1树。私有输入/映射/参考/controls仍仅在控制器树。
- 最终receipt：`reports\linux-host\<acceptanceID>\`；临时副本和运行环境：`tmp\bprep2-<plan-sha-prefix>\`及`workspaces\linux-host\<acceptanceID>\`。根均在`D:\OpenCode-Benchmark\Task24\`，要求全新、无链接、彼此不重叠；不修改Task24Root旧布局。

## 3. 跨任务合同

Task1在`contracts.ts`定义并导出以下类型，后续任务只扩充实现，不重命名：

- `Gate<T> = {kind:"ready",value:T} | {kind:"blocked",code:string,missing:readonly string[]}`；外部JSON均strict decode，未知字段拒绝。
- `HostRequest`为冷启动勘验输入，只含acceptanceID、源码/计划hash、准确CLI路径及期望hash、显式context、本地endpoint限制、D盘候选根与资源/工具要求，不要求事先知道serverID。`HostInventory`为只读实测的daemon/context/default/存储/现有artifact观察和missing清单，不是证明。
- `HostManifest`为schemaVersion2的闭合`phase:prepare|accept` union：两者均绑定实际CLI文件/daemon/context/storage身份、源码/策略/资源/测试清单；prepare记录明确的待准备artifact要求与PreparationPlan hash，缺少的真实artifact用独立pending声明而非假hash。accept必须有全部准确exe/evaluator/浏览器/字体/image/dependency的真实hash且无pending。prepare清单不能签发验收receipt；每个hash实际解析后填入，不放0或虚构digest。
- `StorageProof`：Docker/WSL后端类型、VHDX实址与文件身份、D盘卷身份、数据根、swap实际配置、配置来源白名单字段hash与采集时间。读取受保护系统设置仅提取上述字段，不写回、不保存凭据或完整用户配置。
- `EngineApproval`：上一节scope限定记录；`EngineSession`是不透明的只读勘验/授权会话，能派发已批准操作但**不是**已验收证明。
- `DockerInvocation`：`argv:readonly string[],stdin?:Uint8Array,timeoutMs:number,maxStdoutBytes:number,maxStderrBytes:number,signal:AbortSignal`；`DockerExecution`含started、exitCode、stdout/stderr字节、truncated和可信时序。`DockerRunner.execute(input):Promise<DockerExecution>`，不用shell拼命令。未给session时runner仅能发只读白名单命令；有session仍逐次复核scope/authority才能副作用。
- `Owner`：acceptanceID/runID/attemptID/leaseGeneration/operationID/随机nonce、daemon fingerprint、containerID及期望labels；权限回调`AuthorityGuard():Promise<void>`每次副作用前执行，只核查外部传入有效authority，不实现新的租约算法。
- `OperationReceipt`：身份、operation、候选/config/profile/dependency/workerhash、准确argv hash、container inspect关键字段、exit/耗时/限额/输出hash、证据索引；`EngineReceipt`另含矩阵逐项结果、StorageProof及完整工具/环境manifest。`LinuxAuthority`仅在控制器核验EngineReceipt后签发，不能从JSON/string断言构造。
- `ResolvedImages`：平台、不可变image digest/ID、工具链文件hash、每题recipe和lockfiles hash；依赖使用预先准备的内容寻址**只读依赖卷**，每个挂载目标/内容hash/volume identity在receipt逐项列出。容器只读根提供Node/Bun/driver，候选可丢弃目录可写；依赖卷不由候选创建或替换，不在运行期安装。
- `ReadyBundle`沿用B-Prep1 `ValidatedEvaluationBundle`，结果沿用`EvaluationOutcome`。新增`LinuxEvaluateInput = Omit<EvaluateInput,"facts"> & {dependency:DependencyResolution}`；fixture仍用原EvaluateInput。`makeIndependentEvaluator`的evaluate接受这两个明确分支，Linux由可信`ControllerFactsObserver`在build/probe/visual观察齐备后产facts，**不是要求调用者在测试前填true**。observer输入含bundle、identity、build observation、FunctionalFacts|null、VisualFacts|null和OperationReceipt[]，输出`Promise<EvaluateInput["facts"]>`，不另造评分合同或重复执行候选。

`engine_verified`证明不只验hash：加载者保留不可伪造的进程内authority，并在每次观察/发布/重读时复核磁盘证据与当前CLI/daemon/存储/镜像/策略/源码/二进制身份。持久化结果重读需相应可信manifest，未知或替换身份返回stale而非重新签发。

---

### Task 1: 严格环境合同与只读盘位/身份勘验

**Files:** Create `src/sandbox/{contracts,preflight,storage}.ts`, `test/linux-host/{fixture,contracts,preflight,storage}.test.ts`。

**Interfaces:** Produces `decodeHostManifest(unknown):HostManifest`, `inspectLinuxHost({request,runner,storageProbe}):Promise<HostInventory>`, `openLinuxSession({manifest,approval,inventory}):Gate<EngineSession>`, `verifyStorageProof(unknown):StorageProof`。先HostRequest→实测Inventory→待批准Manifest，批准后重观测匹配再open，避免要求预知daemon身份。`storageProbe`只返回规定字段的独立观察，不接受候选传来的磁盘证明；测试夹具导出`hostFixture():Promise<{root,request,manifest,runner,dispose}>`，是自建临时数据/记录型runner，不声称真daemon。

- [ ] **Step1 RED：** 测试C盘VHDX、D盘CLI但未知disk、缺swap证据、junction/错卷、remote endpoint、Windows daemon、wrong architecture/context/default分叉、过期授权、CLI替换；全为blocked/reject且runner没有create/start调用。正确合成Linux观察只签发session，不产生EngineReceipt。

```ts
expect(result).toMatchObject({ kind: "blocked", code: "engine_storage_not_verified" })
expect(invocations.filter((x) => x.argv.includes("create"))).toHaveLength(0)
expect(() => decodeHostManifest({ ...manifest, unexpected: true })).toThrow()
```

- [ ] **Step2 跑RED：** benchmark包目录运行`& $BPrep2Bun --no-env-file test ./test/linux-host/contracts.test.ts ./test/linux-host/preflight.test.ts ./test/linux-host/storage.test.ts --timeout 30000`。Expected:新模块/行为缺失导致失败，非真实daemon调用。
- [ ] **Step3 实现：** 显式`docker --context <name> context inspect/version/info --format`白名单、15秒及1MiB输出界限，逐次隔离DOCKER_HOST/TLS/BUILDX等继承环境。收集context与default的endpoint/daemon一致性；只读存储适配按实际Desktop/WSL配置版本解析，不猜设置键。未知配置版本/链路即blocked；不运行WSL发行版来“探测路径”，不自动唤醒daemon。
- [ ] **Step4 GREEN：** 同上及`bun --no-env-file run typecheck`。Expected:全部通过；只有真实观察可在未来形成session，不产生readiness=true。
- [ ] **Step5 提交：** `feat(benchmark): validate local Linux engine prerequisites`。

### Task 2: Docker传输、准确所有权与操作证明

**Files:** Create `src/sandbox/{docker,ownership,receipt}.ts`, `test/linux-host/{docker,ownership,receipt}.test.ts`。

**Interfaces:** Consumes Task1；produces `makeDockerRunner({request,session?}):DockerRunner`, `createOwnedContainer({session,owner,spec,guard,signal}):Promise<Owner>`, `cleanupOwnedContainer({session,owner,guard}):Promise<{ended:boolean,removed:boolean}>`, `verifyOperationReceipt({receipt,manifest,evidenceRoot}):OperationReceipt`。无session runner可用于Task1首次只读观察，不能create/pull/exec；不会产生初始化循环。`spec`为strict、从冻结资源/image/挂载档案推导的create配置，不能夹带额外Docker flags。

- [ ] **Step1 RED：** 用实际子进程执行自建协议fixture验证字节、背压、取消/输出上限；记录型Docker测试注入create成功但响应丢失、inspect错ID/label/nonce/daemon、同名异主、generation更新、kill/rm失败。旧owner不得操作新容器；不能只按名称rm，也不能把cleanup失败写成ended。

```ts
expect(await cleanupOwnedContainer(staleOwnerInput)).toMatchObject({ ended: false, removed: false })
expect(destructiveCallsForForeignID).toBe(0)
expect(() => verifyOperationReceipt(tampered)).toThrow()
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/docker.test.ts ./test/linux-host/ownership.test.ts ./test/linux-host/receipt.test.ts --timeout 30000`。Expected:上述身份/有界传输失败。
- [ ] **Step3 实现：** 直接argv、无TTY，stdin/stdout二进制分离，不经PowerShell文本管道；容器label含完整Owner绑定。先create→inspect→guard→start，每次kill/rm前重验；create结果未知时只按本nonce查找并inspect，多个匹配即阻断人工处置。禁用持久候选stdout日志，元数据receipt不带原始stdout/环境/输入。cleanup只删除本次准确容器，不删共享依赖卷。
- [ ] **Step4 GREEN：** 同上+Task1三入口+包typecheck。Expected:0失败，无真正Docker运行；输出/超时与所有权负例均有实测协议证据。
- [ ] **Step5 提交：** `feat(benchmark): bind Docker operations to owned identities`。

### Task 3: 内容寻址工具链、四类库依赖与准备许可

**Files:** Create `src/sandbox/{dependencies,image-recipes}.ts`, `test/linux-host/dependencies.test.ts`。

**Interfaces:** Produces `planLinuxPreparation({request,inventory,catalogue,available}):PreparationPlan`, `prepareLinuxArtifacts({plan,approval,session}):Promise<ResolvedImages>`, `resolveTaskDependency({profile,images}):Gate<DependencyResolution>`, `finalizeHostManifest({preparedManifest,images,binaries,browser}):HostManifest`。最后一项只输出phase:accept且全部artifact已验证；缺字段不创建。`PreparationPlan`逐artifact含来源/精确版本/digest/平台/下载与解压上限/D盘落点/锁文件/审核过的安装命令及脚本hash；缺元数据不得执行准备。

- [ ] **Step1 RED：** 有tag无digest、浮动平台、锁文件/recipe/依赖卷漂移、缺LinuxBun或PDF工具、超磁盘预算、scope为accept却尝试pull、无准备授权均拒绝；已经缓存且全部身份匹配时不联网。四类SWE各有独立recipe，不能通用`npm install`蒙混。

```ts
expect(resolveTaskDependency(missingPdf)).toMatchObject({ kind: "blocked", code: "dependency_unresolved" })
await expect(prepareLinuxArtifacts(withoutApproval)).rejects.toThrow()
expect(networkOperationsDuringAcceptance).toBe(0)
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/dependencies.test.ts --timeout 30000`。Expected:严格来源/授权/可复现检查失败，不pull/build。
- [ ] **Step3 实现：** private/D2C/guardrail用固定运行时；Chart两题、react-pdf monorepo、marked分别从旧锁文件和真实package scripts建立recipe，冻结离线build命令及依赖mount布局。准备操作在单独批准的隔离builder内，不在Windows执行项目安装钩子；只运行逐条审核固定hash的脚本。创建内容寻址只读依赖卷前验证D盘daemon存储和空间；执行时按volume ID/内容清单复核，不自动改锁文件、安装或重建卷。PDF解析/raster工具及字体hash纳入档案。
- [ ] **Step4 GREEN：** 上述测试+Task1/2+typecheck。Expected:无daemon测试通过；真实准备未获授权则另列blocked，不能说依赖已准备。
- [ ] **Step5 提交：** `feat(benchmark): freeze Linux dependency preparation contracts`。

### Task 4: 真实候选导入、构建与非浏览器probe

**Files:** Create `src/sandbox/{linux-backend,archive,worker}.ts`, `test/linux-host/{archive,backend}.test.ts`。

**Interfaces:** `makeLinuxBackend({session,images,runner,guard}):LinuxBackend`；backend提供`build(BuildRequest):Promise<RawBuild>`, `probe(ProbeRequest):Promise<RawProbe>`, `stop(Owner):Promise<void>`，Raw结果含OperationReceipt、构建文件清单或ProbeResponse/失败分类，**不自行声明assurance**。Task5增加受控preview能力。Consuming B-Prep1 `probeWorkerSource()`/有界`store/fixtures/$ref`，不复制oracle比较逻辑。

- [ ] **Step1 RED：** 解包穿越、绝对/Windows设备路径、大小写碰撞、link/hardlink/device、超profile文件数/大小、archive hash错均在执行前拒绝；真实自建加法/状态工厂wrong→correct→alternate的输出符合字面预期。旧dist、改受保护worker/依赖/source、未知build命令、空/多行/伪造pass、超长probe结果不得通过。

```ts
expect(() => decodeProbeResponse(Buffer.from('{"passed":true}'))).toThrow()
expect(exported.files.some((f) => f.path === "private/canary.txt")).toBe(false)
expect(originalSnapshotShaAfter).toBe(originalSnapshotShaBefore)
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/archive.test.ts ./test/linux-host/backend.test.ts --timeout 30000`。Expected:导入/构建/worker合同失败；真实Linux部分只写进accept入口，不在Windows导入真实候选。
- [ ] **Step3 实现：** 校验原始snapshot后，仅复制公开候选到本次D盘可丢弃目录，按manifest重建并在Linux执行；只读依赖卷/driver挂载与候选目录分开，检查前后源/config/受保护路径hash。旧产物先在工作副本中按预登记输出路径排除，再构建并导出有界普通文件，拒绝链接和源/产物互相覆盖；不删原语料dist。生产96MiB档案上限不变，独立snapshot沿原8MiB单文件/64MiB总量/文件数限制，不把归档重复计费。候选stdout是不可信数据，不据它签名；worker走独立受控协议端，候选的日志/附带fd不获authority。错误健康执行可记candidate_failure，驱动/传输/清理不明即harness_error或blocked。
- [ ] **Step4 GREEN：** 同上+已有independent的snapshot/probe/functional测试+typecheck。Expected:所有静态/自建fixture验证通过；真Linux运行待Task8授权，不能提前宣称passed。
- [ ] **Step5 提交：** `feat(benchmark): execute immutable candidates in Linux sandboxes`。

### Task 5: 静态预览与HTTP-over-stdio relay

**Files:** Create `src/sandbox/{relay-protocol,relay-worker,preview}.ts`, `test/linux-host/{relay,preview}.test.ts`。

**Interfaces:** `startLinuxPreview({backend,request,owner,policy,signal}):Promise<PreviewLease>`，`PreviewLease`含opaque capability、previewID(64hex)、loopback URL、build hash、公开asset manifest及`stop():Promise<void>`；`RelayPolicy`仅`methods:readonly string[],paths:readonly string[]`与规格固定上限；`relayHttp({lease,request}):Promise<BoundedHttpResponse>`。不接受任意target URL/host/port。

- [ ] **Step1 RED：** 实际自建loopback fixture测试GET/POST、二进制、取消/背压，以及chunked+content-length/重复header、CRLF、CONNECT、upgrade/WebSocket、编码穿越、重定向跨源/第4跳、Host伪造、错capability/run/lease和错误build；静态服务不可读同run其他文件。合法1MiB请求、8MiB响应、32KiB headers边界可过，各超1byte拒绝。

```ts
expect(await relayHttp(connectAttempt)).toMatchObject({ status: 405 })
expect(await relayHttp(crossRunAttempt)).toMatchObject({ status: 404 })
expect(realCanaryHitsOutsideAdmittedPath).toBe(0)
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/relay.test.ts ./test/linux-host/preview.test.ts --timeout 30000`。Expected:上述协议边界失败，不启动项目服务。
- [ ] **Step3 实现：** 容器network none，候选HTTP服务只监听容器loopback；可信relay-worker仅固定端口/路径，走长度有界stdio frames。控制器提供独立127.0.0.1随机端口、每preview独占origin及64hex URL路径，严格Host/path，不转发broker Authorization/Cookie/任意代理头。最多3次同源redirect、每请求30秒；只有manifest内产物可静态读取。`--network none`不通过publish端口解决。拒绝非HTTP能力，不隐式开放WebSocket。lease失效立刻关入口/在途请求，再结束准确容器。
- [ ] **Step4 GREEN：** 同上+backend/ownership+typecheck。Expected:真实合成HTTP协议通过；实际Linux服务由Task8验证。超限/未知协议不能降级转发。
- [ ] **Step5 提交：** `feat(benchmark): isolate previews behind a bounded stdio relay`。

### Task 6: 真宿主assurance、页面probe与控制器事实

**Files:** Create `src/sandbox/{evaluation-host,browser,browser-helper,controller-facts}.ts`, `test/linux-host/{authority,browser,facts}.test.ts`; Modify仅`src/evaluator/independent/{host,index,visual,result,publication}.ts`及对应5个测试。

**Interfaces:** `authorizeLinuxHost({manifest,engineReceipt,evidenceRoot}):LinuxAuthority`；`makeLinuxEvaluationHost({backend,authority,browser}):EvaluationHost`；`makeLinuxBrowser({release,previewRegistry,roots}):IndependentBrowser & {probe(request:ProbeRequest):Promise<RawProbe>}`；`makeControllerFactsObserver({requirementPlans,browser,authority,evidenceRoot}):ControllerFactsObserver`。新增`RequirementProbePlan`为私有data-only判据：`case`(已比较caseID)、`dom`(selector/count/text/可见性)、`interaction`(固定观察名)、`file`(有界源码静态事实)，每条id对应既有mandatory/weight，不接受JS/eval或模型自报值。`makeIndependentEvaluator` options新增显式controllerFactsObserver，evaluate接受LinuxEvaluateInput；严格验证dependency resolution的recipe/lockfiles/image/platform/receipt与profile匹配，缺少仍blocked。

- [ ] **Step1 RED：** 把fixture字段改成linux、JSON克隆authority、丢operation receipt、跨run/daemon/源码/CLI重用、持久化重读篡改均拒绝。真实页面probe只传公开module及inputs，不传expected；Chart/marked由新browser helper执行、PDF由Linux解析driver执行。缺mandatory/selector映射、少72交互断言、缺任一视口/browser/font不合格，不调权。一般attemptID不能冒充previewID；caps64hex且证据仍绑定原attempt。

```ts
expect(() => authorizeLinuxHost(fixtureOnlyReceipt)).toThrow()
expect(forgedLinuxOutcome.kind).toBe("harness_error")
expect(guardrailResult).toMatchObject({ visual: null, viewportScores: null, diagnosticTotal: null })
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/authority.test.ts ./test/linux-host/browser.test.ts ./test/linux-host/facts.test.ts --timeout 30000`。Expected:Linux接缝/证明/事实缺失失败。
- [ ] **Step3 实现：** 共用host验证逻辑但fixture和Linux签发器分离；既有fixture不得调用Linux签发器。result/publication扩为闭合assurance union，Linux分支必须携带并重验引擎/操作链；不只放宽字符串。先执行build/probe/visual，再由observer产并绑定facts，最后原规则评分；不重复跑代码来凑前置facts。健康候选构建失败时按完整失败receipt记录未观测项，仍走原candidate_failure，不假造通过或截图。新browser helper使用同一冻结WindowsChromium/字体/locale/timezone，隔离profile；禁service worker、所有WebSocket、file/data顶层导航、互联网/broker/跨cap资源，保留浏览器沙箱，真实本地canary验证零命中。页面返回值不可信，控制器比较；需求/质量/策略事实由可信观测生成，不由调用者传几个true。无mapper仍blocked。保留旧分值和candidate_failure/harness_error区别。
- [ ] **Step4 GREEN：** 上述3入口+全部现有11个independent测试+browser-protocol/runtime回归+typecheck。Expected:fixture结果字节语义不变；合成Linux证据负例全过，不能把合成runner记成engine_verified。
- [ ] **Step5 提交：** `feat(benchmark): verify Linux evaluation authority and browser facts`。

### Task 7: 公开MCP工具桥与准确二进制能力验证

**Files:** Create `src/sandbox/{public-tools,mcp-server,capability}.ts`, `test/linux-host/{tools,capability}.test.ts`。现有arms配置/启动函数只读复用，不修改A角色/权限；新的能力微测试在本模块组合，不改旧run/resume。

**Interfaces:** `makePublicToolHost({workspace,profile,backend,preview,guard}):PublicToolHost`提供`read({path,offset,length})`,`write({path,baseSha256,content})`,`check({commandID})`,`preview({entry})`,`capture({previewID,viewportID})`；参数只可选该题公开profile中的值。`servePublicMcp({host,stdio,capability}):Promise<void>`实现现有SDK的stdio tools/list/call，不暴露资源/gold/任意shell。`verifyBinaryCapabilities({binary,armID,session,tools,fakeProvider,isolation}):Promise<CapabilityReceipt>`。`isolation`为显式注入的`HostIsolationAdapter`，提供`verify()`和受约束的`launch()`，绑定准确launcher/exe/token或预配置账户、文件及网络策略和子进程约束；无已核验adapter时无默认native spawn。首版不实现系统安装/新账户/ACL变更器，缺适配器就停止准确exe验收，单列需审阅的环境方案。

- [ ] **Step1 RED：** 写保护测试/.opencode/package/锁文件、越界链接/硬链接、旧baseSha、任意argv、MCP污染stdout、工具预算取消/lease丢失拒绝。自建MCP客户端走真实stdio，不只spy。伪造exe/version、绕过bridge的内置工具/项目插件访问真实存在canary或互联网，均阻断；不得只靠配置deny证明隔离。

```ts
await expect(host.write(protectedConfigEdit)).rejects.toThrow()
expect(await verifyBinaryCapabilities(noOsIsolation)).toMatchObject({
  status: "blocked",
  code: "tool_capability_blocked",
})
expect(networkCanaryHits).toBe(0)
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/tools.test.ts ./test/linux-host/capability.test.ts --timeout 30000`。Expected:工具及隔离边界失败；不运行准确exe或真实provider。
- [ ] **Step3 实现：** B–E用冻结版本支持的local MCP command数组，绝对可信Bun路径、`--no-env-file`、禁npx下载。A走真实生产visual/coding入口和原工具策略，不通过新增planner伪造完整流程。两种准确runtime分别做visual/coding公开能力微测试，A–E逐route假provider驱动“发现已知错→允许范围修复→真实check→preview/capture”，另含只读角色负例；不是完整语料矩阵。修改版探针exe独立构建到toolchain，不替换部署；官方最新版在准备期只解析一次官方release/tag/commit/hash，不使用历史版本号猜最新，不给官方打补丁。Windows agent启动与所有子进程必须有实际OS执行/文件/网络约束证据，可信broker仅允许fixture loopback endpoint；同用户不可信代码可读gold时明确blocked。当前无适配能力则不执行二进制，提出单独授权的最小隔离方案，不在本任务自动创建账户/ACL或改变系统策略。
- [ ] **Step4 GREEN：** 上述2入口+已有arms/config/direct/workflow/process/upstream及e2e/leakage回归+typecheck。Expected:无daemon回归通过；准确A–E真能力receipt待环境许可后由Task8收集，失败不削弱对照组工具。
- [ ] **Step5 提交：** `feat(benchmark): expose equivalent public sandbox tools`。

### Task 8: 显式授权的真实Linux安全与生产能力矩阵

**Files:** Create `src/sandbox/acceptance.ts`, `script/accept-linux-host.ts`, `test/linux-host/acceptance.test.ts`。

**Interfaces:** `acceptLinuxEngine({session,manifest,approval,backend,capabilityVerifier,signal}):Promise<EngineAcceptance>`；`EngineAcceptance={status:"passed",receipt:EngineReceipt}|{status:"blocked"|"failed",checks:readonly CheckResult[]}`。CheckResult为id/status/evidence/code，不接受裸passed；receipt在所有必选检查真实执行且通过后发布。缺授权/条件blocked退出2，验收失败退出1，真实全通过退出0；默认测试仅测编排和自建fixture，不启动Docker、不静默skip。

- [ ] **Step1 RED：** 缺任一真实必选项、只有模拟、旧receipt、canary服务未健康、残留容器、他人容器被误操作，都不能passed；缺accept授权runner创建数0。生产context与指定daemon不一致必须在启动前阻断。

```ts
expect(acceptanceWithOneNotRun.status).not.toBe("passed")
expect(receiptFromFixture).toBeUndefined()
expect(foreignContainerSurvived).toBe(true)
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/acceptance.test.ts --timeout 30000`。Expected:遗漏/伪造矩阵不能过；无实际Docker。
- [ ] **Step3 实现并在获准后运行矩阵：** 以下每行有实际OperationReceipt、inspect及宿主前后哨兵hash；不能仅凭参数字符串：

| 类别                   | 实测内容/通过条件                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| engine/storage/image   | daemon Linux/架构/ID/context及default一致；CLI/image/磁盘身份替换立即stale；D盘实址有证据                                                                                     |
| privilege/root         | UID/GID65532、cap有效集为0、NoNewPrivs、root写失败、无socket/宿主设备、非允许宿主路径不可达                                                                                   |
| network/canary         | 只有loopback、无默认路由；控制器先对真实可服务canary证明可达，再验证容器不可达且命中0；非可达未知目标不能作证                                                                 |
| mounts/archive         | readonly实际写失败；implement/repair仅当前候选可写；只读角色写失败；生产stdin archive哈希对应真实可丢弃check副本                                                              |
| build/noexec/dotenv    | 自建错误→正确代码和真实库build实际执行；临时可执行wrapper直接exec失败、正常解释JS可用；放入真实dotenv canary且嵌套Bun不加载                                                   |
| bounded resources      | inspect+cgroup实值核对CPU/内存/PID；固定有限子进程尝试及一次有上限内存压力验证拒绝/OOM，宿主健康哨兵不变；墙钟/输出限额真实中断。先核准daemon可用资源，不做无限fork或内存耗尽 |
| preview/browser/PDF    | 一个真实Chart/marked库构建静态页、一个自建真实HTTP服务relay、一个真实PDF解析/raster；三视口/键盘交互可用，broker/file/外网/跨run/WebSocket被阻止                              |
| exact production/tools | 准确修改版原生产checks/preview策略与A–E能力微测试实际通过，不能用benchmark backend替代A生产证据                                                                               |
| cancellation/recovery  | create未start、运行中、建/评测/preview孤儿；只按ID+nonce回收；旧generation无权动新资源；cleanup失败保留blocked与准确ID                                                        |
| foreign isolation      | 同名异主、另一run容器和用户已有容器/卷/证据全保留；正/负/取消结束后本次准确容器均证明已停止                                                                                   |

- [ ] **Step4 GREEN：** 软件测试+typecheck先过；未来获准后显式`& $BPrep2Bun --no-env-file run ./script/accept-linux-host.ts --manifest <verified-D-manifest> --approval <accept-scope-record>`。Expected:实际全矩阵通过才exit0/engine_verified；任何未运行都列not_run并非零。缺环境不延长旧测试时限/改断言。
- [ ] **Step5 提交：** `test(benchmark): attest the real Linux sandbox matrix`；真实receipt/private证据留D，仓库仅通用代码和脱敏摘要。若环境未批，可提交软件但不能完成本任务真实验收或B-Prep2。

### Task 9: 16题严格档案收口与全部校准实测

**Files:** Create `src/corpus/evaluation-finalize.ts`, `src/sandbox/calibration.ts`, `test/linux-host/calibration.test.ts`。

**Interfaces:** `finalizeLinuxCorpus({authoredRoot,outputRoot,manifest,authority,images,referenceCapturer,requirementPlans}):Promise<FinalizedCorpus>`；`calibrateLinuxCorpus({corpus,authority,evaluator,signal}):Promise<CalibrationReport>`。FinalizedCorpus含16严格bundle/hash和source/authoring/engine依赖链；CalibrationReport逐候选记录预登记label、实际functional/visual/policy结果及证据，明确哪些not_observed，缺项不能ready。

- [ ] **Step1 RED：** 任一缺题/少control/改预登记预期/无需求映射/错误browser字体/非实际三视口/过期build/真canary泄露/跨run证据都拒绝；同正确候选两次语义结果一致，alternate可通过，seed/functional/visual/responsive/policy负例符合原登记，guardrail浏览器调用0。不得拿构建失败代替单点功能错或把harness错误当模型0分。

```ts
expect(report.taskCount).toBe(16)
expect(report.distinctControlCount).toBe(104)
expect(report.primaryTasks).toBe(12)
expect(report.guardrailTasks).toBe(4)
expect(report.unobservedRequiredChecks).toHaveLength(0)
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/calibration.test.ts --timeout 30000`。Expected:严格收口/遗漏/假就绪负例失败；这里只执行自建合成夹具。
- [ ] **Step3 实现：** 从B-Prep1只读材料生成新根。原公开需求逐条映射RequirementProbePlan，人工按原语义核对，不改mandatory/weight；若无法映射留blocked，不删除需求。profile的probeModules与实际保护的公开驱动一致，分别走Node/browser/PDF路径。private/D2C用保留的参考源，库用正确控制真实build和共同公开fixture，在同Windows浏览器/字体/三视口重新采集真实参考PNG/DOM；参考准备不把隐藏目录挂入候选容器。严格oracle绑定新文件，来源/掩码/容差不改，guardrail仍visual:null。全104个distinct候选各评测一次，再对每题correct重复一次（共120次独立评测），只用于确定性/校准，无模型调用；额外攻击探针单独计数，不改104分母。判定预期在运行前绑定，任何不符停止就绪并报告题号/原因，不根据得分选题、调门槛或重写预期。真实存在canary控制器可读、候选与工具不可达；每次评测先确认生成进程结束，候选原件前后不变。
- [ ] **Step4 GREEN：** 合成校准测试+全部independent回归+typecheck；未来获准的真实120次评测全部完成且符合原预期后才`corpus_engine_ready=true`，否则部分结果/阻断完整保留。语义稳定hash与时间/资源观测分开，不要求墙钟字节相同。
- [ ] **Step5 提交：** `test(benchmark): calibrate all independent tasks on Linux`；隐藏答案/参考/修复不入Git，不覆盖原evaluation-v2。

### Task 10: 独立入口、就绪发布与最终收尾

**Files:** Create `script/linux-host.ts`, `test/linux-host/command.test.ts`, `docs/superpowers/reports/2026-10-17-task24b-linux-host-verification.md`；不修改旧`src/cli.ts`/campaign current。

**Interfaces:** 独立命令固定子操作`inspect|plan-preparation|prepare|accept|calibrate|verify`，其实现消费前9任务；所有root/request/manifest/approval均显式命名参数。inspect/plan-preparation可从HostRequest启动，不要求未准备的准确exe/hash；accept/calibrate只接受phase:accept。`verifyLinuxReadiness({root,manifest}):Promise<Gate<{engine:EngineReceipt,capabilities:readonly CapabilityReceipt[],corpus:CalibrationReport}>>`要求3组同身份全通过，保留软件与真实验收两个结果。最终发布`linux-readiness.json`和完整证据清单，immutable重读，绝无paid入口/授权生成/seal激活。

- [ ] **Step1 RED：** 命令实际子进程测试unknown flags、缺mode/授权/daemon/盘位、跨acceptance重放、证据缺失/截断、任一false/skip、同名不同内容发布拒绝；verify不create/pull；默认调用不得进入准备或接受。只通过软件时输出明确部分进度，exit2而非ready。

```ts
expect(await runCommand(["accept", "--manifest", fixtureManifest])).toMatchObject({ exitCode: 2 })
expect(await runCommand(["paid"])).toMatchObject({ exitCode: 1 })
expect(readinessWithNotRun.kind).toBe("blocked")
```

- [ ] **Step2 跑RED：** `& $BPrep2Bun --no-env-file test ./test/linux-host/command.test.ts --timeout 30000`。Expected:模式/证据/授权检查失败，不触发真实Docker。
- [ ] **Step3 实现：** 命令、help、脱敏错误和最终readiness清单；日志仅保留ID/hash/计数/分类，不落原始候选stdout、模型SSE、Authorization、oracle输入/期望。无环境时输出具体未做项和准备申请，不把未实现项包装成环境缺失。receipt变化失效测试覆盖源码/exe/profile/策略/CLI/context/daemon/image/storage/browser/字体/依赖卷/校准清单各一项。
- [ ] **Step4 联合GREEN：** benchmark包先运行19个新测试的显式文件列表（见下），再`& $BPrep2Bun --no-env-file test --timeout 30000 --only-failures`及`& $BPrep2Bun --no-env-file run typecheck`。Expected:完整退出0，旧skip逐名保留、不加skip/放宽时限。若实际触及其他包，运行其完整检查；生产源码无修改时不重构建部署。准确exe测试使用新toolchain探针制品。未来获准的真实accept/calibrate/verify必须分别exit0，才将后三项状态标true；未获授权不执行。
- [ ] **Step5 一次整体审查：** 沿既定executing-plans，只在全部软件实现后做一次全范围新上下文审查；Critical/Important各自RED→GREEN+完整包回归，Minor列明，不做无限复审。审查包含全部Review Focus和运行不了的边界，不能靠假runner的断言自证安全。
- [ ] **Step6 收尾提交/push：** 报告列实际命令、四项就绪状态、环境许可与准确身份、每个真实未运行/失败项、120次评测的实际数量、源码/部署保护hash。先保存最终证据，按明确owner目标清自建临时/容器，拒绝/策略阻断即列残留，不绕过；保留用户资料/原语料/共享依赖镜像卷。通过获批范围后提交`test(benchmark): publish Linux host readiness evidence`，正常push fork/dev核对远端SHA和干净工作区；环境阻断时不得称B-Prep2全部完成。停止，不进入B-Prep3/付费/部署。

新19入口显式命令，cwd必须为`D:\OpenCode-Audit\packages\benchmark`，执行前设置独立D盘HOME/XDG/TEMP/Bun/npm缓存、清provider变量，并使用可信绝对Bun和`--no-env-file`；嵌套Bun采用已验证的同样无dotenv启动机制：

```powershell
& $BPrep2Bun --no-env-file test ./test/linux-host/contracts.test.ts ./test/linux-host/preflight.test.ts ./test/linux-host/storage.test.ts ./test/linux-host/docker.test.ts ./test/linux-host/ownership.test.ts ./test/linux-host/receipt.test.ts ./test/linux-host/dependencies.test.ts ./test/linux-host/archive.test.ts ./test/linux-host/backend.test.ts ./test/linux-host/relay.test.ts ./test/linux-host/preview.test.ts ./test/linux-host/authority.test.ts ./test/linux-host/browser.test.ts ./test/linux-host/facts.test.ts ./test/linux-host/tools.test.ts ./test/linux-host/capability.test.ts ./test/linux-host/acceptance.test.ts ./test/linux-host/calibration.test.ts ./test/linux-host/command.test.ts --timeout 30000
```

执行时`$BPrep2Bun`精确为`D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`，SHA256=`0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`；这个WindowsBun只运行控制器/测试，不能代替镜像内Linux运行时证明。

## 4. 官方依据与计划自检

截至本计划核查日2026-10-17，仅依据官方文档确认一般语义，不用文档替代准确环境实测：

- none网络仅有容器loopback，因此使用stdio relay而非开放端口。[Docker none](https://docs.docker.com/engine/network/drivers/none/)
- Docker Desktop WSL数据默认可能落C，swap有独立配置，因此分别验证。[Docker WSL存储](https://docs.docker.com/desktop/features/wsl/)、[Microsoft WSL配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- bind默认可写且针对daemon所在主机，readonly需实测；只接本地daemon。[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)
- context可指不同endpoint；create默认pull策略不是never，所以所有验收显式never。[Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)、[container create](https://docs.docker.com/reference/cli/docker/container/create/)
- 官方支持local MCP command数组；仍需冻结准确版本并实际验证工具隔离。[OpenCode MCP](https://opencode.ai/docs/mcp-servers/)

规格覆盖：3.1–3.3→Task1/2/3/6/10；4.1–4.4→Task4/5/6/9；5.1→Task7/8；6.1→Task1/3，6.2–6.3→Task2/4/8；第7节独立评测及Linux门槛→Task8/9/10。真实run/resume/cancel、费用账本与15/12-cell执行矩阵归B-Prep3；新seal/联合Task24A归B-Prep4，不遗漏也不抢做。

接口自检：HostRequest→Inventory→prepare清单/许可→实际准备→accept清单/许可→session/矩阵，冷启动不要求预知daemon或未构建exe哈希；只读runner不依赖session。Task1仅产session不冒充attestation；Task2/4原始操作与Task6签发器分离；Task8真实矩阵通过才产EngineReceipt；Task9据此跑校准；Linux facts在真实观察后生成。Task10要求全部同身份，打破“先假定就绪才能验收”的循环。Review Focus五项分别落到其任务RED负例。只读依赖、候选副本、gold、浏览器和控制器根互不重叠；旧B-Prep1材料完整保留。

范围自检：本轮只写本文件并核查源码/官方文档；没有执行上述尚待实现的命令、容器/安装/下载、付费、部署或源码改动。等待用户审阅后沿既定本会话顺序实施；具体环境副作用仍受分级许可约束。
