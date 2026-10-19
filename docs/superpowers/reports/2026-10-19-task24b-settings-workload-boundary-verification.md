# Task24B：SW0–SW9 设置生命周期与旧工作负载边界验证

日期：2026-10-19。工作区：`D:\OpenCode-Audit`，分支：`dev`。审查范围起点：`ec7fd6d8b71112e517b08bee9d57cc365be6fc36`。

## 结论和适用范围

本轮 SW0–SW9 软件交付已通过无 Docker 验证，状态为 `software_fixture_verified`。独立整段审查发现的 4 项 Important 均在同一轮以 RED→GREEN 修复，最终全包 462 pass / 10 原有 skip / 0 fail。无延期 Minor。原盘维持 `native_blocked`，不等于 Docker 启动许可或 Linux 真实验收。

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
| `test ./test/linux-host --timeout 30000 --only-failures` | 189 pass / 0 fail，1246 assertions，46 files，281.40s，exit 0            |
| `test --timeout 30000 --only-failures`                   | 462 pass / 10 skip / 0 fail，2285 assertions，116 files，286.91s，exit 0 |
| `run typecheck`                                          | 最终重跑 exit 0                                                          |
| `run typecheck --project <本轮 scoped config>`           | 最终重跑 exit 0                                                          |
| 本轮文件 Prettier / `git diff --check`                   | 全范围本轮文件均 exit 0                                                  |
| 全范围独立只读审查                                       | 1 次；0 Critical / 4 Important / 0 Minor；同一修复轮覆盖全部四项         |

scoped config 包含全部 src、linux-host 测试及现有 desktop-launch/linux-host/accept-linux-host 三脚本，不通过删减收集范围、增 skip 或放宽旧时间条件消除失败。Git pre-push 的根仓库 typecheck 不绕过。

### 独立审查与唯一修复轮

审查使用新上下文 `gpt-6-astra`，只读完整 `ec7fd6d..23e34b0` 范围、规格/计划及裁决，没有运行测试、改文件或调度二次审查。四项 Important 经作者核实后全部采纳，无延期 Minor。

| 发现                                  | 覆盖回归与修复                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| observed 漂移在切入 stopping 时被吸收 | 直接合法 Rename 后调用 stop，不先调用 use；停止前与原 seal 比较，成功收尾仍保留 drift 主失败                                                        |
| start 到期后停止操作缺连续父链        | 到期并确认旧窗口关闭后，在 onStop 内尝试父目录 Rename（须拒绝）及合法目标 Rename（须成功）；独立 stop 父链横跨前检查、实际停止和后检查              |
| 取消丢弃晚到 active/bootstrap         | 独立自有 Bun 子进程只延迟真实已签发资源的交付，不伪造 token；资源产生操作使用取消确认并被 join，捕获迟到归属后收尾，不把未观察的创建说成 not_needed |
| 独立 120 秒计时释放仍待返回的启动保护 | 去除 helper 自己的效果期限，分离取得取消与已调用效果生命周期；调用者原 120 秒等待/使用权限不延长，未知启动仍报 uncertain                            |

五个新增回归先全红 0/5（34.53s）；修复后分组 2/0（17.55s）和 3/0（20.98s），再与 runtime/E2E/workload 合跑 17/0（82.83s），最终全量结果见上表。资源交付屏障和独立计时调用观察仅存在于隔离测试子进程：没有修改全局 Date/系统时钟，没有增加 native 可注入时钟，也没有声称实际等待超过 120 秒；仍有真实 Windows 文件锁/替换/释放断言。原调用者启动 120000ms、轮询 200ms、停止 30000ms 均未改变。

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
12. 调用者原 120 秒等待/使用期限不变，但已调用效果的保护跟随其实际返回，取得阶段单独确认取消。代价是未完成的合成操作可保留自有只读保护至返回或控制器退出，绝不以此续发使用权或放行 native。
13. 审查不判断被明确排除的真实 Docker/WSL 兼容、native 目录/采集/停止；继续拒绝并另获批准。代价是软件交付不等于真实 native 就绪。
14. 审查不判断超出合成链的真实活动盘/daemon 真实性；此处不能签发 native proof/receipt。代价是真实 Linux 验收仍待完成。
15. 不将同 SID 恶意代码/管理员纳入 OS 安全沙箱承诺（规格第四节已明确）；所有链接/身份/句柄/竞态检查仍保留。代价是不适用于恶意特权共租环境。
16. 审查不修 v1 数字身份精度，遵守用户明确增量授权。代价是旧精度限制仍在旧路径，不能暗中转成 v2。
17. fixture session 拒绝真实 CLI/原生存储执行不是缺失的放行功能。代价是未来真实适配仍须证据/授权，不能切一个 fixture 开关启用。
18. 独立审查只读、未重新执行测试；作者另行核实新进程日志和类型检查。代价是没有第二次独立测试执行，而源码审查确实独立。
19. push、报告闭合及清理放在修复/复验后的交付门禁，不提前执行。代价是这些操作尚未确认时不能宣称最终交付成功。

## 未放行事项及下一阶段条件

native 仍缺完整 path_routing、backend_environment、registration_reuse、stop_owned、settings_mutation、existing_workload_restart、automatic_behavior 证据。fixture 规则不是从现场学习或风险确认导入的 native 规则；没有 native 工作负载采集器，不能拿 VHD fileID/size/mtime、AutoStart=false 或用户接受风险替代容器/Swarm/Kubernetes 的完整可信前置证明。当前 native start/stop 显式拒绝、START 面板关闭不变。

另须闭合完整临时命名/保存行为、所有其他写入/空间预算、全部进程环境继承、安全停止 engine/WSL、CLI 来源、实际活动盘/daemon/swap 和生产默认连接；当前文件字节上限不是文件系统硬配额。

实际准备与启动各自仍需新的现场只读核查、准确 SID/版本/源码与 3+3 文档绑定、原注册/盘及父链身份、准确文件/目录/argv/环境/预算、准确归属停止清单，并分别取得用户确认。本报告不提供可执行 START 命令，不生成 Linux receipt、EngineSession 或付费跑分结论。

既有未跟踪报告 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md` 原样保留，SHA256 `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07`；它仍使真实源码 clean-tree 绑定 blocked，不 stage、不忽略、不隐藏。已批准规格 SHA256 仍为 `1e15133fc6ad251aeebc838cfae123b9f6bb4c3698487a146942c1228ce99b39`。

## 提交、推送与清理

最终代码修复提交 `68ece417eca42af34c1936ea15af0ce330736686` 已正常 push 到 `fork/dev`（GitHub `EthanLyu30/opencode`），远端由 `fd3861ba88` 前进到该提交，exit 0；没有强推、额外分支或 PR。未绕过 pre-push：37 个包在范围内，31 项 typecheck 全部成功，0 cache hit，30.716s。本文推送回执续提交随后正常发布，最终远端 HEAD 以会话交付核对为准。

直连 GitHub 的只读预检曾被 reset；仅为 Git 子进程复用已有代理变量和既有 manager/schannel 设置后恢复。没有修改全局网络/Git 配置、显示代理值/凭据、读取模型 Key 或打开登录窗口。

审查/交付后仅清理本计划 `.superpowers/sdd/2026-10-19-task24b-settings-workload-boundary` 和本轮 D 盘 owner 临时根。先核实准确 owner、根/祖先身份、无链接及逐项清单；不触及兄弟工作区、旧 C 目录、用户文件或此前被拒绝清理的目录。清理执行结果以会话最终答复为准，不预先声称完成。

最终清理尝试在进程启动前被执行策略拒绝，没有任何删除，也没有尝试替代删除方式。以下两处本轮自有中间物仍在，未声称清理成功：

- `D:\OpenCode-Benchmark\Task24\tmp\bprep1-settings-workload-20261019-a4c63e91`：D 盘隔离环境、临时夹具/编译输出和本轮工具缓存。
- `D:\OpenCode-Audit\.superpowers\sdd\2026-10-19-task24b-settings-workload-boundary`：本轮执行账本、工作副本、日志、runner 和审查 diff。

清理前后只读缓存清单比对显示：pre-push 没有新增仓库内所收集的 Turbo 日志/tsbuildinfo 或 Turbo 目录；预先存在的 32 文件/32 目录未接管删除。代码和报告已推送、可通过 Git 获取；上述保留的是生成性中间物，不是部署或用户数据。
