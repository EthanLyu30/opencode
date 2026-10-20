# Task24B CV1 Vendor Contract Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成CV1厂商交接契约的有限公开材料取证与文档裁决，交付来源、义务/反例表、停止结论及必要的未发送问题稿，不执行任何本机取证或启用原生能力。

**Architecture:** 先锁定既有证据与新材料取得上限，再按K1–K8及HS反例检查厂商是否提供端到端行为保证，最后作唯一CV1裁决。来源不足是有效的blocked交付，不触发CV2或外联；即使有契约依据，准确目标对应和运行状态仍不放行。

**Tech Stack:** 仓库Markdown、现有官方网页/文本读取工具、现有Node的内存字节计数/摘要及本地Prettier。无产品/测试/探针/helper代码、依赖安装、PE分析或Docker/WSL调用。

**Spec:** [已确认有界补证方案](../specs/2026-10-20-task24b-vendor-contract-target-version-design.md)，SHA256 `2d7eeb78f89d7b76cb35f1633c692ec7dcb27b3c15937d428eb7abba12d97628`。规格页首为成文时状态；用户现已确认方案，**本轮仅批准编写本计划，未批准执行CV1**。

本轮只新增本文、文档自审/格式检查和本文本地提交，不push，不运行以下取证步骤。保留在dev、本会话串行使用executing-plans的偏好，不新建worktree、不逐任务派代理。本包为文档取证，采用“预列命题/反例→真实来源→人工裁决→文档验收”，不伪造RED/GREEN、不为文章措辞写程序测试；整包审查按执行时适用技能进行，不执行真实机制实验。

## Global Constraints

- 基线 `dev / 39c8997fe7210912e7bf18f4ab0cd93110a4adff`。历史Desktop `4.79.0 / 230596`、backend SHA256 `2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd`、七成员canonical摘要 `d731b751f4f5afed81b46923ad5c0f381000988089d5b2474538e5b6f9de3f5f`只作历史寻址，不重新采样或当作live事实。
- 本包只执行CV1；CV2的全部V项、CV3/CV4、reader/layout、NW2–NW13均不执行。不得查询系统/卷/注册表/Appx/服务配置、枚举WindowsApps、发现安装路径或打开任何Docker/WSL/HCS安装资产；规格中的未来C系统文件例外不是本包权限。
- 两个原盘 `D:\Applications\DockerWSL\main\ext4.vhdx`、`D:\Applications\DockerWSL\disk\docker_data.vhdx`连新元数据都不查，不打开、hash、复制、挂载、回放、修复、转换、回滚或换空盘。不取得真实双盘保护，不预取可写句柄；实际读盘、准备、启动各自另批。
- 旧C三目录 `C:\Users\Administrator\AppData\Local\Docker`、`C:\Users\Administrator\AppData\Roaming\Docker`、`C:\Users\Administrator\AppData\Roaming\Docker Desktop`不读、不迁移、不复制、不删除、不恢复、不覆盖、不改ACL/链接；真实`.wslconfig`不读不改，不新增C应用配置/缓存。
- 不执行Docker/WSL（含version/list）、backend、服务、VM，不连接pipe/daemon，不提权，不改服务/ACL/share/注册/全局环境，不装工具/驱动、不下载二进制/依赖/符号/归档、不clone或构建。不新增动态调试/反汇编或源代码全仓检索。
- 不读Key、`.env.local`、credential、账号或许可，不做模型发现/调用、合成实验、真实Linux验收、付费跑分、部署替换；旧视觉、workflow租约/重试/预算、endpoint、题目/次数、dist不变。
- 厂商外联、登录、issue/支持单、付款、上传资料和读取用户本地厂商材料文件均另行确认；本包只有公开网络文本及用户明确提供于对话的可用文本/公开URL。无保密/本地附件读取或入Git授权时不读取/转写它们；用户原件保留。
- 一轮最多2条定向查询、最多8份文本材料；每份实际响应上限2097152字节，合计16777216字节。来源失败最多同源重试一次；超额、未知格式/来源、需新权限即停止材料拓展，仍完成本包负面报告，不追加同义搜索。
- 最终唯一输出为下述新报告，最多262144字节；网页/源码原文只在内存，不保存整页、完整源码或通用缓存。来源摘要必须标明实际取得的表示，未取得不造零hash，不将网页、签名/hash或厂商答复当运行许可。
- 保留未跟踪 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md`，SHA256 `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07`，不stage、移动、ignore、隐藏、删除或恢复；clean-tree阻断、endpoint差异、HS误采偏差不消除。
- 所有旧残留、尤其HS中间根及误采的三个同名函数不读取、不复用、不重查、不清理，不借CV1追认。现有规格/计划/报告、runtime源码、registry/descriptor/permit均不改。未来提交精确stage本包报告；push须另有当次明确授权。

## Review Focus

1. 把HS旧API、同一段文字的新URL、搜索摘要、营销描述或官方仓库中的第三方帖子当新厂商契约：预期只作寻址/排除，缺K项仍blocked——Task1及Task2的RF1人工反证核查。
2. 两次attach/批量JSON、VM暂停或局部保留被写成双盘整体准入：预期K1/K3和C1/C2不合格，不凭接口名称补语义——Task2的RF2。
3. close/取消HTTP成功/持有者退出被当作已终止等待writer：预期K5/K6及C5/C6保留缺口，完整有界join/归属收尾必须有来源——Task2的RF3。
4. 厂商答复/tag/commit/版本号被当本机匹配，或保密回复被放入Git：预期K7分层、本机unknown；未知许可不读取/发布——Task1/Task3的RF4。
5. 无契约时自行联系厂商、查元数据/读安装文件、试实验或继续NW；或找不到就宣称永远不可能：预期有限负面交付、操作始终blocked、不自动开展任何后续动作——Task3的RF5。

## 输入、输出与有限取证协议

### 仓库输入与唯一报告

CWD固定 `D:\OpenCode-Audit`。只读：本文、上列规格，以及 `docs/superpowers/reports/2026-10-19-task24b-native-handoff-source-applicability-verification.md`（SHA256 `3f3bb4cfbbeb3a9ce305cc410dac66b0bd73b516efc6aedc3ead8a3c58c81847`）、该报告链接的HS计划/补证总规格中的K/O/C边界。旧未跟踪报告只校验摘要，不接管为输出。无需打开runtime源文件或采样任何安装成员。

未来仅创建 `docs/superpowers/reports/2026-10-20-task24b-cv1-vendor-contract-evidence-verification.md`。文件名固定，实际执行日期/HEAD/获取时间如实记录；若同名文件并非本包所有则停，不覆盖。分节为 `Inputs / Search / Sources / Contract / Counterexamples / Decision / Questions (NOT SENT) / Verification`；未发送问题稿内嵌同一报告，不增加独立附件。

执行技能若要求中间物，仅允许全新独有 `D:\OpenCode-Audit\.superpowers\sdd\2026-10-20-task24b-cv1-vendor-contract-evidence`，合计262144字节；只放计划身份账本、brief、审查差异/短文档检查记录，不放网页/源码/凭据/运行缓存。本轮不创建。交付验证后核对准确计划标记、规范路径/父链/无重解析再清理；拒绝则保留并报告，不换工具重试或复用。任何额外临时根均须另批。

### 两条冻结查询与来源选择

当前没有用户指定的新厂商材料，记 `suppliedSources=[]`。未来若先取得用户明确给出的公开URL/对话文本，优先处理，计入8份预算；已有材料已足以完成正面或负面裁决时不搜索。否则仅允许以下一轮查询，每条最多一次，查询失败可原样再试一次，不改词重查：

| id  | 准确查询                                                                                                                    | 选择目的                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q1  | `site:docs.docker.com "4.79" "disk" ("handoff" OR "transaction" OR "reservation")`                                          | 精确Desktop发行关联的厂商交接/保留契约，而非HS的通用WSL/handle兼容介绍            |
| Q2  | `site:learn.microsoft.com/virtualization/api/hcs ("disk" OR "VHD") ("transaction" OR "reservation") ("cancel" OR "commit")` | HCS侧聚合准入及取消语义，而非重搜AddVirtualDisk/AttachDisk或通用CreateFile/oplock |

Search记录每次原样query、时间、工具返回顺序、查看的前4个不同结果URL及选择/排除原因；摘要只用于定位，不作契约证据。两个查询的结果URL若重复只计一个候选位置，不向后补位凑数。0结果/全是旧材料也记录，不自动用不同拼写、翻译或其他搜索引擎重查。

可作为原文入口的来源仅 `https://docs.docker.com/`、`https://learn.microsoft.com/` 的厂商技术文档，以及新协议直接指向的 `https://github.com/microsoft/WSL/` 官方源码/发行页和对应官方GitHub API/raw路径。域名/仓库归属不使Q&A/用户issue自动成为厂商保证；无可验证作者责任范围的评论排除。未知域名、登录重定向或附件停止该来源，不用博客/镜像兜底。

在剩余8份总额度内按返回顺序取新原文；明确重复HS事实、仅营销/产品介绍或无交接命题的结果可在寻址表排除，不为“也许有关”泛读。仅依据标题/摘要作排除时，标为未读的取证选择，不声称已核查全文或证明该页没有新契约。首次获取的HTML/文本、tag→commit定位响应、固定源码响应都占材料名额和字节预算；重定向/重试的实际响应字节同样累计，不通过更换transport重置计数。只跟明确新协议直接定义，不自动追定义的更多依赖。

获取前先写明准确URL、拟核命题和剩余预算。源码须先指明准确文件和真实immutable commit；master/tag页面仅作寻址，定位响应也计预算，不能pin则记missing停止，不在本地clone/grep。必须以可落实上限的流式/有界读取取得实际表示；达上限中断、记不完整且不支持任何正向命题。若工具只能返回归一化文本，记录其实际字节/摘要及表示，不冒充原始HTTP；不能落实规格“实际响应”上限时记 `source_budget_unenforceable`，停止该来源，不用工具截断页面后的片段假装全文合格。不得为取摘要创建通用抓取器或落地原文。

每项最终记官方归属、revision/适用范围、获取时间、实际表示/完整性/字节/sha256、精确命题位置、limits及novelty（新命题/旧材料/未知）；来源未取全、超预算或无法固定版本时明确missing，不凭hash补语义。未获得新契约并不证明所有厂商私有机制不存在。

## 文档记录与跨任务接口

以下均为报告字段，不写TypeScript/JSON schema或可加载proof：

- `SourceRecord={id,urlOrProvidedText,officialAttribution,revision,acquiredAt,representation,complete,bytes,sha256OrMissing,location,claim,limits,novelty,publicationPermission}`；id为S1–S8，unknown不占用伪造hash。未获内容/发布许可的私有或本地材料只列授权缺项，不复制细节进入报告。
- `ClauseRecord={id,status,sourceIDs,locations,reason,missing}`；id=K1–K8，status=`supported/unknown/contradicted`。K7附`declaredBuildRange`与`localMatch`两列，前者是厂商适用声明，后者本包恒为unknown。
- `CounterexampleRecord={id,status,sourceIDs,locations,reason}`；id=C1–C10，status=`addressed_by_contract/unresolved/contradicted`；前一个只表示文档有行为保证，绝不表示实验通过。
- `Decision={researchStatus,reason,missing,targetApplicability,operationalStatus,nextAuthorization}`；researchStatus=`contract_basis_found/blocked`。targetApplicability恒`unknown`，operationalStatus恒`blocked`；nextAuthorization仅是待用户选择，不是已经获准。

Task1生产Inputs/Search/Sources供Task2消费；Task2生产8条ClauseRecord、10条CounterexampleRecord及逐边调用/所有权语义供Task3裁决。关键步骤无来源就是unknown，不从旧handle/oplock候选或本地helper借能力来拼接“完整契约”。

## Task 1: 固定输入并取得有限新材料

**Files:** 仅新报告的Inputs/Search/Sources。消费已确认规格及HS历史报告，生产SourceRecord清单/实际预算与未取得项；不创建本机版本/安装清单。

- [ ] **Step 1：** 运行 `git status --short --branch`、`git rev-parse HEAD`，用现有Get-FileHash核对规格/HS报告/旧未跟踪报告的上列准确摘要。Expected：dev、输入未变，无重叠用户输出；不一致就停止，不restore/ignore，不能据此采样安装求新基线。
- [ ] **Step 2：** 在报告先列K1–K8命题及C1–C10拒绝条件，创建来源/计数表；确认suppliedSources实际为空或仅含用户明确授权的新公开材料/对话文本。Expected：本地/保密附件或新权限需要先另批；本机输入为0，没有“系统元数据是只读所以顺便查”。
- [ ] **Step 3：** 仅在还需材料时按协议执行Q1/Q2，并记录原样查询及前4结果/排除原因。Expected：最多2条不同查询，无新线索也不重搜HS通用API；无结果/网络失败后继续本包负面报告而非厂商外联。RF1：旧URL变体/摘要/第三方issue不得计作新契约。
- [ ] **Step 4：** 在8份/单份2097152字节/合计16777216字节内，取得选定官方原文及必要的准确pin响应，填写SourceRecord；预算不可落实或来源失败/越界则停止材料获取。Expected：实际表示/摘要/位置可复核，无原始材料落盘，无安装读取；RF4：保密权限未明不接收/发布，source pin不等于本机匹配。
- [ ] **Step 5：** 人工核对来源计数、字节、重试、novelty及所有排除；对报告运行本地Prettier检查及 `git diff --check`，仅stage报告，提交 `docs(benchmark): record bounded vendor contract sources`。Expected：仅报告变更，未stage旧报告；负面来源记录也可提交，未push、未宣称CV1合格。

## Task 2: 裁决交接义务与反例

**Files:** 只续写报告Contract/Counterexamples。消费Task1来源，生产ClauseRecord/CounterexampleRecord；若没有新材料，真实填写unknown，不制造厂商保证或跳过拒绝表。

- [ ] **Step 1：** 逐条填写K1连续只读/deny-share/父链保护、K2准确writer身份、K3双盘整体准入、K4并发/mapping、K5全异常、K6晚到/join/归属、K7构建依赖、K8现有边界。Expected：8项有独立出处/缺项；supported必须精确到原文位置，不按接口名称猜语义，K7.localMatch恒unknown。
- [ ] **Step 2：** 以文字表追 `controller→launcher→backend→WSL/HCS→双盘writer→已归属收尾`，每边写厂商参数/保护/身份/错误或unresolved及来源。Expected：两家答复仅能在有明确相同接口/版本/责任边界时连接；内部VM锁、暂停VM、两次attach/批量请求无聚合保证不能关闭K1/K3（RF2）。
- [ ] **Step 3：** 为C1提前解锁、C2第二盘失败、C3并发writer、C4 PID/VM/pipe伪配、C5取消后晚到、C6持有者崩溃、C7已有mapping/父链替换、C8无需ACK/特殊create、C9权限/组件变化、C10 helper/hash/旧报告逐一填表。Expected：10项明确来源/unknown；尤其RF3不可把释放持锁资源当取消等待者，须厂商有界撤销/join且只清理本次归属。
- [ ] **Step 4：** 对照下列五个纸面反证输入检查裁决强度；这些是人工推理验收，不是生成样本/运行实验或程序回归。Expected：不能因文档格式正确或“官方”二字接受缺证；出现需要扩大读取/外联的材料只记待授权，不执行。

  | 人工反证                                                 | 必须得到的判断                                                             |
  | -------------------------------------------------------- | -------------------------------------------------------------------------- |
  | RF1 旧S7/AddVhd介绍换个URL，或只有搜索摘要/普通用户issue | 不是新增端到端保证；K缺项保留，不能contract_basis_found                    |
  | RF2 仅两个attach成功或VM暂停，未证明VHD写入/双盘提交     | K1/K3不获supported；C1/C2仍unresolved                                      |
  | RF3 取消请求返回成功/关闭句柄，但等候writer可能继续      | K5/K6不获supported；C5/C6仍unresolved或与明确声称冲突                      |
  | RF4 官方答复只说某新版本支持，或提供master/tag/签名      | 分开厂商范围与本机；localMatch/targetApplicability仍unknown，不升级/读本机 |
  | RF5 没找到契约，建议先查系统/试启动/发送支持单           | 不执行，记待授权/blocked；缺证不是普遍不可能定理                           |

- [ ] **Step 5：** 人工核对8义务/10反例/全部消费边和五项反证，格式与diff检查通过后仅提交报告 `docs(benchmark): assess vendor handoff contract obligations`。Expected：无实验通过宣称、无新代码、未push；材料不足不阻止本包继续完成停止报告，但不继续材料拓展。

## Task 3: CV1停止裁决、问题稿与验证交付

**Files:** 只完成报告Decision/Questions (NOT SENT)/Verification。消费Task2矩阵，生产唯一Decision及未发送问题稿，不创建CV2计划或操作命令。

- [ ] **Step 1：** 应用确定规则：有来源证明必要机制义务contradicted或必须改变K8边界，则 `blocked/conflicts_with_boundary`；否则任一K1–K6/K8未supported、契约K7的适用构建/条件缺失、任一HS机制反例未解决或消费链缺边，则 `blocked/insufficient_evidence`。仅全部机制语义/合同范围有据、本机匹配尚待另批时才 `contract_basis_found`。Expected：已知冲突优先于缺证；两种researchStatus都targetApplicability=unknown、operationalStatus=blocked；明确只覆盖历史Desktop寻址，不推算本机现状，不选最相近/新版本补齐。
- [ ] **Step 2：** 无足够契约时，在同一报告写两段标有NOT SENT的问题稿：Docker侧询问Desktop4.79.0/build230596是否有既定边界内入口/双盘协议/异常和完整归属保证；Microsoft侧条件式询问所涉WSL/HCS消费协议、范围和取消/join责任。Expected：不假设接口已存在、不杜撰邮箱/工单，不含本机路径/身份/账号/日志/环境/Key；不发送/登录/上传/付费。已有充分材料则Questions写“不需要本包外联，未发送”，不制造待联系任务。
- [ ] **Step 3：** 完成Verification：逐项列实际材料/未取得项/预算/重试/排除/8+10人工检查及未执行事项。Expected：读盘保护、系统发现、安装读取、外联、实验、Docker/WSL/服务、Linux验收、模型/付费、部署全部未执行；未提供材料的原因具体，但不反复搜或转下一包（RF5）。
- [ ] **Step 4：** 对照已确认规格第三节、第五节CV1门槛、第六/七节分层授权与五项RF自审；复核规格/HS报告/旧未跟踪报告摘要未变，运行下列完整文档验收。Expected：只有本包报告作为正式变更；所有缺项真实可见，HS结论/registry/clean-tree阻断均未被隐藏。不存在“为让报告通过而匹配文字”的新程序测试。
- [ ] **Step 5：** 仅stage报告并提交 `docs(benchmark): conclude CV1 evidence without enabling runtime`。Expected：本包三个任务只改变新报告，未push；不修改旧文档、源码、运行配置或权限。

## 文档验收、自审覆盖与执行交接

执行获批后，现有工具仅用于本包文档验收；不安装、不加载项目env、不跑产品套件/typecheck，手工来源反证不冒充TDD。每个任务提交前以及最终交付前运行（CWD `D:\OpenCode-Audit`；报告存在后才执行）：

```powershell
$ErrorActionPreference = 'Stop'
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$env:NODE_OPTIONS = ''
& 'D:\Applications\nodejs\node.exe' node_modules\prettier\bin\prettier.cjs --check docs\superpowers\reports\2026-10-20-task24b-cv1-vendor-contract-evidence-verification.md
if ($LASTEXITCODE -ne 0) { throw 'CV1 document formatting failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'CV1 whitespace check failed' }
git status --short --branch
```

Expected：格式/diff exit0；8项K、10项C、五项RF全部有人工裁决，来源字节/完整性/表示/摘要及边界清晰；仅报告加原样旧untracked，不能说“测试全绿所以交接合格”。若将来另有push授权，保留原hooks，所需安全D环境/预算须先明确；本计划不复用HS发布wrapper、不绕过hooks，本轮无推送授权。

执行技能要求的最终只读审查范围仅本包文档，不重采本机、不重复拓展网络来源或突破8份预算。审查/必要文档纠错完毕后给用户报告链接、实际结论/缺项/未发送稿及清理实测，不自动push。随后停止：即使contract_basis_found也只供用户另选是否编写CV2计划，不开展CV2/外联/文件读取/NW或实验；审查未独立重取原始来源时明确说明，不声称双重取证通过。

规格覆盖：第一/二节由Global Constraints与Task1/3承接；第三节的材料渠道、K1–K8和问题稿由Task1/2/3承接；第四节版本桥接在Task2/3保留unknown，不实施发现；第五节仅CV1及停止门由Task3承接，CV2–CV4文件预算/工具准备属于明确排除范围；第六节来源分层/新鲜性由三任务承接；第七节授权由全部任务保持。共3任务15步；本轮未执行。

请审阅本计划是否准确。沿用dev/本会话串行方式；**确认计划不等于开始执行CV1，仍须明确批准这一个有限公开材料包**。证据不足继续blocked，不推进NW2–NW13；厂商外联、系统元数据查询及安装/本地材料文件读取另行确认。实际读盘、准备、启动分别另行确认；旧C不迁移不删除，真实验收、付费跑分与部署替换仍先不做。
