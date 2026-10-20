# Task24B HS1–HS3 安全交接来源与适用性静态审计

实际执行日期：2026-10-20，Asia/Shanghai；文件名沿用已确认计划。执行基线：`dev / df92b111040342712862f897a50a2523ffb4b6cd`。依据[补证规格](../specs/2026-10-19-task24b-native-evidence-completion-design.md)及[HS 实施计划](../plans/2026-10-19-task24b-native-handoff-source-applicability.md)。用户本次授权覆盖 HS1–HS3 的静态审计、报告、验证、本地提交和正常 push，覆盖旧文档成文时“尚未批准执行/不 push”的历史状态，但不扩大实操范围。

状态：HS1 输入核对完成；HS2/HS3 尚待本报告后续提交。**运行状态始终 blocked。** 未读取原 VHD（包括元数据/头部），未取得真实保护、执行 Docker/WSL、连接管道、做合成实验或推进 NW2–NW13。旧 C 目录、真实配置/Key、部署均未接触。

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
