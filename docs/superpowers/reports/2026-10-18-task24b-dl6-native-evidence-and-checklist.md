# Task24B DL6 原生兼容证据与准备启动清单

2026-10-18，Asia/Shanghai。基线 `dev` / `454e442544d8a49ee6b828464a1373fc11caa39b`。用户仅批准先补原生兼容证据、列准确清单；**真实档案准备、修改设置、Docker/WSL 发行版启动与停止仍待另行确认**。Linux 验收、校准、付费、部署替换不在授权内。

结论：补实了固定 CLI 的离线连接语义、WSL 名称选择及注册构建号前提，但**整体原生兼容仍 blocked，尚不能签发一份已证实安全的启动命令**。已定的文件准备清单见第五节；启动清单中的未决门槛见第六节，不用试启动填补证据。

## 一 兼容结论

| 项目         | 本次可证明的事实                                                                                                                          | 尚未关闭的门槛                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 安装身份     | Desktop `4.79.0.230596`、CLI `29.5.3`，两个既有 pin 与五个安装文件实际身份均核对                                                          | 后续操作前必须重新核对，不能沿用本次时点作授权                                                   |
| CLI/default  | 两次准确 CLI 离线查询成功；原生产 Docker 连接字段解析到 `docker_engine`，专用字段解析到带 home 前缀的管道                                 | 地址不一致，现有严格 default 合同不能视为通过；没有测 daemon 身份，不推断它们必然对应不同 daemon |
| 原注册与构建 | `docker-desktop` 注册和两块 D VHD 存在；注册与安装资源的 build number 都为 `230596`；未继承 WSL 测试环境时，名称函数返回 `docker-desktop` | 名称和构建号一致是复用前提，不等于完整证明新档案启动不会走重导入、磁盘创建或迁移分支             |
| 路径         | 前端的 local/roaming/crash/userData 与命名管道规则可定位；后端自身也读取 home override                                                    | 启动器到所有子进程的环境传递、服务/更新/辅助程序及所有缓存落点仍未完整证明                       |
| 单实例与停止 | home override 默认绕过前端单实例锁；找到经后端 API 发起退出的候选链                                                                       | 当前派生启动环境未显式启用该锁；候选退出链尚未成为已核验归属与资源范围的 native stop 实现        |

这些是逐项证据判断，不是进程内能力或可反序列化的许可。源码 `platform.ts` 的 native 工厂目前仍保守返回缺项，`observe/start/stop` 也仍显式拒绝。本次不靠文档把它们改成可执行实现。

## 二 本机安装和数据身份

文件均为准确路径、普通文件、单硬链接，实际路径与声明一致。下表 `fileID` 沿用现有代码的 `dev:ino:birthtimeMs` 表示法，并非新创的权限令牌；D 盘 volume ID 为 `2162922028`。

| 对象与准确路径                                                 | SHA256                                                             | fileID                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| 启动器 `D:\Applications\Docker\Docker Desktop.exe`             | `d079706dcb13555ad6e51e04e0f0507f475de5ebb79ac31cf85986d8902e31bc` | `2162922028:844424930151848:1782392158481.433`  |
| 前端 `D:\Applications\Docker\frontend\Docker Desktop.exe`      | `86d8ea314a56cfee849d666f2cac60f07aeb7937632e7fe005d642ad04be2771` | `2162922028:844424930151860:1782392158718.499`  |
| 后端 `D:\Applications\Docker\resources\com.docker.backend.exe` | `2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd` | `2162922028:562949953441327:1782392167112.4827` |
| 资源 `D:\Applications\Docker\frontend\resources\app.asar`      | `607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada` | `2162922028:844424930151876:1782392160973.1448` |
| CLI `D:\Applications\Docker\resources\bin\docker.exe`          | `7bc66b018b9da43fea986f893288bb93970d3d1217f5063201fd97c827f20732` | `2162922028:562949953441307:1782392162018.1116` |
| 既有服务 `D:\Applications\Docker\com.docker.service`           | `5ba942808db6b1ebb32dd9f940d61f27e36322362fb8fe0d794c89f8b6a0d4bf` | `2162922028:844424930151835:1782392158386.837`  |

安装资源 `resources\componentsVersion.json` 的 SHA256 为 `8e1ea0564f06432d37853880188ea838fcd59b2ed751861fc933afb0e54ca233`，给出 `appVersion=4.79.0`、`buildNumber=230596`、`dockerCLIVersion=29.5.3`。这些是安装资源值，不是活动引擎实测。

| 对象            | 实测值                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册位置        | `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{df0675a2-c53b-4596-b91e-bbc3eb2eef63}`                                                              |
| 注册字段        | `DistributionName=docker-desktop`，`BasePath=\\?\D:\Applications\DockerWSL\main`，`VhdFileName=ext4.vhdx`，`Version=2`，`DockerDesktopBuildNumber=230596` |
| runtime VHD     | `D:\Applications\DockerWSL\main\ext4.vhdx`，fileID `2162922028:3940649673950210:1782392352710.1821`，100663296 字节                                       |
| data VHD        | `D:\Applications\DockerWSL\disk\docker_data.vhdx`，fileID `2162922028:1125899906862401:1782392356625.817`，13847494656 字节                               |
| 真实 WSL 配置   | `C:\Users\Administrator\.wslconfig`，fileID `1291369136:8444249301553698:1792291141480.1887`，89 字节，`swap=0`                                           |
| WSL 配置 SHA256 | `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`                                                                                        |
| 只读状态查询    | 固定 `C:\Windows\System32\wsl.exe --list --verbose` 退出0；`docker-desktop`、`Ubuntu-24.04` 均 Stopped、版本2                                             |
| 既有后台服务    | `com.docker.service` 已在运行，PID `6404`，启动于 `2026-10-18 10:24:06 +08:00`，StartMode=Auto；不是本次启动或本次可停止的资源                            |
| 进程观察        | 没有 Desktop 前端、backend、vmmem 或 wslhost 进程；既有 WSL/计算系统服务不被当作发行版运行证明                                                            |
| D 盘空间快照    | NTFS，采样可用 233081221120 字节，约217 GiB；不是将来操作的空间保证                                                                                       |

VHD 只读了文件元数据，没有读取盘内数据、整盘 hash、挂载、复制、重置或更改注册。Registry 的 State 字段没有被当作发行版运行状态，运行状态取自上述 list 查询。

## 三 安装资源的静态证据

### 前端路径与单实例

只在内存解析 ASAR，没有解包副本，也没有运行包内 JavaScript。固定 ASAR 的数据起始偏移为 `282980`，包含1052个条目。定位偏移为解码后 JavaScript 字符串的零基偏移，不与原始整个 ASAR 的字节偏移混用。

- `build/entry-cli.main.js`，SHA256 `3998a5b748667b5bd51fe73d3b113de9dc9d31ebc144b5b95c62413201c5f32b`：约 `991` 的 home override 分支、`1908` 的前缀引擎管道、`8392` 的 Electron userData 设置、`8471` 的 crashDumps 设置均可定位。local/roaming 由 home 拼出，前缀由 basename 得到。
- 同一模块的 Windows `dockerHost` 返回函数约 `3273` 仍使用不带 home 前缀的 `dockerDesktopEngine`；不能从“某个 socket 已带前缀”推导所有内部客户端都带前缀。
- `build/onlyAllowSingleInstance.main.js`，SHA256 `ed2277acdafb0891a3b6d93599738a3ae5fc909a8bc2123018816c67d830027d`：约 `490–690` 的条件在设置 home override 且未显式设置 `PINATA_SINGLE_INSTANCE_LOCK=true` 时可以直接放行，不调用 Electron 单实例锁。
- 当前 `profile.ts` 派生环境没有该显式锁字段。后续最小补丁应评估并测试它，而不是现在修改真实环境；它只能防同一档案重入，不能替代全机既有 Desktop/WSL 冲突核查。
- `build/entry-main.main.js` 约 `42204` 的 `quitDockerDesktop()` 请求后端 `POST /app/quit`。只找到候选控制路径，不据此向真实管道发送请求。
- Electron 的用户数据、session 数据、日志及崩溃路径是不同路径类别；不能把一个 override 当成完整覆盖证明。[Electron app 文档](https://www.electronjs.org/docs/latest/api/app)

### 后端名称与重导入风险

仅静态读取已 pin 的 PE。Go `objdump` 因该 PE 缺少 `runtime.pclntab` 符号而失败，没有据失败结果推断兼容。随后按已安装 Go 的 `pcHeader/_func/functab` 结构定位 PE 中的 pclntab，再用已有 GNU objdump 对准确地址区间反汇编；没有运行目标 Docker 二进制。PE ImageBase 为 `0x140000000`，pclntab 文件偏移 `88651968`，172219个函数。

- `common/pkg/paths.init.func1`，VA `0x14048db80–0x14048dbc0`：调用 `os.LookupEnv` 读取 home override，缺失时才调用 homedir.Get。这证明后端本身包含该读取分支，**不证明启动器确已把变量传给全部子进程/服务**。
- `common/pkg/paths.distroName`，VA `0x140490a60–0x140490ae0`：读取 `WSL_DISTRO_NAME`，仅其值含 `e2e` 时使用该值；否则返回 `docker-desktop`。home override 不在这个名称选择函数中。今后最小环境须不继承 WSL/E2E 注入。
- `win/backend/wsl/distro.subkeyIsMainDistro`，VA `0x141374f40–0x141375220`：读取注册 `DistributionName`，与静态全局 `docker-desktop` 比较。
- `mainDistroState`，VA `0x1413743e0–0x141374740`：读取 `DockerDesktopBuildNumber`。`distroUpToDate`，VA `0x141374040–0x1413742c0`，包含构建号不一致/注册读取失败时强制重导入的分支。当前构建号一致关闭了一个具体风险前提，**没有证明所有其他初始化/迁移分支都不会执行**。
- `handlers/app.(*Handler).QuitDockerDesktop`，VA `0x143044100–0x1430441c0`，及其回调 `0x1430441c0–0x143044320`：候选退出链为异步处理，仍需核查其完整 engine/WSL 收尾范围、pipe owner 和超时行为。不能以 HTTP 已返回替代确认进程与资源已停止。

官方资料说明 WSL2 后端不总是依赖 privileged helper，而该服务也可用于 hosts 文件等系统操作。本机服务已运行不能证明会继承本次 D 档案环境，也不能据此擅自停服务、重配服务或写 hosts。[Docker Windows 权限说明](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/)

## 四 真实离线 CLI 查询与程序门禁

执行文件为第二节已核 hash 的准确 `docker.exe`。工作目录和 HOME/USERPROFILE/APPDATA/TEMP 均隔离到本计划 D 盘审计目录，没有读用户 `.docker/config.json` 或 credential。`--config` 指向原本不存在的 D 路径，查询前后均不存在，未创建配置目录。

两次只执行以下参数；没有 `version`、`info`、`desktop start/stop` 或容器命令，也没有连接 daemon：

```text
--config D:\OpenCode-Audit\.superpowers\sdd\2026-10-18-task24b-d-drive-docker-launch\dl6-empty-cli --context default context inspect default --format {{json .Endpoints.docker.Host}}
```

| 连接字段                                                                                         | exit | 输出 Host                                                  |
| ------------------------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------- |
| `DOCKER_CONTEXT=default`，`DOCKER_HOST` 为空                                                     | 0    | `npipe:////./pipe/docker_engine`                           |
| `DOCKER_CONTEXT=default`，`DOCKER_HOST=npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine` | 0    | `npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine` |

这重现了生产 `invocationEnvironment()` 的 Docker 连接字段与专用 runner 字段；为隔离配置额外使用等价的全局 `--config/--context` 参数和 D 临时路径。没有运行生产宿主或证明 A 组通过。CLI 查询前后 SHA256 不变。context/环境覆盖的一般语义见 [Docker contexts](https://docs.docker.com/engine/manage-resources/contexts/)。

还在仅内存生成的诊断输入上实际调用了现有 `auditDesktopCompatibility(..., makeWindowsDesktopPlatform())`，经过真实文件身份/安装 pin/WSL 配置验证后得到：

```json
{
  "kind": "blocked",
  "code": "desktop_compatibility_blocked",
  "missing": [
    "backend_environment_unproved",
    "registration_reuse_unproved",
    "stop_owned_unproved",
    "path_routing_unproved",
    "cli_default_unproved"
  ]
}
```

诊断输入绑定：Git tree `83443e58ce79f77d6923dc6446c91d1a1aa2d810`，`sourceSha256=SHA256(UTF8("git-tree:" + treeOID))` 为 `149fc4447868291d5daa8d1c59fe5145e61580f0c53b817654e3022d2432237b`；规格文档 SHA256 `169b4469017452b0c32963286d8582d2ac37eac9df6e586c9810ec92448a799d`，计划文档 SHA256 `efa858fbba6d5c371c314448ec08a4182a9b6b527af293d46ea3d4eca6db6578`。注册身份字段使用本次读取的 key GUID，不制造磁盘 fileID。该输入未保存为控制文件、未产生 plan/manifest 或授权；后续代码或文档变化后必须重新生成。

程序仍列 `cli_default_unproved`，是 native 工厂尚未接入本次离线证据，不是本报告把 CLI 查询失败藏掉。当前观察/启动/停止适配、可信确认入口也未完成；单独调用独立脚本并塞授权 JSON 仍被拒绝。

## 五 准备清单 等待单独确认

以下是已确定的**候选发布内容**，不是当前可以绕过门禁执行的操作。须先补齐原生适配与证据，再重新给出本机 SID、准确 plan/compatibility hash、一次性 nonce、有效期和操作范围的确认。

诊断根由原规格固定为 `D:\OpenCode-Benchmark\Task24\reports\desktop-launch\<launchID>`。现有命令只返回 stdout 结果，尚未自动写出 inventory；控制输入、确认凭据和最终诊断的具体文件/新增目录及精确字节须随确认入口一起定稿，再纳入用户实际批准清单。下面4个文件只是档案内部的显式准备写入，不冒充全部运行写入清单。

1. 再核对安装/源版本、真实用户、原注册、两块盘的身份、旧 C 目录元数据和真实 `.wslconfig`。没有运行中的 Desktop/后端或 WSL 发行版；已有系统服务不接管、不停止。
2. 核对准确父目录与目标无链接、无同名他人目录；只在 `D:\OpenCode-Benchmark\Task24\toolchain\docker-launch-dd479` 下排他创建12个目录：根、`state`、`state\grants`、home、home 下 AppData/Local/Docker/Roaming/Docker 共五个节点，以及 `frontend`、`cli`、`temp`。总数包含根和 home。
3. 准备阶段只显式发布4个文件：`owner.json`、`state\grants\<prepare-nonce>.json`、下述 `settings-store.json`、`manifest.json`。不从 C 复制登录、许可、credential、扩展或用户配置，不创建或导入 CLI context。
4. 设置准确位置为 `home-oc-task24-dd479\AppData\Roaming\Docker\settings-store.json`。当前五字段候选 UTF-8 内容如下，**不含换行为144字节**，SHA256 `101128c61474a7887e18f7f700684e9ad8f15723e2496ef2dd5bf0c6c087a278`：

   ```text
   {"AutoStart":false,"CustomWslDistroDir":"D:\\Applications\\DockerWSL","SettingsVersion":44,"UseWindowsContainers":false,"WslEngineEnabled":true}
   ```

5. owner、授权记录和 manifest 还含准备时实际生成的身份，因此目前不能给它们伪造最终 hash。JSON 文本预计数 KiB，实际 NTFS 分配还含目录和分配单元；准备前再报准确发布预算。此量不包括日后 Docker 自身日志、缓存或既有 VHD 增长。
6. 只确认 prepare 时，完成后即停止，不启动任何 Desktop/发行版，不执行安装、服务调整、全局环境或 PATH 修改。结果只能是 `profile_prepared`，不是引擎就绪。

上述目录的五个 home 下节点为 `AppData`、`AppData\Local`、`AppData\Local\Docker`、`AppData\Roaming`、`AppData\Roaming\Docker`。准确 home 为 `home-oc-task24-dd479`。本轮没有创建上述真实根。

## 六 启动和停止清单 尚不具备请求启动确认的条件

在下列缺项关闭前，不提供可执行启动命令、不请求“带缺项试一下”的启动授权。唯一待核候选入口是准确安装的 `D:\Applications\Docker\Docker Desktop.exe`；其最终 argv、子进程环境传递及控制通道仍需 native 适配证明，不能把空参数当作已审计结论。

1. **原生观察/启动/停止适配与确认入口**：当前 native 方法仍拒绝。先用最小软件补丁和无 Docker 回归接入真实证据、准确进程/pipe 观察及可信确认，不把普通 JSON 当许可。source/plan/compatibility 变更后重新计算 hash，旧诊断输入作废。
2. **完整路径和子进程环境**：现有派生环境设置两个 override、D HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP/DOCKER_CONFIG，清空 Docker endpoint/TLS/Buildx 等外部覆盖，只保留准确 Windows 路径。还须补证 frontend/native child/service/updater/缓存落点、真实 C `.wslconfig` 的读取来源，以及设置文件初始化/重写与不可变 manifest 的协调。不能把未知应用写入算作 OS 例外。
3. **单实例和应用自动行为**：显式锁的候选最小环境增量 `PINATA_SINGLE_INSTANCE_LOCK=true` 尚未改代码或配置，必须先验证；它不能代替已有实例检查。`AutoStart=false` 也没有被当作禁止自动下载、后台初始化或容器恢复的总开关。遇到首次许可/onboarding/UAC/下载要求停止，不自动同意或升级。
4. **原盘无初始化复用**：除当前名称/构建前提，还要关闭真实新档案下的 disk discovery、monodistro migration、CreateDisk/re-import 分支风险。不能挂载或复制旧 VHD 来试验，更不能把新建空盘当作复用成功。
5. **旧工作负载自动恢复风险**：Docker 的 `always` 等重启策略可在 daemon 重启时恢复既有容器；未发容器命令并不构成不会启动容器的证明。当前没有读取旧盘内的容器配置，不能保证没有该策略；不擅自改策略或删旧容器。如果不能在现有权限下证明无自动恢复风险，需先向用户说明并另议边界，不能把它隐藏在“只读启动”中。[Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)
6. **单独 start/stop 授权**：准备完成后，用户再次确认真实 manifest/plan/compatibility hash、SID、原盘身份、准确启动/停止方式和空间预算；最长15分钟、nonce 单次消费，不沿用历史额度或其他操作许可。新启动显式增加 start nonce 和 `state\active.json`，应用运行日志/缓存只能落已审核 D 路径。启动空间增长暂不能可靠量化，不承诺144字节设置文件就等于整体新增量。
7. **获准后的固定观察**：隐藏启动准确入口，最多120秒；仅固定 CLI `context inspect/version/info` 和受控的 pipe/注册/活动盘/effective swap 查询，不拉镜像、不运行题目或容器。只对确认已运行的 `docker-desktop` 进行获批只读查询，防止查询变成暗中启动。安装和两个 VHD 身份必须仍一致；真实 swap、实际数据盘/UUID/daemon 绑定只能届时观察，不能从文件存在推断。
8. **准确收尾**：用已审计的本次控制通道结束本次完整身份匹配的实例，30秒上限，并确认 backend/归属资源真的停止。`/app/quit` 只是候选，不能现在发送；禁止默认 `docker desktop stop`、按进程名强杀、全局 WSL shutdown、停既有系统服务、删盘或注册。归属或停止不确定则报告残留，不强杀未知资源。
9. **验后状态**：确认旧 C 目录、注册和 VHD 身份仍在；允许经授权正常启动造成 D VHD 内容/size/mtime 变化，不做数据回滚。保留正式档案和诊断，清理仅本任务临时物。最终只能是 `inventory_observed_not_accepted` 或 blocked/cleanup_uncertain，三项 readiness 仍 false。

官方 [desktop start](https://docs.docker.com/reference/cli/docker/desktop/start/) / [desktop stop](https://docs.docker.com/reference/cli/docker/desktop/stop/) 提供一般启停命令，但不足以证明本项目内部 home override 的作用域；不能据此绕过上述缺项。WSL 配置在 VM 启动时生效，现有文件 `swap=0` 不替代有效 swap 观察。[WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)

CLI 地址不匹配还会阻断后续生产默认接入/A组验收；这不授权修改生产 `docker-config.ts` 或放宽 endpoint 合同。它与“将来能否仅运行专用档案观察”分开处理，不捏造整个方案无意义或已经可用的结论。

## 七 本轮边界和下一步

本轮只有安装/元数据/注册/进程/静态资源核查、两次离线 CLI context inspect、一次 WSL list 和一次内存 native audit；未读取真实 Key、`.env.local`、用户 Docker credential 或盘内数据，未执行 Desktop/后端的 help。没有实际 prepare、启动/停止、真实验收、模型调用或部署变化。

部署 EXE SHA256 仍为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`。旧 C 盘 Local/Docker、Roaming/Docker、Roaming/Docker Desktop 的 UTC mtime 仍分别为 `2026-10-06T15:39:42.7418802Z`、`2026-10-06T15:39:40.8646486Z`、`2026-10-11T15:41:07.2115588Z`；元数据一致不是 OS 级无写入审计。

下一步先解决第六节的软件/兼容缺项，再重新提供可批准的 prepare 清单；准备完成后另行提供 start/stop 清单。**当前不要求用户批准真实启动，也不将 DL6 标为完成。** 本报告保存在仓库既有报告目录，未修改业务代码；消费和部署许可不因证据调查而扩张。

本轮验证是六份安装文件 hash 重核、候选设置字节/hash 核对、真实离线命令与 native audit 的结果核对，以及 Markdown 格式/差异检查。没有业务代码改动，未重复运行源码全套测试；此前375项通过不是本轮新增验证结果。本报告尚未提交或 push，供确认后续方向时审阅。

本轮工具缓存均在 D 盘现有任务工作目录内；准确归属、解析路径及无 reparse point 已核对。三个新缓存子目录的删除命令仍被执行环境策略拒绝，未换接口绕过，暂留约77.3 MiB：

- `D:\OpenCode-Audit\.superpowers\sdd\2026-10-18-task24b-d-drive-docker-launch\dl6-go-cache`：Go 静态分析工具构建缓存。
- `D:\OpenCode-Audit\.superpowers\sdd\2026-10-18-task24b-d-drive-docker-launch\go`：该工具的本轮用户数据。
- `D:\OpenCode-Audit\.superpowers\sdd\2026-10-18-task24b-d-drive-docker-launch\bun`：内存审计加载本地模块时的缓存。

先前报告披露的两棵测试临时根与本计划工作日志也没有删除；本次不把旧残留称作已经清理。没有额外解包副本、下载文件、临时启动档案或可执行启动脚本。

本轮决策：将原生兼容前提、真实活动证据和软件实现状态分开；未知项不升格为通过，代价是仍可能需要最小适配补丁或另议路线。默认地址差异只按现有严格合同记录，不改生产连接，代价是后续接入仍需单独设计。仅授权证据阶段，代价是必须再确认准备/启动，不能用已完成文档代替环境结果。

后续状态 2026-10-18：用户已确认采用交互式 CLI，并要求先写[原生适配与确认补充规格](../specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md)供审阅。本报告保留证据阶段当时的观察与授权记录，不代表当前软件已经补齐；真实准备和启动、验收、付费及部署仍未授权。文中的“尚未提交”是报告形成时状态，后续文档提交不改变其证据范围。
