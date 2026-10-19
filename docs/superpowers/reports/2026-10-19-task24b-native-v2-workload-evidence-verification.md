# Task24B NW1 可行性检查与拒绝回归

日期：2026-10-19，Asia/Shanghai。实施基线：`dev / f5cfa061aafb87345da54889f15c3a27dc9b52dc`。范围仅为用户本次批准的 [NW1](../plans/2026-10-19-task24b-native-v2-workload-evidence.md#task-1-nw1-可行性记录与最早停止关口)，依据[已确认规格](../specs/2026-10-19-task24b-native-v2-workload-evidence-design.md)。

## 决策：blocked，停止后续任务

已建立纯数据可行性查询和不可外部注册的拒绝选择器。**当前没有任何合格 native descriptor、读取器版本/入口或生命周期执行入口；NW2–NW13 未执行。** 匹配真实安装摘要也只返回缺项，不产生读盘、准备、启动或停止权限。测试绿色仅说明该拒绝边界符合预期，不表示原生兼容或真实验收通过。

独立硬门槛 `workload_handoff_unproved` 尚未关闭：没有已审查的固定 Desktop/WSL 接口，能把两个 VHD 的禁止写共享保护，无间隙地交给准确的本次 writer。保持保护会妨碍 writer；先关闭再启动则存在未保护间隙。两次 stat/hash、通知、应用互斥锁或短时间窗口均不替代原子交接。该结论是当前材料**不足以证明可行**，不是断言厂商永远不可能提供机制。没有为“多找几个缺项”继续安装工具或接触旧盘。

## 本次确实检查了什么

- 在现有 dev 上新增本报告、`native-v2/rules.ts` 及两个 NW1 测试/数据夹具文件；不改既有 v1、fixture-v2、设置/发布/启停门面或权限域。
- 用现有 Bun/Node 对以下固定安装文件作只读静态采样，逐文件核对普通文件、规范父链及读取前后身份/长度/mtime。ASAR 仅在内存提取指定成员；PE 仅静态读取符号和指定地址反汇编，不加载或执行目标。
- 查询厂商/项目官方文档与源码，见下文。网页用于技术评估，不被当作已经 pin 的实现或可导入许可。
- 完整测试只使用本次新建 D 盘 owner 根与合成文件/自有 helper；不调用已安装 Docker/WSL。不是原盘内容取证，不新增实际运行档案。

没有打开两个原 VHD 的内容（连头部也未读取），没有挂载、复制、hash、回放日志、修复或写入原盘。没有执行安装的 Docker/WSL/服务、读取真实 Key/`.env.local`/旧账号许可、准备/启动真实档案、真实 Linux 验收、付费跑分或替换部署。旧 C 盘目录未迁移、删除、恢复或修改。未安装依赖，`package.json`、lockfile 不变。

## 固定静态安装 pin

位置 `D:\Applications\Docker`。`componentsVersion.json` 声明 Desktop `4.79.0` / build `230596`、CLI `29.5.3`、打包 engine `29.5.3`、Kubernetes `v1.34.1`、Linux `v6.12.76`、WSLBootstrap `417a95aae81a29194c9be3c03a592309`。这是打包声明，不是当前活动 daemon/containerd 版本、实际启动映射或完整布局证明。

`installSha256 = d731b751f4f5afed81b46923ad5c0f381000988089d5b2474538e5b6f9de3f5f`。

算法为 UTF-8 `sha256(canonicalJson({schemaVersion:1,root:"D:\\Applications\\Docker",members}))`；members 按下表 path 升序、每项仅 `{path,sha256}`，不追加换行，采用仓库现有 canonicalJson。七个实际受核成员共同形成摘要，**不是单个 EXE hash，也不宣称覆盖安装内所有成员或写入行为**。它是静态采样标识，不是后续操作的 live 安装身份。

| path                             | SHA256                                                             |
| -------------------------------- | ------------------------------------------------------------------ |
| Docker Desktop.exe               | `d079706dcb13555ad6e51e04e0f0507f475de5ebb79ac31cf85986d8902e31bc` |
| com.docker.service               | `5ba942808db6b1ebb32dd9f940d61f27e36322362fb8fe0d794c89f8b6a0d4bf` |
| frontend/Docker Desktop.exe      | `86d8ea314a56cfee849d666f2cac60f07aeb7937632e7fe005d642ad04be2771` |
| frontend/resources/app.asar      | `607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada` |
| resources/bin/docker.exe         | `7bc66b018b9da43fea986f893288bb93970d3d1217f5063201fd97c827f20732` |
| resources/com.docker.backend.exe | `2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd` |
| resources/componentsVersion.json | `8e1ea0564f06432d37853880188ea838fcd59b2ed751861fc933afb0e54ca233` |

### 可重定位静态片段，不提升为完整规则

ASAR data 起点为 `282980`；下列 offset 相对该 data 起点，位置可由上述整体摘要锁定。

| 成员或符号                                                              | 本次定位                                                                                                                                                                      | 能证明/不能证明                                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `build/entry-cli.main.js`                                               | offset `25371808`，size `11593`，SHA256 `3998a5b748667b5bd51fe73d3b113de9dc9d31ebc144b5b95c62413201c5f32b`；PINATA_HOME byte `991`，engine/control pipe 文本 byte `1908/2159` | 有前端 HOME/pipe 路由片段；不是全部子进程、既有 SYSTEM 服务、缓存和备用路径的闭合证明 |
| `build/onlyAllowSingleInstance.main.js`                                 | offset `27753709`，size `988`，SHA256 `ed2277acdafb0891a3b6d93599738a3ae5fc909a8bc2123018816c67d830027d`；锁变量 byte `502`                                                   | 单实例相关分支存在；不能排除全部外来实例或证明归属停止                                |
| `build/setupFileLogging.main.js`                                        | offset `27755202`，size `2835`，SHA256 `80a7333968864dd818bd17541d9116e7f1bbd5448bbab5f4a829c8bd5a2de210`                                                                     | 可固定日志初始化片段；不能据此穷尽安装写入                                            |
| backend `settingsloader.New/Initialize/loadSettings/saveToFile`         | VA `0x141136460/0x141137aa0/0x141138760/0x141139d80`                                                                                                                          | 设置保存链的定位点；尚无完整字段/跨文件语义/默认值及各阶段临时文件目录                |
| backend `jsonutil.WriteFile`                                            | VA `0x1404a7ec0`，指定范围反汇编引用 `0x14494ae1f`，调用 `0x14013af00`                                                                                                        | 与既有保存 helper 片段一致；不能把 fixture 临时后缀注册为原生规则                     |
| backend WSL `CreateMainDistro/distroUpToDate/createDataDisk/createVHDX` | VA `0x141373a40/0x141374040/0x141377b80/0x141377e80`                                                                                                                          | 相关分支确实存在；没有证明当前设置下必复用注册/双盘并排除重新导入/初始化              |
| backend `handlers/app.(*Handler).QuitDockerDesktop`                     | VA `0x143044100`，指定反汇编中有调用及间接调用                                                                                                                                | 有退出入口不等于 engine/WSL 完整、限时、仅本次归属的收尾，更不构成 VHD 锁交接         |

Go pclntab 在 backend file offset `88651968`；PE ImageBase `0x140000000`，text RVA `0x1000`。只定位上述符号/指定反汇编，没有把字符串或符号存在视为厂商实现证明。

## 读取器评估：未选定，不申请下载

当前 benchmark 直接依赖和已有 desktop 源码没有合格的 VHDX → 分区/ext4 → 工作负载索引解析链。只核查已有依赖与源代码，没有搜索、执行未知主机工具。

候选技术形状是受限 broker 的只读 `ReadAt` → VHDX 解析 → 文件系统解析 → 固定布局/索引分类。它需要真正落实双盘保护、逐次读预算、256MiB 工作集、取消/120秒以及错误脱敏；不是直接运行通用 forensic CLI，也不允许按盘内路径打开主机文件。

- [libvhdi 官方项目](https://github.com/libyal/libvhdi)声明可读 VHD/VHDX，状态 alpha，库为 LGPL-3.0-or-later。[官方头文件](https://raw.githubusercontent.com/libyal/libvhdi/main/include/libvhdi.h.in)有 bfio handle 打开、offset 读取和 abort API；[实现](https://raw.githubusercontent.com/libyal/libvhdi/main/libvhdi/libvhdi_file.c)拒绝 write access，但也包含路径打开入口。尚未固定版本/源码及二进制 hash、递归依赖与许可证清单，也未审查日志/父盘/所有拒绝及通知输出路径；不能据“支持只读”签发能力。
- [TSK 官方项目](https://github.com/sleuthkit/sleuthkit)是另一层文件系统解析候选；[image header](https://raw.githubusercontent.com/sleuthkit/sleuthkit/develop/tsk/img/tsk_img.h)有 external read callback，[filesystem header](https://raw.githubusercontent.com/sleuthkit/sleuthkit/develop/tsk/fs/tsk_fs.h)有 image-offset 打开接口。未固定版本/hash/构建依赖，未证明实际 ext4 特性、metadata 选择性解码和本规格预算，更未取得完整 Desktop 布局。

这些是浏览源码得到的候选接口，不是已经集成、pin 或批准的依赖。当前 **reader/version/hash/可执行入口均未选定**，不编造 SHA256、下载量、D 盘安装或缓存预算。因此状态不是“只要批准一个下载就可继续”；独立交接和布局阻断仍成立。本轮没有发起依赖准备请求；若未来另立诊断范围，应先重新完成固定版本/来源/许可证/依赖/字节预算，再申请下载授权。

## 原生缺项逐项结论

| missing                              | 准确缺口                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `offline_reader_unavailable`         | 没有经审查且固定版本/入口、无自主开路径/写入/恢复并可执行全部限额的读取链                                                         |
| `workload_layout_unproved`           | 打包 engine 声明不是实际 daemon/containerd/namespace 映射；runtime/data 两盘的容器、Swarm、Kubernetes、模块及其他激活来源尚未闭合 |
| `workload_handoff_unproved`          | 没有兼容准确安装/WSL writer 的无间隙交接机制；不采用先释放后检测                                                                  |
| `path_routing_unproved`              | 前端 HOME 片段不覆盖 launcher/backend/服务/更新/辅助程序的全部写入与缓存                                                          |
| `backend_environment_unproved`       | 备用启动链和既有 SYSTEM 服务的实际环境/行为未闭合                                                                                 |
| `registration_reuse_unproved`        | 相关创建/更新函数存在；准确配置下排除重建/导入/初始化尚未证明                                                                     |
| `stop_owned_unproved`                | 退出入口不证明真实 backend/engine/WSL 的完整归属与有界收尾                                                                        |
| `settings_mutation_unproved`         | 完整原生字段/默认值/跨文件语义/临时规则和保存生命周期缺失                                                                         |
| `existing_workload_restart_unproved` | 未读旧盘，不能声明为空；完整覆盖及当前可信交接 permit 均不存在                                                                    |
| `automatic_behavior_unproved`        | 更新/下载/模块/许可/onboarding/服务等自动行为未全部排除                                                                           |

官方限制也支持保守拒绝，但不替代本机证明：Windows [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)的共享约束持续到句柄关闭，没有由此推导原子移交的依据；[VHDX 日志规则](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-vhdx/0d588e33-23a6-4c71-b27f-87d97ac3e914)要求恢复非空日志，本路线不能跳过后继续解析旧视图；[ext4 文档](https://docs.kernel.org/admin-guide/ext4.html)指出只读 mount 可能回放，禁回放也可能留下不一致；[Docker data-root 文档](https://docs.docker.com/engine/daemon/)指出 containerd 存储可分离。故既不挂载，也不凭单个常见目录或 CLI 版本判空。

另外，原有未跟踪报告仍原样保留，SHA256 `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07`；它造成的 clean-tree 阻断没有被隐藏或绕过。生产 default/profile endpoint 差异未修改；本轮没有再次执行 CLI/WSL 探针来更新现场状态。

## 回归与实施记录

本次自有测试根 `D:\OpenCode-Benchmark\Task24\tmp\bprep1-native-v2-20261019-91c4d7ab`；新 owner、规范父链，无链接，环境白名单。HOME/用户配置、TEMP/TMP/TMPDIR、XDG/Bun/npm/Go/Turbo 缓存均落该 D 根下；不继承 provider Key。使用既有 Bun `1.3.14`，始终 `--no-env-file`，禁模型发现/工具链下载/遥测。

- RED：初始3项断言因 `assessNativePrerequisites/selectNativeRuleDescriptor` 尚不存在而失败；对应预期缺功能，不是伪造成功记录。
- 定向门禁：partial record、未知/错安装摘要、缺 reader/交接/字段的外来对象、完整 fixture descriptor、真实安装摘要均 blocked；返回数据冻结，JSON 克隆/修改不能注册权限。外来 proof getter 不会被读取。
- 首轮测试设施问题已如实记录：静态采样器自己的200MB上限拒绝223205808字节 frontend，按准确元数据改为256MiB后只读采样成功；不是解析器或原盘预算变更。Bun 的 nested asymmetric matcher 会改写所匹配对象，改为直接字段/包含断言，未改依赖或产品行为。全套初跑因测试 TEMP 缺 owner 叶标记导致 `397 pass / 10 skip / 69 fail`；补齐同一 owner 后重跑，不改旧测试/时限/断言。

最终验证（CWD 为 `packages/benchmark`，绝对白名单环境与 D 缓存）：

| 命令/范围                                                                           | 实际结果                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bun --no-env-file test ./test/linux-host/desktop-nw-rules.test.ts --timeout 30000` | 4 pass，0 fail，74 assertions，185ms                                                        |
| `bun --no-env-file run test`                                                        | 466 pass，10 skip，0 fail，2359 assertions，117 files，293.10s；原 skip/断言/时限不变       |
| `bun --no-env-file run typecheck`                                                   | exit 0                                                                                      |
| `bun --no-env-file run typecheck --project <本次D临时根>/tsconfig.native-v2.json`   | exit 0；包括 src、全部 linux-host tests、desktop-launch/linux-host/accept-linux-host 三脚本 |

代码与报告采用本地 Prettier；提交前另作格式及 `git diff --check`。独立审查与保留 hooks 的推送在此后执行，准确提交/远端一致性与本次临时物清理结果在最终交付中报告；这里不预记成功。旧未跟踪报告及前述规格/计划摘要在回归后未变。

## 后续授权与停点

NW1 软件与静态可行性评估交付后即停止，NW2–NW13 全部未执行。不开启 native 域，不新增 capture/prepare/start 命令或运行目录，不以原盘看似为空替代交接证明。

未来如要继续，先选择范围并提供可信交接/布局/读取器证据；或另行制定“只输出离线诊断、prepare/start 永远禁用”的缩小方案，不能由本次执行自行切换。依赖准备、真实原盘内容取证、实际准备、实际启动各自另行确认。旧 C 不迁移不删除，真实验收、付费跑分与部署替换仍未授权且未执行。
