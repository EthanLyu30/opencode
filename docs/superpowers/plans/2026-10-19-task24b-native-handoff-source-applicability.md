# Task24B Native Handoff Source and Applicability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成补证方案第一包“安全交接来源与适用性裁决”的有限静态审计，交付可复核的候选/反例/缺项报告，不启用任何原生能力。

**Architecture:** 先核对准确静态输入和目标适用性，再分别审计厂商协议、Windows 句柄、oplock 三类候选，最后按统一义务与反例表裁决。只有有来源且适用的候选才可被推荐进入另批实验；任何缺项均保持运行 blocked，不将文档研究等同于机制验证。

**Tech Stack:** 仓库 Markdown、现有 Node/PowerShell 的只读文件/摘要能力、固定安装的内存静态解析与已有 objdump、Microsoft/Docker 官方文档及固定 commit 的 WSL 源码。不写产品/测试/helper 代码，不安装工具或启动 Docker/WSL。

**Spec:** [已确认补证方案](../specs/2026-10-19-task24b-native-evidence-completion-design.md)，SHA256 `d6bcc4cbcd858668f3f089dfa9d36c90ba2a77a6d0a2f9ef307929f21b078fcc`。继承其中链接的旧取证规格及 NW1 拒绝边界。规格页首为成文状态；用户现已确认方案，**本次只批准编写本计划，尚未批准执行**。

本轮仅新增本文、文档检查及本文本地提交，不 push、不运行以下审计步骤。保留现有 dev/本会话串行执行偏好，未来若获准执行则使用 executing-plans，不新建 worktree、不逐项派代理。本包是证据文档审计，采用“先列命题/反例→核查来源→裁决→文档验收”，不伪造 RED/GREEN 或创建程序去匹配文章措辞；真实机制反例实验不在本计划内。

## Global Constraints

- 基线 `dev / f5805e4c1ae980be81aef764ea2a83fc354c5edc`；历史 Desktop `4.79.0.230596`、CLI/打包 engine 声明 `29.5.3`；七成员 canonical 摘要 `d731b751f4f5afed81b46923ad5c0f381000988089d5b2474538e5b6f9de3f5f`。不当活动 daemon、WSL 版本或完整安装/布局证明。
- 原盘仅为 `D:\Applications\DockerWSL\main\ext4.vhdx`、`D:\Applications\DockerWSL\disk\docker_data.vhdx`；本包连元数据或头部都不新查，不打开、hash、复制、挂载、写入、日志回放、修复、转换、压缩、合并、回滚或更换。
- 旧 C 盘 `C:\Users\Administrator\AppData\Local\Docker`、`C:\Users\Administrator\AppData\Roaming\Docker`、`C:\Users\Administrator\AppData\Roaming\Docker Desktop` 不读取、不迁移、不复制、不删除、不恢复、不覆盖、不改 ACL 或链接；真实 `.wslconfig` 不读取、不修改。不新增 C 应用配置/缓存例外。
- 不执行安装的 Docker、WSL（包括 version/list 命令）、backend 或服务；不连接 pipe/daemon、查实时 VM、准备/启动/停止实例；不查询注册表、Appx 或枚举 WindowsApps 来自行扩充本包静态输入。
- 不提权，不改服务/ACL/全局环境/PATH/注册，不下载二进制/依赖/完整源码归档，不 clone，不构建或实验。不编写读取器、broker、oplock、竞争 writer 或确认 helper。
- 不读 Key、`.env.local`、credential、账号或许可；不调用模型、发现模型或付费接口。旧视觉、workflow 租约/重试/预算、生产 endpoint 合同、题目/次数、dist 和部署均不变；不做真实 Linux 验收。
- 保持 OPEN_EXISTING、只读、禁止写/删除共享、双盘及父链连续保护的既定不变式；本包只研究其来源，不实际取得保护。不预拿可写原盘句柄，不以接受风险、缩短间隙或关闭后检测代替交接。
- 三候选之外不自动展开其他路线；必要新驱动、厂商补丁、升级、ACL/服务变化、先启动后验证或诊断-only 均须另立范围。读取器/布局补证包、合成实验及 NW2–NW13 不执行。
- 保留旧未跟踪报告 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md`，SHA256 `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07`；不 stage、移动、隐藏、ignore、删除或恢复。其 clean-tree 阻断及 endpoint 差异不在本包解决。
- 不复用此前被拒绝清理的任何临时根或 wrapper。本包正式持久输出仅一份新报告，执行技能的准确中间目录例外见下文；不保存整份网页、安装副本、ASAR 解包树、符号 dump 或可加载 proof/permit，不用旧残留取得能力。不新增实验/运行目录。
- 不更改 `rules.ts`、原4+4 registry 或任何既有规格/计划/运行接口。未来任何提交仅精确 stage 本包报告；push 需该次明确授权。本轮只提交本文。

## Review Focus

1. 把 WSL master、Docker WSLBootstrap 声明或 CLI 版本当本机 WSL/Windows/文件系统适用证据：预期保留 unknown，不可推荐为目标适用——HS1/HS3 的 RF1。
2. 只证明能复制句柄/收到 oplock break，未证明准确 writer、双盘及全部异常分支：预期候选不合格，不引用自制 helper 成功补齐——HS2 的 RF2/RF3。
3. 取消、持有者崩溃或第二盘失败会使等待中的 writer 晚到，但按“关闭句柄=已取消”接受：预期单列不满足，不能设计下一步试启动——HS2 的 RF4。
4. 无证据被表述为“厂商永远不可能”，或需要改共享/ACL/驱动的候选被偷偷接受：预期区分缺证与反例、保持边界，不自动切换路线——HS3 的 RF5。
5. 把静态审计、文档检查或历史 pin 当成真实实验/许可，报告出 ready 或提供 START 命令：预期运行始终 blocked、全部实操标未执行——HS3 的 RF6。

## 输入与有限来源清单

### 仓库只读输入

以仓库根 `D:\OpenCode-Audit` 为 CWD，读取本文、上述补证规格、[旧取证规格](../specs/2026-10-19-task24b-native-v2-workload-evidence-design.md)、[原计划](2026-10-19-task24b-native-v2-workload-evidence.md)、[NW1 报告](../reports/2026-10-19-task24b-native-v2-workload-evidence-verification.md)，以及 `packages/benchmark/src/sandbox/desktop/{native-v2/rules.ts,platform.ts,compatibility-v2.ts}`。旧未跟踪报告仅校验摘要/引用其已知静态事实，不接管为输出。

### 另待执行批准的安装静态输入

仅允许 `D:\Applications\Docker` 下 NW1 报告表中的七个准确成员：`Docker Desktop.exe`、`com.docker.service`、`frontend/Docker Desktop.exe`、`frontend/resources/app.asar`、`resources/bin/docker.exe`、`resources/com.docker.backend.exe`、`resources/componentsVersion.json`；逐项完整 hash 必须等于 NW1 的准确记录。普通文件、规范父链/无链接和读取前后身份/长度/mtime 检查失败，或任何 hash 漂移，停止目标适用性审计，报告 `static_target_drift`，不自动适配新版本。

摘要用现有工具有界流式读取，不加载映像或执行目标；单文件超过268435456字节直接拒绝，buffer 最大1048576字节，不为取证读原盘。ASAR 只在内存取 NW1 已定位的 `build/entry-cli.main.js`、`build/onlyAllowSingleInstance.main.js`、`build/setupFileLogging.main.js` 并核对其既有摘要；其他成员需要新输入清单。

backend 只检查 NW1 已定位的 `CreateMainDistro/distroUpToDate/createDataDisk/createVHDX/QuitDockerDesktop` 片段和同一已 pin PE 内最多两层可解析的直接调用线索；记录函数全名、VA/文件 offset、参数/保护和 unresolved 边。不开新输入、不断点调试、不跟踪无法证明的间接调用、不 dump 全表；到界限就保留 unknown，不把两层覆盖声称整条链已闭合。原有 objdump 仅静态反汇编，不创建解包/反编译工程。

现有资料尚不具备准确 Windows/目标文件系统/WSL 构建及二进制到源码的完整对应。**本包不为补齐它们自动探测新路径或读取 C 文件**；先查上述已允许材料，有则标来源，没有就列入新增静态取证授权请求。这些 unknown 足以阻止“目标适用”结论，但允许完成另外两类独立的公共 API 契约审计，形成具体而非笼统的缺口清单。

### 官方网络来源

本轮计划编写只核对参考资料，未来实际来源审计须重新核查；只用官方文档与项目源码，动态页面不假作固定版本契约。

| 来源 ID | 固定入口与本包检查主题                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1      | [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)：访问/共享约束、已有 write mapping、句柄关闭边界                              |
| S2      | [DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle)：文件访问权和消费方协议，不推导只读升级写入                       |
| S3      | [ReOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reopenfile)：重开仍需满足存活句柄的共享条件                                                 |
| S4      | [oplock 输出结构](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-request_oplock_output_buffer)：ack/mode 信息与请求身份缺口                           |
| S5      | [Breaking Oplocks](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/breaking-oplocks)：需/无需 ack、特殊 create、取消与持有者退出的分支                           |
| S6      | [Acknowledging Oplock Breaks](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/acknowledging-oplock-breaks)：ack/关闭后等待请求如何继续                           |
| S7      | [microsoft/WSL 的 WslCoreVm.cpp](https://github.com/microsoft/WSL/blob/master/src/windows/service/exe/WslCoreVm.cpp)：AttachDisk/AttachDiskLockHeld/AddVhd 周围的调用及锁作用域 |
| S8      | [Docker Windows privileged helper](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/#privileged-helper)：共享服务边界；不是可接管/停止证明         |

最多追加两次定向官方搜索（Docker 交接/分阶段写入接口，以及对应 WSL/HCS 消费协议），只跟 S7 直接必要定义，最多两个 microsoft/WSL 同一固定 commit 下的新增源码文件；不扩大到整个项目或非官方分支。若需超出该界限，输出准确缺失接口/文件和原因，停止该候选，不继续搜索或下载。

WSL raw 文件须先取得真实不可变 commit permalink，记录其实际内容摘要和相关行；master 仅寻址入口。官方网页记录获取时间/版本范围、实际取得内容的 SHA256/表示形式和命题位置；若工具只给归一化正文，明确它是正文摘要，不冒充原始响应/二进制摘要。不能获得所需固定版本/字节就记 missing；hash 不能补足语义或本机对应。网络失败可对同一来源再试一次，仍失败即缺项，不用博客/搜索摘要兜底。官方材料只读，不提交 issue、发消息或上传本机数据。

## 报告结构与共享记录

未来唯一正式输出：`docs/superpowers/reports/2026-10-19-task24b-native-handoff-source-applicability-verification.md`，本轮不创建。文件名固定，执行日期/源码 HEAD/实际读取时间在报告头如实记录；已有同名文件且非本包所有则停止，不覆盖。

执行技能若要求账本/brief/审查记录，仅使用本计划独有的 `D:\OpenCode-Audit\.superpowers\sdd\2026-10-19-task24b-native-handoff-source-applicability`，本轮不创建；不保存原始资料、通用源码缓存或凭据，合计上限262144字节。该目录是可清理中间物，不是正式交付、读盘 owner 或权限。验证交付后核对准确归属、计划标记、父链和无链接再清理；策略拒绝则保留并报告，不复用/改工具重试。未来最终整包审查按届时适用执行技能进行，不增加逐任务代理。

HS1 生产 `Inputs` 与 `Target` 两节；HS2 生产 `Candidates`、`Obligations`、`Counterexamples`；HS3 生产 `Decision`、`Authorization` 与 `Verification`。这是文档记录，不增加可解析运行合同或 JSON proof。

- `SourceRow={id, source, revision, acquiredAt, representation, sha256, location, claim, limits}`；实际未取得的值写 missing 和原因，不造 hash。
- `TargetRow={component, expected, observedOrHistorical, sourceIDs, applicability}`；最后一项为 `proved/unknown/contradicted`，历史字符串不自动等于 observed。
- `CandidateRow={id, sourceIDs, consumerChain, protectionSequence, writerBinding, dualDiskCommit, failureCleanup, obligations, counterexampleIDs, verdict, missing}`；id 准确为 `vendor/handle/oplock`，verdict 仅 `static_candidate/insufficient_evidence/conflicts_with_boundary`。
- `Decision={auditStatus, candidateIDs, targetApplicability, missing, nextAuthorization, operationalStatus}`；auditStatus 仅 `static_candidate_only/blocked`，operationalStatus 必须 `blocked`。targetApplicability 有任一明确矛盾则 contradicted，否则有未知则 unknown，全部必要目标事实及对应均有证明才为 proved。这些文档记录均不得成为 native descriptor、permit、实验通过或 NW1 ready。

## Task 1: HS1 锁定输入与目标适用性基线

**Files:** 新建上述唯一报告，仅 `Inputs/Target` 和状态头。只读输入为前述仓库/安装清单，不改产品文件。

**Interfaces:** 消费已确认规格和 NW1 历史记录；生产 SourceRow/TargetRow 的身份与缺项，供 HS2/HS3 引用。任何字段不得从 Docker CLI 或 WSLBootstrap 推算其他组件版本。

- [ ] **Step 1：** 运行 `git status --short --branch`、`git rev-parse HEAD` 并核对规格实际 SHA256；核对旧未跟踪报告仍为约定 hash。Expected：dev、仅准确自有改动，规格 hash 匹配；有重叠用户改动/身份不符先停止，不 restore/ignore。
- [ ] **Step 2：** 列出七成员期望/实测摘要、普通文件与父链/读取前后检查，按白名单有界读取。Expected：逐项一致才继续目标线索；任何漂移/读取失败记录原因和已实际读范围，停止 HS2 的目标安装部分，仍可做不依赖该安装的公共契约审计。
- [ ] **Step 3：** 从允许材料填写 Windows/文件系统/WSL/Desktop/backend/WSLBootstrap 的 TargetRow，缺字段保持 unknown；RF1 反证核查：给定“仅有 master、CLI 和 WSLBootstrap”，结论必须是目标适用 unknown，而不是 proved。Expected：不调用 version/list、Appx/注册表或读新 C 文件，报告不出现虚构构建/源码对应。
- [ ] **Step 4：** 创建报告 `Inputs/Target`，把安装/系统事实标为当前静态采样、历史或未知，标明未运行任何真实操作。Expected：每条肯定结论均有来源，缺精确目标版本明确阻断，而非“稍后试跑再定”。
- [ ] **Step 5：** 本地 Prettier 与 `git diff --check` 检查报告，人工对照以上输入/反证，准确 stage 报告并提交 `docs(benchmark): record native handoff source audit inputs`。Expected：仅报告变更，未 stage 旧报告或 runtime 文件；无 push。

## Task 2: HS2 三类来源与反例审计

**Files:** 只续写本包报告 `Candidates/Obligations/Counterexamples`，不创建原型、测试或 helper。

**Interfaces:** 消费 HS1 的 SourceRow/TargetRow；生产三条 CandidateRow。每条义务只能是 `supported/unknown/contradicted`，supported 必须指向精确 SourceRow/location；已证违反边界为 conflicts_with_boundary，尚未证明为 insufficient_evidence，全部静态义务和适用性有支持且无未决反例才为 static_candidate。不支持的部分不能从其他候选借来而不证明组合仍满足所有约束。

- [ ] **Step 1：** 先列三候选的相同证明义务：只读与禁止共享不变、连续父链/盘身份、准确 writer 请求绑定、双盘整体提交、其他 writer/已有 mapping 隔离、取消/超时/崩溃与部分失败、晚到请求的终止/已归属收尾、固定目标支持。Expected：八项无遗漏，未定义 use 回调或成功返回当作证明。
- [ ] **Step 2：** 对 vendor 审计允许安装片段、S7/S8 及有界官方搜索，画出文字调用/所有权链 `controller→launcher→backend→WSL/HCS→双盘 writer`，每条边写参数/锁/身份/失败传播或 unresolved。Expected：间接调用、只按路径 AddVhd、内部 VM 锁、共享服务、HTTP 退出入口均不自动补成外部原子准入；未取到不可变 commit/本机对应就缺项。需要补丁/驱动/权限变化直接 conflicts_with_boundary，不实施。
- [ ] **Step 3：** 对 handle 审计 S1–S3 的访问权、共享和消费协议；RF2 反证核查：只读复制成功、重开 API 存在、复制两次却无整体提交，均不能关闭交接缺项。Expected：不能把复制/继承或先解锁再开写，当作目标 writer 接管；消费方不支持时标 insufficient_evidence。
- [ ] **Step 4：** 对 oplock 审计 S4–S6 的每种 ack/break/映射/create/取消/退出分支；RF3 核查“只有 AccessMode/ShareMode，无准确请求/VM 身份”和“仅 helper 成功”，RF4 核查持有者消失/第二盘失败导致晚到 writer。Expected：未证明请求身份、全部分支或安全收尾就不合格，不提出无限期不 ack 或关锁兜底。
- [ ] **Step 5：** 按下表逐行给三候选填来源、支持/反例/未知和裁决。Expected：没有“未测试=通过”，对静态来源不能回答的行明确留实验未执行，且不消除 unknown。

  | case | 输入/故障                                | 本包必须给出的拒绝或待证裁决                     |
  | ---- | ---------------------------------------- | ------------------------------------------------ |
  | C1   | 先释放保护，之后 backend 才打开          | 存在未保护间隙，不接受                           |
  | C2   | runtime 已允许写，data 移交失败          | 无双盘提交/阻止部分写入的证明，不接受            |
  | C3   | 两个 writer 同时请求                     | 不能把“第一个”视为授权者，缺准确请求绑定即不接受 |
  | C4   | 相同 PID 对应不同创建时间/VM，或假 pipe  | 不能授予接管/停止权                              |
  | C5   | 取消/超时后等待中的 writer 继续          | 无完整取消/join/已归属收尾证据，不接受           |
  | C6   | 控制器/持锁者崩溃或异常关闭              | 不能用“进程退出会释放资源”证明外来写入受控       |
  | C7   | 原有 write mapping/父链替换              | 无准入拒绝及稳定保护证明，不接受                 |
  | C8   | 不需 ack 的 break 或特殊 create 分支     | 不能一概声称操作会等待控制器放行                 |
  | C9   | 需改变 share/ACL/服务、拿可写原盘 handle | 超出现有边界，不实施，不作为本期合格候选         |
  | C10  | helper 成功、网页/签名/hash、旧空报告    | 不是厂商支持、当前事实或运行许可                 |

- [ ] **Step 6：** 人工检查3候选×8义务及3候选×10反例全部有明确记录、来源可追溯；Prettier 和 `git diff --check` 通过后仅提交报告 `docs(benchmark): assess bounded native handoff candidates`。Expected：剩余 unknown 真实可见，反例仅为静态推理核查，未宣称执行过竞态/取消实验；无 push。

## Task 3: HS3 目标适用性裁决与停止交付

**Files:** 只完成本包报告 `Decision/Authorization/Verification`；既有规则、规格、registry、旧报告和部署不动。

**Interfaces:** 消费 HS1 TargetRow 与 HS2 三 CandidateRow；按以下决策规则产生唯一 Decision。没有任何结果类型允许启动、实验或继续原任务。

- [ ] **Step 1：** 复核候选组合是否覆盖八义务、十反例及目标版本对应；将材料中的正向命题、已知反例、未知和所需新范围分开。RF5：缺证据应为 insufficient_evidence，不写“永远不可能”；若某候选需改权限/补丁则 conflicts_with_boundary，不静默放宽或改成诊断-only。Expected：恰当强度的裁决，不把 absence 当普遍不可能证明。
- [ ] **Step 2：** 应用固定决策：无候选覆盖全部静态义务/目标对应，或任何必要字段 unknown，则 `auditStatus=blocked`；仅有全部静态义务与适用性有来源支撑、但机制实验尚未执行的候选，才为 `static_candidate_only`。两种结果都 `operationalStatus=blocked`。RF1/RF6：只有版本字符串、未 pin master、helper 或旧报告，不得得到后一个结果或任何 ready。
- [ ] **Step 3：** 完成新增授权清单：逐项列 Windows/文件系统/WSL 构建或代码对应缺少什么准确材料、拟新增只读路径/范围及为何必要；目前路径尚未知的材料写为“须先另批发现范围”，不写通配读取命令。厂商问题可以草拟但不发送；后续实验须另出清单/计划，无候选则停止，不进入读取器/布局包、下载或 NW2–NW13。
- [ ] **Step 4：** 完成 Verification：逐项记录实际读过的输入/来源、未取到项、3×8义务/3×10反例覆盖及人工核查结果；真实读盘/保护、helper/竞态实验、安装启停、Linux验收、模型调用/付费、部署一律未执行。Expected：不把文档格式检查、历史 NW1 的466/10/0或任何代码检查算本包新实验通过。
- [ ] **Step 5：** 对照 Review Focus 五项和规格第四/七/八/九节自审；比较原规格/方案、rules/platform/compatibility 源码及旧未跟踪报告摘要未变，运行文档检查和 `git diff --check`。Expected：准确输出仅报告；缺项/网络失败/源漂移均在最终结论可见，clean-tree 阻断未隐藏。
- [ ] **Step 6：** 仅提交报告 `docs(benchmark): conclude native handoff applicability without enabling runtime`，不自动 push。向用户链接报告，说明候选结论、还需的准确证据/新授权、所有实操未执行并停止。Expected：即使为 static_candidate_only，也只供下一次选择，不自动建实验计划、执行实验、切路线或继续 NW2–NW13。

## 文档验收与执行交接

上述“反证核查”是对来源命题的人工推理验收，不是程序回归或真实机制实验。报告只有事实/缺项/建议，没有执行器、callback、TTY、权限 factory 或 runtime 接口，故不增代码测试/typecheck，也不运行产品套件。未来决定实现或实验时，须另写具体 TDD/自有资源计划并获批，不借本文实施。

文档检查使用现有 `D:\Applications\nodejs\node.exe`、仓库本地 `node_modules/prettier/bin/prettier.cjs`，进程级禁 Node compile cache 和外来 NODE_OPTIONS；不安装、不加载项目 env。CWD 为 `D:\OpenCode-Audit`：

```powershell
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$env:NODE_OPTIONS = ''
& 'D:\Applications\nodejs\node.exe' node_modules\prettier\bin\prettier.cjs --check docs\superpowers\reports\2026-10-19-task24b-native-handoff-source-applicability-verification.md
git diff --check
git status --short --branch
```

Expected：格式/diff exit0、来源/版本/位置/摘要的表示形式明确、全部候选义务/反例有记录；git 仅本包报告改动加原样旧 untracked 文件。报告不存在时不预跑此命令；此刻仅对本计划做等价文档检查。正式文档和用户资料保留；仅执行技能的准确自有中间目录按前述条件清理，不产生额外实验缓存。

规格覆盖：第三/四节由 HS1/HS2/HS3 全部承接；第二/八/九节边界贯穿三任务；第五/六节完整布局和读取器及第七节后续实验包明确不在本计划范围。Review Focus 均映射至实际反证核查，没有遗漏后假定为完成。本文共3任务17步，未执行。

请审阅本计划是否准确。沿用现有 dev、本会话串行方式；**确认计划后仍需明确允许开始这一个静态审计包，不能因编写计划已获批就执行**。证据不足继续 blocked；原盘读盘、实际准备和启动分别另行确认，旧 C 不迁移不删除，真实验收、付费跑分和部署替换继续不做。
