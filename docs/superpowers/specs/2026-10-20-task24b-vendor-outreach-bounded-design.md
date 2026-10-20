# Task24B Docker 与 Microsoft 厂商外联有界方案

状态：待用户审阅，仅方案，未发送。日期：2026-10-20，Asia/Shanghai。仓库基线：`dev / 8b0b9d81ba449771daa86532f8412f980208ea36`。

## 一 目标与当前结论

向 Docker 和 Microsoft 确认：是否存在受支持、可核实且符合既定边界的双盘交接契约，以及哪些准确构建消费该契约。成功可以是取得明确技术依据，也可以是取得明确限制或“不属于本团队支持范围”的答复；不承诺厂商会提供接口、定制方案或支持结论。

依据[契约与目标版本规格](2026-10-20-task24b-vendor-contract-target-version-design.md)及[CV1 报告](../reports/2026-10-20-task24b-cv1-vendor-contract-evidence-verification.md)。CV1 的两条限定查询无结果，不代表所有渠道无资料。本方案只增加联系途径、问题稿和发送边界，不把渠道页面当作交接实现证据。

当前继续保持 `researchStatus=blocked / insufficient_evidence`、`targetApplicability=unknown`、`operationalStatus=blocked`。不推进 NW2–NW13、CV2–CV4、reader/layout 或实验。

本轮只读仓库上下文与公开渠道页面，编写本规格、自审、格式检查并本地提交；不 push，不登录、填表、使用在线 AI、建单、发帖、发信、上传或购买支持。本规格确认只表示方案定稿；实际外联仍需按第七节单独批准。

## 二 路线选择与官方渠道

### 推荐顺序

| 路线                                                             | 收益和限制                                                               | 选择                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| 先 Docker 正式支持确认 Desktop 入口，再向 Microsoft 核实下层保证 | 先确定实际产品消费关系；需用户确认支持权益，咨询可能超出支持范围         | 推荐；每家分别审批，前一家回复不自动授权联系后一家 |
| Docker 社区与 Microsoft 官方项目公开询问                         | 可取得文档线索，但公开账户身份及正文；无答复或回复不具契约效力均可能发生 | 无正式支持途径时的备选，不能自动切换               |
| 同时在多个论坛、issue、邮件或售前渠道广泛征询                    | 扩大披露、重复通知和责任不清；不能保证取得更强证据                       | 不采用，不猜测员工邮箱或寻找私人联系人             |

默认由用户手动处理账号、权益和最终提交，助手只准备经过审阅的正文。将来如希望助手代发，需另行确认具体渠道、账号身份和完整发送包；本方案不预批浏览器登录或连接邮箱。

### 已核对的入口和限制

以下是 2026-10-20 的公开渠道依据，不是已登录后的受理验证。没有读取用户订阅、许可、个人资料或支持合同。

| 对象           | 官方渠道与依据                                                                                                                                                                                                                                                                                                                  | 拟咨询内容及限制                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker 首选    | [Docker 支持说明](https://docs.docker.com/support/)链接的[联系入口](https://hub.docker.com/support/contact/)，本次公开页面重定向至[Docker 联系页](https://app.docker.com/support/contact)                                                                                                                                       | Desktop 受支持接口与构建适用性。付费支持有订阅、版本和范围限制，文档排除部分集成定制；本咨询能否受理未知，不假装已有服务承诺                               |
| Docker 备选    | 同一支持说明列出的 [Docker Community Forums](https://forums.docker.com/)                                                                                                                                                                                                                                                        | 仅询问既有文档和负责团队。社区尽力答复，不等于正式厂商保证；栏目、发帖规则与公开身份须在选择该路径时确认                                                   |
| Microsoft 首选 | [Microsoft 正式支持工作流](https://learn.microsoft.com/en-us/services-hub/sfbus/support-for-business/access-id-prof-support)及[现行 Partner 支持指引](https://learn.microsoft.com/en-us/partner-center/benefits/mpn-benefits-technical-support)列出的 [Engage Center Support for Business](https://engagecenter.microsoft.com/) | 请求路由给负责 Windows 虚拟化、WSL/HCS 的支持团队。需要登录与适用权益；所引 Partner 流程不证明用户是 Partner，也不保证本问题有可选分类或属于可受理支持事件 |
| Microsoft 备选 | [WSL 官方故障与功能反馈指引](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#file-an-issue-bug-report-feature-request)指向 [microsoft/WSL issues](https://github.com/microsoft/WSL/issues)                                                                                                                        | 仅在当前规则允许时提交既有接口/文档澄清或准确转交请求。不把设计咨询伪装成已复现 bug，也不把功能愿望当作已有功能；不能受理则停止，不随意换仓库              |

没有确认任何 HCS 专用私人邮箱、保证直达产品团队的工单分类或免付费通道。Microsoft 一般 Contact Us 页面本次未取得稳定可用的分类内容，不据此补写准确受理路径；以上述可核对的正式文档入口为准。HCS 不在 WSL 团队职责内时，应要求明确转交途径，不能把 WSL 回复扩展为 HCS 承诺。

Docker 当前公开联系页显示 Subject、Details、Contact name、Email、Confirm email、Topic 等字段，Namespace 为可选，并先提供 Gordon 自助入口；只查看了空白页面，没有输入或点击提交。**不自动点击 Get instant help 或向 Gordon 发送正文。** 若没有可绕过自助 AI 的已批准人工支持路径，先报告渠道限制；是否允许把同一最小正文交给该 AI，需用户另选，AI 输出仍不是契约证据。[公开联系页依据](https://app.docker.com/support/contact)

支持工单创建可能消耗已有支持次数，即使没有新增扣款，也属于资源使用。预算默认新增费用为 0、支持次数消耗为 0；若渠道必需消耗一次权益、升级订阅或支付费用，先停下另批，不能以“已有权益”视为可自行使用。[Microsoft 权益与工单说明](https://learn.microsoft.com/en-us/partner-center/benefits/mpn-benefits-technical-support)

WSL 的 bug 指引会要求本机版本、复现和诊断材料；本任务不是 bug 复现。表单强制要求未获准字段时，不运行其示例命令、不编造值或填无关内容绕过规则，停止并报告所缺授权。[WSL 指引](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#file-an-issue-bug-report-feature-request)

## 三 拟发送字段与不得夹带的内容

以下只是未来可提请批准的白名单，当前没有任何字段获准对外发送。技术正文与账号/联系资料分开审批；若改正文、收件方、可见性或新增字段，需要重新审阅实际发送内容。

| 字段                   | 拟发送的准确值或处理方式                                                                  | 边界                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 主题                   | 第四节或第五节对应的英文 Subject                                                          | 每家一个问题，不声称生产事故、数据损坏或紧急中断                                                      |
| 产品和版本参考         | Docker Desktop `4.79.0 / build 230596`，明确只是历史参考版本，不是当前机器已复核身份      | 不发送 backend hash、安装路径、七成员摘要；不宣称该版本当前受支持或本机仍安装它                       |
| 场景                   | Windows 上拟议的 WSL2 backend，两块既有 VHDX，抽象命名 A/B                                | 不发送盘符、盘路径、文件名、卷序列号、文件 ID、大小、mtime、内容或布局；不声称实际布局/离线状态已验证 |
| 保护要求               | OPEN_EXISTING、只读、拒绝写/删除共享、稳定父链、准确 writer、双盘整体准入                 | 说明为设计要求，不声称现有工具/厂商已实现                                                             |
| 待确认能力             | 连续保护、请求身份、并发/mapping 拒绝、异常、取消/晚到终止、完整有界 join、构建与双方责任 | 使用下面完整问题稿，不包含真实 SID、PID、VM ID、nonce、pipe 名或签名                                  |
| 平台细节               | 当前 Windows build、WSL/HCS 版本、文件系统及启用条件均未采集                              | 不发送猜测值；可请厂商先列其契约依赖的最少字段，不自动采集或补发                                      |
| 链接和附件             | 默认附件 0，项目/仓库/报告链接 0                                                          | 不附本规格、CV1/HS 原报告、内部提交或会话历史；它们可能含本机资料，不能整份复制                       |
| 联系姓名及邮箱         | 由用户在实际发送审批时选定并直接填写；当前未选择，不从配置、浏览器、Git 或系统提取        | 只供选定的私有官方门户，不放公开正文、仓库或方案；新增抄送/电话/组织字段另批                          |
| 账号及支持身份         | 用户自行选择并操作账号；支持计划/合同 ID 不进入技术正文，助手不读取或记录其值             | 登录、关联权益、个人资料初始化或改变账号均不在当前授权内                                              |
| 语言、严重性及联系偏好 | 技术正文英文；非紧急咨询；优先书面回复，不请求电话、远程协助或屏幕共享                    | 若表单无符合事实的分类/严重性，停止，不夸大影响以取得支持                                             |

永不夹带 Key、`.env.local`、凭据、cookie/token、密码、账户许可明细、支付信息、用户名/主机名、IP/网络配置、日志、diagnostics ID、dump、截图、设置、VHD 或其他本地文件。后续确有必要时只能先提出准确字段与新授权，不因厂商索取而自动提供。

公开发帖还会暴露所选账号显示名/主页、正文、时间及回复关系；私有门户也会接收账号资料和正常连接元数据。无法承诺“只传正文、完全无 IP/浏览器元数据”。是否接受这些披露由用户在实际发送前决定；不以删帖保证撤回，因为通知、转存和索引可能已发生。

## 四 Docker 咨询稿

**NOT SENT。** 以下主题和正文可作为一份待审发送包，账号字段不包含在内。若门户允许，本包只请求既有支持契约的出处或准确转交，不要求实现新接口。

Subject: Supported Windows WSL2 dual-VHD handoff contract and version applicability

We are assessing a proposed external controller for Docker Desktop on Windows with a WSL2 backend. Please assess Desktop 4.79.0, build 230596, as a historical version reference, not as a verified current installation. No local reproduction or product failure is being reported.

Before implementation, is there an existing supported interface that transfers two existing VHDX objects from read-only inspection to one specifically authorized writer, without an unprotected release-and-reopen window? We require OPEN_EXISTING, denial of write/delete sharing and stable parent-chain protection before handoff, and no pre-acquired writable original-disk handle.

Please provide the interface, parameters, documented guarantees and applicability, or explicitly identify unsupported requirements:

1. How is protection preserved continuously until writer admission, including competing writers, existing writable mappings, parent replacement and special open/oplock branches, including opens that do not require an acknowledgement before proceeding?
2. How does the controller request bind to the actual process handle, exact creation time, security identity, image and this VM, rather than a PID, pipe name or first arriving request alone?
3. Can both disks be reserved, validated and committed as one admission decision, so disk A cannot obtain writable ownership before disk B is safely admitted? Two successful attaches or a paused VM do not by themselves establish this guarantee.
4. What happens on cancellation, timeout, second-disk failure, or controller, protection-holder or consumer crash? How are queued or late writers terminated and all owned work joined within a specified bound, without stopping shared services or unrelated VMs, or restoring disk contents?
5. Which exact Desktop/backend, WSL/HCS, Windows and filesystem versions, configurations and caller obligations implement these guarantees? Which common protocol and responsibility boundary connect Docker and Microsoft components?
6. Does the mechanism work without upgrades, patches, new drivers, ACL/share/service changes, copying the original disks or acquiring writable handles in advance? If not, please identify the incompatible condition.

Please distinguish documented guarantees from suggestions or unverified implementation assumptions. We cannot run diagnostics, start the backend, provide local files or collect machine metadata under this inquiry. If specific platform fields are essential, please list the minimum fields and why; they require separate approval. If this is outside your support scope, please identify the appropriate official route rather than submitting a separate request or forwarding our material to another vendor on our behalf.

## 五 Microsoft 咨询稿

**NOT SENT。** 这是独立的下层契约问题，不假定 Docker 已接入任何 Microsoft 协议。Docker 若给出新接口名称、回复摘录或私有材料，必须先审阅新发送包及转发权限，不能自动拼入此稿。

Subject: Supported WSL HCS dual-VHD admission and cancellation guarantees

We seek a documented Windows/WSL/HCS contract for a proposed external controller. Docker Desktop 4.79.0, build 230596, is a historical integration reference only; its use of any such Microsoft mechanism and the current machine versions have not been verified. This is an interface/supportability inquiry, not a reproduced bug or request to change the platform.

Is there an existing supported mechanism that transfers two existing VHDX objects from read-only OPEN_EXISTING inspection, denial of write/delete sharing and stable parent-chain protection to one specifically authorized writer, without releasing protection before admission or pre-acquiring writable original-disk handles?

Please identify the responsible component, documented entry point and exact guarantees, including:

1. Continuous object/parent protection, rejection of competing writers or pre-existing writable mappings, and special open/oplock branches, including opens that do not require an acknowledgement before proceeding.
2. Joint reservation, validation and commit for both disks: no writable admission of disk A while disk B is unprotected or has failed. A VM pause or two path-based attach operations is not sufficient evidence.
3. Binding the request/controller to the actual process handle, exact creation time, security identity, image and VM; state which obligations belong to the caller rather than being enforced by Windows.
4. Cancellation, timeout, partial failure, and controller, holder or consumer crash: revocation of queued/late writers, complete bounded joining and cleanup limited to this request, without terminating shared services/unrelated VMs or restoring original-disk contents.
5. The supported Windows revisions, filesystem capabilities, WSL/HCS builds, open parameters and exclusions. What documented consumer interface would Docker need to use, and how can its use by a specific Desktop/backend build be established?
6. Whether any guarantee requires upgrades, patches, drivers, ACL/share/service changes, disk copies or writable-handle prefetch. Please identify requirements not supported under these constraints, rather than proposing a release-then-reopen workaround.

Please supply verifiable documentation or a support statement with its exact scope. If responsibility is split between WSL, HCS, Windows storage and Docker, identify each boundary instead of treating partial assurances as an end-to-end guarantee. We cannot run commands, start components or upload local diagnostics/files. Any minimum machine fields you require need separate approval. If the question belongs elsewhere, please identify the official route rather than submitting a separate request or forwarding our material to another vendor on our behalf.

### 与既有义务的对应

| 既有要求                               | Docker 问题   | Microsoft 问题 |
| -------------------------------------- | ------------- | -------------- |
| K1、K4，C1/C7/C8 连续保护与竞争分支    | 开头和第 1 问 | 开头和第 1 问  |
| K2，C3/C4 准确进程及请求身份           | 第 2 问       | 第 3 问        |
| K3，C2 双盘整体准入                    | 第 3 问       | 第 2 问        |
| K5、K6，C5/C6 异常、晚到请求及归属收尾 | 第 4 问       | 第 4 问        |
| K7 构建条件与消费链                    | 第 5 问       | 第 5 问        |
| K8，C9/C10 不改边界、不以间接材料放行  | 第 6 问及结尾 | 第 6 问及结尾  |

两稿不要求厂商采用我们自定的 reserve/commit/abort 函数名；可以提供等价行为契约。每家只能证明自身负责的部分，接口、参数、版本和责任边界必须能相互连接。

## 六 数量预算与停止条件

这些是拟议上限，不是已经取得的发送权限。发送包括表单可能的自动保存、在线 AI 请求、评论、回复和实际提交，不仅是最后一个 Submit 按钮。

| 项目                 | 拟议上限或默认值                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首次咨询             | Docker 最多 1 个官方线程，Microsoft 最多 1 个；每次单独批准，合计最多 2 次，不跨渠道重复投递                                                                                  |
| 正文                 | 每家最多 16384 UTF-8 字节，只含已审稿件；平台限制更小时先重写审阅，不截断安全条件后直接发送                                                                                   |
| 跟进                 | 默认 0 次；有具体缺项后可另批每家最多 1 次、最多 4096 UTF-8 字节，仅在原线程澄清，不催单或追新收件方                                                                          |
| 附件、远程会话及费用 | 附件 0，远程会话 0，新增费用 0，支持次数消耗 0；必需消耗权益时单独列数量与用途后再批                                                                                          |
| 跨厂商转发           | 默认 0；只可另批准确、允许披露的摘录，不能转发整封邮件、私有 ticket URL、账号或保密附件                                                                                       |
| 回复审阅             | 将来另批后，一轮最多每家 2 份文本、共 4 份；每份最多 65536 字节、合计最多 262144 字节。不自动读取附件、运行命令或追随全部链接；超限先停止，不截断反证后记为通过，用户原件保留 |
| 等待与检查           | 不自动轮询或创建提醒。用户提供回复或另行要求检查时再处理；无回复只记录待回复，不续发、重搜或持续耗费额度                                                                      |

实际提交结果不明、超时或缺少工单/帖子确认时，先记 `delivery=unknown`，不得直接重发造成重复。经用户允许只读核对原线程后，才裁定是否投递成功；自动确认邮件或 AI 回答不等于人工技术答复。

遇到无合适分类、当前版本不受支持、咨询超出支持范围、强制诊断/日志/元数据、要求启动/升级、必须购买/消耗支持权益、captcha 或额外条款、需新账号/联系人、拟公开内容变化时停止并呈现准确缺口。不能改用售前、安全漏洞渠道、无关仓库或私人邮箱绕过，也不自动创建第二张单。

不因“厂商建议先试一下”执行命令、复现、升级、注册、服务操作或盘操作。即便厂商回复包含官方示例/脚本，仍只是待审材料，不获得执行权限。

## 七 审阅与实际发送分开确认

实际发送前，每家必须有一份用户可逐项核对的发送包：准确官方入口、接收组织及拟选支持队列、私有/公开可见性、用户选定的账号显示身份、完整 Subject/正文、全部表单字段、附件 0、费用及支持次数预算、是否允许原线程跟进，以及提交操作方式。队列/分类不明确时先停，不猜测具体工程师；未选择账号/联系资料时写“未选择，不能发送”，不填占位个人信息或从本机提取。

同厂商在该工单内的正常内部分派应在实际发送审批中说明；它不等于助手另建单、跨厂商转发或自行新增联系人。若门户条款涉及超出用户可接受范围的共享，停止，不承诺能控制厂商接收后的内部处理。

1. **方案审阅**：确认本规格，只定稿路线、问题与边界，不登录或发送。
2. **渠道和身份确认**：用户选择每家渠道，手动确认权益、联系人与公开披露；若需要助手查看登录后页面或字段，先单独批准。禁止只为查看表单而预填正文，因为可能自动上传/保存。
3. **发送确认**：在完整字段和成本明确后，分别批准“向准确渠道发送这一份稿件一次”；正文差异、意外字段、AI 中转、跟进和转发不自动包含。
4. **回复处理确认**：用户提供可审阅的文本，或另批只读核对原线程；来源核实、引用权限和静态裁决独立处理，不顺带查询本机或执行厂商命令。

用户手动提交也要以相同字段白名单为准；助手不会因用户提交过一个问题就推断获准登录账号、检查邮箱、回复或联系其他厂商。

## 八 回复如何进入证据而不变成许可

只有可核实的厂商来源、明确负责范围、准确接口/行为保证及适用构建才是候选依据。官方域名上的普通用户发言、AI 回答、一般客服建议或“支持 WSL/停止 VM/只读 attach”不自动满足 K1–K8；员工标记也不能替代技术内容和责任范围。

后续记录应包含来源入口与线程、作者职责的可核实依据、答复时间、准确原文位置、版本范围、支持/限制、公开或保密属性和允许引用范围。原回复不写入公开 Git；用户拥有的原件不删除、不修改。只有用户允许发布的脱敏事实可进入后续报告，不能自动复制私有工单或截图。

按八项义务、十项反例和五条消费边逐项裁决，不把双方各自不负责的片段拼成整体承诺：

- 未回复、仅路由、回复含糊、缺构建范围或缺取消/双盘保证：继续 `blocked / insufficient_evidence`。
- 明确需要放宽保护、预取写权、复制盘、改 ACL/share/服务/驱动或升级组件：记录准确冲突，继续 `blocked / conflicts_with_boundary`，不实施替代路线。
- 得到清楚机制依据：只成为后续有限静态复核的输入，不自动改 CV1 结论或推进版本采集。厂商确需最小本机字段时，仍先提出独立 CV2 字段包供确认。
- 即使以后所有静态契约及准确版本对应闭合：运行仍 blocked；reader、完整布局、真实盘状态与各项独立验证仍未因此完成。

## 九 不变边界与本轮验收

系统查询、安装文件读取、实际读盘、准备和启动各自另批。本轮不执行 Docker/WSL/backend、服务、VM 或 pipe；不读取原盘、安装目录、真实 `.wslconfig`、Key/env/credential 或账号许可。旧 C 盘目录不读、不迁移、不删除、不恢复或覆盖；不做真实验收、付费跑分或部署替换。

仅新增本规格，不改业务代码、旧视觉流程、租约/重试/预算、模型/endpoint、部署或旧报告。旧未跟踪报告及其 clean-tree 阻断不处理；包括 CV1 在内的旧策略拒绝中间目录不读、不复用、不再清理。本轮不需要新中间根、包装器、下载副本或缓存，只保留这份用户要求的方案。

文档验收逐项核对官方链接及其证据边界、K1–K8/C1–C10 覆盖、拟发字段与禁止字段、人工/AI/公开渠道区别、资源消耗、重复发送防护和分步授权；运行本地格式与差异检查，不把文档检查冒充产品回归或交接验证。

**请审阅是否采用“Docker 正式支持优先，Microsoft 分别核实，最少字段、每家一次、无附件、无自动跟进、缺证停止”的方案。确认方案不等于批准实际外联。**
