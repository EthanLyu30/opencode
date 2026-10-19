# Task24B：SW0–SW9 设置生命周期与旧工作负载边界验证

日期：2026-10-19。工作区：`D:\OpenCode-Audit`，分支：`dev`。审查范围起点：`ec7fd6d8b71112e517b08bee9d57cc365be6fc36`。

## 结论和适用范围

本轮无 Docker 全量软件测试已通过，状态为 `software_fixture_verified`，不是原盘 Docker 启动许可或 Linux 验收。独立整段审查和 push 尚待完成，完成后以实际结果更新本报告。

v2 使用 bigint 精确身份，v1 身份算法和 v1 NT-handle helper 保持原样。新模块对版本显式分流；原视觉流程、workflow 租约/重试/预算、公开 StorageProof/HostRequest、生产连接配置、评测题目/分组/次数和现有部署没有调整。

真实环境维持 `native_blocked`：没有真实准备、Docker/WSL 启停、旧 VHD 内容读取/挂载/复制、Linux 真实验收、付费模型调用、旧 C 盘目录迁移/删除或部署替换。夹具使用 D 盘新 owner 根内的非可执行安装文本、合成 VHD 普通文件，以及本轮自有 Bun/PowerShell 子进程；这些子进程不是已安装 Docker/WSL。

## 已实现与规格映射

| 任务 | 交付及主要验证                                                                                   | 提交                                 |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| SW0  | `v2:dev:ino:birthtimeNs`，bigint 全程保留；相邻大整数、真实 D 父链、硬链接/C 目标拒绝            | `1be7a23978`                         |
| SW1  | 独立 v2 schema/intent/plan/manifest/approval；固定 3+3 文档 registry，v1 2+2 不变                | `d1b29c2e11`                         |
| SW2  | fatal UTF-8、重复/转义/大小写键、深度与字节限额、固定临时命名及跨文件规则                        | `37de824df3`                         |
| SW3  | 容器/Swarm/Kubernetes 三范围合成空状态及连续文件锁；native 无采集器即拒绝                        | `d908ab5a5f`                         |
| SW4  | 固定父链，三文件全有或全无短租约；第二/第三取得失败、异常释放、合法 Rename、三轮采样上限         | `de5b11e933`，SW9 补强               |
| SW5  | 13 目录/5 文件；不可变 intent 与 manifest、独立 seed、独立一次性 grant/active 事实；不接管旧根   | `c8fac623da`                         |
| SW6  | starting/observed/stopping/stopped/stale；私有 session/seal；设置失败与 consumed stop-owned 分离 | `89da055c20`、`936ba7e50e`，SW9 补强 |
| SW7  | 当前同组租约内的 v2 观察 decoder；注册/双 VHD/设备 UUID/daemon/swap 链；只读历史诊断             | `381b867843`                         |
| SW8  | 严格 CLI 版本分流；兼容/旧负载门禁优先于确认和写入；finally 收尾；无 force/accept-risk           | `e852f10adf`                         |
| SW9  | 真实自有写入子进程退出、合法原子替换、重放/取消/重复窗口回归、全量测试与独立审查                 | 最终提交见 Git 历史                  |

v2 最终设置必须同组固定，租约期间不能被写入或删除，使用后释放目标句柄；父目录仍不能被替换。observed 后的 raw/fileID 漂移不因 semantic 相同而被接纳。稳定非法 JSON、未知键或关键值错误不被当作 pending。最多三轮仅重试取得，不重跑已经进入的 use callback。

v2 存储摘要严格绑定 `schemaVersion:2`、intent、policy、当前 runtime seal、完整实际观察与 plan。旧 seed/克隆 seal/跨会话对象/过期租约不能复用。`.wslconfig` 仍须早于当前 backend；运行设置可在启动后合法保存，其内容由 seal 绑定且观察时校验实际 mtime。默认连接不匹配仍 blocked，全部 readiness 始终 false。当前没有可签发的 native v2 session，因此 fixture 不会被执行为真实 CLI，也不能交给原生存储探针。

## 观察到的 RED → GREEN

- SW0：缺精确读取 0/2 → 2/2；发现真实 D 祖先 inode 超过 2^53，未作 Number 舍入。
- SW1：缺新合同 0/4 → 新合同/旧绑定/档案 14/0。
- SW2：缺策略、错误 intent、伪造盘身份分别复现，定向 7/0；包括完整 6 MiB 上限校验。
- SW3：缺私有旧负载事实 0/3 → 与旧兼容/原生拒绝合计 15/0。
- SW4：缺租约、未打开子目录即核对身份、释放后 Rename 被父句柄阻止，均先复现再修正；实际 Windows 句柄验证。新增三次实际取得失败、use=0 的回归通过。
- SW5：D 根 `realpath` 表示差异、重复 manifest 键、active 档案被重载为 prepared、将原锁移入替换根后被误删，均先复现再修正；真实 prepared 权限用于 SW4。
- SW6：缺 runtime、pending seed 的 undefined canonical 字段分别复现；最终命名回归 37/0（94.81s），包含原 launch/confirmation。
- SW7：缺 decoder/历史发布接口先红；最终命名回归 33/0（100.45s），包含旧 storage/inventory。
- SW8：v2 缺分流、旧负载缺项被吞、准备失败 0/3 → 新用例 4/0；最终命名回归 20/0（21.39s）。
- SW9：删除自有 journal 后 nonce 可重用、重复 bootstrap 可打开、取消后实际 start 未返回即释放旧负载保护，均以真实文件边界先复现。nonce 在 await 前一次性标记；bootstrap 只能开一次；调用者取消等待不会令仍在进行的 start 提前释放保护。E2E 最终定向 3/0（16.51s），自有写入子进程实际退出码 23。

初轮 linux-host 在边界回归仍为 RED、模块已经载入旧实现时完成为 183 pass / 1 fail（254.25s）；该结果不计为验收通过。修复后从新进程重跑以下全部命令，最终结果如下。

## 最终验证

使用固定 `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe --no-env-file`；HOME/USERPROFILE、APPDATA/LOCALAPPDATA、XDG、TEMP/TMP、Bun/npm/Go/Turbo 缓存均隔离到本轮 D 盘 owner 根。禁用模型目录拉取与工具链下载，环境采用白名单，不加载 API key 文件；保留全部旧断言、时限和 skip。

| 命令（benchmark 包目录）                                 | 实际结果                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `test ./test/linux-host --timeout 30000 --only-failures` | 184 pass / 0 fail，1235 assertions，45 files，257.05s，exit 0            |
| `test --timeout 30000 --only-failures`                   | 457 pass / 10 skip / 0 fail，2274 assertions，115 files，258.88s，exit 0 |
| `run typecheck`                                          | 最终重跑 exit 0                                                          |
| `run typecheck --project <本轮 scoped config>`           | 最终重跑 exit 0                                                          |
| 本轮文件 Prettier / `git diff --check`                   | 全范围本轮文件均 exit 0                                                  |
| 全范围独立只读审查                                       | 待完成                                                                   |

scoped config 包含全部 src、linux-host 测试及现有 desktop-launch/linux-host/accept-linux-host 三脚本，不通过删减收集范围、增 skip 或放宽旧时间条件消除失败。Git pre-push 的根仓库 typecheck 不绕过。

## 实施裁决（按记录顺序）

1. 计划标题改为 `Task N: SWN`，仅供既定任务脚本提取；代价是文档标题调整。
2. 按用户选择直接在 dev 实施并最终 push，不另建 worktree 或重复询问；代价是必须逐项 stage、保留外来文件。
3. v2/test 身份用 bigint 新命名空间，v1 原样；代价是新 ID 不得传给旧身份消费者。
4. 策略选择改为异步 Promise<Gate>，真实检查 owner/安装/盘身份；代价是本计划调用者均须 await。
5. v2 compatibility 私有权限独立成模块，旧元数据 helper 意义不变；代价是一份版本专用模块。
6. 先完成 SW5 再接 SW4 高层租约，使用真实签发的 prepared 对象；代价仅为任务顺序。
7. SW3/SW4 共享独立 publication-v2 句柄原语，完全保留旧 helper；代价是一份新 helper。
8. v2 launch 私有状态独立模块，旧 inspection 先明确只用 v1 validator，再于 SW7 分流；代价是额外版本模块。
9. v2 inspection/inventory 独立适配，固定 record-only 相对句柄发布诊断；代价是额外适配及很小的发布模式。
10. v2 设置允许启动后保存，用当前 seal+实际 mtime 约束，wslConfig 仍须预先存在；代价是 v2 必须依赖完整租约/物理链，不能借用 v1 的 seed/时间算法；native 仍拒绝。
11. 为满足最终审查必须覆盖已提交整段源码的执行顺序，SW9 先提交已验证源码与明确标记待审查的报告，再做一次全范围独立审查及最终报告续提交；不提前 push 或宣告交付完成。代价是多一份报告状态更新提交，不改变任何验收或操作门禁。

## 未放行事项及下一阶段条件

native 仍缺完整 path_routing、backend_environment、registration_reuse、stop_owned、settings_mutation、existing_workload_restart、automatic_behavior 证据。fixture 规则不是从现场学习或风险确认导入的 native 规则；没有 native 工作负载采集器，不能拿 VHD fileID/size/mtime、AutoStart=false 或用户接受风险替代容器/Swarm/Kubernetes 的完整可信前置证明。当前 native start/stop 显式拒绝、START 面板关闭不变。

另须闭合完整临时命名/保存行为、所有其他写入/空间预算、全部进程环境继承、安全停止 engine/WSL、CLI 来源、实际活动盘/daemon/swap 和生产默认连接；当前文件字节上限不是文件系统硬配额。

实际准备与启动各自仍需新的现场只读核查、准确 SID/版本/源码与 3+3 文档绑定、原注册/盘及父链身份、准确文件/目录/argv/环境/预算、准确归属停止清单，并分别取得用户确认。本报告不提供可执行 START 命令，不生成 Linux receipt、EngineSession 或付费跑分结论。

既有未跟踪报告 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md` 原样保留，SHA256 `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07`；它仍使真实源码 clean-tree 绑定 blocked，不 stage、不忽略、不隐藏。已批准规格 SHA256 仍为 `1e15133fc6ad251aeebc838cfae123b9f6bb4c3698487a146942c1228ce99b39`。

## 提交、推送与清理

最终提交与 push 仅在新进程全量验证、独立审查及所需修复通过之后进行，不强推、不创建额外分支/PR。目标为 `fork/dev`（GitHub `EthanLyu30/opencode`）。实际状态待补。

审查/交付后仅清理本计划 `.superpowers/sdd/2026-10-19-task24b-settings-workload-boundary` 和本轮 D 盘 owner 临时根。先核实准确 owner、根/祖先身份、无链接及逐项清单；不触及兄弟工作区、旧 C 目录、用户文件或此前被拒绝清理的目录。清理执行结果以会话最终答复为准，不预先声称完成。
