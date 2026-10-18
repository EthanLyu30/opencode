# Task24B：D 盘专用 Docker 启动档案与既有数据盘复用规格

**状态：DL1–DL5 软件已获批并通过无 Docker 验证；DL6 未授权。** 2026-10-18 用户确认规格和计划后批准代码、无 Docker 回归及验证后提交/push。实际软件证据见[验证报告](../reports/2026-10-18-task24b-d-drive-docker-launch-verification.md)。native 兼容证据仍有缺项、保持 blocked；没有创建真实启动档案、启动 Docker 或修改系统配置。

**代码基线：** `dev` / `d437c4bd90f05f17a6fa894b31ea2606ada6307b`。继承 [Task24B 就绪规格](2026-10-17-opencode-task24b-readiness-design.md)、[B-Prep2 计划](../plans/2026-10-17-task24b-linux-docker-host.md)及[上次环境准备报告](../reports/2026-10-18-task24b-managed-storage-preparation.md)。这是解决启动路径阻断的增量子项目，不重做 B-Prep1/B-Prep2，也不改变实验题目、分组、试跑次数或评分。

## 1. 目标与成功边界

使用同一套已安装 Docker Desktop，为本项目提供独立 D 盘启动档案，将应用可控的新设置、日志、缓存、临时文件和 CLI 配置放 D；保留现有 C 盘档案，复用现有 D 盘 WSL 注册和数据盘，不迁移、不清空、不另建空引擎替代。

交付分两层：先完成可验证的软件及无 Docker 回归；另获环境授权后，才准备真实档案、短时启动及查询。后者只证明启动路径、活动数据盘和连接身份，不创建容器、不执行题目，不是 Linux 安全矩阵、工具能力或语料校准验收。

内部 override 目前只有安装包静态证据，**尚未证明能安全复用既有注册，也没有证明全部后端路径与停止行为**。若无法在启动前补齐关键证据，本子项目应交付明确的 blocked 结论和已验证软件，不通过实际启动碰运气，不宣称环境完成。

## 2. 授权与不可变项

- 用户审阅并确认本文及配套计划后，先实施代码与无 Docker 回归。真实 D 盘档案准备、Docker 启停和活动盘核查仍需带准确操作清单的单独确认。
- 旧 C 盘目录不复制整树、不迁移、不删除、不重命名、不覆盖、不改 ACL、不换成 junction/symlink。也不靠启动后清理或恢复 C 盘文件满足要求。
- 不重装或升级 Docker/WSL，不创建账户、不改系统隔离策略、服务设置、注册信息、全局环境变量或现有快捷方式。不使用 `setx`。
- 不修改、重建、复制、压缩、重置、卸载或注销既有 VHD/发行版；不自动关闭 Ubuntu 或执行全局 `wsl --shutdown`。Docker 正常启动可能写入既有 D 盘 VHD，**复用不等于磁盘字节不变**。
- 必要配置 C 盘例外仅沿用已批准的真实用户 `.wslconfig`；本项目不再新增 C 盘应用配置或缓存例外。不能把 D 盘的假 USERPROFILE 当成 WSL 全局配置来源。
- 不读取真实 API Key、`.env.local`、用户 Docker CLI credential 文件、浏览器 Cookies/令牌或完整用户档案。不调用 provider、模型发现或模型生成接口。
- 不拉取/构建/加载镜像，不创建/启动/执行/删除容器或卷，不做 prune。真实 Linux 验收、120 次校准、真实执行循环和付费跑分均不在本项目授权内。
- 不改旧视觉流程、租约、重试或预算算法，不改生产 Server/Core/CLI；不替换 `D:\OpenCode-Local`、旧 dist 或历史 seal/receipt。
- 直接在既有 `dev` 工作，保留用户改动；不另开隔离分支。软件验证与提交策略沿用本会话顺序实施、最终一次整体审查，不扩成多轮代理调度。

## 3. 已知事实与尚待证明的事实

已记录的安装身份是 Desktop `4.79.0.230596`、CLI `29.5.3`、设置格式 `44`；不因为后续官方有更新而放宽版本。相关路径：

| 对象                | 固定位置 / 已记录身份                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 启动器              | `D:\Applications\Docker\Docker Desktop.exe`                                                                                          |
| Electron 前端       | `D:\Applications\Docker\frontend\Docker Desktop.exe`                                                                                 |
| 前端资源            | `D:\Applications\Docker\frontend\resources\app.asar`；SHA256 `607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada`      |
| 后端                | `D:\Applications\Docker\resources\com.docker.backend.exe`；SHA256 `2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd` |
| CLI                 | `D:\Applications\Docker\resources\bin\docker.exe`                                                                                    |
| 既有 WSL 注册       | `docker-desktop` → `D:\Applications\DockerWSL\main`，原始注册路径可能带 `\\?\` 前缀                                                  |
| 既有运行盘 / 数据盘 | `D:\Applications\DockerWSL\main\ext4.vhdx` / `D:\Applications\DockerWSL\disk\docker_data.vhdx`                                       |
| 真实 WSL 配置       | `C:\Users\Administrator\.wslconfig`，`swap=0`；SHA256 `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`             |

旧 C 盘三棵树为 `C:\Users\Administrator\AppData\Local\Docker`、`C:\Users\Administrator\AppData\Roaming\Docker`、`C:\Users\Administrator\AppData\Roaming\Docker Desktop`，都是原有普通目录；保留。仅有文件存在性不能证明活动 daemon 使用哪块盘。

安装包静态路径函数使用 `PINATA_HOME_DIRECTORY_OVERRIDE` 推导 Docker local/roaming、扩展、崩溃目录，并以该 home 的 basename 形成管道前缀；`PINATA_USER_DATA_DIR_OVERRIDE` 在 Electron 初始化时改变 userData。**这些是固定安装身份的内部实现证据，不是 Docker 对外稳定承诺。** 只设置 TEMP/LOCALAPPDATA 或只设置 Electron userData 都不足够。

以下四项必须形成逐项证据，而不是把字段手动填成 true：

1. 启动器→前端→后端/服务的环境传递、日志/缓存/崩溃/更新辅助路径；任何未重定向的应用写入来源都阻断启动。
2. home 前缀对 VM/WSL 注册名、VHD 发现、singleton 和引擎管道的影响；必须仍使用现有 `docker-desktop` 及两块既有 D 盘 VHD，不触发导入、新建、迁移或首次初始化。
3. 固定 CLI 的 context/default 实际解析；单独的生产 `DockerConfig.invocationEnvironment()` 会清空 `DOCKER_HOST` 并固定 `DOCKER_CONTEXT=default`，不得把专用 CLI 环境的成功冒充生产入口成功。
4. 同用户既有实例冲突检测、准确进程归属以及作用域正确的停止方式；若启动后依赖无法归属的服务/VM 或无法安全停止，不进入真实启动阶段。

允许以静态安装资源、官方源代码和不接触 daemon 的固定 CLI context 查询补证。禁止执行 Desktop/后端的 `--help` 作为静态探针，它们可能在参数处理前启动。无法补证就列出具体缺项并停止，不扩大系统改造范围。

## 4. 专用档案与写入落点

根固定为 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479`，profileID 固定为 `oc-task24-dd479`。只在获准准备时创建；存在但无本任务 owner/身份的目录拒绝接管。

| 派生路径                                      | 用途                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `home-oc-task24-dd479\AppData\Local\Docker`   | 后端日志、运行状态、Electron crash 等安装包已证明的 local 路径                 |
| `home-oc-task24-dd479\AppData\Roaming\Docker` | 独立 `settings-store.json` 及该 profile 的 Docker 状态                         |
| `frontend`                                    | Electron userData/session 缓存；是否还需额外路径由固定版本审计决定，遗漏即阻断 |
| `cli`                                         | 本项目专用 Docker CLI 配置/context，无用户 credential 导入                     |
| `temp`                                        | 启动器及子进程 TEMP/TMP、PowerShell 模块缓存和临时输出                         |
| `manifest.json` / `owner.json`                | 不含秘密的版本化档案与本任务所有权，不冒充引擎证明                             |
| `state\grants`                                | 授权 nonce 的排他消费记录，阻止进程重启后重放；正式安全状态，不作临时缓存删除  |

最终诊断证据另存 `D:\OpenCode-Benchmark\Task24\reports\desktop-launch\<launchID>`；合成测试使用新的 `tmp\desktop-launch-<nonce>`，绝不能拿真实 VHD/旧 C 目录当夹具。所有新路径检查规范 D 盘绝对路径、逐级无 reparse point/链接、父目录身份及互不重叠；禁止 UNC、盘符别名、ADS、`..`、短路径和 junction 逃逸。

由专用启动器给**子进程**构造最小环境：设置两个已核查 override、D 盘 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP/DOCKER_CONFIG，保留准确 Windows 系统路径及必要用户身份；不继承 provider、Electron 注入、WSL/Docker endpoint/TLS/Buildx 覆盖。WSL 配置仍从真实用户的注册信息和真实 `.wslconfig` 读取，不能由上述子进程环境授权。

独立设置只重建这些明确值：`SettingsVersion=44`、`CustomWslDistroDir=D:\Applications\DockerWSL`、`WslEngineEnabled=true`、`UseWindowsContainers=false`、`AutoStart=false`。不复制其他字段，不复制账号、扩展、遥测 ID、登录或许可接受状态。首次启动如要求许可/onboarding/管理员操作，交给用户处理；不伪造同意，不自动升级或静默下载。

profile basename 已确定为 `home-oc-task24-dd479`，但**完整管道名与目标不能只靠字符串推算就信任**；静态规则给出期望，运行时仍验证实际 pipe owner、SID、启动时间和 backend 身份。只支持本机命名管道，不提供 TCP、SSH、远端 context 或默认旧引擎回退。

这些设置只约束项目专用启动入口；原快捷方式仍可能使用原 C 盘档案。本项目不改用户默认启动行为，也不承诺改变后 Windows/杀毒/Prefetch/事件日志等 OS 自身完全不写 C。应用管理的配置、数据、日志、缓存须在 D；无法确定的应用路径是阻断项，不归类成 OS 例外。

## 5. 版本化身份、准备与启动门槛

### 5.1 无启动兼容审计

产出 `DesktopCompatibilityReport`，包含源码/规格/计划及安装身份、每条路径规则的证据出处、注册复用/管道/服务传递/停止结论、CLI/default 解析记录及缺项。为启动器、前端、backend、asar、CLI 捕获真实 hash 与文件身份；已有两个 hash 必须精确匹配，其他值现场读取后锁定，不用零值或猜测填充。

未知版本/设置格式、安装文件变化、未知路径规则、首次初始化风险、注册或停止语义未证实都返回 blocked。纯 fixture 只能说明软件逻辑通过，不能把兼容报告升级为 native 或解除实际缺项。一个报告即使 hash 正确，也不能自行构造运行权限。

### 5.2 准备授权与原子发布

用户另行授权准确的 `prepare-profile` 操作后，验证真实 SID、WSL 注册和两块 VHD 的路径/fileID/volumeID、旧 C 目录元数据和 `.wslconfig` 身份，再只创建新 D 档案。VHD 不做整盘 hash，不要求正常启动后 size/mtime 不变；路径/fileID/volumeID 与注册身份不得替换。

`manifest.json` 绑定上述身份、路径、派生环境、配置内容 hash 和兼容报告 hash；发布使用新目录和排他创建，不覆盖同名文件。重入只有完全匹配的 owner/内容/身份可复用，任何漂移停止，不能“修复”旧目录。临时文件在验证后按精确 owner 清理。

准备成功仅为 `profile_prepared`，不是启动许可或引擎就绪。若版本兼容仍有缺项，允许输出计划/诊断，但不创建可启动档案。

### 5.3 单次启动授权

另行确认的授权记录绑定 `launchID`、随机 nonce、plan/manifest/compatibility hash、SID、VHD 身份、允许的 `start-readonly` / `stop-owned`、有效期和超时。授权最大 15 分钟、单次消费；manifest、环境变量、`--yes` 或普通 JSON 自报不能替代人类授权。可信控制器负责核对授权来源并签发进程内能力，原文件不传给 Docker。

prepare 授权绑定准备前已知的 plan/compatibility hash 和目标路径；start 授权再绑定准备后实际 manifest hash，避免依赖尚未创建的文件。核对用户授权与目标后，允许先排他创建本任务 owner/授权账本；其他 profile 文件写入或进程启动前，必须持久记下 nonce 消费。崩溃后不能靠丢失内存状态再次使用。对已完整准备、身份完全一致的 profile，只读返回原准备结果不算新副作用；不得借重入修补配置。

启动前重新核对全部身份、路径、文件读取稳定性、无既有 Docker 实例/相关 pipe、相关 WSL 停止及配置加载时序。若发现任何 Docker 实例或运行中 WSL，先报告，绝不为本项目停掉它们。需要管理员提升、许可、联网下载、全局服务重配、新注册/新盘时停止请求方向。

只有可启动条件均有证据才隐藏启动准确入口；最长等待 120 秒，每次查询有界、可取消，并在 60 秒内给用户进度。启动授权包含本次已归属资源的收尾；不是容器操作或真实验收许可。

## 6. 观察链与现有底座接缝

新增 benchmark 专用 `sandbox/desktop/`，负责兼容规则、profile、准确进程和显式命令。它不改变生产默认环境。新 `StorageSource` 分支命名为 `desktop-wsl-managed-launch`，与旧 `desktop-wsl-managed` / `desktop-wsl-legacy` 严格区分。

原 `readManagedSettings({file,windowsProfile})` 对真实 Windows profile 的校验、旧分支行为及公开 `StorageProof` / `HostRequest` / `HostManifest` 结构不变。新分支必须接收真实启动控制器签发的不透明 `DesktopLaunchSession`，并核对 manifest 的 D profile 和实际进程/pipe 绑定；不能仅传一个任意 `settingsFile` 或替换 `windowsProfile` 绕过校验。真实 Windows 用户、Docker profile 和 WSL 配置来源是三个明确概念。

观察链保持强绑定：准确安装文件 → 本次 session 的进程 PID/creation time/SID/映像/归属 → 实际 profile pipe → backend → 原 WSL 注册/运行盘 → 指定数据 VHD 的实际设备 → Windows ext4 UUID 与活动 dockerd mount UUID → daemon server ID → CLI 实际 context/endpoint。有效 `/proc/swaps` 必须确认禁用。读取不稳定、多个 dockerd、工具或物理设备观察不支持都 blocked；不额外挂载 VHD、不推断磁盘已被使用。

专用只读 CLI runner 只允许固定 `context inspect`、`version`、`info`，只使用本次已核对的 profile endpoint/config；清除外部覆盖。CLI 的 default 行为必须在该安装上用真实、无 daemon 的 context 查询刻画，不伪造 inspect 输出。旧 runner 不增加可继承的自由 `DOCKER_HOST` 参数。

另用**原生产环境的逐字合同**记录其 default 解析，产出 `production_default_compatible`。如与 profile endpoint 不同，只能报告后续生产接入阻断；本阶段不改 `packages/server/src/workflow/docker-config.ts`，不将 profile 专用 runner 通过当成 A 组通过。确需修改生产连接时另立最小设计并征求授权。

本入口只生成 `inventory_observed_not_accepted` 或 blocked 诊断，不签发 `EngineSession`、Linux acceptance receipt 或 readiness。原 `inspectLinuxHost`、manifest 的 default/endpoint/daemon 一致性断言不得放宽；专用启动报告不能传入原验收路径充当证据。

## 7. 生命周期、停止和清理

状态顺序为 `planned → profile_prepared → starting → observed_not_accepted → stopping → stopped`；任一门槛失败为 `blocked`，收尾归属不明为 `cleanup_uncertain`。崩溃/超时/取消不自动重新启动，不恢复真实启动授权，不更换 profile 或引擎。

只向完整身份仍一致、确属本次 session 的进程或专用控制通道发送已审核的停止操作；PID 必须同时核对创建时间、SID、映像和归属，不能仅按进程名或父 PID 杀进程。停止动作上限 30 秒。禁止全局 `taskkill /IM`、`Stop-Process -Name`、`docker desktop stop` 默认实例或 WSL 全局关闭。

若无法证明某个后端/WSL 生命周期归属或无法安全结束，保留证据，报告残留，不对未知资源执行强杀/注销/删除。预启动不能证明有安全收尾路径时，不启动。

保留用户原目录、两块 VHD、必要 `.wslconfig`、新正式 profile 和最终报告。合成测试 helper、临时副本/日志/cache 在验证后按精确所有权清理。真实 profile 的运行状态不被当成随手可删除缓存；只报告体积和用途。回退是停用专用入口、回到原启动方式，**不是把旧 C 盘目录搬来搬去**，也不做磁盘数据回滚。

## 8. 验证与交付门槛

软件验证包括路径/链接/漂移、版本与未知规则、环境污染、两阶段授权与重放、既有实例冲突、PID 复用/归属、取消/超时/崩溃、配置来源分离、活动盘不匹配、CLI/default 冲突及命令副作用拒绝。使用真实 D 盘临时文件系统与准确 PowerShell parser；模拟进程/pipe/WSL 观察不接触真实 Docker。所有模拟结果明确 `assurance=fixture`。

完整 benchmark 回归和包内 typecheck、覆盖新测试/脚本的 scoped typecheck、文档/diff 检查必须通过；不得增 skip、删断言、放宽旧测试时限或顺手修业务。上次记录的 **345 pass / 10 既有 skip / 0 fail** 只是基线，不是本轮已重跑结果。

最后记录软件状态、真实环境缺项和 `production_default_compatible`，并保持 `engine_verified=false`、`tool_capability_verified=false`、`corpus_engine_ready=false`。只有未来另获许可且真实矩阵/能力/校准通过，才可能改变后三项。

源码提交/push 不触发部署。实施验证通过后按用户要求普通提交并 push `fork/dev`，保留 hooks；如环境阶段尚未获准，报告“软件已完成、真实准备/核查未运行”，不能将整个环境目标标为完成。本次授权仅覆盖 DL1–DL5 的软件及无 Docker 验证，不包含 DL6 或后续消费。

## 9. 方案取舍与依据

采用专用 D profile：不触碰旧 C 树、便于撤销专用入口，但必须处理内部版本耦合、命名空间和原数据复用。未采用“仅改 TEMP/userData”，因覆盖不全；未采用“移动旧目录加 junction”，因违反用户不迁移的边界。若原数据复用不成立，不自动转成新盘/新引擎方案。

官方资料用于确认一般语义，不替代本机核查：

- [Docker context 与 endpoint/环境覆盖](https://docs.docker.com/engine/manage-resources/contexts/)：连接来源必须显式记录，不能仅凭当前 context 名字认定同一个 daemon。
- [docker desktop start](https://docs.docker.com/reference/cli/docker/desktop/start/)：该页未给出上述内部 home override 的稳定接口承诺。
- [Electron app 源码文档](https://github.com/electron/electron/blob/main/docs/api/app.md)：userData、sessionData、crashDumps 等路径需分别考虑，不能从一个 override 推导全部缓存位置。
- [WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)：真实用户 `.wslconfig` 是全局 WSL2 配置，须在相关 VM 启动时生效，不能用子进程的假 home 代替。

配套 [实施计划](../plans/2026-10-18-task24b-d-drive-docker-launch.md) 已获用户确认；DL1–DL5 软件记录见验证报告，DL6 仍待单独确认。
