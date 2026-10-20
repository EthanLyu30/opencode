# Task24B Docker 与 Microsoft 厂商外联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在逐项人工授权后，以最少字段、有限次数向两家厂商咨询既有双盘交接契约，交付可核查的联系状态和静态缺口结论，不产生运行许可。

**Architecture:** 先离线固定两份稿件，再分别完成每家渠道与身份核对、一次发送及有界回复裁决。默认账号和提交由用户手动操作；助手沿用本会话逐任务执行，使用 executing-plans，不创建自动外联程序或新代理。任务间传递脱敏报告栏目，不把报告布尔值、hash 或前一家答复当作下一项授权。

**Tech Stack:** 仓库 Markdown、Git、PowerShell 和现有 Node/Prettier；未来门户/公开线程仅在另获准确授权后使用。无新增依赖、SDK、探针、数据库、浏览器自动化或产品代码。

**Spec:** [已确认外联规格](../specs/2026-10-20-task24b-vendor-outreach-bounded-design.md)。用户本轮只批准编写实施计划，尚未批准执行 OE1–OE6。规格正文的历史“待审阅”标记不覆盖本轮确认，但也不代表批准登录、发送或消耗权益。

日期：2026-10-20，Asia/Shanghai。工作目录：`D:\OpenCode-Audit`。计划基线：`dev / b81f536f5689540dc7fc2b3a0eb5632230e25fc3`。本文只在本地保存、检查并提交，不 push，不产生新的网络请求；不执行下述任务。

## Global Constraints

- 既有 CV1 的 `researchStatus=blocked / insufficient_evidence`、`targetApplicability=unknown`、`operationalStatus=blocked` 保持不变；本包另记联系阻断项和候选材料的冲突，不把渠道页面或工单回执当作技术契约。
- 不推进 NW2–NW13、CV2–CV4、reader/layout 或实验；系统查询、安装文件读取、实际读盘、准备和启动仍各自另批。
- 旧 C 盘目录不读、不迁移、不删除、不恢复、不覆盖；真实 `.wslconfig`、原盘、安装目录、Key/env/credential、账号许可不读。不执行 Docker/WSL/backend、服务、VM、pipe 或诊断。
- 真实验收、付费跑分和部署替换仍先不做；旧视觉、租约/重试/预算、模型/endpoint、旧 dist 和部署不变。
- Docker 最多 1 个官方线程，Microsoft 最多 1 个；每次单独批准，合计最多 2 次，不跨渠道重复投递。
- 每家正文最多 16384 UTF-8 字节。默认跟进 0 次；另批后每家最多 1 次、最多 4096 UTF-8 字节，仅在原线程澄清。
- 附件 0，远程会话 0，新增费用 0，支持次数消耗 0，跨厂商转发 0。必需消耗一次已有权益也要单独明确批准，不能自动使用或购买。
- 回复审阅另批后，一轮最多每家 2 份文本、共 4 份；每份最多 65536 字节、合计最多 262144 字节。超限先停，不截断反证后记通过，用户原件保留。
- 不自动轮询、提醒、催单、重搜、重发或读取邮箱。提交结果不明记 `delivery=unknown`，不得直接重试。
- 公开渠道、在线 AI、登录后页面、增加表单字段、跟进和跨厂商摘录均不是原始发送授权的隐含部分。输入可能触发自动保存，不能把“尚未点 Submit”当作未发送。
- 旧未跟踪报告及 clean-tree/endpoint 阻断原样保留；所有旧策略拒绝中间根均不读、不复用、不再清理。后续任务不以“清理工作区”为前提删改旧文件。

## Review Focus

以下为五项纸面反证核查，不是要实现的测试程序、真实登录实验或 mock 门户。执行对应任务时记录输入、人工判断和结果，不写虚构的 RED/GREEN 或产品回归通过。

1. **RF1 授权与隐式发送**：只有方案/计划确认，或门户预填会自动上传时，必须保持未发送；原人工路径不可用不能自动转向 Gordon、社区或另一家厂商。由 OE2、OE3/OE4 核查。
2. **RF2 资源与账号**：报价为零但要消耗一次支持权益、未知账号/联系字段、需要 captcha 或新增条款时，必须停止，不自动登录、消耗、绕过或创建第二单。由 OE2 核查。
3. **RF3 不确定投递**：超时、无工单确认或用户不能确定是否提交时，记 unknown；只能另批只读核对原线程，不能重发或据自动回信宣称人工答复。由 OE3、OE4 核查。
4. **RF4 版本与本机数据**：历史 `4.79.0 / 230596` 不能变成 live 安装身份；表单索取版本/诊断/复现时，不运行命令、不编造值、不删掉关键限制以绕过。由 OE1、OE2 核查。
5. **RF5 回复的效力与披露**：AI/社区身份、私有转发、未覆盖取消/双盘的局部保证或版本错配，均不能解除阻断或触发本机操作。由 OE5、OE6 核查。

## 文件与材料边界

本轮只新增本计划。未来另获执行授权后，OE1–OE6 只创建/更新一份脱敏交付报告：

`D:\OpenCode-Audit\docs\superpowers\reports\2026-10-20-task24b-vendor-outreach-preparation-and-decision.md`

报告固定栏目为 `Inputs / Drafts / Gates / Delivery / Replies / Contract / Decision / Verification`，合计最多 262144 UTF-8 字节。文件已存在则先查明用途与已有内容，不覆盖或另建重复副本。Tasks 的 Files 块均指此报告的准确栏目；不修改规格、CV1 历史报告、旧未跟踪报告或产品文件。

来源只读：

| 输入                                                                                       | 本轮核对的工作副本 SHA256                                          | 用途                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------ |
| `docs/superpowers/specs/2026-10-20-task24b-vendor-outreach-bounded-design.md`              | `ce0a447ffde1b00671fcfb036db3b5a58ec9cfb903e95c1b06bf6da3b20095e1` | 已确认渠道、英文稿、白名单、预算和授权边界 |
| `docs/superpowers/reports/2026-10-20-task24b-cv1-vendor-contract-evidence-verification.md` | `1912a935bcfd807e2c708fa45496e3a0babe4521d452514a9e9e0a9173fcf705` | 已完成有限取证的缺证结论，不重新取证       |

渠道仅沿用规格第二节的记录：Docker 支持说明及 `https://hub.docker.com/support/contact/` → `https://app.docker.com/support/contact`；Microsoft 正式支持说明及 `https://engagecenter.microsoft.com/`。Docker Forums 与 `microsoft/WSL issues` 只是另选备选，不自动访问或投递。上述路径是规格记录的入口，不声称本轮重新验证受理情况。

账号、姓名、邮箱、电话、合同/Access ID、票据私有 URL、原回复及附件不进入 Git；默认由用户自行持有和操作，不新建保存个人资料的文件。报告最多写“用户已选择/未选择/未核实”，不能把用户口述写成助手亲自核实。

无新的落地原文、抓取缓存、脚本或包装器。若执行技能要求中间文件，须先修订计划、明确全新 D 盘独有根、owner、预算和清理方式，再请用户确认；不能借技能默认创建或复用 CV1 旧根。用户原件、目的不明文件及既有残留不清理。

## 栏目接口与固定稿件

这些名称仅统一报告字段，不是新增程序类型、数据库表、授权状态机、descriptor 或 permit。

- **DraftRecord**：`vendor=docker|microsoft`、`specCommit`、`subject`、`bodyRepresentation`、`bodyBytes`、`bodySHA256`。只存公开技术稿；账号字段不并入正文。
- **GateRecord**：每家单独记 `channel`、`visibility=private|public|unknown`、`actor=user_manual|assistant_separately_authorized`、`identity=not_selected|user_selected_unverified|user_confirmed`、`fields=unreviewed|whitelist_reviewed|extra_required`、`cost=unknown|zero_confirmed|separate_budget_required`、`draft=exact|changed|unverified`、`authorization=not_requested|missing|explicit_for_exact_operation`、`gate=blocked|ready_for_one_submit`、`reason`。真实账号值不入报告；ready 不是登录/点击/运行许可。
- **DeliveryRecord**：每家单独记 `delivery=not_sent|unknown|confirmed`、`basis=user_attested|authorized_thread_check|none`、实际发生时间或 `not_observed`。私有线程定位由用户保留，不编造 ticket ID 或“已送达”时间；确认投递不等于人工回复。
- **ReplyRecord**：获准文本的 `vendor / receivedAt / sourceVerification=verified|unverified / disclosure=allowed_summary|not_approved / clauseLocations / limits`。私有来源和作者职责在获准输入中核对，公开报告只写允许的脱敏事实；无法核实的边保持 unknown。
- **DecisionRecord**：`coordination=not_contacted|awaiting_user|awaiting_reply|bounded_closed`、`contactBlocker` 及静态缺口；另附既有 CV1 的 `researchStatus / reason / targetApplicability / operationalStatus`，不覆盖历史结论。候选材料的边界冲突写入 `contactBlocker=conflicts_with_boundary` 或 Contract 候选评述，不擅自改 CV1 的 reason。只有另批静态复核才可能更新研究结论，本包始终不授权运行。

Contract 逐行包含 K1–K8、C1–C10 和五条边：controller→launcher、launcher→backend、backend→WSL/HCS、WSL/HCS→双盘 writer、双盘 writer→已归属收尾。保留 `inheritedStatus`：K 为 unknown、C 和边为 unresolved；另记本包候选出处、原文位置、限制和 `candidateStatus=unknown|claimed_support|conflict`，初始均 unknown。claimed_support 仍待独立静态复核，不等于正式关闭旧义务或反例。

### 稿件的确定性表示

从规格第四、五节各取唯一 `Subject: ` 行为 subject；正文从该行后第一个空行起，到下一节标题之前止。正文转为 UTF-8 无 BOM、CRLF 转 LF、去掉末尾空白后添加恰好一个 LF；不包括 NOT SENT 提示、节标题或字段白名单。subject 不带 `Subject: ` 前缀。不得在复制时追加签名、路径、报告链接或其他摘要。

| vendor    | subject                                                                    | bodyBytes | bodySHA256                                                         |
| --------- | -------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| docker    | Supported Windows WSL2 dual-VHD handoff contract and version applicability |      2732 | `f9e8f49b1008804eb0d2d542bc87f26bbf13eee5bf26c60ba89f74e501898571` |
| microsoft | Supported WSL HCS dual-VHD admission and cancellation guarantees           |      2736 | `d47d1dec160399cdc1030b5cdd4cd517a811ae99e97990629fa53ca81ed06aca` |

以上是本轮离线计算的稿件 pin，不是正文已经发送或未来任何操作已获授权。将来发现规格/稿件改变，先显示差异重新审阅，不自动重算 pin 后继续。门户格式转换也需用户查看实际可见完整正文，hash 一致不能代替人工检查。

## 执行顺序与硬停止门

`OE1 离线准备 → OE2 每家分别审查渠道 → OE3 Docker 单次发送 → OE4 Microsoft 独立单次发送 → OE5 获准回复审阅 → OE6 文档封口`

每条箭头表示依赖，不表示授权继承。未来即使泛称“按计划执行”，也只可进行明确获准的离线任务；OE2 的登录后/账号访问、OE3/OE4 的每次发送或权益消耗、OE5 的来源访问/跟进都必须先取得对应准确批准。授权缺失时停止该任务并交接，不挂起长等待或自动申请下一关。

Docker 没有回复不自动转微软；用户可另行明确选择先向 Microsoft 发出原稿，但仍需它自己的 OE2 和发送确认。没有发送、渠道不可用或没有回复也能交付有界停止报告；不可把这些任务标为发送/技术取证已完成。

## Task OE1 离线固定稿件与未接触状态

**Files:** Create 报告的 `Inputs / Drafts / Gates / Delivery / Contract / Decision`；Verify 两份只读输入文档与本计划。Test 为 RF4 的纸面代入及本地文档检查，无产品测试文件。

**Interfaces:** Consumes 已确认规格、上述稿件表示与 pin；Produces 两份 DraftRecord，初始 GateRecord、DeliveryRecord 和 blocked DecisionRecord，供 OE2–OE6 读取。

- [ ] **Step 1 核对文档输入**：只读确认 dev、当前差异和输入摘要。记录真实基线；旧未跟踪文件不 stage/移动/忽略/删除。输入语义变化或任务报告归属不明则停止，不读取旧中间根。
- [ ] **Step 2 建立报告骨架**：按固定八栏目创建报告；两家均记 `identity=not_selected / fields=unreviewed / cost=unknown / authorization=not_requested / gate=blocked / delivery=not_sent / basis=none`，`coordination=not_contacted`；8 项 K unknown、10 项 C unresolved、5 条消费边 unresolved。
- [ ] **Step 3 固定实际技术稿**：按确定性表示提取两段正文，核对 subject、字节数和 SHA256，逐字段对照规格第三节；不复制实际联系人、附件、Git 链接或本机字段。任一 pin 不符只列差异，不发、不自动更新基线。
- [ ] **Step 4 纸面核查 RF4**：代入“把历史 build 改写成当前已验证安装”与“要求追加本机版本/诊断”两项，期望分别拒绝稿件变化、维持未采集且不执行命令；记录人工判断，不运行任何模拟门户或诊断。
- [ ] **Step 5 验证并本地提交**：按文末验证命令检查本报告，确认只新增该公开技术报告后提交 `docs(benchmark): prepare bounded vendor outreach`。不 push；此任务完成只代表离线包就绪，两家仍 not_sent。

## Task OE2 分别确认渠道身份与成本边界

**Files:** Modify 报告 `Gates / Decision / Verification`。Test 为 RF1/RF2 及表单强制本机字段反证；不写账号配置、cookie、截图或联系人文件。

**Interfaces:** Consumes 对应 DraftRecord 与用户对该厂家、准确查看范围的授权；Produces 该厂家独立 GateRecord。Docker 和 Microsoft 的记录不能互相代替。

- [ ] **Step 1 判断本次允许查看的范围**：缺少渠道核对授权就记 `authorization=missing / gate=blocked` 并停止。若只允许公开页面，不进入已有登录会话或登录页操作；用户手动核对权益也不赋予助手账号访问权。
- [ ] **Step 2 核实单一官方路线**：默认由用户手动查看所选入口、接收组织/队列、隐私和条款。若另批助手公开只读核对，仅用不携带用户账号会话的公开读取能力，只查规格中该厂家的一个入口，最多跟随两次同组织官方重定向；网络失败原样最多重试一次。无此读取能力不另建浏览器档案绕过。遇登录、第三方目的地、captcha 或无法确认队列即停，不填表、不用 Gordon、不扩大到备用站点。需要用户自行完成的登录另由用户选择，助手不读取其凭据或替其接受条款。
- [ ] **Step 3 完成用户可审阅的字段与资源清单**：用户直接选择身份/联系人并核对门户完整字段；报告仅记录确认状态及脱敏字段名，未知项保持未知。新增费用/支持次数默认均 0；要求消耗一次已有权益也记 `separate_budget_required`，先列确切次数/费用、用途和可见性另批。不主动读取或关联合同、初始化个人资料、购买或激活支持权益。
- [ ] **Step 4 纸面核查 RF1/RF2**：分别代入“已确认计划但未批准登录/发送”“免费建单要扣 1 次支持次数”“只有 AI 自助或公开 issue 可用”“强制诊断/未知联系字段”。四项都应 blocked、无输入/投递/消耗；不能降低严重性真实性、编造版本或通过另开渠道绕过。
- [ ] **Step 5 交付该厂家准确发送包并停止**：呈现入口/组织/队列、私有或公开、用户所选身份的披露方式、完整 subject/正文、字段白名单、附件 0、费用/次数和实际操作者。没有准确的一次发送批准时保持 blocked；其后明确批准后才可在该次操作前复核并记 `ready_for_one_submit`。只提交允许公开的报告增量，消息为 `docs(benchmark): record vendor outreach gate`；不把个人字段或私有页面入 Git，不 push。

## Task OE3 Docker 单次发送及投递裁定

**Files:** Modify 报告 Docker 的 `Gates / Delivery / Decision / Verification`。Test 为 RF1/RF3。不得修改固定正文、门户客户端或网络配置。

**Interfaces:** Consumes Docker DraftRecord、Docker GateRecord，以及用户针对准确正文、渠道、字段、费用/次数和实际操作者的发送授权；Produces Docker DeliveryRecord。Microsoft 的授权和 delivery 不变。

- [ ] **Step 1 复核准确授权**：缺少人类对这一次操作的明确批准，或字段/草稿/队列/身份/条款改变，立即 not_sent/blocked。若有支持次数消耗，还须核对单独获批的准确预算；0 元不能替代次数授权，页面中的默认勾选也不是授权。
- [ ] **Step 2 检查实际提交内容**：默认用户手动逐项核对门户实际可见正文与白名单后才输入/提交。助手代发必须另批相应账号访问与交互能力；未获准就不操作。发现自动保存/AI 中转或新字段时，在输入前停止，不以正文 hash 相同放行其他元数据。
- [ ] **Step 3 执行至多一次获准投递**：仅由该次授权确定的操作者完成，附件 0、不跨渠道重复发送。无法提交则记录实际未执行/受阻，不创建备用单、不发送邮件或增加联系人，也不运行厂商建议命令。
- [ ] **Step 4 纸面核查 RF3 并裁定实际 delivery**：代入“点击后超时、无回执、自动回信不是人工回复”，期望 unknown、禁止重发。实际只有用户确认可核实的原线程或另批的原线程只读检查才可 confirmed，并明确 basis；没有观察到的时间写 not_observed，私有 ID/URL 不入 Git。
- [ ] **Step 5 交接并停止**：成功仅记 `coordination=awaiting_reply`；未知则列出核对原线程所需授权；未执行则 not_sent。更新允许公开的报告增量并本地提交 `docs(benchmark): record Docker inquiry disposition`，不 push、不轮询、不自动转 OE4，不把此阶段称为契约通过。

## Task OE4 Microsoft 独立单次发送及投递裁定

**Files:** Modify 报告 Microsoft 的 `Gates / Delivery / Decision / Verification`。Test 为 RF1/RF3 及跨厂商披露反证。

**Interfaces:** Consumes Microsoft DraftRecord、Microsoft 自己的 OE2 GateRecord 和这次准确授权；Produces Microsoft DeliveryRecord。只依赖 OE3 的状态记录，不继承 Docker 账号、条款、预算或发送权。

- [ ] **Step 1 复核独立 gate**：明确用户是否选择现在向 Microsoft 咨询。没有选择或没有准确发送批准就保持 not_sent/blocked；Docker 成功、转介、无回复或被拒均不是这项批准。
- [ ] **Step 2 复核该包披露范围**：默认只用固定 Microsoft 原稿，不夹带 Docker 私有工单 URL、原回复、附件或本机资料。若需加入新协议名/摘录，先核对可转发权限并另审修改后的正文，旧 pin 不再代表新稿已获批准。
- [ ] **Step 3 依 OE3 的 Step 2–3 执行该次独立提交**：按 Microsoft 自己的字段、账号、费用/次数及实际操作者复核，至多一次，附件 0。无适当 WSL/HCS 分类或只能要求机器诊断时停止，不开 Azure/无关仓库/私人邮箱工单代替，也不假装本问题是已复现 bug。
- [ ] **Step 4 核查反证并裁定 delivery**：RF3 同 OE3，未知禁止重发；另代入“Docker 员工建议联系微软即授权转发整封邮件”，期望拒绝转发且保留原稿。实际记录 basis 和可核实的投递状态，不臆造产品团队受理或正式技术答复。
- [ ] **Step 5 交接并停止**：只更新 Microsoft 的 delivery 及总协调状态；允许公开的增量本地提交 `docs(benchmark): record Microsoft inquiry disposition`。不 push、不查其他邮箱或工单，不新建轮询/提醒，等待用户提供材料或另发准确请求。

## Task OE5 获准回复审阅与可选跟进申请

**Files:** Modify 报告 `Replies / Contract / Decision / Verification`，不改既有 CV1 报告或保存原邮件/附件。Test 为 RF5 及回复预算。

**Interfaces:** Consumes 用户明确允许审阅的文本，或另批只读查看的准确原线程及引用权限；Produces ReplyRecord、逐条候选依据和未解决项。没有回复输入时可交付无材料状态，但不能标为已完成技术回复审阅。

- [ ] **Step 1 检查输入权限与限额**：只接受每家最多 2 份文本、共 4 份，每份 65536 字节、合计 262144 字节。超限、保密/引用权不明或需新账号入口即停，保留用户原件；不自动读附件、截图 OCR、邮箱、全线程或回复中的链接，更不运行代码/命令。
- [ ] **Step 2 核实来源与负责范围**：分别判断来源入口、作者职责、答复时间、原文位置、覆盖构建及保密属性。用户粘贴且无法核实时写 unverified；AI、普通社区用户或仅提供方向的答复不记正式保证。报告只保留允许的脱敏事实，不写真实联系人、合同、工单私有 URL 或原回复。
- [ ] **Step 3 对照必要义务和消费链**：对 K1–K8、C1–C10 和五边逐项列候选出处、限制、candidateStatus；准确映射沿用规格第五节表及 CV1 报告。没有明确连续保护、双盘整体准入、准确身份、取消/晚到终止、有界 join/归属收尾与构建条件的候选项仍 unknown；旧义务/反例仍 unknown/unresolved，双方不相连的承诺不能合并。
- [ ] **Step 4 纸面核查 RF5**：代入 AI 回复、私有材料未经许可跨厂商复制、仅 VM pause/两次 attach、取消响应成功但等待者可能继续、只覆盖不同构建、厂商建议启动/运行诊断。预期不扩大来源效力、不转发、不执行、不放行；明确边界冲突只记 conflicts_with_boundary。
- [ ] **Step 5 只提出有界跟进申请并交接**：若有具体缺项，可写原线程最多 4096 UTF-8 字节的问题稿供审阅，正文不入自动发送队列；默认跟进 0 次。以后另批每家最多 1 次时，须重新经过该厂家 OE2/发送核对并沿用 RF3，不能重新创建首帖、重置次数或跨厂商转发。只提交获准公开的分析，消息为 `docs(benchmark): assess bounded vendor replies`，不 push；缺少回复或披露许可时只报告准确缺项。

## Task OE6 有界文档封口与下一授权清单

**Files:** Modify 报告 `Decision / Verification` 及允许公开的缺口汇总；不修改规格、CV1 结论、registry 或任何运行设置。Test 为五项 RF 的覆盖复核和静态结论分层。

**Interfaces:** Consumes 已实际执行部分的 Draft/Gate/Delivery/ReplyRecord 及所有未获授权/未取得项；Produces 有限报告，状态缺证继续 blocked。OE3–OE5 未获准并不阻碍交付停止报告，但不得标为已执行。

- [ ] **Step 1 对账实际操作**：分别列正文、投递、跟进、附件、费用和支持次数的实际已知数量，未知记 unknown。把未执行/待确认与已完成分开；不把 0 次发送写成已联系两家、不以自动回复写成工程结论。
- [ ] **Step 2 作分层裁决**：无回复/无合格契约继续 insufficient_evidence；明确要求改 ACL/share/服务/驱动、预取写权、复制盘或升级时记录 boundary conflict 并停止；新清楚材料只标“候选，待另批静态复核”。不自动重开 CV1/CV2、不查询版本、更不推进 NW2–NW13 或生成许可。
- [ ] **Step 3 复核 RF1–RF5 与规格覆盖**：逐项指出对应人工核查的记录和未执行原因；特别确认来源真实性、版本范围、双盘保证、取消后晚到和 crash 语义均未被间接替代。验证时不登录/重投递来补“测试”，缺项仍缺项。
- [ ] **Step 4 验证报告与既有材料保持不变**：执行下述格式、差异及准确 staging 检查；旧未跟踪报告保留，旧被拒中间根不复用。若出现新增中间物，按其已获准、准确归属与路径清单清理；未获准的中间物创建不是计划的常规步骤，不能删除目的不明文件来掩盖偏差。
- [ ] **Step 5 本地提交与交接**：仅在文档检查通过后提交 `docs(benchmark): conclude bounded vendor coordination`，交付实际状态及需要什么新材料/授权，不创建自动跟踪任务。push 必须另批，届时保留原 hooks 并单独核对远端；本计划不要求创建发布包装器，也不允许为 push 复用旧被拒根。

## 文档验证命令与通过条件

未来执行任务时，在 `D:\OpenCode-Audit` 运行，`$oeReport` 只能是上述准确报告；本轮写计划时只把目标替换为本计划文件。使用现有工具，不自动安装。Formatter 需要修正时只可格式化本次获准文档，不能整仓格式化。

```powershell
$env:NODE_DISABLE_COMPILE_CACHE='1'
$env:NODE_OPTIONS=''
$oeReport='docs/superpowers/reports/2026-10-20-task24b-vendor-outreach-preparation-and-decision.md'
& 'D:\Applications\nodejs\node.exe' 'node_modules/prettier/bin/prettier.cjs' --check $oeReport
if($LASTEXITCODE -ne 0){throw 'document format check failed'}
git diff --check
if($LASTEXITCODE -ne 0){throw 'worktree diff check failed'}
git diff --cached --check
if($LASTEXITCODE -ne 0){throw 'staged diff check failed'}
git status --short --branch
```

通过证据：Prettier 输出 `All matched files use Prettier code style!`、两个 diff check 退出 0；人工逐项核对字段、预算与授权记录，实际 staging 仅含本次获准文档。先 `git add -- $oeReport` 后再检查 staged 差异与准确文件清单，不用 `git add -A`、`reset/restore`、忽略旧文件或清空工作区；意外 staged 内容先停止，不擅自处理他人改动。

正文 pin 的验证按上述确定性表示在内存计算字节数与 SHA256，并对照表中精确值；不创建提取副本、测试账号或 helper。pin 只能说明稿件一致，不能证明内容无所有隐私风险、已取得发送许可、厂商真实承诺或实际部署安全。

这是文档/人工协调任务，不添加产品测试，不运行根目录测试或用全量业务回归代替审阅。凡未执行的网络、预算执行器、登录、发送或运行检查均不记通过；纸面核查不冒充端到端验收。

## 计划自审与审阅入口

规格第一/九节由 Global Constraints、OE1/OE6 覆盖；第二节的渠道路线由 OE2–OE4 覆盖；第三节白名单和第四/五节稿件由 OE1/OE2、独立发送核对覆盖；第六节预算、unknown 禁重发和停止条件由各任务及 RF 覆盖；第七节分步授权由全部门槛覆盖；第八节证据分层由 OE5/OE6 覆盖。RF1–RF5 均有具体反证输入和预期判断，不要求新增实现代码。

当前需用户审阅的是本计划，不是任何发送包。推荐保持“本会话逐任务、默认用户手动账号/提交”的方式；若后续只授权 OE1，就只完成离线报告后停止。**确认本计划不触发登录、发送、支持权益消耗、系统查询、安装文件读取、读盘或启动；这些仍按准确范围另行确认。**
