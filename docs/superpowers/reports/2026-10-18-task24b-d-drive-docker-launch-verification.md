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

## 一次整体审查及 RED→GREEN 修复

按顺序实施技能，仅派一次独立审查，覆盖 `8923a3b11..e4c7760c9` 全范围及规格/计划。审查发现 4 项 Important、无 Critical 或 Minor；全部纳入一次修复，不增设重复审查。

1. **配置重载绑定**：原 reload 可接受“改设置并重算 manifest”的自洽文件。回归实际复现错误放行；现在重载及每次 revalidate 都同时核对设置字节和原 plan 的 settings hash。对应 `a self-consistent rewritten manifest cannot authorize settings different from the audited plan`，RED→GREEN。
2. **目录替换/文件发布竞态**：不再使用“检查父目录后按路径 mkdir/open”的组合。新增仅 Windows 可用、有界隐藏辅助进程，所有临时/应用目录显式 D 盘；原子 `FILE_CREATE` 相对已固定的父目录句柄创建目录/文件，并保持祖先、根、子目录和文件的非写/非删除共享句柄至操作完成。先固定原文件、核对身份，再用该句柄移除锁；不按重新解析的路径删除。平台不支持时拒绝，不回退到旧模式。真实 NTFS 测试验证父/新根/state 在发布窗口内不能重命名，foreign 普通目录/junction 不接管，越界/ADS 不写、替换锁不删；3 tests / 21 assertions，新增原语不存在时 RED，接入后 GREEN。所用语义依据 [NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) 和 [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle)，官方接口说明不被当成 Docker 兼容证明。
3. **启动前取消遗留锁**：原实测取消后 active.json 遗留；现在仅清理本次准确锁身份，已消费 nonce 保留，新的可信授权可以重试。对应 `cancellation after lock creation removes only that lock and allows a fresh authorized attempt`，RED→GREEN；未放宽未知/未决启动的 cleanup_uncertain 语义。
4. **夹具写死本轮 run owner**：旧夹具拒绝新的独立 owner；现在核对固定夹具标记、格式合法的当前 owner 和真实目录身份，清理仍绑定准确临时根。真实新子进程用新 owner 通过，不冒充本轮标识。对应 `committed fixtures accept a fresh run owner without impersonating the implementation run`，RED→GREEN。

修复中补充锁替换测试时，Bun `.rejects` 匹配器会使已经打开的 Windows 管道等待无法交接；临时阶段日志证明辅助进程已收到并回包。仅将这个新测试改为先 await 成功/拒绝结果、再同步精确断言，通过后移除全部诊断日志；没有放宽时限、旧断言或改业务等待算法。中止的诊断进程只按核对过的本轮 PID/可执行文件/父子关系停止，没有操作 Docker/WSL 进程。

修复与格式化后完整 benchmark：**375 pass / 10 既有 skip / 0 fail / 1594 assertions / 98 files，47.95s，退出0**。包内源码 `typecheck` 与涵盖全部 Linux 测试/三个入口的 scoped `typecheck --project` 均退出0。没有改旧测试、增加 skip 或扩大 Windows 时限。10 项既有 skip 保留如下：

- offline security/leakage：真实二进制 terminal/network 拒绝与空日志证明。
- offline crash/recovery：8 个真实崩溃点收敛。
- browser integration：惰性控件、三视口一致采集、popup/download/navigation 逃逸、等待超时、外部子资源阻断（5 项）。
- candidate import：环境/argv/stdin/mount 隐藏输入隔离。
- daemon-owned container 超时清除。
- authenticated Node/Chromium helper 的两次 PDF 字节一致。

上述跳过项目不被算作已完成真实验收。无延期 Minor；审查未判断的环境/部署/消费边界按下方 Rulings 明确保留，而非默认通过。

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
4. 用 Windows 句柄绑定原子发布替代路径检查/重开，超出平台能力时拒绝而无不安全 fallback；这是原发布竞态要求的最小平台适配，不启动 Docker 或改全局设置。若有误，代价是系统权限/共享限制可能阻断合法操作，须保留原目录并单独诊断。
5. 审查不替 native 路径传递、WSL/VHD 复用、安全停止或 default 兼容作结论；这些继续 unproved/blocked，fixture 不能解锁。若有误，代价是 DL6 前仍需补证据或另议最小路线，不能承诺直接可启动。
6. DL6、Linux 真实验收/校准、付费与部署不在本轮审查的可执行范围，全部保持 not_run，而非未发现问题即通过。若有误，代价是还需后续独立授权与实证。
7. 不扩大为修改生产 default 或操作系统级绝对禁止 C 写入的工程；当前提供来源隔离和缺项阻断，不冒充 OS 审计。若有误，代价是未来 default/强隔离需求可能需要另立获批设计。
