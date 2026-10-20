# Task24B HS1–HS3 安全交接来源与适用性静态审计

实际执行日期：2026-10-20，Asia/Shanghai；文件名沿用已确认计划。执行基线：`dev / df92b111040342712862f897a50a2523ffb4b6cd`。依据[补证规格](../specs/2026-10-19-task24b-native-evidence-completion-design.md)及[HS 实施计划](../plans/2026-10-19-task24b-native-handoff-source-applicability.md)。用户本次授权覆盖 HS1–HS3 的静态审计、报告、验证、本地提交和正常 push，覆盖旧文档成文时“尚未批准执行/不 push”的历史状态，但不扩大实操范围。

结论：三类候选的有限静态审计已收口，**auditStatus=blocked；targetApplicability=unknown；operationalStatus=blocked**。vendor 缺准确协议/本机对应；单靠只读句柄复制/重开或普通 oplock 通知/ACK 的两种具体方案与既定交接边界冲突。没有可推荐进入实验的静态候选，不继续读取器/布局实验或 NW2–NW13。执行中存在一次已披露的同名符号超范围采样，见 Candidates；不将其用作证据，也不把文档验收称为真实机制验证。

未读取原 VHD（包括元数据/头部），未取得真实保护、执行 Docker/WSL、连接管道、做合成实验或推进 NW2–NW13。旧 C 目录、真实配置/Key、部署均未接触。

## Inputs

### 仓库来源 R1–R9

以下是 SourceRow 的紧凑表示。共同 `revision=df92b111040342712862f897a50a2523ffb4b6cd`（R9 为未跟踪文件，无 Git revision），`acquiredAt=2026-10-20T13:48:31Z`，`representation=当前工作副本原始字节`；source/location 为下表相对 `D:\OpenCode-Audit` 的准确路径/整文件摘要。摘要不产生权限。

| id  | source/location                                                                              | sha256                                                             | claim / limits                                          |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| R1  | `docs/superpowers/specs/2026-10-19-task24b-native-evidence-completion-design.md`             | `d6bcc4cbcd858668f3f089dfa9d36c90ba2a77a6d0a2f9ef307929f21b078fcc` | 已确认补证边界；不是实现                                |
| R2  | `docs/superpowers/plans/2026-10-19-task24b-native-handoff-source-applicability.md`           | `eca0d198cad28175050855d256b0190a1482641c2322a3e1b1a73b17a843985f` | 本包3任务17步；不是实验许可                             |
| R3  | `docs/superpowers/specs/2026-10-19-task24b-native-v2-workload-evidence-design.md`            | `807f7054d221b65bcafbea9abf68e721496786f42b324cbe0c920aad0f62950f` | 原生 v2 取证不变式；不是原盘事实                        |
| R4  | `docs/superpowers/plans/2026-10-19-task24b-native-v2-workload-evidence.md`                   | `37addc67e380a8e170069fef8f7de72d1bbf3c0132880795e0eae45db990c7b6` | NW1 及后续边界；NW2–NW13 不执行                         |
| R5  | `docs/superpowers/reports/2026-10-19-task24b-native-v2-workload-evidence-verification.md`    | `abe24bdaca3e1eeb17ba52e6ebf82682c50cf4f7f6d59c44a60f487aa470ead7` | 历史安装/定位/拒绝报告；历史测试不计为本轮结果          |
| R6  | `packages/benchmark/src/sandbox/desktop/native-v2/rules.ts`                                  | `7cde3cb8842d4793f693b333703084c8eb1e9dea34634329dca28b991bc9d312` | 当前静态代码：无合格 descriptor，选择器始终拒绝；未执行 |
| R7  | `packages/benchmark/src/sandbox/desktop/platform.ts`                                         | `f53a8a2814f1fb6f7a6caafbfb3080703bc2abcb614869bb3ae2cc72139c04da` | 原生启停/取证拒绝入口；未执行                           |
| R8  | `packages/benchmark/src/sandbox/desktop/compatibility-v2.ts`                                 | `d524fbf09d233ed299fd6e5973850701276a7808b0a22f4ac43e005c3fbdb165` | 原生兼容检查提前返回七类缺项；未执行                    |
| R9  | `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md` | `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07` | 仅核对摘要，未接管/stage；保留既有 clean-tree 阻断      |

### 当前静态安装采样 I1–I7

共同 SourceRow：`source=D:\Applications\Docker\<path>`，`revision=以下准确七成员集合`，`acquiredAt=2026-10-20T13:48:31.686Z`，`representation=整文件原始字节流`，`location=整文件`。下表 SHA256 同时是 R5 的期望值和本轮实测值，七项均一致，没有 `static_target_drift`。这仅固定静态样本，不证明活动状态或完整安装行为。

| id / path                             |  读取字节 | sha256                                                             | ino / mtimeNs（前后相同）               |
| ------------------------------------- | --------: | ------------------------------------------------------------------ | --------------------------------------- |
| I1 `Docker Desktop.exe`               |  15104944 | `d079706dcb13555ad6e51e04e0f0507f475de5ebb79ac31cf85986d8902e31bc` | `844424930151848 / 1781887868439395000` |
| I2 `com.docker.service`               |     36784 | `5ba942808db6b1ebb32dd9f940d61f27e36322362fb8fe0d794c89f8b6a0d4bf` | `844424930151835 / 1781887871001144500` |
| I3 `frontend/Docker Desktop.exe`      | 223205808 | `86d8ea314a56cfee849d666f2cac60f07aeb7937632e7fe005d642ad04be2771` | `844424930151860 / 1781887872536233700` |
| I4 `frontend/resources/app.asar`      |  38301066 | `607225828b3ca3921972052a4186b89e9fcce271a2c5af25ae2ea9924a14dada` | `844424930151876 / 1781887817812661600` |
| I5 `resources/bin/docker.exe`         |  42748848 | `7bc66b018b9da43fea986f893288bb93970d3d1217f5063201fd97c827f20732` | `562949953441307 / 1781887869865601800` |
| I6 `resources/com.docker.backend.exe` | 157746096 | `2856de9fd89456513e8b6c85bfe1fb2df791365b227297e58ed08fb3ffaa09fd` | `562949953441327 / 1781887870177778200` |
| I7 `resources/componentsVersion.json` |       552 | `8e1ea0564f06432d37853880188ea838fcd59b2ed751861fc933afb0e54ca233` | `562949953441330 / 1781887513448600900` |

逐项使用现有 Node 文件 API，只读打开，单文件拒绝超过268435456字节，buffer 为1048576字节。读取前 lstat/打开后 fstat/读取后 fstat 与 lstat 的 BigInt `dev/ino/size/mtimeNs` 精确比较；dev 均为 `2162922028`。所有父层至盘根均核对普通目录、非符号链接、native realpath 与规范路径一致，并在读取后再次比较父链 dev/ino。七文件均普通文件且规范路径一致。**这是采样前后检查，不是已取得双盘连续防替换锁，也不声称排除采样间 ABA/竞态。**

canonical 安装摘要复算为 `d731b751f4f5afed81b46923ad5c0f381000988089d5b2474538e5b6f9de3f5f`，与 R5/R6 一致。算法：递归排序对象 key 的 UTF-8 canonical JSON、无末尾换行，内容 `{schemaVersion:1,root:"D:\\Applications\\Docker",members:[{path,sha256},...]}`，成员按表中 path 升序。该摘要不覆盖安装全集，也不是可加载 proof/permit。

## Target

每行是 TargetRow；`expected` 指交接资格所需事实，而不是从版本字符串推断的值。`proved` 只覆盖该行写明的狭窄静态命题。

| component      | expected                                      | observedOrHistorical                                                                              | sourceIDs  | applicability             |
| -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- | ------------------------- |
| Desktop 样本   | 准确本次七成员集合                            | 当前采样七项匹配；I7 声明 `4.79.0 / 230596`、gitCommit `0eca98235d83a80b72e1977716bd2d2096cf911a` | I1–I7、R5  | proved（仅静态集合/声明） |
| backend 对应   | 固定 PE 与可审查交接实现/契约对应             | 当前 I6 字节已固定；尚无该闭源构建→完整协议实现的对应                                             | I6、I7、R5 | unknown                   |
| Windows        | 准确构建及相关文件/锁 API 适用保证            | missing：允许输入未提供；未运行系统探针/读新 C 文件                                               | R1、R2     | unknown                   |
| 目标文件系统   | 两盘所在文件系统、特性、锁/映射/父链行为      | missing：没有获准的新卷查询；未碰原盘元数据                                                       | R1、R2     | unknown                   |
| 本机 WSL / HCS | 实际安装构建、消费方二进制与准确源码/协议对应 | missing：未执行 WSL/version/list，不查 Appx/注册表                                                | R1、R2、I7 | unknown                   |
| WSLBootstrap   | 本机 WSL 对应证据（不能只凭打包值）           | I7 当前声明 `417a95aae81a29194c9be3c03a592309`；不是 WSL 安装构建                                 | I7         | unknown                   |
| engine / CLI   | 实际 writer/VM/存储消费链                     | I7 仅声明 CLI/打包 engine `29.5.3`、Linux `v6.12.76`；不等于活动 daemon                           | I7、R5     | unknown                   |
| 原盘/旧负载    | 当次准确双盘身份、内容、保护及自动行为        | 未取得；本包无权新查元数据或内容                                                                  | R1–R4      | unknown                   |

RF1 反证核查：仅有 CLI、WSLBootstrap、后续公开 WSL 源码，即使后者固定 commit，也不能使 Windows/文件系统/本机 WSL 行变为 proved。当前合并目标适用性为 **unknown**，不是 contradicted，也不承诺后续试启动补证。

## Candidates

### 官方来源 S1–S8 与有界补充

以下 SourceRow 中的网页 `revision` 不是目标产品构建 pin。网页 SHA256 均是内存取得、HTTP 解压后的完整 HTML 响应字节，不是线上压缩传输字节，也不是网页归一化正文；正文仅在内存阅读，未保存页面。微软表中日期为页面 `ms.date`，不保证等于页面最后更新日期。源码为 GitHub Contents API 的 base64 解码原始 UTF-8 字节，未转行尾、未落完整源码副本。

| id / source                                                                                                                                                   | revision / acquiredAt（UTC，2026-10-20）                        | bytes / sha256                                                              | location / claim / limits                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| S1 [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)                                                          | ms.date `2022-08-16`；13:50:47.551                              | 115313 / `e41c7126db972d34854e54f614c444a57e6723a1e99a9bcca654208a3ab75c17` | Parameters: desired access/share、OPEN_EXISTING；Remarks/Directories/Symbolic Link Behavior。提供单文件共享基础约束，非双盘交接协议 |
| S2 [DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle)                                              | ms.date `2018-12-05`；13:50:47.956                              | 69064 / `422f1d50481eb607ad64694b0326464f819a1e32cb40e65d8cdd3da79f9d9f7b`  | Remarks 的文件 GENERIC_READ/GENERIC_WRITE 例外；复制文件句柄不提供只读升级写入                                                      |
| S3 [ReOpenFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-reopenfile)                                                            | ms.date `2018-12-05`；13:50:48.372                              | 65704 / `d60003fd6e4d47c21dbaa0266d4aef67a7d82fa6f92cb77ca718700a9dce58fe`  | dwDesiredAccess/dwShareMode；重开仍须兼容存活打开的共享条件                                                                         |
| S4 [REQUEST_OPLOCK_OUTPUT_BUFFER](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-request_oplock_output_buffer)                      | ms.date `2018-12-05`；13:50:48.600                              | 54008 / `02285f1291cbad45fdec499ef8409f195a058227b9a2bcd5564fa98a60baef9e`  | Syntax、Flags、AccessMode/ShareMode、Remarks；mode 字段仅特定 break 提供，结构不含准确 writer/VM 身份                               |
| S5 [Breaking Oplocks](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/breaking-oplocks)                                                        | ms.date `2024-12-18`；13:50:49.264                              | 54642 / `8ef6d596aa6f7b21a6312607076d23045da8d5a177b39800d071b3ac13da5b27`  | ack 等待、cancelable IRP、FILE_COMPLETE_IF_OPLOCKED、Level2/Read/部分 Read-Handle、NTFS sharing 顺序；不是所有请求等待放行          |
| S6 [Acknowledging Oplock Breaks](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/acknowledging-oplock-breaks)                                  | ms.date `2017-04-20`；13:50:50.443                              | 50697 / `19c1277de00b0a01e009a69439cbe934cfda5ed9a5d74992192b4c4007127f1e`  | 各 ACK FSCTL、ACK_CLOSE_PENDING、末段隐式 ACK；关闭持有句柄可能放行，不是取消等待 writer                                            |
| S7 [WslCoreVm.cpp 固定源码](https://github.com/microsoft/WSL/blob/e71176846ea326a91bdef4d16bf4ded25c082713/src/windows/service/exe/WslCoreVm.cpp#L1015-L1144) | commit `e71176846ea326a91bdef4d16bf4ded25c082713`；13:51:09.837 | 124956 / `019b662cb47734aac329db34623f05fb413f258af888ecbe47b62663a82ce61a` | L1015–1144 AttachDisk/AttachDiskLockHeld；路径、内部 VM 锁和单盘 attach；未对应本机 WSL                                             |
| S8 [Docker privileged helper](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/#privileged-helper)                               | 动态文档，Last-Modified `2026-10-20 11:48:20 GMT`；13:51:10.451 | 532129 / `e85e1285687f3f8cbcfa88fc2cad111c4aa6d1626808ac20c5d31864af38d18e` | Privileged helper 节；SYSTEM 服务/pipe 的权限边界，不是本次独占服务/归属停止证明                                                    |
| S7a [hcs.cpp](https://github.com/microsoft/WSL/blob/e71176846ea326a91bdef4d16bf4ded25c082713/src/windows/common/hcs.cpp#L56-L69)                              | 与 S7 同 commit；13:51:35.704                                   | 13665 / `e455d3d484262393abfadb2361c7eff98e48170280b93ed9de2cd525c3f69a85`  | L56–69 AddVhd，L203–230 GrantVmAccess/ModifyComputeSystem；按 Path/Lun/ReadOnly 发单次修改并等待，不是外部双盘事务                  |
| S7b [hcs.hpp](https://github.com/microsoft/WSL/blob/e71176846ea326a91bdef4d16bf4ded25c082713/src/windows/common/hcs.hpp#L50-L68)                              | 与 S7 同 commit；13:51:37.028                                   | 3218 / `e18d330a310c8c3388c72da637a5f8f5d1f85812554cca21488a8522e73b866b`   | L50 AddVhd / L68 ModifyComputeSystem 声明；Identity 默认 nullptr，不是调用者持有的受保护双盘句柄                                    |

S7 的 master 仅用于定位。GitHub commit API 实际解析到上述不可变 commit（commit 时间 `2026-10-19T21:53:52Z`），其 Contents API blob 分别为 `1bffaed0a802bf2cf49cf41bf3f553b8094435c7`、`2106ee4e01a9e7c1041e1fe4356a2032df21189f`、`6e0e52c897d6da31ad1f1c175f035ceec8ceb302`。这些只固定公开源码，不证明它编译成本机 WSL/WSLBootstrap。首次 raw host 取得 S7 失败；仅重试同一文件一次，改由官方 GitHub Contents 成功，未用搜索摘要替代原文。前一内存 HTTP 片段还曾因 CommonJS 顶层 await 在解析时失败，未发请求；修正为 async 包装后取证，不是产品缺陷/实验。

有限搜索恰好两次（约13:50 UTC）：① `site:docs.docker.com desktop WSL disk handle handoff staged writer admission transaction`；② `site:learn.microsoft.com HCS WSL AddVirtualDisk AttachDisk file handle ReadOnlyPath atomic`。返回的 WSL/挂载/通用 HCS 介绍及 Docker WSL 介绍没有在已检查材料中给出所需厂商双盘保留/提交/取消契约；不采用 Q&A、博客或摘要作证明。没有追加第三次搜索。额外源码仅 S7a/S7b 两个直接必要定义文件；未扩大到仓库归档或其他源码。**这不是对所有厂商私有接口不存在的证明。**

### 安装片段 A1–A3 / P1–P6

A1–A3 共同 SourceRow：source=I4；revision=I4 SHA256；acquiredAt 为本轮约13:52 UTC；representation=ASAR 内存精确原始成员字节；location 为 data 起点282980加下表相对 offset。三个摘要均与 R5 一致；没有解包树。只说明局部代码，不闭合子进程/全写入或交接协议。

| id / member                                | offset / size / sha256                                                                | 当前核查到的局部命题                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A1 `build/entry-cli.main.js`               | 25371808 / 11593 / `3998a5b748667b5bd51fe73d3b113de9dc9d31ebc144b5b95c62413201c5f32b` | byte991 为 PINATA_HOME_DIRECTORY_OVERRIDE；engine/control pipe 构造使用 devHomePrefix（control 名 byte2159）。这不是 writer 进程/VM 身份 |
| A2 `build/onlyAllowSingleInstance.main.js` | 27753709 / 988 / `ed2277acdafb0891a3b6d93599738a3ae5fc909a8bc2123018816c67d830027d`   | byte502 的 PINATA_SINGLE_INSTANCE_LOCK 分支：有 HOME override 等条件时可以绕过 app 单实例锁，除非明确要求；不是磁盘锁                    |
| A3 `build/setupFileLogging.main.js`        | 27755202 / 2835 / `80a7333968864dd818bd17541d9116e7f1bbd5448bbab5f4a829c8bd5a2de210`  | byte1073/1133 的 mkdir/chdir 和 byte2126 的日志清理线索；不代表获准创建档案，也不证明全部缓存重定向                                      |

P1–P6 共同 SourceRow：source=I6；revision=I6 SHA256；约13:52–13:53 UTC；representation=同一 PE 的只读符号/指定机器码静态反汇编，未执行目标。PE ImageBase `0x140000000`、text RVA `0x1000`、pclntab file offset `88651968`；只输出选定片段/调用线索，未保存符号/反汇编 dump。下列全名使用前缀 `D=github.com/docker/pinata/win/backend/wsl/distro`、`H=github.com/docker/pinata/common/cmd/com.docker.backend/internal/handlers/app`，拼接后为完整符号名。

| id / 完整符号（前缀如上）                 | VA 区间（右端不含） / file offset    | 直接调用/参数与保护的证据边界                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 `D.(*Distro).CreateMainDistro`         | `0x141373a40–0x141374040` / 20394048 | call@`0x141373ae9`→P2；call@`0x141373c1a`→os.MkdirAll，@`0x141373c87`→D.copyFile；多处间接 call 未解。未识别外部双盘保留、锁移交或准确请求身份参数                             |
| P2 `D.(*Distro).distroUpToDate`           | `0x141374040–0x1413742c0` / 20395584 | @`0x141374062`→os.Stat，@`0x1413740e0`→runtime.memequal，其余关键接口间接。版本/存在性比较不能证明本次必复用且不重导入；分支错误传播未闭合                                     |
| P3 `D.(*Distro).createDataDisk`           | `0x141377b80–0x141377da0` / 20410752 | @`0x141377c0a`→P4，@`0x141377cfa`→errgroup.(\*Group).Go；并发任务完整 join/取消及双盘整体提交仍 unresolved。精确函数末尾来自 Go 表，不沿用历史宽范围                           |
| P4 `D.createVHDX`                         | `0x141377e80–0x141378440` / 20411520 | @`0x141377f07/0x141378092`→linuxkit/pkg/vhdx.Metadata，@`0x14137802a`→linuxkit/pkg/vhdx.Create；mkdir/路径构造和间接 call。不能从调用名推导 readonly、消费方共享参数或外部事务 |
| P5 `H.(*Handler).QuitDockerDesktop`       | `0x143044100–0x1430441c0` / 50607872 | @`0x143044160`→runtime.newproc；退出工作异步触发，@`0x143044175`间接调用未闭合。HTTP 处理返回不证明 VM/盘 writer 已退出                                                        |
| P6 `H.(*Handler).QuitDockerDesktop.func1` | `0x1430441c0–0x143044320` / 50608064 | P5 的派生 closure 线索；@`0x1430441e0`间接 callback，@`0x1430441f1`→time.NewTimer，@`0x14304422f`→runtime.selectgo；收尾身份、完整进程树和晚到请求仍 unresolved，不追间接链    |

**执行偏差及停止处理：** 符号名称筛选过宽，在同一已 pin PE 中额外静态反汇编了 `github.com/docker/pinata/common/pkg/backend.(*backendClient).QuitDockerDesktop`（`0x1409428c0–0x1409429e0`）、`github.com/docker/pinata/linuxkit/pkg/sailor.createDataDisk`（`0x141389d60–0x141389de0`）、`github.com/docker/pinata/win/backend/hcs.createVHDX`（`0x143724320–0x1437243a0`）。这不在五个批准根函数及其已证直接链内，是本轮取证范围错误，不宣称完全按准确五根采集。已通知用户并停止 backend 扩展；不以这三个额外片段作候选证据，不补追两层以“凑齐”。没有运行 PE、断点/调试、读新文件或产生持久 dump。独立公共 API 审计仍可完成，运行阻断不变。

### vendor：厂商协议候选

`sourceIDs=I1–I7,A1–A3,P1–P6,S7,S7a,S7b,S8`；`verdict=insufficient_evidence`。下表是 consumerChain；**箭头不表示已证明可调用/可移交**。

| 边                    | 参数/保护/所有权与失败传播                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| controller → launcher | R1 要求 plan/request/nonce、双盘父链与精确 writer；未找到与 I1 对应的受保护对象/分阶段保留入口。unresolved                                                                                                                                                    |
| launcher → backend    | A1 仅给 HOME/pipe 路由；A2 app 锁不是排他存储准入。pipe 名不绑定进程句柄、创建时间、SID、映像和本次 VM；身份/取消传播 unresolved                                                                                                                              |
| backend → WSL/HCS     | P1–P4 有创建/比较/异步路径，但间接接口/实际参数不可由片段可靠还原；I7 Bootstrap 不能把这条边接成 S7。准确构建对应、锁/对象传递 unresolved                                                                                                                     |
| 公开 WSL 内部 → HCS   | S7 L1015–1018 取得内部 m_lock 后按 Disk 路径调用；L1026–1043 单 LUN 清理，L1105–1126 打开 backing、可能 GrantVmAccess 后 AddVhd。S7a L56–69 单个 Path/Lun/ReadOnly 序列化，L212–230 调 HcsModifyComputeSystem 并以 INFINITE 等待。非外部双盘 commit/join 契约 |
| HCS → 两盘 writer     | 公开请求不接受当前 controller 的只读受保护双盘句柄/nonce；HCS 内部精确打开共享、worker/VM 身份和组合提交未取到；本机适用性未知。unresolved                                                                                                                    |
| 取消/退出 → 归属收尾  | S7 的单盘 scope cleanup 是有限正向证据，不证明两盘事务/晚到 writer；P5/P6 与 S8 不能授予停止共享 SYSTEM 服务或外来 VM 的权利。unresolved                                                                                                                      |

`protectionSequence`：R1要求读取期间保护不断→准确双盘 writer 整体准入→归属收尾；当前链未证明第一保护到可写接管的连续转换。`writerBinding`：缺 controller 到准确 worker/VM 的绑定；UserToken/ComputeSystem 仅是公开内部参数，不等于本次来源。`dualDiskCommit`：缺 reserve/commit/abort 协议；两个单盘调用不自动合并。`failureCleanup`：单盘异常清理≠取消/超时/控制器崩溃后完整收尾。`obligations=O1–O8`；`counterexampleIDs=C1–C10`；`missing` 为上述所有 unresolved 和 Target 的 unknown。

若把 S7 已见的 GrantVmAccess 路径改造/移植为解决方案，会涉及 ACL/厂商变更，**该子路线 conflicts_with_boundary**；未证明这是当前安装实际走法，故不把通用 vendor 整体判为绝不可能，也不擅自修改。

### handle：只读句柄复制/重开候选

`sourceIDs=S1,S2,S3,Target`；`consumerChain=controller只读句柄→DuplicateHandle/ReOpenFile→目标消费方（未证明支持）`。`protectionSequence`：保持 deny-write/delete 会阻止冲突可写重开；释放保护再开写则有间隙。S2 的只读文件访问权限制、S3 的存活共享条件直接否定“保留原保护且凭这两个 API 获得写入”。不是所有对象类型或所有未来组合机制都不可能。

`writerBinding`：DuplicateHandle 的目标进程参数是局部正向能力，但没有证明该进程就是准确 WSL/HCS writer，或会消费传入句柄；继承同样不是消费契约。`dualDiskCommit`：两次复制各自成功不含整体提交。`failureCleanup`：关 controller 副本不撤销其他进程副本，不证明等待/已发起 writer 被终止；不执行 DUPLICATE_CLOSE_SOURCE 或任何句柄实验。`obligations=O1–O8`；`counterexampleIDs=C1–C10`。

`verdict=conflicts_with_boundary`，针对本次“仅凭只读复制/重开完成可写交接”的具体候选。`missing`：消费方句柄协议、双盘原子准入、精确 writer/异常收尾和目标对应；若需预拿可写原盘句柄、改 share/ACL 或先解锁即越界。不借 vendor/oplock 未证能力补齐。

### oplock：仅以普通 break/ack 作交接门候选

`sourceIDs=S4,S5,S6,Target`；`consumerChain=controller持锁→文件系统break→access/share通知→ack或关闭→等待请求`。`protectionSequence`：ACK_REQUIRED 只对指定分支有效；S5 的无需 ACK 分支和特殊 create 否定“一律等待我放行”。这不表示特殊 create 可以绕过 S1 的普通共享检查；保留 deny-share 仍阻写，撤掉它又不能靠 oplock 证明安全转换。

`writerBinding`：S4 的模式信息仅部分请求提供，结构未承载精确进程/创建时间/SID/VM/nonce；即使有 mode，也不能认定第一个请求为授权 writer。`dualDiskCommit`：两个独立 stream 的 break/ack 无已证整体事务。`failureCleanup`：S5 等待者退出可取消其 IRP，不等于持锁者退出就取消所有等待者；S6 关闭持锁句柄会隐式 ACK，可能让晚到请求继续。无限期不 ACK 无超时且违反及时应答要求，不作为收尾。已有 mapping 和父链替换也不能由通知存在排除。

`verdict=conflicts_with_boundary`，针对仅以该通知/ACK 替代连续保护和准确准入的具体候选，**不是对所有文件系统机制/有厂商协议的组合下普遍不可能定理**。`missing`：准确请求绑定、全部 break/create/mapping/退出分支、双盘和已归属取消/join及目标文件系统支持。`obligations=O1–O8`；`counterexampleIDs=C1–C10`。不编写 helper、不安装驱动、不改变 ACL 或尝试原盘。

## Obligations

八项义务在来源检查前已列入执行账本。以下24格分别裁决完整义务；局部正向事实在 Candidates 标明，不以它替代整项。unknown 是缺证据，contradicted 是此处具体候选/声称与已见契约冲突，不是未知目标版本的肯定反证。

| obligation                                      | vendor                                      | handle                                                                     | oplock                                                                     |
| ----------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| O1 只读、OPEN_EXISTING、禁止写/删除共享始终不变 | unknown：P1–P4/S7无外部保护→准入协议        | contradicted：S2 Remarks/S3 access；只读复制不可变写，冲突重开不可同时保锁 | contradicted：S5 特殊/无需ACK分支不能替代 deny-share；松开原保护无连续证明 |
| O2 双盘/父链身份连续稳定                        | unknown：A1/P1路径不提供父链持锁链          | unknown：S2复制文件对象未证明全父链/双盘交接                               | unknown：S4单stream通知不是父链/双盘身份                                   |
| O3 准确 writer 请求/创建时间/SID/映像/VM/nonce  | unknown：A1 pipe、S7 UserToken 未闭合本次链 | unknown：S2目标进程参数不证明消费者/VM绑定                                 | unknown：S4 mode字段不足，无另证身份协议                                   |
| O4 双盘整体提交，部分失败不先写                 | unknown：S7/S7a每次单盘/LUN                 | unknown：S2/S3无所需聚合消费契约                                           | unknown：S4–S6独立stream，无事务证据                                       |
| O5 其他 writer/已有mapping隔离                  | unknown：A2 app锁不是存储准入               | unknown：S1提供单文件冲突基础，不闭合准入及全部父链/消费方                 | unknown：S5 break规则不证明全部mapping和外来writer排除                     |
| O6 取消/超时/崩溃/部分失败完整安全              | unknown：S7单盘cleanup、P5/P6异步退出不够   | unknown：S2/S3无消费者两盘撤销/join保证                                    | contradicted：S6关闭隐式ACK；当作取消将放行而非撤销                        |
| O7 晚到请求终止与只清理已归属资源               | unknown：P5/P6/S8无完整归属收尾             | unknown：复制对象/等待者的生命周期未闭合                                   | contradicted：S5等待者退出≠持锁者退出；S6关锁不证明终止晚到writer          |
| O8 固定 Windows/FS/WSL/Desktop 消费方适用       | unknown：Target、S7非本机映射               | unknown：Target，API存在不是消费协议                                       | unknown：Target，未证文件系统/锁型/完整消费分支                            |

## Counterexamples

下表是30格**人工来源推理**，未执行任何故障注入、竞争 writer、取消或崩溃实验。每格“拒绝”表示不能凭该候选接受该情形；缺陷的实验可重复性仍未验证，不能把未测试写成通过。

| case / 输入                                 | vendor                                                     | handle                                        | oplock                                            |
| ------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------- |
| C1 先释放保护，之后backend打开              | 拒绝：P1/S7无锁交接，路径间隙未封闭                        | 拒绝：S1/S3关原锁再重开有间隙                 | 拒绝：S5/S6 ACK/关闭不是准确独占准入              |
| C2 runtime可写，data移交失败                | 拒绝：S7/S7a单盘cleanup非双盘回滚                          | 拒绝：S2两次复制无整体commit                  | 拒绝：S4–S6两个stream无整体commit                 |
| C3 两writer同时请求                         | 拒绝：A2不证明writer身份/排他                              | 拒绝：S2目标进程不证明实际消费链              | 拒绝：S4首个mode不等于被授权者                    |
| C4 PID复用/不同创建时间或VM/假pipe          | 拒绝：A1管道名称/S8权限不绑定本次VM                        | 拒绝：S2句柄操作存在不补创建时间/映像/VM      | 拒绝：S4结构无此身份，无额外可信协议              |
| C5 取消/超时后等待writer继续                | 拒绝：P5/P6/S7无完整取消join链                             | 拒绝：S2/S3关闭本地资源不等于撤销消费者       | 拒绝：S5取消等待者的条件不覆盖本方取消；S6可放行  |
| C6 controller/持锁者崩溃或异常关闭          | 拒绝：P5/P6退出不是全部writer终止                          | 拒绝：S2别的进程副本可能仍在；未证归属收尾    | 拒绝：S6关闭隐式ACK，不得推导writer已取消         |
| C7 已有write mapping/父链替换               | 拒绝：P1/A1未证父链稳定，Target缺证                        | 拒绝：S1共享冲突是基础；完整父链准入仍unknown | 拒绝：S4/S5通知不证明mapping/父链排除             |
| C8 无需ACK break/特殊create                 | 拒绝借用oplock兜底：S5分支须另闭合，vendor无证             | 拒绝借用oplock兜底：S1–S3不是该ACK协议        | 拒绝：S5明确不是所有break等待；不声称绕过共享规则 |
| C9 必须改share/ACL/服务或先拿可写原盘handle | 越界不实施：S7 GrantVmAccess子路线与R1冲突；不冒充本机路径 | 越界不实施：S2/S3不能以预拿写权/解锁兜底      | 越界不实施：S4–S6不能借改share/驱动/服务变合格    |
| C10 helper成功/网页/签名/hash/历史空报告    | 拒绝：I/S7只静态材料，R5非当次许可                         | 拒绝：S2 API成功也非目标消费/双盘证明         | 拒绝：S4通知/helper成功也非厂商兼容或运行许可     |

HS2 人工核对：3条候选、24项义务、30项反例均有明确记录和来源/缺项；八项完整义务无候选全部 supported；无 static_candidate，不推荐进入实验。没有把三种未合格机制拼成一条未证明的组合方案。

## Decision

以下为唯一 Decision 的文档表示，不是供运行时加载的记录。

| field               | value / reason                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| auditStatus         | **blocked**：三类均未覆盖 O1–O8、C1–C10 和准确目标对应                                                                                           |
| candidateIDs        | 已审查 `vendor / handle / oplock`；合格/推荐集合为空                                                                                             |
| targetApplicability | **unknown**：Windows/FS/WSL 构建及 backend→源码/协议对应未取得；没有把通用 API 候选反例当作本机版本事实的矛盾                                    |
| missing             | 厂商受保护对象/双盘保留-提交-终止协议；准确 writer/VM 绑定；异常与晚到请求完整归属收尾；Windows/FS/WSL/闭源 backend 对应；读取器和完整布局也仍缺 |
| nextAuthorization   | 仅可考虑下节列出的独立有界补证授权；本报告不批准它们，不自动搜索、下载、实验、读盘或继续 NW 任务                                                 |
| operationalStatus   | **blocked**：静态候选、机制实验、目标适用及真实操作授权层次分开；本包不产生任何许可                                                              |

决策公式已手工代入：所有静态义务有证、目标适用 proved、无未决反例时才可能为 static_candidate_only；现在这些前件均未满足，故非 static_candidate_only。即使未来满足，它也不能把 operationalStatus 改为其他值。

这次有限材料不足，不等于 Docker/Microsoft 永远不可能提供其他机制；本结论仅否定已审查的具体候选/缺证状态。不能用新驱动、改 ACL/share/服务、补丁、先启动观察或“诊断-only”暗中替换既定目标。已知冲突、未证明、所需新范围分别列示；不是等待用户“接受风险”即可放行。

R6 的三个前置缺项 `offline_reader_unavailable / workload_layout_unproved / workload_handoff_unproved` 均未关闭。七类原生门槛（路径/缓存、backend 环境、注册/双盘复用、归属停止、设置生命周期、旧负载恢复、自动行为）全部保留。R9 的 clean-tree 阻断和生产 default/profile endpoint 差异均未处理；本报告不会导入 registry、重算旧绑定或签发 descriptor。

## Authorization

以下是**新增授权需求清单，不是执行清单/命令或已批准的下一包**。建议先取得厂商交接契约；没有可信静态候选就停，不用反复试同一 API 或投入 reader/layout 实验来换取启动权。

| 缺少的准确证据                                                   | 为何必要 / 拟议最小范围                                                                      | 必须另行确认的边界                                                                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 对应 Desktop 4.79.0/230596/I6 的保留/提交/撤销契约或厂商源码映射 | 是否接受已受保护对象，能否从只读采集到两盘 writer 原子准入；包含控制器崩溃/部分失败/晚到请求 | 可先由用户提供准确厂商材料；若需继续查源，先给准确新 URL/文件/版本和有界搜索清单，不 clone/打补丁/发送本机数据        |
| 本机 Windows 精确构建/API 适用声明                               | 当前材料不含 OS 构建，不能把文档最低支持版本当目标证明                                       | 本包没有已确定可读路径；**须先另批发现范围**，仅字段级系统版本元数据，列明准确读取方式后再确认，不泛查 C/注册表       |
| 双盘所在宿主文件系统及特性/共享/mapping/父链保证                 | oplock/共享规则须对应准确卷和实际模式；卷标/路径 D 不等于 NTFS 证明                          | 须另批对指定卷的只读、非原盘内容元数据范围；目前不提供通配查询/盘文件 stat，连原 VHD 新元数据检查也未授权             |
| 本机 WSL/HCS 构建、二进制→固定源码/协议对应                      | S7 固定 commit 与 I7 Bootstrap 都不能替代本机版本证据                                        | WSL 安装文件路径未知，**须先另批发现范围**；不自动枚举 Appx/WindowsApps/注册表、不运行 version/list、不开旧 C 配置    |
| 从 launcher 到真正双盘 writer 的完整消费/所有权链                | 需要进程句柄、精确创建时间、SID、映像摘要、VM/request/nonce，以及失败后的 join/终止保证      | 若需更多安装资产/闭源分析，先列准确成员/范围和字节预算；此次超范围片段不作为进一步扩展的授权；不做动态调试或连接 pipe |
| 有资格的 reader/完整布局                                         | 交接有可信候选后才进入下一补证包；三项互不替代                                               | 另写布局/读取器的固定来源、依赖/许可证/下载量/D 预算和计划；目前不选定工具、不下载、不实现                            |
| 自有合成实验资格                                                 | 静态契约成立也需独立、确定预期的竞争/取消/崩溃反例                                           | 另批准确新 D 根、工具/样本/helper/预算；**当前无合格候选，不启动这一步**                                              |
| 真实原盘读盘、准备、启动                                         | 各自取得当次事实、保护和独立许可；报告/hash 不可复用为权限                                   | 三次范围各自另批；本报告无 START 命令/未知 argv，也不预授权原盘引导扫描                                               |

可供未来由用户决定是否向厂商询问（本轮未发送）：

1. 哪个准确构建支持外部受保护双盘的 reserve/commit/abort？是否接受既有只读 deny-write/delete 句柄/对象，并保持父链身份，无先解锁窗口？
2. 如何绑定实际 writer 的进程/创建时间/SID/映像、VM、request/nonce，而非普通 pipe 名或可复用 PID？
3. 第一盘移交后第二盘失败、超时、控制器/持锁者崩溃时，如何保证尚未提交的 writer 不运行，取消后晚到请求也不继续？能提供完整 join 和只收尾自有资源的契约吗？
4. 该协议是否不要求改旧盘 ACL/share、预取可写原盘句柄、修改共享 SYSTEM 服务或升级/重建厂商组件？如需要，现有范围内不可采用。

旧 C 三目录不迁移、不删除；实际读盘、准备、启动仍分别另行确认；真实 Linux 验收、付费跑分和部署替换均不做。没有借当前阻断改选其他方案。

## Verification

本节区分“文档完成”与“机制合格”。HS1–HS3 的判断材料、表格和停止交付均已形成；**不声称所有采样严格符合批准范围**，前述同名符号筛选偏差保留可见。没有因缺证继续启用路线。

| 核查项        | 本轮实际结果                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仓库基线/输入 | dev、开始 HEAD df92b111040342712862f897a50a2523ffb4b6cd；R1–R9 实测摘要见 Inputs；R9 只核 hash，未 stage/移动/ignore                                         |
| 安装静态文件  | 七文件流式完整 SHA256 均匹配；精确文件身份/大小/mtime、规范父链前后检查通过；未触及原 VHD 元数据/内容。ASAR仅三成员，PE偏差另列                              |
| 网络材料      | S1–S8 实际正文及原始表示摘要；S7 经一次失败/一次同源重试成功；两次定向搜索、两个额外固定同commit源码文件，之后停止                                           |
| 未取得项      | Windows/FS/本机WSL/HCS及闭源对应、厂商双盘交接协议、准确writer/完整异常收尾；均未用版本字符串/hash顶替                                                       |
| 义务/反例     | 人工逐格对照：3×8=24义务、3×10=30反例；来源/矛盾/unknown完整；不是54项运行测试或实验通过                                                                     |
| RF1           | master已换准确公开commit，但目标对应仍unknown；Bootstrap/CLI未推导Windows/WSL/FS                                                                             |
| RF2/RF3       | 复制/重开、mode/break/单文件局部能力未合成准确writer/双盘保证；未用helper成功补齐                                                                            |
| RF4           | S5等待者终止与S6持锁者关闭明确分开；取消、部分失败、持锁者崩溃、晚到writer未得安全证明                                                                       |
| RF5           | vendor为缺证；两个具体API门方案已知冲突；没有声称普遍不可能、修改权限或静默变更目标                                                                          |
| RF6           | auditStatus/operationalStatus均blocked；没有运行命令/permit/ready；所有实操未执行                                                                            |
| 规格覆盖      | R1第四节交接审查、七节顺序/停点、八节原七门槛/registry分层、九节授权分别对照；未进入第五/六节布局读取器实现                                                  |
| 真实操作      | 双盘保护/读盘、helper/竞争/崩溃实验、Docker/WSL/服务运行或连接、准备/启动/停止、Linux验收、模型发现/调用/付费、部署替换：全部未执行                          |
| 文档验证      | 使用现有Node/本地Prettier、禁compile cache/外来NODE_OPTIONS，不加载项目env；每任务提交前格式检查和git diff --check；非产品测试，不引用历史466/10/0作本轮结果 |

仅新增本报告；原规格/计划、R6–R8业务文件、R9未跟踪报告将于最终提交前再次比较摘要。最终独立只读审查、正常push及本轮自有技能中间物清理结果在实际完成后追加，不预写成功；保留 hooks，不把发布门禁的代码检查算成安全交接实验。
