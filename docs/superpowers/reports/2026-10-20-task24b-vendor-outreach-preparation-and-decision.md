# Task24B OE1 厂商外联离线准备与未联系状态

本轮仅执行已确认计划的 OE1，基线为 `dev / e874e2a442c3e41460c746557ef948d4b2fcc276`。用户批准离线准备、文档验证、提交和 push，不批准 OE2–OE6 或厂商操作；计划旧文中的“不 push”不覆盖本次明确发布授权。

两家均 **未联系、未发送**。这里只固定技术稿和未接触状态，不核对登录后渠道、账号、支持资格或费用，不接收/裁决厂商回复。CV1 的 `researchStatus=blocked / insufficient_evidence`、`targetApplicability=unknown`、`operationalStatus=blocked` 保持不变。

## Inputs

依据[已确认外联规格](../specs/2026-10-20-task24b-vendor-outreach-bounded-design.md)、[实施计划 OE1](../plans/2026-10-20-task24b-vendor-outreach.md)及[CV1 历史缺证报告](2026-10-20-task24b-cv1-vendor-contract-evidence-verification.md)。规格和计划的历史待审/未执行标记不覆盖用户本轮只执行 OE1 的明确指令，其余限制原样保留。

开始时为正常 checkout，git-dir 与 common-dir 均指向本仓库 `.git`，无 superproject；不创建 worktree 或新分支。HEAD 为上述完整基线，工作区只有既有未跟踪报告；本报告与本轮发布目录均不存在。之前本地领先 fork/dev 的两次提交仅含已确认外联规格与计划，未含产品代码。

| 输入                                                                             | 本轮工作副本 SHA256                                                | 处理                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 外联规格                                                                         | `ce0a447ffde1b00671fcfb036db3b5a58ec9cfb903e95c1b06bf6da3b20095e1` | 全文只读，固定稿件来源；specCommit=`b81f536f5689540dc7fc2b3a0eb5632230e25fc3` |
| 外联实施计划                                                                     | `316969ddab856490257c968911b82c76384c317f435afbef9a2bca82ffbd2e06` | 全文只读，只选 OE1 五步，其余未执行                                           |
| CV1 报告                                                                         | `1912a935bcfd807e2c708fa45496e3a0babe4521d452514a9e9e0a9173fcf705` | 全文只读，继承缺证状态，不重新检索或改历史结论                                |
| 旧未跟踪报告 `2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md` | `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07` | 仅核摘要，不读正文、不 stage/移动/忽略/删除，保留 clean-tree 阻断             |

以上仅为仓库文档摘要，不是安装、系统或磁盘取证。Desktop `4.79.0 / build 230596` 只作历史参考；没有取得当前安装、Windows build、WSL/HCS、卷、父链或原盘状态。

## Drafts

两稿作为仓库内待审技术文本，随用户已批准的 Git 文档发布交付，不填入任何厂商门户或外部 AI。bodyRepresentation 为 **UTF-8 无 BOM、LF、末尾恰好一个 LF**；subject 不含 `Subject: ` 前缀，正文不含下列元数据、节标题、NOT SENT 或 code fence。提取规则与计划完全相同。

| vendor    | subject                                                                    | bodyBytes | bodySHA256                                                         |
| --------- | -------------------------------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| docker    | Supported Windows WSL2 dual-VHD handoff contract and version applicability |      2732 | `f9e8f49b1008804eb0d2d542bc87f26bbf13eee5bf26c60ba89f74e501898571` |
| microsoft | Supported WSL HCS dual-VHD admission and cancellation guarantees           |      2736 | `d47d1dec160399cdc1030b5cdd4cd517a811ae99e97990629fa53ca81ed06aca` |

上述 pin 已在本轮离线重新计算，均小于 16384 字节。内存文档检查确认报告内两份复制稿与来源逐字节一致，故仅把 Gates.draft 从 unverified 更新为 exact；这不表示门户完整字段已经核对或发送已获授权。两份 DraftRecord 的 specCommit 均为 Inputs 所列规格提交。

### Docker NOT SENT

Subject: Supported Windows WSL2 dual-VHD handoff contract and version applicability

```text
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
```

### Microsoft NOT SENT

Subject: Supported WSL HCS dual-VHD admission and cancellation guarantees

```text
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
```

字段白名单逐项核对：主题为固定英文 subject；版本仅历史参考；场景仅 Windows/拟议 WSL2/A、B 两块既有 VHDX；保护要求及六项问题为设计义务，不是已实现能力。正文没有实际联系人/账号、盘符或路径、SID/PID/VM ID/nonce/pipe 的实际值，没有本机版本、文件身份、日志、Key、附件、项目/仓库/报告链接、诊断或复现结果。联系人、渠道身份、支持计划及门户完整字段均未选择/未核对；不为补字段读取配置或本机。

## Gates

下表 authorization 专指厂商查看/发送操作，不是本轮 OE1 或 Git 发布授权。channel 未选择不等于官方候选入口不存在，只表示本包未执行 OE2 核对。

| field         | docker                                                  | microsoft                                               |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| channel       | not_selected                                            | not_selected                                            |
| visibility    | unknown                                                 | unknown                                                 |
| actor         | user_manual，未来默认方式，尚未执行                     | user_manual，未来默认方式，尚未执行                     |
| identity      | not_selected                                            | not_selected                                            |
| fields        | unreviewed                                              | unreviewed                                              |
| cost          | unknown                                                 | unknown                                                 |
| draft         | exact                                                   | exact                                                   |
| authorization | not_requested                                           | not_requested                                           |
| gate          | blocked                                                 | blocked                                                 |
| reason        | 仅获准 OE1；未选身份、未核字段/成本、未申请本次厂商操作 | 仅获准 OE1；未选身份、未核字段/成本、未申请本次厂商操作 |

实际支持资格、费用、支持次数需求均未知；不能由实际本轮消耗为 0 推导未来建单免费。没有访问渠道、登录、查看账号、关联合同、初始化资料、接受条款、填写或自动保存正文，也未向 Gordon、社区、邮箱或 issue 发送。

## Delivery

| vendor    | delivery | basis | deliveredAt  | 首次发送 / 跟进 / 附件 / 跨厂商转发 | 支持次数消耗 / 新增费用 |
| --------- | -------- | ----- | ------------ | ----------------------------------- | ----------------------- |
| docker    | not_sent | none  | not_observed | 0 / 0 / 0 / 0                       | 0 / 0                   |
| microsoft | not_sent | none  | not_observed | 0 / 0 / 0 / 0                       | 0 / 0                   |

未创建任何厂商线程/工单，无 ticket ID、回执或投递时间；不捏造“已联系”“待厂商回复”。Git 文档 push 是用户单独批准的发布，不算厂商咨询发送，不把整个会话或私有材料提交到仓库。

## Replies

`ReplyRecord=[]`。本包没有接收厂商回复、用户新材料或附件，没有查询门户/邮箱/原线程，也未进行 OE5 的来源核实、回复裁决或跟进申请。缺少输入不是厂商机制不存在的证明；不自动轮询、催单、重搜或创建提醒。

## Contract

以下只建立 OE1 的继承/候选状态骨架，`candidateSources=[] / locations=missing`。这是已读 CV1 的缺项，不是本轮技术取证或新厂商保证；不执行 OE5/OE6 静态裁决。

| id  | 义务或反例                                          | inheritedStatus | candidateStatus |
| --- | --------------------------------------------------- | --------------- | --------------- |
| K1  | 连续只读、deny-write/delete 及父链保护到准确 writer | unknown         | unknown         |
| K2  | controller/request/nonce 到准确进程及 VM 身份       | unknown         | unknown         |
| K3  | 双盘共同保留、验证和整体准入                        | unknown         | unknown         |
| K4  | 竞争 writer、已有 mapping、路径/父链及特殊打开分支  | unknown         | unknown         |
| K5  | 取消、超时、部分失败和各方崩溃全分支                | unknown         | unknown         |
| K6  | 晚到撤销、完整有界 join、仅本次归属收尾             | unknown         | unknown         |
| K7  | 准确构建、依赖及本机匹配                            | unknown         | unknown         |
| K8  | 不需升级/补丁/驱动/ACL/share/服务变化或预取写权     | unknown         | unknown         |
| C1  | 先解锁再打开留下窗口                                | unresolved      | unknown         |
| C2  | A 先可写而 B 交接失败                               | unresolved      | unknown         |
| C3  | 多 writer，不能把首个当作授权者                     | unresolved      | unknown         |
| C4  | 同 PID 不同创建时间/VM、假 pipe                     | unresolved      | unknown         |
| C5  | 取消/超时后等待请求继续                             | unresolved      | unknown         |
| C6  | holder/controller 关闭或崩溃后等待者仍可能运行      | unresolved      | unknown         |
| C7  | 已有可写 mapping 或父链替换                         | unresolved      | unknown         |
| C8  | 不需要 ACK break 的特殊 create/open                 | unresolved      | unknown         |
| C9  | 要改变 share/ACL/服务/组件或先拿写权                | unresolved      | unknown         |
| C10 | helper/签名/hash/旧报告冒充端到端保证与许可         | unresolved      | unknown         |

| 消费边                 | inheritedStatus | candidateStatus |
| ---------------------- | --------------- | --------------- |
| controller→launcher    | unresolved      | unknown         |
| launcher→backend       | unresolved      | unknown         |
| backend→WSL/HCS        | unresolved      | unknown         |
| WSL/HCS→双盘 writer    | unresolved      | unknown         |
| 双盘 writer→已归属收尾 | unresolved      | unknown         |

K7 的 declaredBuildRange 仍 missing、localMatch 仍 unknown。无一项因正文 pin、报告完整或发布门禁而变为 supported/claimed_support；不把未知写成已证矛盾。

## Decision

| field                   | 本轮值                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------- |
| scope                   | OE1 only；其余 OE2–OE6 未推进                                                         |
| coordination            | not_contacted                                                                         |
| contactBlocker          | 尚未批准渠道/账号查看及准确发送，身份未选、表单和成本未核；不是厂商拒绝或渠道已不可用 |
| researchStatus / reason | blocked / insufficient_evidence，继承 CV1，不修改历史结论                             |
| targetApplicability     | unknown                                                                               |
| operationalStatus       | blocked                                                                               |
| nextAuthorization       | 未取得 OE2 等后续权限；系统查询、安装文件读取、读盘、准备、启动分别另批               |

本包完成条件只是离线交付，不是外联或机制就绪。旧未跟踪报告的 clean-tree 阻断、endpoint 差异、reader/完整布局和原有证据缺口不因此消除。没有修改代码、旧视觉、租约/重试/预算、模型、部署或旧文档。

## Verification

### OE1 执行记录与裁定

Pre-flight：OE1 产生两份 DraftRecord、两家初始 Gate/DeliveryRecord 和 blocked DecisionRecord，供 OE2–OE6 消费；字段名与计划一致。后续任务共享这些记录，但均未获执行权限，接口检查不执行其动作。

1. **Ruling:** 已批准计划的单报告、纯文档及现有 dev 边界优先于技能默认 workspace/brief/task-start/task-done/TDD 设置；记录留在本节，检查命令内存执行，不创建执行技能根、不安装依赖、不改分支，不制造 RED/GREEN 或跑产品 suite。代价若有误：需另行复核执行记录/补相应文档验证，不获得任何运行权限。
2. **Ruling:** 计划明确不创建新代理，本轮采用作者分离的一次文档自审，不派 fresh reviewer，不宣称独立审查。代价若有误：文档盲点可能保留，需要另批独立审查；不把自审等同第二份取证。
3. **Ruling:** 用户本轮明确要求 push，覆盖旧计划“不 push”的历史限制；仅发布已确认的外联规格、计划和 OE1 报告。另经用户准确批准，只创建本轮发布目录中的两个 Bun 短包装器、归属标记和最小配置，总量不超过 65536 字节，不复用任何旧根。代价若范围判断有误：需重新确认发布范围/中间物；不会扩大厂商、账号或本机操作权限。

| OE1 步骤       | 当前实际记录                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1 输入与基线   | 已核实 dev/e874e2a44、四份文档摘要、原样旧未跟踪状态及新目标原不存在                                              |
| 2 初始骨架     | 八栏目及两家 not_contacted/not_sent、blocked/unknown 状态已建立                                                   |
| 3 稿件固定     | source 与本报告复制稿逐字节相同，2732/2736 字节及 SHA256 与计划 pin 一致                                          |
| 4 RF4 纸面反证 | 见下表；只作人工代入，不执行模拟门户或诊断                                                                        |
| 5 验证与发布   | 格式/内容/状态/差异检查和作者自审通过；OE1 提交与首次正常 push/远端核对完成，实测见下；本记录补交及清理不预记成功 |

### RF4 纸面反证

| 输入                                          | 预期边界                                   | 本轮人工判断与实际动作                                                          |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| 把历史 `4.79.0 / 230596` 改成“当前机器已验证” | 拒绝稿件变化，不能自动重算 pin 后继续      | 判定应拒绝；保留两稿的 historical/not verified 限定，没有修改版本表述或查询本机 |
| 假设表单要求本机版本、诊断、复现或文件        | 保持未采集、停在缺授权，不运行命令或编造值 | 判定应停止；本轮没有访问表单，更没有运行命令、读安装或原盘来补字段              |

RF1/RF2/RF3/RF5 属于未获准任务，本轮未运行其任务核查或现场实验；没有将纸面判断写成门户拒绝功能或真实安全机制已测试。

文档内容检查实际通过：八个准确栏目、8 项 K/10 项 C 骨架、两份完整稿件及四份旧输入摘要均一致；报告小于 262144 字节。五条消费边的名称、继承 unresolved 与候选 unknown 已逐行人工核对。该检查只读文档/内存计算，没有创建测试文件、调用模型或对厂商发请求；正文路径/Key 前缀/联系人/链接扫描只是补充，不声称证明了所有隐私风险。

已在格式化后单独读回全文，完成作者文档自审：对照 OE1 五步、字段白名单、初始 gate/delivery、K/C/消费边和 RF4；并澄清仓库发布不等于厂商发送。未安排独立 reviewer，无双重取证或独立复验声明。此时文档内容/格式通过不预示后续 push 或清理已经成功。

### 验证与发布边界

自建发布根仅为 `D:\OpenCode-Audit\.superpowers\sdd\2026-10-20-task24b-oe1-publication`，用户已批准此准确例外。创建前确认根不存在、现有父链无重解析点；仅放 `--no-env-file --no-install` 包装器和发布最小配置，编排在内存，不写运行/结果缓存 payload，不新增 Git 登录。清理前须复核准确路径、owner、全父/子链、合计字节及归属；策略拒绝则停止，不换工具重试或读取复用旧根。

已只读核对 fork URL 为 `https://github.com/EthanLyu30/opencode.git`、hooksPath 为 `.husky/_`，原 pre-push 检查 Bun 版本并运行 workspace typecheck。开发工具帮助和仓库钩子读取只用于已批准的正常发布，不是 Docker/WSL 安装取证；不改钩子、不强推、不跳过验证。只使用已有非交互 Git 认证，缺凭据则停止。

除获准 Git 发布外，本包厂商网页/搜索/登录/发送、支持权益查询/消耗、模型调用、系统/卷/注册表/Appx/服务查询、安装/原盘读取、Docker/WSL/backend/VM/pipe/准备/启动、合成实验、真实验收/付费跑分/部署替换均未执行。旧 C 盘目录、真实 .wslconfig、Key/env 和所有旧被拒中间根未读写/迁移/删除/恢复或复用。

### 已完成的文档验证与首次发布

- Prettier --check 实际输出 `All matched files use Prettier code style!`；内容检查确认两个完整正文逐字节与规格/计划 pin 一致，8 个栏目、8 项 K/10 项 C、四份输入摘要无变化，报告低于 262144 字节。
- 补充状态检查确认两家 gate=blocked、delivery=not_sent、首次发送/跟进/附件/转发/费用/权益实际均 0；五条继承边 unresolved，候选均 unknown。它验证报告中的记录一致性，不是门户或磁盘机制测试。
- OE1 首次提交为 `4c7fb98150fe95511318c606e5d6dda1d6b0240d`，消息 `docs(benchmark): prepare bounded vendor outreach`；准确 staging 只含本报告，原旧未跟踪报告保留。
- 已用仅该 Git 子进程的白名单环境、D 盘配置/TEMP、HTTP/1.1、禁 env/自动安装/运行及结果缓存配置正常 push，未改全局设置或钩子。原 pre-push 实际完成 **31 successful / 31 total、0 cached，1m6.248s**，退出 0；此为发布类型检查，非产品测试或真实验收。
- 首次 push 将 fork/dev 从 `8b0b9d81ba449771daa86532f8412f980208ea36` 更新为上述 `4c7fb9815`。随后独立 ls-remote 返回同一完整 SHA。发布范围只含已确认外联规格、实施计划和本报告，不含产品代码或旧未跟踪文件。
- 本轮准确发布根实际核对为 5 个文件、1339 字节，owner 与全父/子链无链接检查通过，低于 65536 字节。文件为两个 Bun 包装器、owner 及工具生成的最小配置/标记，不含原文、凭据或结果缓存 payload；尚未清理，不把检查通过写成已删除。

Task OE1: complete，五步离线文档交付已验证；OE2–OE6 保持未执行。上述是发布记录补交前已发生的事实；补交提交自身的最终远端身份及清理结果在实际核对后交接，不以本段预记它们成功。裁定 1–3 完整保留，无 deferred minors。
