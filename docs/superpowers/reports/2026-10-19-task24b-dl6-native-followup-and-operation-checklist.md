# Task24B DL6 原生兼容补证与待批准操作清单

2026-10-19，Asia/Shanghai。首次取证基线为 `dev / 153aa024966ffcacbb1746cd3bc2f264575c5597`；修复后复核基线为 `dev / fd3861ba88e846453573b611445fade5c1a6e0b8`。第一至七节保留18:43–18:45的历史采样，第八节为修复后复核，当前状态以第八节为准。没有执行真实准备或启动，没有进行验收、付费跑分或部署替换。

当前结论：修复后的真实元数据探针已返回完整 JSON、stderr 为0，严格 Windows/WSL 快照查询成功；**七类原生兼容门槛仍未全部关闭，目前不能批准实际准备或启动。** 本次进一步定位到正常设置保存路径与现有不可变文件合同不兼容，并补出两处运行期设置文件；旧盘工作负载自动恢复风险在当前读取权限内仍无法排除。正式审计还因本地未提交报告而拒绝源码绑定，不隐藏该文件或绕过检查。

本清单以[原启动规格](../specs/2026-10-18-task24b-d-drive-docker-launch-design.md)、[确认补充规格](../specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md)和[NC1–NC7 软件交付](2026-10-18-task24b-dl6-native-cli-verification.md)为准；[上次证据](2026-10-18-task24b-dl6-native-evidence-and-checklist.md)是历史采样，不沿用其中旧的软件状态、PID、时限内授权或启动许可。

## 一 已完成的软件与本机新发现

NC1–NC7 已提供文档与源码绑定、只读探测、交互式确认、两次预检和历史报告；`PINATA_SINGLE_INSTANCE_LOCK=true` 已在 `planning.ts` 中启用。旧报告中“尚未补锁、尚无确认入口”的描述不再代表当前软件。

但 native `start/stop` 仍显式抛出 `TASK24_DESKTOP_NATIVE_RULES_UNPROVED`；原生启动面板也仍拒绝。补证文字不会自动解除这些门禁，普通 JSON 或临时诊断不能生成 live session。

18:43 的真实 `auditDesktopCompatibility` 调用返回 `desktop_compatibility_blocked`。七项缺项外还含 `cli_default_unproved` 和 `TASK24_DESKTOP_NATIVE_QUERY`；这次 CLI 阶段尚未执行，`production_default_compatible=null`，不能把后面的独立 CLI 诊断伪装成该次审计已通过。

| 定位步骤                                                        | 实际结果                                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 原固定 Windows 元数据脚本，经现有有界 transport 执行            | exit0、有效 JSON，但 stderr 有三个 CLIXML progress 记录，内容为“正在准备首次使用模块。” |
| 仅在内存诊断脚本前添加 `$ProgressPreference='SilentlyContinue'` | exit0、有效 JSON、stderr 为空                                                           |
| 正式业务脚本                                                    | 未修改，仍按原规则拒绝非空 stderr                                                       |

两次直接元数据探针均经相同 transport，单次上限10秒；这是单变量定位，不是原生适配的 GREEN 或新的测试通过数。Microsoft 说明 `SilentlyContinue` 控制进度显示；它不等于忽略 ErrorRecord。[PowerShell 首选项](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables?view=powershell-5.1#progresspreference)

上述 progress 修复已在后续提交 `fd3861ba8` 完成，保留 ErrorAction=Stop、真实 stderr 拒绝、输出上限、身份检查和超时。修复后的本机复核见第八节；本节失败仍是首次取证的历史结果。

## 二 安装与静态位置证据

六份安装文件与 componentsVersion 已重新实际读取，hash/fileID 均与10月18日报告一致。安装仍是 Desktop `4.79.0.230596`、Docker CLI `29.5.3`；不是升级到官网新版本。官方4.79.0发布记录日期为2026-06-22，但兼容判断锁定本机文件，不用当前最新版文档的默认值替代该安装的行为。[Docker 发布记录](https://docs.docker.com/desktop/release-notes/#4790)

| 对象                                                      | 本轮 SHA256                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------ |
| `D:\Applications\Docker\Docker Desktop.exe`               | `d079706dcb13555ad6e51e04e0f0507f475de5ebb79ac31cf85986d8902e31bc` |
| `D:\Applications\Docker\frontend\Docker Desktop.exe`      | `86d8ea314a56cfee849d666f2cac60f07aeb7937632e7fe005d642ad04be2771` |
| `D:\Applications\Docker\resources\com.docker.backend.exe` | `2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd` |
| `D:\Applications\Docker\frontend\resources\app.asar`      | `607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada` |
| `D:\Applications\Docker\resources\bin\docker.exe`         | `7bc66b018b9da43fea986f893288bb93970d3d1217f5063201fd97c827f20732` |
| `D:\Applications\Docker\com.docker.service`               | `5ba942808db6b1ebb32dd9f940d61f27e36322362fb8fe0d794c89f8b6a0d4bf` |
| `D:\Applications\Docker\resources\componentsVersion.json` | `8e1ea0564f06432d37853880188ea838fcd59b2ed751861fc933afb0e54ca233` |

ASAR 只在内存解析，未解包或执行 JavaScript。数据起点282980，1052个条目。以下偏移为对应模块 UTF-8 解码字符串的零基位置；函数名和 VA 来自本机准确 PE 的 Go functab，与 GNU objdump 的目标区间核对，不是目标二进制的运行轨迹。

- `build/entry-cli.main.js` 的 SHA256 为 `3998a5b748667b5bd51fe73d3b113de9dc9d31ebc144b5b95c62413201c5f32b`。函数 `U` 从1764开始，Windows engine pipe 带 home 前缀；`ne` 从1997开始，backend API pipe 也带前缀。由此得到停止通道的静态候选 `\\.\pipe\home-oc-task24-dd479dockerBackendApiServer`，**不是** engine pipe；尚未连接或发送请求。
- 同模块 `ce` 从3210开始，Windows `dockerHost` 返回未带 home 前缀的 `npipe:////./pipe/dockerDesktopEngine`；`le` 从3611开始，Windows 模块管理通道固定为 `\\.\pipe\dockerModulesManagerAPI`。这是“不是所有内部通道都被 profile 隔离”的实际静态证据，不推断它们一定已经连到其他 daemon。
- `build/onlyAllowSingleInstance.main.js` 的 SHA256 为 `ed2277acdafb0891a3b6d93599738a3ae5fc909a8bc2123018816c67d830027d`；约502的显式 true 分支要求请求单实例锁。只解决同档案重入，不替代全机冲突检测。
- 启动器 Go pclntab 文件偏移8715904、17682个函数；backend 对应88651968、172219个函数。两者 PE ImageBase 为 `0x140000000`，text RVA 为 `0x1000`；本文件 VA 已加这两项，不能直接把 Go header 中的0当作链接基址。

| 准确函数或区间                                          | 本轮新增证据                                                                             | 不能据此宣称                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 启动器 `main.run`，`0x1405d0f40–0x1405d14a0`            | 调用 LocalDir、MkdirAll、flock、jobobject.New、BackendBinary 和 startAndWaitBackend      | 所有分支都不写 C、所有后端都已归属                   |
| `main.startBackendProcess`，`0x1405d1ae0–0x1405d1d20`   | 先走 Job.StartProcess；失败还有 exec.Command → Cmd.Start → AssignProcess 路径            | 主 Job 路径、服务和全部子进程的环境传递都已证明      |
| settingsLoader.Initialize，`0x141137aa0–0x141137e80`    | `0x141137c97` 调用 loadSettings                                                          | 五字段文件初始化后必定不变                           |
| loadSettings，`0x141138760–0x141138de0`                 | `0x141138bd8` 调用 saveToFile                                                            | 已经证明每次都会写同一个目标                         |
| saveToFile，`0x141139d80–0x14113a180`                   | 三处直接调用 jsonutil.WriteFile：`0x141139e03`、`0x141139ea0`、`0x14113a020`             | 三个目标、分支条件和原子替换行为已全部解析           |
| Distro.CreateMainDistro，`0x141373a40–0x141374040`      | 检查 distroUpToDate，仍有 MkdirAll/copyFile 及间接调用分支                               | 仅构建号一致就排除一切导入或初始化                   |
| Distro.CreateDisk，`0x141375260–0x141375480`            | 可调用 createDataDistro、keepAlive、createDataDisk；后者在 `0x141377c0a` 调用 createVHDX | 文件存在就一定直接复用，或该分支在本机一定被执行     |
| QuitDockerDesktop，`0x143044100–0x1430441c0` 及其 func1 | handler 启动 goroutine；回调还有间接调用、timer/select                                   | HTTP 成功等于完整 backend/WSL 已停止、30秒内一定收尾 |

fallback 的 exec.Command 路径没有观察到显式 Env 赋值，结合 Go 的 nil Env 语义，支持“该分支继承 launcher 环境”的静态推断；它不是完整 backend_environment 证明。[Go os/exec](https://pkg.go.dev/os/exec#Cmd)

## 三 七项兼容门槛与关闭条件

| 保留缺项                             | 本轮推进及下一条必要证据                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path_routing_unproved`              | 已定位前端 home/userData/crash 路径和非前缀内部通道；仍需完整前端、backend、服务、更新及其他辅助程序的应用写入路径闭包，未知 C 写入不算 OS 例外                                                          |
| `backend_environment_unproved`       | 已从 launcher 追到主 Job/备用 exec 两条启动链；仍需主链、frontend、service 的准确环境和所有子进程传递；既有 SYSTEM 服务不会因设置子进程 HOME 就自动改档案                                                |
| `registration_reuse_unproved`        | 名称、build、原盘身份匹配；仍需排除真实设置下的 CreateDisk/reimport/migration 分支，且不能靠挂载、复制旧盘或试启动求证                                                                                   |
| `stop_owned_unproved`                | backend API pipe 与 engine pipe 已区分；仍需 server PID/创建时间/SID/映像与会话归属，以及退出回调到完整 engine/WSL 收尾的作用域证明                                                                      |
| `settings_mutation_unproved`         | 初始化加载链有明确落盘调用，现有 profile.ts 又逐字、逐 hash、逐 fileID 验证设置；需先厘清目标/条件。若 Docker 会改写受绑定文件，须另批“不可变期望配置与有界运行设置分离”的设计，不能直接接受任意新增字段 |
| `existing_workload_restart_unproved` | 未读取旧盘内容器策略，无法排除 daemon 启动后自动恢复；不能仅凭未执行 docker run、AutoStart=false 或人工 START 短语关闭此项                                                                               |
| `automatic_behavior_unproved`        | AutoStart 不是许可、更新、下载、组件更新、服务/hosts 写入的总开关；需固定4.79安装的准确规则，不套用当前官方文档的默认值                                                                                  |

Docker 官方说明 `always` 可随 daemon 重启恢复容器；这是旧数据盘复用与“本阶段不运行容器”之间的实质边界问题，不会通过继续扫描安装文件知道旧盘中的实际策略。[容器重启策略](https://docs.docker.com/engine/containers/start-containers-automatically/)

官方也把登录自动启动、软件更新及 privileged helper 的系统操作分开描述。因此五字段设置不构成禁下载、禁 hosts 写入或服务环境隔离证明。[设置分类](https://docs.docker.com/desktop/settings-and-maintenance/settings/)、[Windows privileged helper](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/#privileged-helper)

## 四 本机只读采样

18:44–18:45 的独立诊断记录：Windows 元数据没有 Desktop/backend/VM 角色，只有既有 SYSTEM 服务 `com.docker.service`，PID6488，创建时间 `2026-10-19T10:28:05.076Z`；三个原有观测 engine pipe 均不存在。SID 从 Windows 身份读取成功，未生成任何待批准请求。

固定系统工具只执行 `wsl.exe --list --quiet` 与 `wsl.exe --list --running --quiet`，均 exit0，单次上限5秒；安装列表为 docker-desktop、Ubuntu-24.04，running 列表为空。没有执行 `-d`、发行版内命令、import、terminate 或 shutdown。

固定且租约绑定的 `docker.exe` 只执行两次以下离线参数，单次上限5秒；config 指向已核 owner 的 D 临时根下原本不存在的随机叶目录，两次查询后仍未创建：

```text
--config <本轮隔离的不存在目录> --context default context inspect default --format {{json .Endpoints.docker.Host}}
```

| 环境字段                                            | exit | 输出                                                       |
| --------------------------------------------------- | ---- | ---------------------------------------------------------- |
| DOCKER_CONTEXT=default，DOCKER_HOST 为空            | 0    | `npipe:////./pipe/docker_engine`                           |
| DOCKER_CONTEXT=default，DOCKER_HOST 为专用 endpoint | 0    | `npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine` |

两次均无 stderr，不读用户 CLI credential、不连接 daemon；本轮独立诊断再次得到 `production_default_compatible=false`。不推断两个地址必然属于不同 daemon，也不修改生产 `docker-config.ts`。

这些分次采样不是一个可消费的原子启动快照，不合成为 native 许可；正式审计仍保留前述失败与 null。审计输入绑定的 source/spec/plan 摘要分别为：

- source：`dc683bd83e4c3ba8d37cc6092f4c80a4dc64b29bbb4e303c0e84b309950aed37`
- spec：`589da841effd265286dc720049a29458b196fc519d74c16904d4129a8168ecf9`
- plan：`e982890a5f3f6334019a76490c9ab681c055399c341095028a7a37761b8f5702`

三项是本次干净提交与四份既有规格/计划的绑定，不是 profile plan/approval hash；新增本报告后工作区有未提交文档，不能复用这些值申请实际操作。

## 五 实际准备清单 尚不可执行

以下是完整的**候选显式写入清单**；兼容门槛、软件修复、准确请求和本会话单独确认均通过后，才允许执行。不会现在创建输入文件、预填许可或消费 nonce。

候选 launchID 固定为 `dl6-native-20261019`。如果将来换 ID、路径、源码或配置，清单和请求必须重出，不能套用此次文字确认。

### 辅助工作区与控制输入

先另批排他建立审计工作区 `D:\OpenCode-Benchmark\Task24\tmp\desktop-native-b101b8defc738767f164f94d22496b24` 及其 `owner.json`。此路径目前不存在；owner 只是工作区标记，不是 approval nonce 或运行权。拟定的 UTF-8 owner 文本为92字节、SHA256 `2ebc32056b2e75bef2782332516aeeedc6fcc30e611450848c1c3a3c224c571e`：

```text
{"kind":"desktop-native-probe","nonce":"b101b8defc738767f164f94d22496b24","schemaVersion":1}
```

helper 的 HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP 与缓存只指向这个已核 owner 的 D 工作区，PowerShell 模块分析缓存使用 NUL；compiler 产生的动态临时文件也只允许在该根内，不能把它们遗漏为“总共只写几个 JSON”。

控制输入位于 `D:\OpenCode-Benchmark\Task24\control\desktop-launch\dl6-native-20261019`：

- `spec.json`：重新计算的源码、四份文档、准确安装、真实 WSL 配置、原注册及两块盘身份。
- `prepare-approval.json`：仅请求 prepare-profile；绑定现场 SID、目标、准确 plan/compatibility hash、新 nonce 和不超过15分钟的有效期。它本身不是许可。

当前 `control` 不存在，因此该部分需新增 control、desktop-launch、launchID 三个目录，排他发布两个输入文件，不覆盖未知目标。

### 专用 profile

根 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479` 不存在，父 toolchain 已存在且为普通目录。profile 准备仍只新增以下12个目录，名称相对该根；点号表示根本身：

```text
.
state
state\grants
home-oc-task24-dd479
home-oc-task24-dd479\AppData
home-oc-task24-dd479\AppData\Local
home-oc-task24-dd479\AppData\Local\Docker
home-oc-task24-dd479\AppData\Roaming
home-oc-task24-dd479\AppData\Roaming\Docker
frontend
cli
temp
```

四个显式文件为 `owner.json`、`state\grants\<新 prepare nonce>.json`、`home-oc-task24-dd479\AppData\Roaming\Docker\settings-store.json`、`manifest.json`。设置文本不含换行，为144字节，SHA256 `101128c61474a7887e18f7f700684e9ad8f15723e2496ef2dd5bf0c6c087a278`：

```text
{"AutoStart":false,"CustomWslDistroDir":"D:\\Applications\\DockerWSL","SettingsVersion":44,"UseWindowsContainers":false,"WslEngineEnabled":true}
```

合计是**16个候选新增目录、7个显式文件**：审计工作区1目录1文件，控制输入3目录2文件，profile 12目录4文件；不含 helper 的动态临时输出和任何 Docker 运行文件。profile 面板中的保守 payload 上限为3145728+144字节，不是整个操作的 NTFS 配额或启动增长上限。owner/grant/manifest 和控制输入的最终字节/hash 需随实际请求核对，当前不能伪造。

执行入口仅为已核 Bun `D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` 加 `--no-env-file`，包目录 `D:\OpenCode-Audit\packages\benchmark` 下的 `script\desktop-launch.ts`，操作 `prepare-profile`、准确的 `--spec/--approval` 路径与 `--interactive`。这里不运行入口；缺项存在时连确认面板都不应索取。

准备确认需展示实际 SID、所有摘要、现场目标/文件身份、准确字节与目录预算；用户在真正本地控制台输入本次完整 PREPARE 短语。Codex 不自动输入、不伪造 TTY。前后预检有漂移则取消，不覆盖、不自动修复。完成后只允许 profile_prepared，立即结束，不启动 Docker/WSL。

## 六 实际启动与收尾清单 尚缺的准确字段

准备完成不产生启动权。将来启动需**再次单独确认**，还必须先完成版本化 native 启动/停止实现与回归；不能只把当前 throw 删除或把 missing 写成 true。

已固定的文件边界是：

- 新控制请求 `D:\OpenCode-Benchmark\Task24\control\desktop-launch\dl6-native-20261019\start-approval.json`。
- 新消费记录 `<profile>\state\grants\<新 start nonce>.json` 与 `<profile>\state\active.json`；仅在准确归属且停止验证完成时移除本次 active，不删除正式 profile/授权账本。
- 最终诊断 `D:\OpenCode-Benchmark\Task24\reports\desktop-launch\dl6-native-20261019\inventory.json`。当前 reports 父目录存在、desktop-launch 不存在，因此将来还需两个报告目录和一个 inventory 文件，排他发布。

启动面板必须补齐以下字段才可请求批准；目前不提供可执行 START 命令：

1. 准确入口候选 `D:\Applications\Docker\Docker Desktop.exe` 的最终 argv。已定位 launcher，但**不将空数组或 --help 当作已审计参数**。
2. 全链路 D 环境与写入位置，包括两个 PINATA override、显式单实例锁、D 用户目录/临时/CLI路径、受控 PATH，以及清空 WSL/E2E、Electron、Docker/TLS/Buildx 等注入。固定 SYSTEM 服务的环境和行为须单独证明。
3. 原注册 GUID、build230596、原 runtime/data VHD fileID/volumeID 和准确数据发现分支；不允许迁移、导入、新盘、复制/挂载旧盘或借试启动探路。
4. 设置初始化/重写、许可、下载/升级、hosts/服务操作、旧容器自动恢复的已批准处理方式。未知项继续阻断；START 短语不豁免。
5. 实际准备后的 manifest hash、SID、plan/compatibility hash、新 nonce 与不超过15分钟有效期；现场无既有 Desktop/backend、相关 VM/WSL 或冲突管道，不能使用本报告里的旧采样代替。
6. 准确 backend API 通道、实际 server PID/创建时间/SID/映像/归属，以及发送时的身份绑定；证明其能在30秒内结束本次 backend/engine/WSL，不只返回 HTTP。不得用 engine pipe、默认 desktop stop、名称强杀、全局 shutdown 或停止既有服务兜底。
7. 启动最多120秒；启动授权同时含本次已归属资源的 finally 收尾。仅限定 version/info/context 与获批的活动盘、UUID、swap、daemon 观察，不发容器/镜像/卷命令，也不是 Linux 验收。
8. 实际运行写入预算与空间阈值。即便成功复用，正常启动也可能写 D VHD 内容和增长 size/mtime；这不是盘数据回滚许可。

成功最多是 inventory_observed_not_accepted；engine_verified、tool_capability_verified、corpus_engine_ready 均保持 false。归属、路径或收尾不明时只记录 cleanup_uncertain 和残留，不强杀、不恢复文件。崩溃后的磁盘历史不恢复 session 或停止权。

## 七 保护对象与本轮交付

部署 EXE SHA256 仍为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`；真实 `C:\Users\Administrator\.wslconfig` 仍为89字节、SHA256 `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`。未修改配置，也未替换部署。

原 runtime/data VHD 的 fileID、volumeID、大小及 mtime 与10月18日报告一致；runtime 为100663296字节，data 为13847494656字节。只读元数据，不读盘内容、不整盘 hash。旧 C 三目录仍为普通目录，按 Node 毫秒精度的 UTC mtime 分别为 `2026-10-06T15:39:42.742Z`、`2026-10-06T15:39:40.865Z`、`2026-10-11T15:41:07.212Z`，与历史同精度记录一致；不将此称为 OS 零写入审计。

本轮只新增这份报告；没有创建真实 control/profile/report 目录，没有修改业务代码，未读取真实 Key、.env.local、CLI credential、许可状态或旧盘内配置。实际执行的是静态读取/反汇编、一次正式 blocked 审计、两次直接元数据定位、两次 WSL list 和两次离线 context inspect，不是零个真实 CLI 调用，也不是 daemon/容器调用。

分析脚本均以内存执行，未下载或解包副本。辅助查询复用已核 owner 的 `D:\OpenCode-Benchmark\Task24\tmp\bprep1-native-cli-20261018-6e9184ab`，没有重试清理此前被策略拒绝的根或旧缓存，不声称这些残留已消失。本轮不重复运行源码全套测试；411通过是上次代码交付证据，不计作此次新增结果。报告保留本地供审阅，未提交或 push。

首次取证提出的 progress 修复现已完成。当前下一步不是试启动，而是审阅设置生命周期、运行期写入清单和旧工作负载风险边界，再完善原生生命周期规则。**当前不请求实际 prepare/start 授权，不以一份笼统确认豁免缺项。**

## 八 修复后的只读复核与清单更正

### 本机复核结果

复核使用提交 `fd3861ba88e846453573b611445fade5c1a6e0b8` 的生产探针源码，没有内存追加 progress 设置、修改 transport、过滤 stderr 或放宽门禁。辅助进程复用已核 owner、祖先路径和可精确表示 fileID 的既有 D 临时叶目录；不创建正式 control/profile/inventory 目录。以下为19:06起的分次只读诊断，不是可用于启动的原子快照或授权。

| 查询                                   | 实际结果                                                                                      | 结论范围                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 固定 Windows 元数据脚本，生产5秒上限   | exit0，stdout857字节、完整 JSON，stderr0字节，耗时1623ms                                      | 进度污染在本机的该次真实查询中已消除                           |
| `queryDesktopWindows` 严格路径         | 元数据、两次固定 WSL list 和身份/编码/盘位检查成功                                            | 完整只读快照可取得，不是 native 启动兼容通过                   |
| 进程与管道                             | 仅既有 SYSTEM 服务PID6488；无 Desktop/backend/VM 角色；三个已检查 engine pipe 均不存在        | 不给既有服务签发本次 session 归属                              |
| WSL                                    | installed 为 docker-desktop、Ubuntu-24.04；running 为空                                       | 未执行 `-d`、发行版命令、import、terminate 或 shutdown         |
| 两次固定离线 `context inspect default` | 均 exit0、stderr0，隔离 config 目录前后均不存在                                               | 无 daemon 连接，不读取旧 CLI credential                        |
| 生产默认地址 / 专用地址                | `npipe:////./pipe/docker_engine` / `npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine` | 独立诊断的 `production_default_compatible=false`，不改生产入口 |

规范模块入口的正式 `auditDesktopCompatibility` 返回 `desktop_compatibility_blocked`，缺项包括七项原生缺项、`cli_default_unproved` 和 `TASK24_DESKTOP_SOURCE_DIRTY`；其 endpoint 与兼容值仍为 null，因为正式路径在源码绑定阶段就已停止。不能用上表独立 CLI 诊断填补这次正式审计的 null。首次 eval 诊断脚本另有一次 `TASK24_DESKTOP_FIXTURE_SCOPE` 拒绝，未取得 native 结果；改用规范动态模块导入后确认工厂来源有效，得到上述源码绑定拒绝。未改生产代码或可信来源登记规则。

工作区的唯一未跟踪文件是本报告。没有移动、删除、暂存、提交该文件，也没有改 ignore、Git index 或源码干净检查以求放行。当前提交树的诊断绑定候选为：

- source：`8c948c64f15e510389ccc78c6504028d070b8bc78821ea1c62602e10b06bf926`
- spec：`589da841effd265286dc720049a29458b196fc519d74c16904d4129a8168ecf9`
- plan：`e982890a5f3f6334019a76490c9ab681c055399c341095028a7a37761b8f5702`

这些只刻画提交树和四份文档，不是当前脏工作区的可信绑定，更不是批准摘要。将来整理文档、调整代码或规格后必须重新计算。

### 设置保存链已定位到准确目标

本次重新读取并核对固定 backend/launcher/ASAR，只作内存解析和有界反汇编，不执行目标程序。backend SHA256仍为第二节的 pin。`settingsloader.New` 将三条路径写入同一 receiver 的不同字段；`saveToFile` 随后按对应字段调用 `jsonutil.WriteFile`：

| receiver字段  | 构造路径与可复查位置                                                                                   | 保存调用位置  | 受控 home 下的运行期候选目标                                                |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------- |
| `+0x28/+0x30` | `New`：`0x141136496–0x1411364ed`，`Home(".docker", "daemon.json")`                                     | `0x141139e03` | `<profile>\home-oc-task24-dd479\.docker\daemon.json`                        |
| `+0x38/+0x40` | `New`：`0x1411364f6–0x14113654d`，`Home(".docker", "windows-daemon.json")`                             | `0x141139ea0` | `<profile>\home-oc-task24-dd479\.docker\windows-daemon.json`                |
| `+0x18/+0x20` | `New`：`0x1411367be–0x1411367f6`，`GroupDir("settings-store.json")`；`0x141136f62/0x141136fcc`传递目标 | `0x14113a020` | `<profile>\home-oc-task24-dd479\AppData\Roaming\Docker\settings-store.json` |

`<profile>`在本报告中固定为 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479`；这些 D 路径以正确传入受控 home 为前提，不构成全部 service/子进程路径已隔离的证明。

进一步的准确调用链为：

1. `loadSettings` 在 `0x141138840–0x141138843` 检查 provider 循环结束并跳向 `0x141138bd5`，随后 `0x141138bd8` 调用 `saveToFile`。这是常规完成加载后的保存路径，不是只有用户手动修改设置才会保存。
2. `jsonutil.WriteFile`（`0x1404a7ec0–0x1404a8300`）调用 Marshal、MkdirAll、CreateTemp 和 Retry；其 Rename 闭包在 `0x1404a8320` 调用 `os.Rename`。存在临时文件替换目标的路径，不能保证原 fileID 恒定；也不将 Windows Rename 称为已证明原子发布。[Go Rename 源码说明](https://go.dev/src/os/file.go)
3. `jsonutil.Marshal` 在 `0x1404a84ed` 调用 `encoding/json.MarshalIndent`，indent为两个空格（`0x144940b10`的两字节是`20 20`）；成功分支在 `0x1404a8585` 追加`0a`换行。

因此，即使五个关键值不变，常规成功保存后的文本也不会等于当前准备阶段“144字节、不带换行”的 canonical JSON。仓库 `profile.ts:199` 起仍同时核对精确文本/hash及已记录的 fileID，`inspection.ts`也绑定原 settings hash。**这是现有运行设置合同与已定位正常保存路径的不兼容，不能通过放松错误检查或接受任意新增字段解决。** 未启动 Docker 来验证实际执行分支，不将静态路径冒充运行轨迹。

需要另行审阅最小设置生命周期设计：将不可变的期望配置/关键安全约束与有界运行设置分开，明确允许的版本化字段、路径、替换行为和写入预算；保留未知字段/路径、关键值变化和外来文件漂移的拒绝。本轮不新增期望配置文件、不改 manifest 或验证算法。

### 其他缺项的新增证据与边界

| 缺项                                 | 本次补实                                                                                                                                                                                                                                            | 仍不能据此关闭的部分                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend_environment_unproved`       | launcher 的 `Job.StartProcess`（`0x1405cfb80–0x1405d0100`）在 `0x1405cfead`清零RBX，`0x1405cfebc`将其传入 CreateProcess 的 environment 实参，`0x1405cfeca`调用；结合 Win32 NULL environment 语义，支持该新 backend 进程继承 launcher 环境的静态推断 | 既有 SYSTEM 服务、frontend、其他辅助子进程和后续环境修改并未全部证明；不登记全链路已通过。[CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) |
| `path_routing_unproved`              | 补出上述`.docker`目录及两个设置目标；重新核对两个 home override、前端 userData/crash 路径和未加前缀的 modules pipe                                                                                                                                  | 全部日志、更新、服务和辅助程序写入闭包仍未齐全；额外目标不能遗漏为“只写一个设置文件”                                                                                                                                  |
| `registration_reuse_unproved`        | 本机 GUID、build230596和两盘身份匹配；`distroUpToDate`（`0x141374040–0x1413742c0`）存在构建差异/注册读取失败时强制 re-import 的分支；`createDataDisk`在`0x141377c0a`调用createVHDX                                                                  | 前提匹配不等于当前完整配置下必定跳过创建/迁移；不挂载或读取旧盘、也不试启动                                                                                                                                           |
| `stop_owned_unproved`                | `QuitDockerDesktop`在`0x143044160`启动goroutine；func1还有间接回调、timer/select、栈输出分支                                                                                                                                                        | 没有完整的backend/engine/WSL停止证明和当前live session，不能把HTTP完成当作停止完成；不连接候选管道                                                                                                                    |
| `automatic_behavior_unproved`        | ASAR的`useSoftwareUpdateSettingsDefinition-CMm-PqDk.js`分别列自动检查、后台下载、无重启组件更新三项；模块hash为`21eccd18701c380a6f7516e07b77b4ea2a4899754b0ae65d638d81aa3b4d20e3`                                                                   | 只证明开关相互独立，不推断本机默认值；现有五字段设置不能证明全部禁下载、禁服务/hosts写入或许可行为                                                                                                                    |
| `existing_workload_restart_unproved` | 官方restart policy说明已重新核对；`always`可在daemon重启后恢复，即使此前人工停止                                                                                                                                                                    | 不读取旧盘内容或启动daemon，就不能从安装文件证明旧容器策略；`AutoStart=false`和START短语不解决此问题。[Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)            |

旧盘工作负载是当前权限下无法关闭的实质边界：若没有独立、可信且适用当前原盘的无自动恢复证据，需要另行讨论允许的取证/风险范围。本报告不批准挂载、读盘内配置、启动后再查、改容器策略或改用新空引擎。纯静态安装扫描不能替代这个决定。

### 准备和启动清单的准确状态

第五节的16个目录、7个显式文件仍是**未调整软件的准备阶段候选清单**，不是完整启动写入清单，也不是目前可执行方案。其正式目标当前均不存在。设置生命周期如改版，新增期望文件、manifest字段、目录预算和确认面板必须一起重出；不沿用旧计数申请批准。

已补入运行期清单的具体新增目标是：

- 目录：`D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479\home-oc-task24-dd479\.docker`。
- 文件：该目录的`daemon.json`、`windows-daemon.json`。
- 运行写入/替换：第五节原有的`home-oc-task24-dd479\AppData\Roaming\Docker\settings-store.json`。
- 上述保存链会产生同目录临时文件及重命名；准确命名模式、数量和总增长预算尚未全部闭合，不编造完整列表或声称只有两个新文件。

实际执行前的顺序应为：

1. 先审阅设置生命周期/写入范围和旧工作负载风险的处理边界，补齐余下路径、复用、自动行为与作用域正确的停止证据。保持现有native start/stop和启动面板显式拒绝；启停实现仍需另批软件工作和回归，不能只删throw。
2. 验证后整理并正常提交必要源码/规格/计划/报告，重新获得干净工作区绑定。本轮只更新本地报告，不提交或push；文档文件不是启动许可。
3. 向用户重新展示准备清单：准确审计工作区、control输入、所有profile目录/文件、字节/空间预算、安装/文档/源码摘要、原注册/盘身份和现场SID。新目录的fileID须能被现有精确身份比较接受；不得跳过上轮发现的编号精度拒绝。获得本会话单独批准后，才可准备审计/控制输入，再经本地PREPARE短语核对、消费新nonce；成功后结束，不启动。
4. 准备成功后，另出启动清单并再请用户确认：准确launcher/argv、完整D环境和写入预算、实际manifest与新请求摘要、pipe owner/归属和完整停止方法、120秒启动/30秒收尾、准确inventory输出路径。现在尚无这些字段的完整有效值，**不提供可执行START命令**。
5. 即使将来获准启动，仍仅做限定只读观察与本次已归属资源收尾，不创建容器，不做Linux验收或付费跑分；三个readiness保持false。任何漂移、许可/管理员/下载要求、迁移/新盘、意外工作负载或归属不明均停止继续操作，不强杀、不回滚旧数据。

准备和启动是两次独立授权；当前只能审阅上述证据及更正清单，不能请求用户用一份宽泛“确认”豁免未满足的门槛。

### 保护对象和交付核对

本次实际重读的五个安装身份/hash与第二节一致；componentsVersion仍为Desktop4.79.0.230596、CLI29.5.3。部署EXE、真实`.wslconfig`的fileID/hash/size/mtime，以及两块VHD的fileID/volumeID/size/mtime均未变化。VHD只作元数据比较；Bun与Node的mtime末位显示可能相差1ms，采用同API复核相等，不作恢复。旧C三目录未迁移、删除或写入；普通元数据相等不冒充OS零写入审计。

生产源码、测试、规格和计划均未修改；未重跑全套测试，也不把上轮414通过、10跳过或pre-push31项作为本次新增验证。本次验证依据是上述真实只读命令及文档检查。没有读取Key、`.env.local`、用户CLI credential、许可状态或旧盘内容；没有运行Desktop/backend/服务目标程序、daemon API、容器命令或Linux验收。

分析与辅助脚本均在内存执行，没有新增下载、解包副本、脚本或日志文件。复用上轮残留的`D:\OpenCode-Benchmark\Task24\tmp\bprep1-native-progress-20261019-5f492ac1\probe`；有界PowerShell编译器仍会留下空临时子目录。该根此前清理被策略拒绝，本轮不重试，也不通过逐文件删除绕过；既有约5.3MB残留继续保留。最终交付仅更新本地本报告，实际准备/启动、真实验收、付费跑分和部署替换均未执行。
