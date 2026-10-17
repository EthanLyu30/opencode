# Task24B 就绪设计：独立评测、真实执行循环与 Linux Docker 验收

**状态：** 2026-10-17 用户已确认书面设计，并要求编写 B-Prep1 独立评测器实施计划；不是实施授权、验收通过记录或消费授权。

**基线：** `e3ae03101145fc72e990f262ed36bb900b498945`，其运行源码与已验证的 `1724911a15226f6d413fa77cfc43b68d1dae5edb` 相同。非视觉入口六步计划已完成，见[工程验收报告](../reports/2026-10-16-opencode-coding-workflow-verification.md)。

**继承：** [Task24 总规格](2026-09-12-opencode-workflow-effect-benchmark-design.md)的实验问题、五组、语料、评分和统计规则，以及[非视觉入口规格](2026-10-16-opencode-coding-workflow-design.md)的生产边界。本设计只补齐下一次有效试跑的前置条件，不重新实现已完成底座。

## 1. 用户目标、授权与不变项

目标是最终回答“这套 Kimi 规划/设计/复审 + DeepSeek 主要编码/修复的工作流，是否比单模型直接使用 OpenCode 更有效”，而不只是证明调用和工作流能运行。

当前授权为已确认设计及 B-Prep1 计划编写；实施须待对应计划审阅。后续实施也先限于零额度准备；不读取真实 Key 或 `.env.local`，不调用真实生成或 `/models`，不替换 `D:\OpenCode-Local` 部署，不改旧 `dist`、回滚制品或历史 seal。本设计不授权安装/启动/迁移 Docker、拉取镜像、修改系统隔离策略或开始付费试跑。

继承的不变项：

- 主任务仍为 12 个视觉任务：private、Design2Code、SWE-bench Multimodal 各 4 个；4 个非视觉 guardrail 单独统计。
- A 为修改版完整工作流，B/C 为同一修改版直连 DeepSeek/Kimi，D/E 为官方 OpenCode 直连 DeepSeek/Kimi。主要比较 A−B、A−C；D/E 只是外部参照，不能当作纯工作流因果效应。
- 视觉主任务 A 使用真实 `visual-build`；非视觉 guardrail A 使用真实 `coding-build`。禁止给库项目降类、伪造页面或用私有旁路替代生产入口。
- 保留已确认 Kimi K3、DeepSeek Pro/Flash 的角色分工及原 effort。生产模型继续“自动发现、确认启用、在途任务锁定”；一次实验在新 seal 中固定实际模型/协议/合同，不自动换新模型，不降至 Kimi 2.x。
- pilot 只含 `private-analytics-dashboard`、`d2c-g29-spelling-bee`、`swe-chartjs__chart.js-10157`，每题 A–E 各一次，严格 15 cells，串行。不增加重复、替换难题或把 guardrail 算进去。若题目不兼容则阻断并报告，不按结果挑题。
- 主任务合格标准仍为全部硬功能/需求/安全/预算条件通过，视觉总分至少 75、任一视口至少 65；视觉权重仍为 35/20/25/10/10，诊断权重仍为 45/30/10/10/5。
- 效果门槛仍为超过较佳 B/C 至少 10 个百分点、配对 95% 区间下界大于零、各主任务族非负、功能不落后超过 5 个百分点、安全通过、每合格任务成本不超过 2 倍。pilot 不用于宣布效果已被证明。
- 保留原工作流的事件、租约 fencing、重试、预算算法、视觉合同和默认 CLI 行为。兼容改动若确实涉及生产语义，另列最小修复设计，不能藏在评测代码里。

## 2. 现状核查与方案选择

| 已有能力                               | 当前缺口                                                                    | 本设计处理                                                  |
| -------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `run/commands.ts`、RunStore、Scheduler | pilot `run` 只规划行，`resume` 只列举；没有完整执行闭环                     | 新增执行组合层，复用持久化身份与既有调度器                  |
| `offline/evaluator.ts` 与独立评分函数  | 静态 `index.html` 假设；存在反向补丁和仅截图完整的功能回退                  | 保留历史离线解释，新实验使用显式 task profile 和独立 oracle |
| `evaluator/score.ts`                   | 固定要求 3 个视觉分数，不适用于 guardrail                                   | 增加区分主任务/guardrail 的版本化结果，不伪造视觉值         |
| `arms/workflow.ts`                     | 只构建视觉请求和视觉角色证据                                                | 主任务沿用；guardrail 新增编码请求/角色验证分支             |
| `arms/environment.ts`                  | 直连默认 Bash deny，不能证明五组工具能力相当                                | 增加公开工具能力验收，不直接放开宿主 Shell                  |
| broker、逐请求预留/结算、双币种上限    | 当前启动粒度是 run，不能给每个 run 重置整阶段预算；grant 目前允许全部三模型 | 阶段共享账本、run 级最小授权，组合现有算法                  |
| `cli.ts` 的二进制锁定                  | 修改版路径写死为现有部署 exe                                                | 新实验锁定独立 benchmark 制品；不靠更新部署满足校验         |
| Windows 进程、Docker 和浏览器适配      | 单元/模拟传输已过，但真实 Linux 引擎尚未验收                                | 独立引擎证据门槛，不把模拟结果重命名为通过                  |

推荐“增量组合”：在 benchmark 包中补 profile、独立 evaluator、executor 和 engine acceptance，复用现有评分、计费、存储和生产入口。相比直接扩写巨大的离线 campaign 文件，它更容易隔离旧证据、单独测试和定位问题。另起一套跑分平台会重复预算/恢复底座，本阶段不采用。

三部分分别验收，再做联合零额度验证；本规格审阅通过后，先为独立评测器写实施计划，后续两部分按已冻结接口分别落计划，不把三套新子系统塞成一次不受控改造。

## 3. 共用合同与证据链

### 3.1 版本与身份

新实验使用严格的 v2 campaign/任务执行档案，显式记录 `executionKind=visual-build|coding-build`、evaluation profile、依赖/公共夹具、工具能力、平台、二进制和 sandbox receipt 的哈希。旧 v1 seal/数据库/报告按原版本只读解释，不原地升级、补字段、覆盖或与新结果合并。

每个 run 绑定 campaign、stage、task、arm、repeat；每次进程尝试另有 attempt 和现有 lease generation。结果必须绑定 seed、公开夹具、最终候选树、模型路由、运行程序、评测器及 gold 的哈希。源码树与 Git/Snapshot 包含的配置不一致时直接拒绝。

`completed` 只表示执行及评测证据完整落盘，不等于模型任务成功。分数来自 evaluator；缺少 evaluator 证据绝不能用进程 exit0、工作流 succeeded 或模型文字填充。

### 3.2 任务档案分为公开与隐藏两部分

公开 `TaskExecutionProfile` 冻结：源码入口、锁文件与依赖镜像/工具链 digest、允许改动范围、配置/测试/插件保护路径、有限 argv 的构建/公开检查命令、预览类型、准备条件、输入媒体和预算档案。所有组使用逐字相同的公开内容与资源，不给 B–E 附送 A 的设计或复审产物。

隐藏 `EvaluationOracle` 冻结：功能输入集合与预期值、隐藏断言、参考图、掩码、DOM/交互/无障碍要求、容差和已知正确/错误校准候选。隐藏目录不进入 Location、候选压缩包、容器、MCP 资源或模型提示词。公开档案只暴露必要的接口，不暴露 oracle 路径、答案或逐项评分反馈。

库项目的构建产物必须从本次候选源码重新生成，不能沿用 seed 的旧 dist 或 gold 产物。依赖预先按锁文件准备且内容寻址；执行阶段不联网安装、不运行未知安装钩子。无法用既定宿主与依赖档案执行的任务是兼容性阻断，不准偷偷扩展权限或更改题目。

### 3.3 模块边界

| 单元                  | 接收                                             | 产生                                  | 不拥有                           |
| --------------------- | ------------------------------------------------ | ------------------------------------- | -------------------------------- |
| Corpus/profile        | 固定来源、seed、公共适配夹具                     | 已校验的 task/profile/dependency 哈希 | 运行结果、计费 Key               |
| Executor              | 已验证 campaign、既有 lease、执行模式、arm grant | 最终候选归档和执行凭据                | gold、评分裁决                   |
| Tool host             | 当前 run 的公开能力与工作区权限                  | 真实命令/预览/工具证据                | 角色规划、隐藏测试               |
| Independent evaluator | 冻结候选、profile、私有 oracle                   | 版本化结果及证据清单                  | provider Key、生成请求、修复权限 |
| Engine acceptance     | 明确的 Docker context、镜像/资源/存储档案        | 有适用范围的 Linux 证明               | 宿主重配、部署替换               |
| Reporter              | 已发布且哈希匹配的结果/账本                      | 统计及可复现报告                      | 重新判分、再调用模型             |

## 4. 独立评测器

### 4.1 真正独立的执行方式

先停止生成进程，证明其子进程及本 run 容器已结束/交接，再捕获不可变的最终候选树。评测在独立的可丢弃副本上执行，前后校验候选原件哈希。评测阶段没有 broker grant、真实 Key、模型会话或修复入口；评测详情在本轮生成结束前不回传给任何组。

模型复审、生产测试和工作流成功状态都只是 treatment 的运行证据，不能代替独立评分。评测器既不调用 Kimi/DeepSeek 当主裁判，也不复用 A 的实测结果充当隐藏测试。

隐藏断言和期望值始终留在受信任控制器。执行候选代码的进程只接收被测输入，返回有界数据；oracle 不与不可信库代码同进程运行，也不挂载进该容器。候选伪造 stdout 的 `passed=true` 不产生分数，只有控制器比较实际输出与隐藏预期才能判定。

### 4.2 两条评测路径

**库/非视觉：** 使用冻结接口适配器导入候选模块或运行候选 CLI，覆盖正常、边界、异常、状态变化及回归；比较真实行为，不要求补丁与标准答案一致。错误实现必须失败；语义正确但不同实现必须通过。`git apply --reverse --check` 最多保留为补丁相似度诊断，禁止参与功能通过判定。

guardrail 单独输出 `functionalQualified`、功能/需求/质量/安全及资源指标；`visual`、视口和美观总分明确为 `null/not_applicable`。不重分配主任务的权重、不制造 guardrail 百分制总分，也不计入主视觉排行。正式 guardrail 矩阵仍是 4 题 × A/B/C 一次，共 12 cells；不是 20。

**视觉/库项目页面：** 私有页面和 Design2Code 使用真实候选页面；Chart.js、react-pdf、marked 等先真实构建本次候选库，再加载共同的公开展示/复现夹具。夹具只连接公开接口和测试输入，不包含修复实现、gold 输出或答案 CSS。不得靠放一张静态参考图“完成”视觉任务。

继续使用固定 Windows Chromium、字体、locale/timezone，以及 390×844、768×1024、1440×900、DPR1 三视口。参考与候选使用同一个渲染版本；动画、随机数、时间、网络和等待条件在 seal 前固定。保留视觉全部分量，缺失不能调权；已有 70–79 盲审只用于解释，不改变自动合格结果。

独立运行构建、功能、要求、typecheck/lint（档案明确支持时）、范围/依赖和安全检查。未声明或不可用的质量命令记录 `not_available` 并保留原有扣分语义，不能把“没运行”记成通过。

### 4.3 预览不能绕过隔离

静态产物由只读、路径白名单的预览服务提供。需要真实服务端的任务在 Linux 沙箱运行候选服务，通过固定的 stdin/stdout HTTP relay 与控制器交换有界请求/响应，再由受信任 loopback preview 提供给 Windows 浏览器；不把项目 Node/Bun 服务直接运行在 Windows 宿主。

relay 只支持 seal 中声明的 HTTP 方法/路径，单请求 body 至多 1MiB、单响应 body 至多 8MiB、headers 总计至多 32KiB、单请求至多 30 秒、同源重定向至多 3 次；不提供任意 URL、文件系统、CONNECT、WebSocket 或 Docker API。需要这些能力而当前档案不支持的任务在 preflight 阻断。浏览器不得访问 broker、gold、file URL、其他 run、任意互联网或 service worker 外连。

这样无需让 `--network none` 容器通过映射端口与宿主“通信”；Docker 官方说明该模式只创建容器自己的 loopback。预览 relay 是拟新增的 benchmark 边界，必须先做协议/逃逸及真实引擎测试，不能把现有生产预览实现宣称已具备它。[Docker 网络说明](https://docs.docker.com/engine/network/drivers/none/)

### 4.4 评测器自身的验收

每个准备参加 pilot 的 task 必须有同一题目的：已知正确候选、原始失败 seed、单点功能错误、视觉/响应式错误、策略违规候选；guardrail 不要求视觉候选。其余语料也须有适用的正确/错误控制，不以“能生成 JSON”替代。

必须验证：相同候选重复评测结果一致；不同正确实现可过；空测试/空结果、stdout 伪造、标准补丁逆向匹配、过期构建产物、隐藏数据读取、跨 run 证据及候选树漂移不能通过。隐藏数据隔离用真实存在且控制器可读的私有 canary 验证，不能只探测一个不存在的文件。候选包解压拒绝绝对路径、穿越、链接、设备文件、硬链接及档案声明的大小/文件数超限；生产 checks 仍受既有 96MiB archive 上限约束。

参考图或 gold 缺失、浏览器崩溃、relay 证据不全归为 evaluator/harness failure，不能算模型 0 分后继续跑。候选自身构建失败、功能错误或越权行为在受控宿主健康且证据完整时才算任务失败。

## 5. 五组真实执行循环

### 5.1 共用能力，不给对照组削弱工具

建立有界的公开能力合同：Location 内读写、真实构建/公开检查、必要的预览与截图；工具调用计数和时间均计入同一任务预算。A 保留生产角色权限与流程，B–E 只有单模型 agent，不得到拆解、修复策略或复审答案。

B–E 通过官方支持的本地 MCP 配置接入最小工具桥，提供与 A 在该题上等效的公开能力，而不是开放 Windows 宿主 Bash。官方二进制不打补丁；MCP 工具桥使用受控工作区、同一 Linux sandbox 策略和依赖档案，不返回隐藏评分。官方文档说明本地 MCP 可通过命令数组配置；目标冻结版本仍须实测，不能仅凭当前文档判断兼容。[OpenCode MCP 文档](https://opencode.ai/docs/mcp-servers/)

工具桥只暴露公开读写、有限 argv 检查及预览调用，不实现另一个多模型 planner。必须证明内置同类宿主工具、项目插件/钩子、全局配置、任意外部目录与非 broker 网络不能绕过它；仅设置环境变量或最后检查违规日志不算隔离。保护 `.opencode`、运行配置、测试、依赖锁及 broker/宿主目录，加载项目代码只能进入沙箱。

在每个准确二进制上，以假 provider 驱动真实工具调用，验证同一失败代码能被发现并改正确、公开检查和预览实际可用。任何一组缺少能力或无法隔离即 `tool_capability_blocked`，不得降低对照组能力来凑齐五组，也不得扩大 A 的生产权限。若必须改 A 的生产工具语义，另行审阅最小方案。

### 5.2 从计划到真实执行

复用既有 RunStore、Scheduler、lease generation、取消及恢复规则。新增 executor 组合层负责：

`校验 campaign/模式 → claim → materialize → 验证工具/运行档案 → 授权并预留 → 启动准确 arm 程序 → 收集并验证真实终态 → 冻结候选 → 独立评测 → 原子发布结果 → 完成及释放`

实际状态仍走现有 `planned/materializing/ready/reserved/running/evaluating/completed`。预算拒绝、取消、租约丢失、未知 provider 结算沿既有状态及 adjudication 处理，不悄悄增加自动重试或把已结算调用重放。安全检查在 claim 后、每次进程/工具派发前和发布时重复确认 authority。

现有 collector 只接受成功终态的行为需要拆成“解析观察事实”和“判定任务结果”：正常观察到 provider 终止失败、预算耗尽或候选失败也要形成完整失败记录，不能一概抛成 harness 异常。真实调用数、角色、修复轮数、工具数、恢复次数和耗时从受信任事件计算，不套离线 fixture 的固定数字；拿不到的 first-pass 指标为 `not_observed`，不从最终成功倒推。

CLI 的 `run` 必须实际执行至终态/暂停而非仅打印 `plannedRuns`；`status` 报计划/已执行/待裁决/已评测数；`resume` 先核查活进程、grant、账本与候选/结果身份，不能只列出 ID。旧 `resume` 对已结算或不明确调用的保守规则原样保留，本阶段不承诺任意直连会话可自动续跑。

### 5.3 零额度与付费模式在结构上分开

同一个 executor 使用封闭的 `fixture` 或 `paid` 传输组合，不依赖一个可随意切换的环境开关：

- fixture：独立验证 campaign ID、合成价格和专用假凭据；broker 上游是内存/本地受控假 provider，进程环境不含真实 Key，不加载 dotenv，真实出网派发默认拒绝。用准确修改版/官方二进制和真实 Linux 代码执行，不用假输出替换宿主。
- paid：只能在完整证据门槛通过后，读取匹配新 seal、阶段、有效期和两个币种上限的全新授权，才组装真实 provider transport。`run/resume/preflight --stage pilot` 均不能绕过授权；本轮不生成这份授权。

fixture 的记录永远标识为零额度验收，不能改名变成 pilot 观测。验证的 15 cells 与未来付费 pilot 的 15 cells 身份空间分开。

### 5.4 成本、路由和取消

全阶段共享一个预算账本及固定双币种 ceiling，每个 cell 使用独立短期 grant；重启、换 arm、换 broker 进程不能重置余额。grant 的 allowed routes 是该组已封存的最小集合，直连组不可调用其他模型。沿用现有预留/结算算法和未知用量保守处理；不确定请求保留最坏预留并阻断后续消费，不能当作未收费重试。

每次请求在转发前执行剩余累计 token、调用/重试和最坏货币上界检查；同任务预算对五组一致。官方 SDK 的隐式重试、工具计数和取消必须可观测并受限，否则阻断。禁用计划外 server-side 搜索/文件工具等可能改变成本和网络能力的能力；不偷偷启用 provider fallback。

取消先阻断新请求/撤销 grant，再终止准确进程树和本 run 容器，等待在途流结束或记为未知结算，最后按现有状态记录终态。cap 耗尽同样先停止派发，不事后发现超支再停止。

原始 provider SSE、推理、Authorization、Key、grant 和完整模型 JSON stdout 不写盘；流式解码仅保留允许字段、计数、摘要与哈希。候选代码/交付文本和异常日志在发布前做秘密检查；不把脱敏当作事后擦除原始秘密的替代品。

### 5.5 恢复与发布

每次尝试将输出放到唯一 attempt 目录。提交结果时核对现有 lease generation、run/campaign/候选/账本哈希，发布不可变结果；旧 owner 不得覆盖新 owner。数据库和文件之间不宣称天然事务一致：恢复通过完整校验已发布清单协调，缺一不可。

已完成 cell 不重跑；仅评测中断时可在同一冻结候选上重做无模型评测。provider/工具副作用未知则暂停等待现有人工裁决，不发新请求。进程 PID 必须结合启动身份、准确 exe 和 owner 记录，容器须结合 ID、标签及 nonce，不能只按名称清理。

## 6. Linux Docker 真实验收

### 6.1 支持范围与环境准备门槛

第一版只验收本机 Windows 控制器连接明确指定的 Linux Docker context，优先复用已有 Docker Desktop/WSL2 后端；这不是把整套 OpenCode 移植到 Linux。远程 daemon、自动新建 VM、系统级 Docker/WSL 安装或迁移不在本设计的执行授权内。

Docker CLI 路径/哈希与 daemon 身份是两种证据。需要记录 context/endpoint、server ID/版本、Linux OSType/架构、镜像 digest/平台和资源能力；只验证 `docker.exe` 哈希不能证明实际连接的是预期 Linux 引擎。

先只读核查 Docker Desktop disk image/WSL 数据与相关 swap 的实际 Windows 路径。Docker 官方说明 WSL2 引擎数据默认可能在 C 盘；因此 D 盘 CLI、`DOCKER_CONFIG` 或 Linux 的 `/var/lib/docker` 均不能单独证明数据在 D。无法证明 benchmark 引擎持久化数据在 D 时，返回 `engine_storage_not_verified`，等待专门批准的迁移/配置方案，不自动改盘。[Docker WSL2 存储说明](https://docs.docker.com/desktop/features/wsl/)

只承诺 benchmark 自有缓存/工作区/引擎数据按已核验策略位于 D；不宣称 Windows/WSL 系统本身绝对不会有 C 盘活动。必须使用系统组件而产生的必要例外，先列明并确认。

准备镜像/依赖的联网阶段与验收隔离：先提出明确 digest、大小、D 盘落点及准备操作供批准；真正验收一律 `--pull never`。引擎未运行、镜像未准备、盘位未知时记 `blocked/not_run`，既不自动启动，也不记作模型失败或测试通过。

### 6.2 原生产沙箱策略必须实测

准确生产宿主执行保持 `--network none`、只读容器 root、非 root `65532:65532`、drop ALL capabilities、no-new-privileges、无 Docker socket、有限 CPU/内存/PID、`/tmp` 64MiB noexec、HOME 16MiB noexec 等现有限制，不为 Chart.js 或测试放宽。

命令写权限仍按生产角色确定；编码 checks 使用已有的哈希绑定 stdin archive 和容器内可丢弃副本。不可把隐藏 gold 挂入容器，也不可为方便构建改成整个 D 盘可写挂载。工作区 bind mount 的只读状态既检查 inspect，也做真实写入失败及宿主哨兵哈希检查。Docker 的 bind mount 默认可写，且绑定 daemon 所在主机路径，故远程 daemon 不隐式复用 Windows 路径。[Docker bind mount 约束](https://docs.docker.com/engine/storage/bind-mounts/)

评测构建/服务若使用自己的资源档案，须独立冻结并对五组相同，不冒充生产 checks 资源。生产 checks 和独立 evaluator 都必须在原限制下跑过实际项目；不兼容时报告具体资源/依赖约束，另审最小兼容修复，不自动增大 tmpfs、开启执行权限或联网安装。

### 6.3 必须通过的真实引擎矩阵

| 验收类别    | 必须出现的真实证据                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| 引擎/镜像   | 实际 server Linux 身份、准确平台/digest；错误 context、替换 CLI/镜像被拒绝                            |
| 最小权限    | 实测 UID/capabilities/no-new-privileges、root 写失败、socket/设备/宿主目录不可访问                    |
| 网络        | inspect 的 none、实际接口/路由、受控本地 canary 阻断；不能用访问一个本来就没服务的端口证明隔离        |
| 挂载/路径   | 只读输入实际写失败、角色允许写仅影响当前候选；链接/穿越/错卷/替换身份被拒绝                           |
| 构建/实测   | 错代码真实失败、修复后通过；构建可写临时输出但宿主/冻结输入未改；嵌套 Bun dotenv canary 未加载        |
| noexec/依赖 | 真实 Bun/JS 工具链与受限 tmpfs 兼容；临时可执行 wrapper 被阻止，不靠单元模拟                          |
| 限额        | 有界测试 CPU/内存/PID/输出/超时，检查实际限制生效；不进行无边界 fork bomb 或耗尽宿主资源              |
| 预览/浏览器 | 一份真实库产物的静态预览、一个真实 HTTP 服务的受限 relay、三视口和交互，互联网/broker/file 越界被阻止 |
| 取消/恢复   | 运行中、创建后未启动、检查/预览孤儿各场景；只清当前 ID/nonce，过期 owner 不可操作新容器               |
| 清理/隔离   | 同名异主、第三方容器、其他 run 和历史证据存活；成功/失败/取消后当前自建容器均可证明已结束             |

验收 receipt 绑定源码、准确 exe、profile、策略、CLI、daemon/context、镜像、存储与测试清单哈希。任何其中身份改变，不能沿用旧 receipt；明确标为 stale。真实引擎测试不能静默 skip 后让 readiness 通过。

## 7. 新制品、seal 与零额度门槛

新增 benchmark v2 二进制清单，在 `D:\OpenCode-Benchmark\Task24\toolchain\modified\<source-sha>\` 保存独立准确构建，官方版也存于版本化 toolchain 目录。Windows 宿主运行根、沙箱/浏览器配置及状态均使用独立受控 D 盘路径。现有部署只作保护哈希核查，不作新 campaign 的执行目标。

官方“最新版本”在环境准备阶段只解析一次不可变官方 release/tag/commit/hash，记录日期并在新 seal 前锁定；不沿用历史文档的版本号当作当前最新，不在组间自动更新。新制品通过完整功能/安全和准确二进制测试后才候选封存；Task6 的无嵌入 UI 验收 exe 不自动成为新 campaign 制品。

顺序门槛：

1. **设计/计划门槛：** 本规格和对应分段实施计划经用户审阅；仍不授权消费或部署替换。
2. **独立评测门槛：** 全部 16 题 profile 完整；校准候选的功能/视觉/策略结果符合预登记预期；guardrail 不走视觉评分；隐藏数据不可达。
3. **Linux 门槛：** 指定环境已获准备授权、D 盘证据和上述真实引擎矩阵通过。无 daemon 的模拟回归可先做，但不能绕过此门槛。
4. **执行门槛：** 同一个 executor 通过 3 题 × 5 组的 15-cell fixture 真实二进制/工具/评测闭环，以及独立的 4 题 × A/B/C guardrail fixture；二者均是假 provider、零真实出网/消费，非 paid pilot。
5. **崩溃/费用门槛：** 见下一节；全部受影响包测试/类型检查、旧视觉/历史快照/15-cell 回归、客户端生成稳定性（若接口受影响）、准确制品证明通过，一次全范围审查的重要问题经失败→修复→通过验证。
6. **候选封存门槛：** 新 campaign v2 汇总源码/二进制/语料/模型/工具链/评测器/引擎证明，重新运行完整 Task24A；发布新 ID 的零额度 acceptance 和候选 seal，不覆盖旧 seal，不激活付费授权或改旧 current pointer。为 v2 增加独立候选路径选择，不能直接调用会改写旧指针的 v1 `campaign seal` 冒充无副作用封存。
7. **付费门槛，当前关闭：** 临近执行时再查官方价格，给出 Kimi CNY、DeepSeek USD 的新上限及余量计算，经用户专门批准并绑定新 seal 才可进入 pilot。历史“512 上限”等批准不继承。Task24C 仍需另批。

零额度验收可以使用合成价格验证计费算法，但必须与真实价格快照分开。实际价格/时间档位、所需模型能力或 runtime 在付费前改变时，新建候选/授权，不在已封存实验中无声更换。

## 8. 关键失败与恢复验证

必须注入：materialize 后；预算 reserve 后/dispatch 前；provider 可能已发送但无终态；终态结算后/进程记录前；候选冻结后/评测前；评分发布后/数据库完成前；取消和 lease generation 更替期间。

验收要求：零重复已结算 provider 请求；未知请求不自动重发；已完成 cell 不重跑；只评测中断时可复用同一候选；未完整发布的分数不进入统计；旧 owner 发布被拒绝；nonce/PID 重用不会误杀其他进程；失败和未知预留跨重启保留；各组累计消费始终共享同一 ceiling。

用合成用量覆盖两个币种的恰好上限、超出 1 微单位、缺失 usage、流取消、重复终态、SDK 隐式重试、切换 arm 和 broker 重启；预留不足时上游收到的请求数必须为零。不会用真实额度来“测试限额是否有效”。

## 9. 后续分段与完成定义

| 分段    | 独立交付/主要落点（拟议，不是本轮代码改动）                                           | 完成的含义                                                            |
| ------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| B-Prep1 | `corpus/` 的 v2 profile/公共库夹具、`evaluator/` 独立库/页面路径与 guardrail 结果     | 正确/错误/恶意候选在同一规则下可复现区分，不依赖 provider             |
| B-Prep2 | `sandbox/` 引擎证明、公开工具/预览桥及准确版本能力检查；生产接口只复用                | 真实 Linux 下安全、检查和五组公开工具能力均有证据；环境未批时明确阻断 |
| B-Prep3 | `run/executor`、现有 `run/commands` 组合、arm 编码分支、broker 最小授权及阶段共享账本 | run/resume/cancel 真正闭环，崩溃与双币种验证通过，不改既有工作流算法  |
| B-Prep4 | v2 campaign/制品选择、联合零额度 Task24A、审查及新候选 seal                           | 新的可执行、可复现 readiness 包，不替换部署、不发生付费调用           |

每段先测试再实现、独立验收并在 `dev` 提交。继续沿用用户此前选定的本会话顺序实施方式；写计划时不重新询问执行模式。实际提交/push 按该段获批计划执行，不能用本设计把“付费跑分仍先不做”解释成允许试发一次请求。

“B-Prep 完成”只表示可以向用户申请 15-cell paid pilot，不是 pilot 已跑，更不是证明工作流有效。结果报告保留失败、排除、未知和环境阻断，不发布虚构的分数。

## 10. 数据保留、风险与自检

所有工作区、缓存、浏览器 profile、依赖包、Docker 数据和临时文件均按已核验的 D 盘策略管理。清理只针对本次生成且身份已验证的 tmp/workspace/容器；不使用宽泛 prune、不删除共享镜像/卷，不递归指向盘根或仓库根，不改原始取证、用户输入、历史 runs/reports/seal 和现有部署。保留请求的最终制品、封存输入与验收证据；清理不安全的项目必须列明原因。

需明确接受的限制：独立 oracle 不能证明所有可能行为；公开 benchmark 存在污染；15-cell pilot 不足以作最终效果结论；Windows 控制器加 Linux 沙箱不等于整个应用跨平台验收；容器不被宣称为抵御内核逃逸的绝对安全边界。若普通账户权限不足以隔离 gold/网络/进程，保持 blocked，提出单独授权的最小环境方案，不靠模型提示词保证安全。

设计自检：保留 15-cell 和原主评分规则；guardrail 不伪造视觉分数；三模块只经显式证据合同连接；真实 Linux 与模拟分开；新版本不改写历史数据；阶段预算不随 cell 重置；旧部署和真实 Key 不成为设计验证输入。用户已确认本规格；[B-Prep1 实施计划](../plans/2026-10-17-task24b-independent-evaluator.md)另行审阅后才可实施。本轮没有任何“已验收 Linux / 已跑 pilot / 已证明有效”的完成声明。
