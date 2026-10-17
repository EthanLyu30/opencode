# B-Prep2：Linux Docker 宿主软件 / 无 Docker 验证

日期：2026-10-17。直接在 `dev` 实施。基线 `f534e2de264922f5a9b8f479e0d058d1b76c30e2`，任务规格与计划分别见同日期 readiness spec、linux-docker-host plan。本报告只覆盖获批的软件和无 Docker 验证，不是跑分或真实 Linux 就绪证明。

## 门槛与实际执行

| 门槛 | 本轮状态 |
|---|---|
| software_complete | 代码与无 Docker 回归通过；最终独立审查见下方收尾记录 |
| engine_verified | false；真实十行矩阵全部 not_run |
| tool_capability_verified | false；A–E 准确程序的视觉 / coding / 只读微检均 not_run |
| corpus_engine_ready | false；真实 16 题、104 个不同控制和 16 次重复，实际执行 0 / 120 |

未启动真实 Docker、Linux 候选代码、Chromium 或准确生产 exe；未安装/移动 WSL、Docker、VHDX、swap、账户或网络策略；未读真实 Key / `.env.local` / Docker 登录配置；未触发付费、模型目录查询或部署替换。单元测试中只运行本轮自建的合成程序、本机 HTTP / named-pipe 夹具。

独立命令为 `packages/benchmark/script/linux-host.ts`：`inspect | plan-preparation | prepare | accept | calibrate | verify`。没有 paid、授权生成、seal/current 激活或旧 CLI 改动。所有路径为显式命名参数；缺参数/许可/环境/证据返回非就绪，错误输出只含分类、ID、hash、计数，不输出原始候选日志或 oracle 答案。`verify` 仅重读、哈希和只读 Docker 查询，不 create / pull。

`accept` 需要冻结数据配置、真正的隔离适配器、项目探针和五个准确程序微检。`calibrate` 复用同身份引擎证明，创建独立 Linux 语料派生树，真实串行执行完整 120 项。仅全部同身份、实测、匹配、重复稳定且无未观测项时发布并重读 immutable `linux-readiness.json`；软件夹具和孤立 JSON 不能签发真实 authority。

## 新增 / 接续代码

- Task6：独立 Linux host / browser / controller-facts / result-proof 路径，保留旧 fixture 流程。功能失败保留实测分值、视觉为 null，不伪造为 0。
- Task7：同等公共 read/write/check/preview/capture MCP，控制器持有 Docker 和私有数据；隔离子程序仅获随机 capability 的命名管道。有限本机 fixture provider 没有任何上游转发分支。
- Task8：固定 Linux 安全驱动，实际身份/权限/资源/网络/读写/生命周期/第三方资源矩阵，真实操作证据和恢复校验。浏览器恶意网络、跨 capability、WS、file、data 操作有专用验收路径，未真实执行。
- Task9：原 16 题 / 104 控制 / 16 重复，不替换题目、权重或负例；保留 B-Prep1 原材料，新参考图与 PDF 公共 Linux wrapper 分别绑定。
- Task10：内置数据配置组合器、版本化物理盘位观察器、完整控制器文件身份清单、分阶段入口、只读 readiness 校验、证据清单和最终发布。构建期公共驱动/配置单独只读挂载并逐一核对实际挂载；Linux 探针控制父进程丢弃候选 stdout，只接受绑定的专用 IPC 值和固定覆盖率。

## 复现与结果

全部测试 cwd 为 `D:\OpenCode-Audit\packages\benchmark`。可信 Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`，SHA256 `0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`。使用 `--no-env-file`，所有临时 HOME/XDG/TEMP/Bun/npm 缓存位于本轮 D 盘 owner 根，禁用 provider/model discovery/update 和所有真实 integration 开关。

运行计划列出的 19 个 `test/linux-host/*.test.ts` 显式入口：49 pass / 0 fail / 285 assertions。随后完整 `bun --no-env-file test --timeout 30000 --only-failures`：322 pass / 10 既有 skip / 0 fail / 1324 assertions / 89 files。`bun --no-env-file run typecheck` 退出 0。

10 个既有 skip 保持原开关与断言：5 个真实浏览器捕获，1 个 PDF 浏览器，1 个准确程序安全，1 个准确程序恢复，2 个 Docker vector。未新增 skip、放宽时限或改旧视觉/租约/重试/预算业务算法。RED→GREEN 包含命令入口、嵌套配置拒绝、截断/覆盖/跨清单证据、精确挂载、stdout 伪造、原始校准标签和未测分值。

Task6–9 软件提交：`33b91c4f`、`8cf5e0ad`、`ae7d9bbd`、`66472854`。Task10 与最终修复提交以本报告所在 Git 历史为准，最终远端 SHA 在交付消息列出。

## 环境准备前必须确认的材料（尚未执行）

1. 只读核查实际 Docker Desktop 版本/CLI/context/daemon、WSL/VHDX/swap 的物理 D 盘身份。当前内置 collector 仅支持明确版本的 legacy WSL `docker-desktop-data` 布局（4.x 至 4.29）；新 managed-VHD / Hyper-V 布局明确 blocked，不能套用旧字段。需在后续核查后补对应 collector，不把该兼容缺口称为已验证。
2. 冻结新 toolchain 制品、源/构建来源、依赖镜像/卷、浏览器 helper 和字体，以及每题输出/probe/reference 元数据。配置不猜 `dist`、mask/tolerance，也不沿用旧部署冒充新构建。实际项目可构建性、marked 生成文件与输入重叠、PDF 工具兼容、字体来源和 Windows Docker bind 源路径格式均待真实验收；遇不匹配必须 blocked / failed，不替换题目或放宽门槛。
3. 准确 Windows 程序的 OS 隔离适配器是单独批准、hash 固定的环境制品；软件没有自动安装 ACL/账户/网络规则，也绝不回退普通 native spawn。没有实际隔离证明时能力检查 blocked。
4. 校准政策预检只识别原注册控制中的明确网络 canary，辅以真实引擎隔离/私有挂载边界/源哈希/只读驱动证明；不是面向任意付费候选的通用恶意代码探测器。后者、真实 run/resume/cancel 和费用账本属于 B-Prep3，不可拿本轮政策计数作任意候选安全背书。

Docker / WSL 官方一般语义见 [Docker WSL 存储](https://docs.docker.com/desktop/features/wsl/) 与 [WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)。文档不能替代准确环境实测。

## 裁决摘要（按作出顺序）

1. 软件完成与真实门槛分开；误判代价：不得宣称真实 B-Prep2 已就绪。
2. 新建兼容旧 fixture 的 bprep1 前缀临时根，不复用旧材料；代价：额外精确清理根。
3. 仅 prepare 许可允许初次依赖卷填充，运行期 always nocopy；代价：准备镜像必须具备准确目录和审计驱动。
4. 大 OCI 包使用 hash 绑定 stdin 文件流；代价：传输必须保留二进制流语义。
5. 输出路径使用冻结显式表；代价：准备时逐题登记，不猜 dist。
6. HTTP 服务使用受保护入口/固定端口/逐请求有界 exec；代价：真实矩阵验证状态保留，不支持 WS。
7. 持久化结果需重新获得 authority，JSON 自身不能复活权限；代价：读者需重开当前清单/session。
8. 公共接口要求包含全部 mandatory case 与逐视口交互；代价：缺观察阻断，不悄悄忽略。
9. MCP 子进程通过 capability pipe 访问控制器；代价：OS 适配器必须精确放行该 IPC，不能开放 Docker/gold。
10. 新增 start:false 验证创建后未启动崩溃点；代价：额外生命周期选项，不改默认逻辑。
11. 每次评测独立证据子根；代价：host/browser/observer 使用同一根。
12. 导出公共源/驱动与新输出，不仅 dist；代价：全部仍受文件与字节上限约束。
13. 显式参考策略，并给全部 PDF 控制加共同公开 wrapper；代价：需审核准备元数据，不改 104 个标签与权重。
14. 校准 armID A 仅为 schema 占位、无 provider route；代价：不能计入 A 处理组效果。
15. 内置数据组合器与封闭 fixture provider；代价：环境准备必须补齐冻结项目数据，不可外包未实现的软件。
16. 仅识别已定义版本的 legacy 盘位格式；代价：实际新版 Desktop 可能需要追加 collector。
17. 执行代码/测试/策略用完整清单约束；代价：改源使旧验收失效，并增加只读哈希成本。
18. 构建期单独只读挂载驱动与配置；代价：真实 Docker 必须逐一支持并证明这些挂载。
19. 校准政策 canary 在 Linux 中只读预检拒绝，功能失败视觉保持未测；代价：仅用于注册校准控制，不是任意候选通用安全扫描。
20. Node 控制父进程与候选日志分离；代价：准确 Linux Node/Bun 的 IPC 行为必须真实验证，不能以 Windows 合成程序替代。

## 独立审查 / 收尾记录

待一次全范围新上下文审查及必要的单轮 TDD 修复后填写最终结果。当前尚未 push Task6–10，不应把本地提交等同于远端已更新。

部署保护 SHA256（本轮再次实读）：`D:\OpenCode-Local\bin\opencode-local.exe` = `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`，与开始前一致。

最终验证后仅清理本轮 owner 根与 SDD 临时材料；保留原语料、旧 dist、共享工具链/依赖和其他任务遗留。具体清理与远端复核结果在最终收尾更新。
