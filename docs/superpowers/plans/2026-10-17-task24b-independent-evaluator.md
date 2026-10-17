# B-Prep1 Independent Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本项目已选定本会话顺序实施，使用 executing-plans；不重新询问执行模式。

**Goal:** 新增与生成工作流独立的 v2 任务档案、库/页面评测及非视觉结果合同，通过零额度控制样本验证正确性，并为 B-Prep2 输出明确的宿主/语料准备清单。

**Architecture:** 新模块放在 benchmark 包的 corpus 与 evaluator 下，不扩写历史 offline campaign 巨型实现。受信任控制器持有 oracle，只把公开输入传给显式注入的执行宿主；默认没有宿主则拒绝执行，不在 Windows 主进程导入候选代码。保留 v1 评分与历史结果，新 v2 包装层区分视觉主任务、guardrail、环境阻断和评测故障。

**Tech Stack:** 已有 Bun1.3.14、TypeScript、Effect Schema、Node、Playwright/Chromium、sharp；不新增运行依赖，不安装库、浏览器、镜像或系统组件。

**Spec:** [2026-10-17-opencode-task24b-readiness-design.md](../specs/2026-10-17-opencode-task24b-readiness-design.md)，用户已确认。重点实现第3–4节及第7节的评测前置条件；不实现 B-Prep2/3/4。

**Status:** 2026-10-17 用户已确认并授权本计划实施；实施基线 `19ae30d1469caa3f140b381c2caac232f7898a57`。付费、Docker准备和部署替换仍不授权。

## Global Constraints

- 只在现有 `D:\OpenCode-Audit` 的 `dev` 工作，保留用户修改，不另建隔离分支；每个任务验证通过后提交，最终正常 push `fork/dev`，不强推、不绕过 hooks。
- 不读取真实 Key 或 `.env.local`，不调用真实生成或 `/models`；不替换 `D:\OpenCode-Local`、旧 `dist`、回滚制品或历史 seal/current pointer。
- 不启动/安装/迁移 Docker，不拉取镜像，不改系统隔离策略。实际 Linux 适配、MCP/公开工具桥、HTTP relay 实现归 B-Prep2；真实五组循环、账本组合归 B-Prep3；新 campaign seal/二进制归 B-Prep4。
- 主语料固定12题，private/Design2Code/SWE-bench Multimodal各4题；guardrail另4题；不得替换题、改任务类别或按结果筛题。
- pilot 固定 `private-analytics-dashboard`、`d2c-g29-spelling-bee`、`swe-chartjs__chart.js-10157`，每题A–E一次，严格15cells；guardrail正式矩阵为4题×A/B/C一次，共12cells。本计划不执行任一付费矩阵。
- 主任务视觉合格75、每视口65；视觉权重35/20/25/10/10，诊断45/30/10/10/5不变。固定视口390×844、768×1024、1440×900，DPR1；不修改已有 `evaluateScore` 或效果统计阈值。
- guardrail 的 `visual`、`visualComposite`、`viewportScores`、`diagnosticTotal` 必须是 `null`，只输出 `functionalQualified` 和适用维度，不补零、不重分配权重、不混入视觉排行。
- gold、期望值、校准修复、隐藏断言在受信任控制器侧；不进入 Location、候选归档、宿主请求、模型上下文或公开夹具。公开题面明确给出的参考图另按公开输入身份处理。
- v1 文件、schema、offline 入口、报告和快照保持不变。新档案及语料写新版本目录，不原地改 `D:\OpenCode-Benchmark\Task24\assets\tasks`。
- 不改生产工作流、旧视觉合同、角色权限、事件存储、租约/重试/预算算法或模型路由；不改公开 Server/Protocol API，不生成客户端。
- 全部临时目录、日志、缓存、浏览器 profile 位于 D。只清理本计划可证明自建的精确目标；不处理前次被策略阻止清理的目录、不删除共享目录/镜像、原始取证或不明归属文件。
- 不在 Windows 宿主执行/导入语料或模型产出的候选代码。测试自建的已知驱动夹具可验证协议，但必须标识 `fixture`，不能当作 Linux 证据或真实跑分。
- 不放宽旧测试断言/时限，不新增“没有Docker也算通过”的 skip。发生超范围基线问题先给证据，再单独申请最小修复。

## Review Focus

1. 候选伪造 `passed=true`、读取 oracle 或污染同进程 judge：Task3验证只传输入、控制器比较、无默认宿主；Task6验证缺少权威证据不能发布。
2. 构建产物过期、源码/配置/归档不一致、Windows链接或大小写逃逸：Task2真实文件系统测试，Task4/6再次核对构建与最终源码哈希。
3. 公开截图合法地与gold同字节，但修复答案/隐藏参考不得泄露：Task1/5通过来源白名单区分，不采用“所有重复哈希都拒绝/都允许”。
4. 老库依赖/构建或PDF渲染未准备，却被静态HTML/反向补丁回退冒充通过：Task5逐题档案与缺失项报告，Task6保持 blocked。
5. 浏览器/宿主故障被算作模型失败、guardrail伪造视觉分、缺分量后调权：Task4固定边界测试，Task6验证 outcome 和历史v1兼容。

## 范围与完成口径

B-Prep1完成的是评测软件、严格档案、公共适配夹具和校准输入准备；不是证明16题已在Linux运行。已缓存的普通文件可用于档案核查，不读取或执行真实凭据/外部项目。

有两层记录：`software_verified` 表示本计划测试通过；`corpus_engine_ready` 只有B-Prep2的真实Linux构建、参考捕获和隔离证明通过后才可为true。缺少依赖镜像、PDF raster能力、库构建证明或三视口参考时，必须有逐题 `blocked` 清单，不能用占位digest、假PNG或fixture证据补齐。B-Prep4必须同时要求两层就绪。

这并非降低“16题完整评测”的总要求，而是把其真实引擎部分明确交给已划定的下一分段。本计划不产生 `pilot_ready=true` 或可用的付费授权。

## File and Interface Map

下列路径相对于 `packages/benchmark`；均为新增，除明确说明的验证报告外不修改旧生产模块。

| 文件                                                                                                                          | 职责/归属任务                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/corpus/evaluation-profile.ts`                                                                                            | v2公开profile、私有oracle、严格JSON类型及解码，Task1           |
| `src/corpus/evaluation-bundle.ts`                                                                                             | 独立bundle校验、公开导出、内容身份，Task1                      |
| `src/evaluator/independent/snapshot.ts`                                                                                       | 有界无链接候选归档、工作副本和配置指纹，Task2                  |
| `src/evaluator/independent/host.ts`                                                                                           | B-Prep2宿主接口、失败关闭的默认组合，Task3                     |
| `src/evaluator/independent/probe.ts`                                                                                          | 有界输入/结果协议与受信任worker字面源码，不负责启动候选，Task3 |
| `src/evaluator/independent/functional.ts`                                                                                     | oracle比较、功能事实及已执行断言计数，Task3                    |
| `src/evaluator/independent/visual.ts`                                                                                         | 构建产物绑定、捕获/交互事实、复用固定视觉评分，Task4           |
| `src/evaluator/independent/result.ts`                                                                                         | v2结果union和主任务/guardrail合格判定，Task4                   |
| `src/corpus/evaluation-catalogue.ts`                                                                                          | 固定16题的适配/要求注册表，Task5                               |
| `src/corpus/evaluation-author.ts`                                                                                             | 只读旧来源、准备新版本夹具/oracle/校准材料，Task5              |
| `src/corpus/evaluation-fixtures/{private,design2code,chartjs,react-pdf,marked,guardrail}.ts`                                  | 各类公共夹具模板；只有公开接口/输入，不含正确实现，Task5       |
| `script/prepare-independent-corpus.ts`                                                                                        | 显式root与新输出目录的准备命令，不激活campaign，Task5          |
| `src/evaluator/independent/index.ts`                                                                                          | 冻结输入→调用宿主→独立评测→结果的唯一组合，Task6               |
| `src/evaluator/independent/publication.ts`                                                                                    | 验证证据、不可变发布和校验重读，Task6                          |
| `test/independent/fixture.ts`                                                                                                 | 本计划共享合成夹具与精确归属清理，Task1起按需扩展              |
| `test/independent/{profile,bundle,snapshot,probe,functional,visual,result,catalogue,author,orchestrator,publication}.test.ts` | 对应11个测试入口，不包含共享助手                               |
| `docs/superpowers/reports/2026-10-17-task24b-independent-evaluator-verification.md`                                           | 任务结果、范围、阻断项和后续交接；Task6新增，不能提前写成功    |

重用：`campaign/canonical.ts`、`hash.ts`、`corpus/manifest.ts`的已有安全数据工具、`evaluator/{evidence,functional,visual,requirements,quality,accessibility,policy,score}.ts`、`browser-runtime.ts`及`offline/atomic.ts`的不可变发布。发现安全语义不满足时只在新模块做更严格校验，不静默改变v1实现。

## 共用类型与安全默认值

Task1拥有以下名字，后续任务不可另造同义字段：

- `TaskExecutionProfile`：`schemaVersion:2`，`taskID`、`kind:primary|guardrail`、`stratum`、`executionKind:visual-build|coding-build`、`seedSha256`、`publicFixtureSha256`、公开输入清单、`sourceEntry`、`probeModules:string[]`、受保护/可改路径、有限argv检查清单、依赖要求、预览类型及限制。文件记录统一为已有 `FileEntry {path,sha256,size}`；probe只能选择声明模块，预览入口独立于源码模块。
- 检查项 `CheckCommand`：`id:test|build|typecheck|lint`、相对`cwd`、非空字符串数组`argv`、`timeoutMs`、`required`。argv仅来自Task5的固定档案，不接受shell字符串/模型覆盖；不执行package安装钩子。
- `DependencyRequirement`：`kind:none`，或`kind:locked`加来源commit、锁文件清单、`recipeSha256`、`requiredCapabilities:string[]`。实际镜像digest由B-Prep2 `DependencyResolution`绑定这些字段；未解析时返回blocked，绝不生成假digest。
- `DependencyResolution`：`kind:none`，或`kind:resolved`加`recipeSha256, lockfiles:FileEntry[], image, platform, receiptSha256`；image必须是带`@sha256:`的精确镜像引用，其他哈希按已有Sha256验证。Task1定义数据合同，B-Prep2才提供真实解析/权威证明；B-Prep1仅可为本计划无依赖合成题使用none，不伪造resolved。
- `EvaluationOracle`：`schemaVersion:2`、`taskID`、私有功能cases、需求/策略/质量断言、视觉参考/掩码/容差（guardrail必须null）、校准候选清单。输入与期望值分开；断言只允许确定性的equal/deep-equal/throws/带显式有限容差的number比较，不接受eval/任意回调代码。
- `ValidatedEvaluationBundle`：控制器持有的`root, profile, oracle, profileSha256, oracleSha256, seedSha256, publicFixtureSha256, bundleSha256`；本对象不传给宿主。`PublicEvaluationTask`仅含profile和已授权的公开文件。
- `EvaluationIdentityV2`：`schemaVersion:2, campaignID, runID, attemptID, leaseGeneration, taskID, armID, repeat, campaignSha256, binarySha256, routeSha256, profileSha256, oracleSha256, seedSha256, candidateSha256, evaluatorSha256`。ID/哈希复用已有验证规则，generation为正整数，repeat为非负整数。

Task2的归档限制：编码后至多96MiB、解码文件内容合计至多64MiB、单文件至多8MiB、至多20,000文件；路径采用 `/`，拒绝大小写冲突、ADS、Windows保留设备名及尾点/尾空格，不放宽生产96MiB限制。依赖包不塞入候选源码归档。

Task3的probe：单请求/单响应至多1MiB，每批至多1,000个操作，超时最多30秒；仅允许相对模块导入及 `call/method/get` 的有序JSON输入/结果。结果只描述值、抛错、退出或资源失败，不接受 `passed`/分数/期望值字段。

Task4的HTTP预览能力仅声明合同：body请求1MiB、响应8MiB、headers32KiB、30秒、同源重定向3次；不实现relay或扩大已有浏览器v1协议。需要旧协议不具备的交互/捕获能力时返回明确能力缺失，留B-Prep2实现，不缩减隐藏断言。

## 验证命令约定

所有下面的Run均在确认的 `D:\OpenCode-Audit\packages\benchmark` 执行，预先定义：

```powershell
$BPrep1Bun = 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe'
if ((Get-Location).Path -ne 'D:\OpenCode-Audit\packages\benchmark') { throw 'Wrong package directory' }
```

命令前按既有D盘策略设置任务专用TEMP/TMP/TMPDIR、XDG、Bun/npm/浏览器缓存，并清除provider Key环境变量、关闭模型发现/下载及录制；不读取真实env。使用显式原生argv，不使用条件表达式产生的scalar字符串splat、盘根、目录/glob测试参数或其他项目测试。每条命令检查退出码，日志只写本计划自建的D盘目录。

---

### Task 1: v2档案、oracle和公开/私有bundle

**Files:** Create `src/corpus/evaluation-profile.ts`, `src/corpus/evaluation-bundle.ts`, `test/independent/fixture.ts`, `test/independent/profile.test.ts`, `test/independent/bundle.test.ts`。

**Interfaces:** Produces `decodeTaskExecutionProfile(input:unknown):TaskExecutionProfile`、`decodeEvaluationOracle(input:unknown):EvaluationOracle`、`loadEvaluationBundle(root:string):Promise<ValidatedEvaluationBundle>`、`exportPublicTask(bundle:ValidatedEvaluationBundle):PublicEvaluationTask`。测试助手 `independentFixture(label:string)`返回独立D盘`root/sourceRoot/workRoot/resultRoot/bundleRoot`、profile/oracle原始输入、`oracleCanary`与精确归属清理方法；默认是只有公开 `src/math.js` 的guardrail合成题，不创建provider或容器。

- [ ] **Step1 — 写RED：** `rejects_excess_properties_and_kind_mismatch`拒绝provider/Key字段、主任务coding-build、guardrail视觉oracle及未知schema；`public_reference_is_not_a_gold_leak`允许题面已声明的同字节参考图，却拒绝隐藏修复源码/期望值/路径被导出；`bundle_hashes_bind_both_sides`更换任意oracle/公开夹具字节必须改变bundle身份；旧v1 manifest解码不变。

```ts
expect(() => decodeTaskExecutionProfile({ ...fixture.profile, provider: "kimi" })).toThrow()
const bundle = await loadEvaluationBundle(fixture.bundleRoot)
expect(JSON.stringify(exportPublicTask(bundle))).not.toContain(fixture.oracleCanary)
```

- [ ] **Step2 — 跑RED：** `& $BPrep1Bun --no-env-file test ./test/independent/profile.test.ts ./test/independent/bundle.test.ts --timeout 30000`。Expected:新导出缺失或安全断言失败；不得把夹具初始化失败当作目标RED。
- [ ] **Step3 — 实现接口：** 使用Effect Schema严格解码并冻结；公开/私有文件分别列举与逐文件校验，不允许未声明文件、链接、跨卷路径或root重叠。公开授权以来源/路径/用途白名单判断，不能简单把所有相同图片哈希视作泄露。v2 bundle放新目录，旧 `task.json`、来源和许可证只读。
- [ ] **Step4 — 跑GREEN：** 同上两文件，再跑 `./test/corpus/validate.test.ts ./test/corpus/materialize.test.ts ./test/campaign/candidate.test.ts ./test/campaign/fairness.test.ts` 及 `& $BPrep1Bun --no-env-file run typecheck`。Expected:全部通过、无旧schema或literal快照变化。
- [ ] **Step5 — 提交：** 只stage本任务文件，`git commit -m 'feat(benchmark): define independent evaluation bundles'`。

### Task 2: 候选冻结、隔离副本与源码/配置/制品身份

**Files:** Create `src/evaluator/independent/snapshot.ts`, `test/independent/snapshot.test.ts`；扩展本计划 `fixture.ts` 的纯数据/文件夹具。

**Interfaces:** Consumes Task1 profile。Produces `captureCandidate({sourceRoot,workRoot,profile}):Promise<CandidateSnapshot>`、`verifyCandidate(snapshot:CandidateSnapshot):Promise<void>`。`CandidateSnapshot`含`sourceRoot, workRoot, archiveFile, candidateSha256, configSha256, archiveSha256, entries:FileEntry[]`；归档正文只通过控制器到宿主，不含gold、全局配置或依赖目录。source/work必须是不同、无重叠的自建D盘叶目录。

- [ ] **Step1 — 写RED：** `rejects_link_alias_and_path_collisions`用真实临时硬链接/junction、大小写和ADS/保留名输入测试；`drift_after_capture_is_not_evaluated`在捕获后改源码或受保护配置，断言拒绝；`stale_dist_is_not_a_candidate_build`仅更换旧dist不能产生有效构建证明；空包、单文件8MiB+1、总量/文件数超限拒绝；无gold哨兵进入archive。

```ts
const snapshot = await captureCandidate({ sourceRoot: fixture.sourceRoot, workRoot: fixture.workRoot, profile })
await Bun.write(`${fixture.sourceRoot}/src/math.js`, "export const add = (a, b) => a * b\n")
await expect(verifyCandidate(snapshot)).rejects.toThrow("TASK24_CANDIDATE_DRIFT")
```

- [ ] **Step2 — 跑RED：** `& $BPrep1Bun --no-env-file test ./test/independent/snapshot.test.ts --timeout 30000`。Expected:接口缺失或精确负例失败。
- [ ] **Step3 — 实现接口：** 枚举普通单链接文件并绑定大小/哈希/配置；复制到一次性副本，复制前后复核源身份。无需通用tar解压器；采用有界、逐条哈希验证的归档，拒绝任何特殊文件。构建输出只能由之后宿主在工作副本新建并绑定candidate/config/dependency哈希，不能凭路径叫dist就采信。
- [ ] **Step4 — 跑GREEN：** 同上并联跑Task1两文件、旧 `./test/evaluator/evidence.test.ts ./test/e2e/leakage.test.ts`，然后package typecheck。Expected:全部通过；所有失败路径不修改原件，外部同名哨兵保留。
- [ ] **Step5 — 提交：** `git commit -m 'feat(benchmark): freeze independent candidate snapshots'`，仅本任务文件。

### Task 3: 无oracle泄露的功能probe与失败关闭宿主接口

**Files:** Create `src/evaluator/independent/{host,probe,functional}.ts`, `test/independent/{probe,functional}.test.ts`。

**Interfaces:** `EvaluationHost`的三个方法为 `build(request:BuildRequest):Promise<BuildObservation>`、`probe(request:ProbeRequest):Promise<ProbeObservation>`、`preview(request:PreviewRequest):Promise<PreviewObservation>`；请求只含Task2候选归档引用、公开命令/输入、run身份与超时。observation都包含`assurance:fixture|linux-attested`、绑定身份和 `kind:ok|candidate_failure|unavailable`；后两者分别给明确reason，不伪造输出。`makeUnavailableEvaluationHost():EvaluationHost`全部返回unavailable且启动进程数0。B-Prep1没有生产 `linux-attested` factory；其权威验证在B-Prep2实现，不能接受普通JSON自称已验收。

三个request共有`identity, candidate:{archiveFile,archiveSha256,candidateSha256,configSha256}, profileSha256, timeoutMs`；BuildRequest另含固定CheckCommand与DependencyResolution，ProbeRequest另含`module, inputs, operations`，PreviewRequest另含绑定该candidate的新构建清单与公开预览档案。三个ok observation分别返回真实命令/exit/输出清单、逐operation的value/throw数据、预览能力句柄；共同回传上述身份和`hostReceiptSha256`。所有对象严格解码，oracle/expected/私有路径不在允许字段内。

`makeProbeRequest({identity,profile,inputs}):ProbeRequest`严格筛选字段；`decodeProbeResponse(bytes:Uint8Array):ProbeResponse`按前述限制解码；`probeWorkerSource():string`返回固定worker程序，只描述候选执行机制；`evaluateFunctional({oracle,observation,evidence}):FunctionalFacts`在控制器比较。`FunctionalFacts`含`assertions:FunctionalAssertion[]`、`executedAssertions`、`mandatoryPassed`、`evidence`，结果里不放expected原文。

- [ ] **Step1 — 写RED：** 可信合成输入`(2,3)`的加法返回5通过、乘法返回6失败、不同正确实现仍通过；有序method/get验证状态和防御性复制；expected/隐藏路径不在任何host request。`passed:true`、空outputs、少/多case、重复ID、超1MiB、非法JSON/NaN、stdout额外行均不能变成功能通过。宿主未装配时spawn/import计数为0，返回blocked而非fallback。

```ts
expect(() => decodeProbeResponse(Buffer.from('{"passed":true}'))).toThrow("TASK24_PROBE_RESPONSE_INVALID")
expect(() => decodeProbeResponse(new Uint8Array(1024 * 1024 + 1))).toThrow("TASK24_PROBE_SIZE_INVALID")
```

- [ ] **Step2 — 跑RED：** `& $BPrep1Bun --no-env-file test ./test/independent/probe.test.ts ./test/independent/functional.test.ts --timeout 30000`。Expected:目标接口/行为失败；记录每一核心安全负例。
- [ ] **Step3 — 实现接口：** 候选输出只作不可信数据，所有期望/比较在控制器；worker没有oracle参数或评测文件路径。未执行完全部必选case不能通过。已知夹具只验证协议和比较，不用宿主import语料候选；测试明确注入fixture host，不提供自动Bun/Docker启动。候选抛错是行为事实，传输不可用则是blocked，驱动损坏则是harness_error。
- [ ] **Step4 — 跑GREEN：** 同上及Task1/2文件、旧 `./test/evaluator/functional.test.ts ./test/evaluator/policy.test.ts ./test/evaluator/mutation.test.ts` 和package typecheck。Expected:全过，空报告/伪造分数不能通过，旧评分不变。
- [ ] **Step5 — 提交：** `git commit -m 'feat(benchmark): evaluate functional probes outside candidates'`。

### Task 4: 真实页面事实合同与主任务/guardrail分离评分

**Files:** Create `src/evaluator/independent/{visual,result}.ts`, `test/independent/{visual,result}.test.ts`。

**Interfaces:** `evaluateVisual({identity,profile,oracle,build,preview,browser}):Promise<VisualFacts>`复用现有BrowserRuntime与视觉评分函数，不执行候选服务；`scoreIndependentEvaluation(facts:EvaluationFacts):IndependentResult`。Task4定义 `EvaluationFacts`：identity、源码/构建绑定、Task3功能事实、需求/质量/策略/预算/人工干预事实，以及主任务必选的VisualFacts。`VisualFacts`包含固定三视口的真实捕获记录、旧`aggregateVisualViewports`结果、无障碍/键盘/交互断言和EvidenceReference[]。事实必须关联证据文件，不能只传若干true。结构或证据缺失抛稳定TypeError code，由Task6映射harness_error，不把错误对象当评分结果。

`IndependentResult`是schemaVersion2、以`kind:primary|guardrail`区分的闭合union：primary包含`qualifiedSuccess`、原维度与总分；guardrail包含`functionalQualified`及适用维度、上述四个视觉/总分字段为null，无qualifiedSuccess。共同包含identity、assurance、证据哈希与`semanticSha256`；真实观测时间/耗时单独保留，不参与确定性语义哈希。fixture结果不可转成linux-attested。

primary另有`measurementStatus:complete|candidate_failure`：complete才调用原总分器；健康宿主证明候选构建/启动失败时仍是合法任务失败，`qualifiedSuccess:false`，未执行的视觉/总分为null并写明not_run_due_to_candidate_failure，不能伪造0分截图或因缺截图改判harness_error。没有候选失败证明却缺分量则必须harness_error。安全违规仍保留原强制诊断0政策，明确是policy override而非测量值；不重分配权重。

- [ ] **Step1 — 写RED：** 视觉75且每视口至少65通过，74.999或任一64.999不通过；总分与真实三视口聚合不符、少一视口/分量、错误字体/browser身份是harness_error而非调权。guardrail评测browser调用数0且四字段严格null；被篡改的primary/guardrail类型拒绝。build引用旧candidate或错误entry拒绝；正常候选构建失败为任务失败，浏览器崩溃为harness_error。同候选事实重复评分semanticSha256相同。

```ts
// Task4在fixture.ts定义evaluationFactsFixture(overrides)，默认primary，返回证据齐全且聚合一致的合成facts。
expect(scoreIndependentEvaluation(evaluationFactsFixture({ viewportScores: [65, 80, 80] }))).toMatchObject({
  kind: "primary",
  qualifiedSuccess: true,
})
expect(scoreIndependentEvaluation(evaluationFactsFixture({ viewportScores: [74.999, 74.999, 74.999] }))).toMatchObject({
  kind: "primary",
  qualifiedSuccess: false,
})
```

- [ ] **Step2 — 跑RED：** `& $BPrep1Bun --no-env-file test ./test/independent/visual.test.ts ./test/independent/result.test.ts --timeout 30000`。Expected:新边界断言失败。
- [ ] **Step3 — 实现接口：** primary直接复用旧固定权重与判定，v2只增加来源绑定和结果分类；guardrail独立判定全部必选功能/需求/安全/预算，不调用旧视觉总分器。typecheck/lint未运行时保留not_available和原有扣分，不记pass。动态库页面必须来自该candidate的新构建清单；预览/交互能力缺失返回blocked，不退回单一index.html或静态答案图。
- [ ] **Step4 — 跑GREEN：** 同上、新功能测试，旧 `./test/evaluator/visual.test.ts ./test/evaluator/score.test.ts ./test/evaluator/quality.test.ts ./test/evaluator/requirements.test.ts ./test/evaluator/capture.test.ts ./test/evaluator/browser-protocol.test.ts`、typecheck。Expected:原75/65与每个组件权重断言不变；不扩展v1浏览器协议。
- [ ] **Step5 — 提交：** `git commit -m 'feat(benchmark): separate visual and guardrail evaluation results'`。

### Task 5: 固定16题的公共适配、独立oracle与校准材料

**Files:** Create `src/corpus/evaluation-catalogue.ts`, `src/corpus/evaluation-author.ts`, 六个 `evaluation-fixtures/*.ts`、`script/prepare-independent-corpus.ts`、`test/independent/{catalogue,author}.test.ts`。

**Interfaces:** Task5定义`TaskAdapterDefinition {taskID,kind,stratum,executionKind,adapterID,sourceEntry,probeModules,publicFixtureTemplate,requiredCapabilities,requiredOracleCases}`；字符串/路径/枚举沿Task1规则，三个required/probe字段为数组，template为六个固定模块之一。`evaluationCatalogue():readonly TaskAdapterDefinition[]`返回下表精确16题；`prepareEvaluationCorpus({sourceRoot,outputRoot}):Promise<CorpusPreparationReport>`只读取固定旧来源并在新目录生成准备材料。report逐题含`taskID,profileSha256,oracleSha256|null,missing:string[],status:prepared|blocked`，并显式`corpusEngineReady:false`；null是缺失，不得用64个0假冒哈希。全部依赖/参考实际齐备时才可publish Task1严格bundle，准备报告不冒充有效bundle。

命令：`prepare-independent-corpus.ts --source-root <精确D盘旧tasks目录> --output-root <全新D盘owned目录>`；source-root固定为`D:\OpenCode-Benchmark\Task24\assets\tasks`，输出只能是`D:\OpenCode-Benchmark\Task24\assets\evaluation-v2`或本计划owned tmp内的全新严格子目录。必须拒绝已存在输出、任何链接路径、旧`assets\tasks`源/部署/runs目录及其祖先或重叠路径。源root要求正好匹配16个固定ID，不扩展搜索D盘。不得在仓库提交真正的隐藏答案、修复patch、预期PNG或私有oracle内容；仓库仅有适配器/公开模板/合成测试。

| Task ID                         | 适配/独立功能要求                                                              | 公开预览/构建要求                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `private-analytics-dashboard`   | `src/analytics.js`的过滤、汇总、异常状态                                       | 当前候选源码驱动dashboard；保留公开brief/参考                                                        |
| `private-checkout-recovery`     | `src/checkout.js`的结算/恢复/幂等边界                                          | 当前候选结算页面、键盘与错误态                                                                       |
| `private-inventory-admin`       | `src/inventory.js`的库存、筛选与输入校验                                       | 当前候选管理页面与响应式状态                                                                         |
| `private-travel-search`         | `src/search.js`的过滤、排序、空/错误结果                                       | 当前候选搜索页面与状态交互                                                                           |
| `d2c-g29-spelling-bee`          | 必需DOM内容、图片加载、语义/本地链接与页面健康                                 | 本地候选HTML，非“有截图就功能通过”                                                                   |
| `d2c-g38-icfp-editorial`        | 同上，使用本题自己的内容/DOM oracle                                            | 同上                                                                                                 |
| `d2c-g41-jasmine-docs`          | 同上，使用本题自己的内容/DOM oracle                                            | 同上                                                                                                 |
| `d2c-g63-range-engine`          | 同上，使用本题自己的内容/DOM oracle                                            | 同上                                                                                                 |
| `swe-chartjs__chart.js-10157`   | 0值bar在minBarLength/borderSkipped/borderRadius组合下的角半径及邻近非0回归     | 冻结依赖后`bun --no-env-file run build`，公共canvas夹具只加载该次候选产物                            |
| `swe-chartjs__chart.js-10301`   | legend hover→离开画布的onLeave计数/状态及普通hover回归；使用确定事件序列       | 同一Chart.js构建与公开legend夹具；不靠随机快速拖动复现                                               |
| `swe-diegomura__react-pdf-1363` | Text与View的rgba颜色/背景alpha及非rgba回归                                     | `packages/renderer`本次候选构建生成PDF；固定PDF raster能力与参考未验证时blocked，不替换成CSS模拟文本 |
| `swe-markedjs__marked-1535`     | 题面GFM复选框列表的空行/嵌套组合及普通列表回归                                 | 候选`lib/marked.js`输出真实HTML，再用公共固定样式渲染；不使用旧marked.min.js                         |
| `guardrail-data-normalization`  | `src/usage.js`：cached/reasoning/uncached关系、整数/负数、聚合/稳定排序        | 公开Bun smoke tests，preview:none                                                                    |
| `guardrail-idempotent-orders`   | `src/orders.js`：同key同payload、冲突、库存只减一次、取消和防御性复制          | 同上                                                                                                 |
| `guardrail-registry-refactor`   | `src/registry.js`/`commands.js`：alias/cycle、冲突无部分写入、排序和原执行语义 | 同上                                                                                                 |
| `guardrail-session-debug`       | `src/session.js`：乱序、完全重复、冲突重复、不改输入                           | 同上                                                                                                 |

- [ ] **Step1 — 写RED：** 精确16ID/12primary/4guardrail、pilot3ID不变；每个公开fixture不含修复/expected/source答案。公共包为缺脚本的private/guardrail增加中性Bun smoke检查及配置冻结，不能把hidden tests公开。校准矩阵包含不同正确实现、原始seed、单点功能错、视觉/响应式错（仅primary）、策略违规；用修复patch构造私有正确校准候选可以，但运行评分不得比较patch。缺少4个SWE的真实三视口参考/依赖，必须列blocked，不能合成成功。

```ts
expect(evaluationCatalogue()).toHaveLength(16)
expect(evaluationCatalogue().filter((task) => task.kind === "primary")).toHaveLength(12)
expect(evaluationCatalogue().filter((task) => task.kind === "guardrail")).toHaveLength(4)
```

- [ ] **Step2 — 跑RED：** `& $BPrep1Bun --no-env-file test ./test/independent/catalogue.test.ts ./test/independent/author.test.ts --timeout 30000`。Expected:精确注册/泄露/输出边界断言失败。
- [ ] **Step3 — 实现注册与准备：** 通过固定来源commit/文件hash重建新版本；输出公共profile/夹具与私有oracle/controls分树。沿用原来源许可证、掩码/需求和容差；从公开问题及原测试语义提炼确定断言，不把问题中的外链拉到在线执行。只读旧缓存，发布前核查源hash没变。不能运行候选/安装依赖/调用浏览器捕获真实语料；缺少准备材料归入B-Prep2具体待办。没有gold副本或输入时宁可blocked，不制造占位值。
- [ ] **Step4 — 跑GREEN：** 同上，加全部新profile/功能/结果测试、旧 `./test/corpus/source-lock.test.ts ./test/corpus/validate.test.ts ./test/run/plan.test.ts`及typecheck。再在本计划新临时输出运行一次准备命令，仅检查档案/文件/逐题缺失，Expected:16题均列出、旧source/bundle/hash/pilot名单未改，无付费/候选执行/安装；blocked题不记ready。
- [ ] **Step5 — 提交：** `git commit -m 'feat(benchmark): prepare independent corpus adapters'`；生成的真实语料/隐藏材料留D盘新目录并保持ignored，只提交代码和脱敏准备摘要。

### Task 6: 独立组合入口、证据发布与B-Prep1零额度验收

**Files:** Create `src/evaluator/independent/{index,publication}.ts`, `test/independent/{orchestrator,publication}.test.ts`、上述验证报告。

**Interfaces:** `makeIndependentEvaluator({host?:EvaluationHost,browser?:BrowserRuntime}):{evaluate(input:EvaluateInput):Promise<EvaluationOutcome>}`；`EvaluateInput`为Task1控制器bundle、Task2snapshot、Task1 identity及本run受信任执行/预算事实，不能包含provider Key或模型自报pass。`EvaluationOutcome`是 `evaluated`+Task4结果，或 `blocked`+稳定reason，或 `harness_error`+稳定code；后两者绝无qualified分数。

`publishIndependentEvaluation({root,outcome}):Promise<PublishedIndependentEvaluation>`、`verifyIndependentEvaluation({root,manifest}):Promise<IndependentResult>`；只允许evaluated结果发布为评分，先复核Task2原件及全部EvidenceReference。manifest包含schemaVersion2、identity、assurance、结果文件hash/bytes和完整证据索引。复用不可变发布，同字节重试可读回、不同字节冲突，缺失/截断/跨run/hash变更拒绝。控制器内部完整结果不自动暴露给生成进程。

- [ ] **Step1 — 写RED：** 构建→probe→preview→评分按绑定输入执行；guardrail preview0次；原源码前后相同。默认无host、未知dependency、缺raster/交互、缺参考分别blocked；driver损坏/浏览器崩溃为harness_error；健康宿主中的候选功能失败为evaluated且不合格。错run/attempt/generation/candidate/route、证据file链接/篡改、重复不同内容发布拒绝。请求/证据不含gold canary、grant/Key；fixture不能晋升linux-attested或pilot-ready。

```ts
// Task6在fixture.ts定义orchestratorFixture()，使用前面任务的真实bundle/snapshot构造input。
const fixture = await orchestratorFixture()
expect(await makeIndependentEvaluator({}).evaluate(fixture.input)).toMatchObject({
  kind: "blocked",
  reason: "EVALUATION_HOST_UNAVAILABLE",
})
```

- [ ] **Step2 — 跑RED：** `& $BPrep1Bun --no-env-file test ./test/independent/orchestrator.test.ts ./test/independent/publication.test.ts --timeout 30000`。Expected:上述新安全/分类断言失败。
- [ ] **Step3 — 实现组合：** 只使用前五任务接口，重新验证profile/oracle/候选与构建身份，再判定并发布；不引入provider、模型修复、外部网络或自动默认宿主。sanitize日志只保留ID/哈希/计数/分类，不写隐藏输入/预期或原始stdout。稳定结果hash与观测时间分开；无证据绝不把true当事实。
- [ ] **Step4 — 联合GREEN：** 跑全部11个 `test/independent/*.test.ts` 的**显式文件列表**，不要把glob交给Shell展开；随后在已确认的benchmark包目录执行 `& $BPrep1Bun --no-env-file test --timeout 30000 --only-failures` 与 `& $BPrep1Bun --no-env-file run typecheck`。Expected:完整退出0、新回归全部通过；报告每个旧skip/待办，不改超时/断言。核查旧 `offline/evaluator.ts`、评分/报告、Core/Server/CLI及运行源码无非计划diff，部署exe哈希与实施前一致。没有源码变更的包不重新编译或部署。

Focused Run: `& $BPrep1Bun --no-env-file test ./test/independent/profile.test.ts ./test/independent/bundle.test.ts ./test/independent/snapshot.test.ts ./test/independent/probe.test.ts ./test/independent/functional.test.ts ./test/independent/visual.test.ts ./test/independent/result.test.ts ./test/independent/catalogue.test.ts ./test/independent/author.test.ts ./test/independent/orchestrator.test.ts ./test/independent/publication.test.ts --timeout 30000`。Expected:11文件全部通过，再执行上面的完整package命令，不以focused替代全包。

- [ ] **Step5 — 一次全范围审查和修复：** 按已选顺序实施方法，提供本计划/规格/BASE至当前全部代码及rulings做一次新上下文审查；若环境提供相应审查能力则使用，不为每小步派实现者。Critical/Important逐项先RED后GREEN并重跑受影响与完整benchmark检查，Minor明确记录；不无限复审，不顺手修业务基线。
- [ ] **Step6 — 收尾提交并push：** 验证报告分别列software_verified、16题准备/blocked清单、未执行的Linux/付费部分、精确命令/结果和源commit。先保留最终软件/脱敏证据，再清理可证明自建的中间数据；策略阻止则列路径，不绕过。提交 `test(benchmark): verify independent evaluator boundary`，正常push `fork/dev`并核对远端SHA与干净工作区。未获得后续计划批准，不继续B-Prep2，不创建新active seal或更新部署。

## Plan Self-Review and Handoff

覆盖：规格3.1–3.2→Task1/2，4.1→Task2/3/6，4.2→Task3/4/5，4.3→Task4宿主能力合同（relay实现归B-Prep2），4.4→Task1–6；第7节联合矩阵/真实Linux/新seal分别留B-Prep2–4，第5节真实循环不在本计划。

接口检查：Task1定义档案与身份；Task2只消费profile并产snapshot；Task3只接收公开请求且产功能事实；Task4产闭合结果；Task5产固定题目材料及显式缺失；Task6组合和发布，不越过没有Linux证明的界线。task文件map中共享助手为 `fixture.ts`，实际测试入口精确11个，最终命令必须核对文件数量，不能扫描其他目录。

范围检查：本轮只写计划并记录规格已获批，不写业务代码、不跑上述尚不存在的测试、不发布新结果。实施计划待用户确认后沿用直接dev、本会话顺序实施；不再询问执行方法。付费跑分、Docker环境准备、部署替换仍未获本计划授权。
