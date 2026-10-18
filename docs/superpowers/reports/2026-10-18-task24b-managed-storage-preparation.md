# Task24B：Docker 4.79 managed-VHD 适配与环境准备检查

日期：2026-10-18。源码基线 `60d4f4e4667ab866d334985da028031362f5ab4f`，直接在既有 `dev` 上修改。用户已确认：先软件与无 Docker 回归，再配置 WSL、启动既有 Docker 做只读检查；必要配置可放 C，数据和新缓存须留 D；不重装、不迁移或删除既有数据，不做真实验收、付费跑分或部署替换。

## 结果与边界

- 软件适配和无 Docker 回归通过；这不是实际 managed-VHD 已通过的证明。
- 已新建 `C:\Users\Administrator\.wslconfig`，仅 `[wsl2]` / `swap=0` 及说明注释；创建前不存在，未覆盖用户文件。SHA256：`6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`。
- `.wslconfig` 全局作用于 WSL2，包括 Ubuntu；禁用 swap 会失去磁盘换页缓冲，未改变 CPU/内存配置。本轮未关闭任何运行中的发行版。
- **Docker 未启动。** 启动前发现既有 Docker 日志/缓存/界面状态仍在 C 盘，且安装包的部分路径直接从用户主目录推导；改变 `LOCALAPPDATA` 不足以证明新写入都落 D。按照已批准的“无法在不迁移、不删除条件下保证就停止”规则，停止在启动之前。
- 真实 daemon/有效 swap/活动 backing device 核查未运行；真实验收、校准、模型调用均为 0。四项 readiness 中，仅软件验证成立，后三项仍 false。
- 未读取 API Key、`.env.local` 或用户 Docker credential 配置。只读取 Docker Desktop 设置中的存储/版本字段及安装包公开程序内容，不把完整用户设置保存到报告。

## 软件变化

仅修改 `packages/benchmark/src/sandbox/storage-source.ts`，新增 `test/linux-host/managed-storage.test.ts`；不改 Host StorageProof 对外结构、旧视觉流程、租约/重试/预算算法或部署入口。

1. 显式新增 `desktop-wsl-managed` 分支，限定实际安装的 `4.79.0` / settings format 44；保留旧 `desktop-wsl-legacy` 分支的版本限制，其他版本和未知布局继续 blocked。
2. 读取真实用户 profile 下的 `AppData\Roaming\Docker\settings-store.json`，采用实际 `CustomWslDistroDir` 字段；过滤无关值，限制大小，拒绝链接、路径冒用及读取漂移。配置变更将使身份失效。
3. 绑定当前 pipe owner / SID / 后端程序版本、活动 `docker-desktop` 注册、实际数据与运行时 VHD 身份、有效 swap 状态；Docker 设置和 `.wslconfig` 都必须早于后端启动且读取稳定。
4. 不能仅以 VHD 存在或 Attached=true 代替实际 backing device。新增固定只读观察链：指定 D 盘 VHD 的 Windows 物理设备前 2048 字节 → ext4 superblock UUID；活动 dockerd 的实际数据 mount/device → 同 namespace 的文件系统 UUID；同时用其 `engine-id` 与实际 Docker API 的 server ID 绑定。UUID/ID 不匹配或观察不全都拒绝。
5. 上述原生链**尚未运行**。它要求 Get-DiskImage 提供可只读访问的实际物理设备、whole-disk ext4 布局，以及 VM 内可用的 mount/blkid/nsenter 观察；不满足时 blocked，不使用猜测路径、额外挂载、镜像下载或普通 native 后备。

## 验证证据

可信 Bun：`D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe`。所有测试使用 `--no-env-file`，临时 HOME / XDG / APPDATA / TEMP / Bun/npm 缓存位于本轮新建 D 盘 owner 根；清除 provider 凭据及真实 integration 开关，不触发真实 Docker。

- 初始基线有 3 项子进程启动失败：`independent/author`、`linux-host/dependencies`、`linux-host/docker`。证据为 `Bun.which("bun") === null` 和退出 127，原因是本轮临时 PATH 漏了固定 Bun。仅修正临时环境，相关 13 项通过；未改业务代码、断言或时限。
- 新 managed-storage 六项测试：6 pass / 0 fail / 38 assertions。包括实际临时文件系统路径别名/修改、未使用的附加磁盘 UUID、错误 daemon ID、启动后配置、未知版本，以及真实 PowerShell parser 解析生成脚本（不执行脚本）。
- 完整包回归，cwd `D:\OpenCode-Audit\packages\benchmark`：`bun --no-env-file test --timeout 30000 --only-failures` → **345 pass / 10 原有 skip / 0 fail / 1412 assertions / 91 files**。
- 包内 `bun --no-env-file run typecheck` → 0。
- 额外临时 tsconfig 纳入全部源码、Linux 测试及三个脚本入口，包内 `typecheck --project` → 0。期间修正一个测试夹具的数字字面量类型和一次声明顺序错误，未放宽断言。
- 独立只读审查一次，0 Critical / 2 Important / 0 Minor。两个 Important（活动 backing disk 绑定、WSL 配置启动时序）均经历 RED→GREEN 修复，然后全套回归通过；未重复派发审查。

## 只读环境事实与启动阻断

Desktop 文件版本 `4.79.0.230596`，CLI 文件版本 `29.5.3`，现有设置 `SettingsVersion=44`、`CustomWslDistroDir=D:\Applications\DockerWSL`。

注册路径与文件存在性已只读观察到：

- `D:\Applications\DockerWSL\main\ext4.vhdx`
- `D:\Applications\DockerWSL\disk\docker_data.vhdx`

它们不是“该 daemon 正在使用这些文件”的实测证据。Docker/Ubuntu 在核查时均 stopped，没有为调查而唤醒它们。

以下三个既有 C 盘目录均为普通目录而非 D 盘链接，内容未移动、重命名、删除或覆盖：

- `C:\Users\Administrator\AppData\Local\Docker`：日志与运行状态。
- `C:\Users\Administrator\AppData\Roaming\Docker`：既有设置与其他状态/缓存。
- `C:\Users\Administrator\AppData\Roaming\Docker Desktop`：已有 Cache / Code Cache / GPUCache 等。

只读检查固定版本安装包表明：frontend 的用户目录路径函数从主目录拼接上述 local/roaming 路径；`PINATA_USER_DATA_DIR_OVERRIDE` 仅改变 Electron userData，并不能证明所有 Docker 后端路径已改变；更广泛的 home override 还会改变配置和命名管道命名空间，不能直接当成原配置的无副作用替代。

安装包核查身份：

- frontend `resources\app.asar`：`607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada`。
- `resources\com.docker.backend.exe`：`2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd`。

继续启动前，需单独确定用户允许的 Docker 日志/缓存重定向方式；不能自行迁移既有目录，也不能冒险启动后再清理 C 盘写入。未因此改动系统用户目录、账户、ACL、防火墙、全局环境变量或 Docker 的既有配置。

## 留待后续的事项

- 安装版本上的原生活动盘位观察兼容性、有效 swap、daemon/context 身份仍需启动后的只读核查；证据不完整时不就绪。
- 真实引擎矩阵、准确程序/浏览器能力和 120 项校准仍未运行；合成测试不代替这些门槛。
- WSL 配置是本轮应保留的必要配置；所有自建测试日志、helper、临时工作区和任务缓存在最终代码验证后按精确 owner 清理。保留用户原目录、VHD、工具链和其他任务材料。
- 现有部署 SHA256 仍为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`。提交、远端复核和精确清理结果以最终交付消息为准。

参考：[Microsoft WSL 配置](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)、[Docker Desktop 设置文件位置](https://docs.docker.com/desktop/settings-and-maintenance/settings/)、[Get-DiskImage](https://learn.microsoft.com/en-us/powershell/module/storage/get-diskimage)、[Linux ext4 superblock](https://www.kernel.org/doc/html/latest/filesystems/ext4/super.html)。官方一般语义不替代实际环境验证。
