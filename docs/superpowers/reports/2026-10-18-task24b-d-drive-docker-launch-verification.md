# Task24B D 盘专用 Docker 启动档案：DL1–DL5 软件验证

日期：2026-10-18。实施起点 `8923a3b11cb3d3210c406f6920c19afbabc7b2e5`，直接在既有 `dev`。用户批准代码、无 Docker 回归、验证后提交/push；**DL6、真实验收、付费调用、部署替换均未授权、未执行**。

## 交付与未完成边界

新增 benchmark 专用 `sandbox/desktop/`：严格合同、兼容来源登记、D profile 环境/白名单设置、排他准备与 manifest 重载、持久授权 nonce、单次 session/准确进程与 pipe 绑定、取消/慢启动/收尾、专用只读连接及独立命令。存储源新增 `desktop-wsl-managed-launch`，保留原 Windows profile 校验、旧来源、Host/StorageProof 合同及生产 default 行为。

新命令为 `packages/benchmark/script/desktop-launch.ts`，默认只诊断、不准备/启动；单独的授权 JSON 或 `--yes` 不提供权限。可信宿主可注入确认回调；独立 CLI 目前没有用户确认传输适配器，不凭磁盘文件自动授权。首次启动许可/onboarding 不被复制或绕过。

**本交付不是可直接启动的原生 Docker 适配成功记录。** 固定 Windows native 适配器对完整应用路径、闭源后端环境传递、旧 WSL/VHD 无初始化复用、安全停止及 CLI/default 尚无充分证据，保持 unproved/blocked；start/stop/observe 不带猜测后备，拒绝执行。fixture 的完整生命周期不会解除这些缺项。DL6 前需补齐证据；不能补齐时应重新讨论最小路线，而不是创建新盘、改注册或放开 C 缓存。

当前 `engine_verified=false`、`tool_capability_verified=false`、`corpus_engine_ready=false`。没有 EngineSession、Linux acceptance receipt 或新 campaign seal 被签发，生产 OpenCode 没有改动。

## 测试和类型证据（整体审查前）

可信 Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`，SHA256 `0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c`。cwd 均为 `D:\OpenCode-Audit\packages\benchmark`，使用 `--no-env-file`，临时 HOME/XDG/APPDATA/TEMP/Bun/npm/Node 缓存全部在本轮 D owner 根，清除 provider/integration/update/discovery 开关；没有安装依赖。

- 初次基线出现 36 个 `FIXTURE_ROOT`：独立评测夹具要求临时根的固定 `bprep1-` 前缀。仅调整本轮新临时环境，基线恢复为 **345 pass / 10 既有 skip / 0 fail / 1412 assertions / 91 files**，没有改旧夹具或业务代码。
- DL1：4 项新测试、21 assertions；完整包 349 pass / 10 skip / 0 fail。覆盖未知版本/注册、安装字节变化、缺项/重复证据、native 来源伪造；源字段自报不授予权限。
- DL2：6 项新测试、31 assertions；完整包 355 pass / 10 skip / 0 fail。精确重试曾实际失败，修复后只读重入；foreign owner、junction/别名、过期/错 hash/克隆授权和文件漂移均拒绝，不修补旧目录。
- DL3：7 项新生命周期测试；完整包 362 pass / 10 skip / 0 fail。慢启动等待曾实际失败，修复后按状态等待；验证准确 PID/创建时间、冲突、取消、未决启动、并发停止、磁盘替换与持久 nonce 拒绝重放。新取消测试以观察屏障触发，不依赖短毫秒调度。
- DL4：新旧存储/传输/preflight 共 24 pass / 151 assertions；完整包 **365 pass / 10 skip / 0 fail**。新增分支不接受 fixture session 作为 native；专用 runner 无验收 provenance，拒绝容器/image/volume/desktop 等命令。两种 PowerShell 观察脚本都经真实 Parser 解析，**没有执行脚本或唤醒 WSL**。不同 `4.79` build 曾被新纯解码器接受，新增失败断言后收紧为当前准确版本，旧分支范围不变。
- DL5 五个新入口合跑：**24 pass / 0 fail / 151 assertions**；完整包 **369 pass / 10 既有 skip / 0 fail / 1563 assertions / 96 files**。含独立脚本真实子进程无参数退出2、严格参数、无确认不写入、跨控制器重载准备档案及 finally 收尾，不声称验收成功。
- 包内 `bun --no-env-file run typecheck` 退出0；另以本轮 D 临时 scoped tsconfig 纳入全部源码、全部 Linux 测试及 `desktop-launch` / `linux-host` / `accept-linux-host` 三脚本，包内 `typecheck --project` 退出0。外置临时 config 初次无法自动找到 Bun types，补其准确包内 typeRoots 后通过；没有修改业务 tsconfig、安装依赖或关闭类型检查。

实际全范围审查及其修复记录在完成后追加；当前这份记录只证明上述已执行的软件检查，不把尚未做的审查写成通过。

## 保护对象与清理边界

复核部署 `D:\OpenCode-Local\bin\opencode-local.exe` SHA256 仍为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`；真实 `.wslconfig` 仍为 `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`。旧 C 盘 Local/Docker、Roaming/Docker、Roaming/Docker Desktop 三目录元数据与开始时相同；元数据不是 OS 级无写入审计。

没有创建真实 `toolchain\docker-launch-dd479` profile，没有迁移/删除旧 C 盘目录、改注册/VHD、启动/停止 Docker 或 WSL，也没有拉镜像/运行容器或真实 provider 请求。所有会写入的合成文件均处于精确 owner 临时根；最终验证与 push 后清理本轮两棵临时根和本计划 SDD workspace，保留源码/测试、已批准规格/计划和本报告。未知所有权文件不删，清理结果在最终交付核对。

## 距离真实验收与付费试跑的剩余门槛

1. **DL6 环境阶段（另批）**：先解决上述 native 证据缺项，再准备 D profile、核查原盘实际使用、有效 swap、pipe/daemon/context；生产 default 不兼容则另提最小接入设计，不在本轮偷偷改生产。之后列准确镜像/依赖/工具/二进制准备清单，缺什么只按获批范围准备。
2. **B-Prep2 真实验收（另批）**：在准确环境上跑真实安全矩阵、公开工具与准确 A–E 二进制能力验证；无 daemon 单测不能代替。
3. **16 题真实校准**：固定的 120 次评测、严格 Linux corpus、readiness 联合复核，保留失败/阻断。
4. **B-Prep3**：真实 run/resume/cancel 执行闭环、共享双币种预算、未知请求与崩溃恢复；假 provider 下跑 15-cell 主流程及独立 guardrail，零真实消费。
5. **B-Prep4**：联合 Task24A、准确候选制品/模型/语料/引擎证明与新 seal，不替换当前部署，不沿用历史消费授权。
6. **专门的消费确认**：执行前再核官方价格与模型，用户批准新 CNY/USD 上限并绑定新 seal 后，才开始 **3题×5组=15-cell** paid pilot；完整正式跑分另按原规格批准。

因此，当前只是在完成本轮软件门槛；真实验收前至少还有环境准备和其权限确认，付费前仍有 B-Prep2 实证、B-Prep3、B-Prep4 和额度确认。上述是顺序阶段而非工时保证；native 缺项若不成立，需要另议路线，不能承诺“DL6 一跑就必过”。

## Rulings I made

1. 计划标题改为 `Task N: DLN` 以使用现成 task-start/task-done 工具；不改任务范围。若有误，代价只是文档标题调整。
2. 由可信进程内确认回调登记授权，不把 JSON 当成人类批准；当前独立 CLI 不解锁 native 操作。若有误，代价是 DL6 前还需接入正式确认传输。
3. 新控制器先重新审计，再严格重载准备 manifest，仅恢复文件身份、不恢复 live session。若有误，代价是合法 profile 可能被安全阻断；不会因此接管运行中的进程。
