# Task24B DL6 原生适配与交互确认软件验证

2026-10-18，Asia/Shanghai。NC1–NC7 在现有 `dev` 实现，软件验证与真实运行严格分开。原生准备与启停仍受兼容证据和后续人工授权双重门禁限制；这不是 DL6 真实核查通过，也不是 Linux 验收或跑分结果。

依据[补充规格](../specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md)、[实施计划](../plans/2026-10-18-task24b-dl6-native-cli-confirmation.md)及[原启动规格](../specs/2026-10-18-task24b-d-drive-docker-launch-design.md)。实现基线为 `8443c5ce9aa2dc4e7992883e200173bc13457139`，没有创建隔离分支、覆盖外来修改或替换部署。

## 软件范围

NC1–NC6 和 NC7 输入修复之后，整体审查安全修复提交为 `14a9d59dc`。下表的最终回归对应该修复代码，而非修复前405项结果。

文档绑定覆盖两份规格与两份计划，源码绑定实际干净 Git tree。原生诊断采用固定 Windows 元数据及离线 CLI 查询边界，严格处理编码、截断、身份和取消；service 不被当作 engine，报告摘要不混入临时采样值。

`--interactive` 只允许准备与启动；控制输入固定按 launchID 和阶段命名。确认前核对请求、SID、兼容报告及实际 manifest，确认后再次核对文件及父目录身份、安装、注册与盘位、实例状态。相同内容的新文件同样使确认失效。fixture 回调不能签发 native 权限，底层 prepare/start/grant 也检查来源。

固定控制台 helper 验证三个真实标准句柄，不附加控制台、不打开 CONIN$、不更改共享模式；完整面板写出后生成 96 位一次性 challenge，最多等待60秒且不超过请求有效期。本轮只验证了编译、重定向拒绝、输入判定及系统映像只读租约；**正向真人本地控制台流程未实测**，没有自动输入短语或制造 native 授权。原生启动规则未知时仍不显示可执行启动面板。

启动历史仅在本进程确认持久消费成功后发布，绑定原 profile/approval 和消费时的报告祖先身份。报告先收尾、后排他发布；不覆盖外来目标，不含 nonce、原始环境或短语。历史读取永远 stale/not_live，不恢复 session、停止权限或旧验收能力。未消费与确认前取消不产生报告。

## 实际验证

使用已核 SHA256 的 Bun 1.3.14，命令均带 `--no-env-file`，在 `D:\OpenCode-Audit\packages\benchmark` 运行。HOME、XDG、APPDATA、TEMP、Bun/npm/Go 缓存均位于本次专属 D 临时根；禁用真实 provider/集成开关，不读取真实 Key 或 `.env.local`。

| 验证                                                             | 实际结果                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 开始时完整基线                                                   | 375 pass /10 既有 skip /0 fail /1594 assertions /98 files                                 |
| NC1 完整回归                                                     | 378 pass /10 skip /0 fail                                                                 |
| NC2 完整回归                                                     | 383 pass /10 skip /0 fail                                                                 |
| NC3 完整回归                                                     | 388 pass /10 skip /0 fail                                                                 |
| NC4 完整回归                                                     | 393 pass /10 skip /0 fail                                                                 |
| NC5 完整回归                                                     | 398 pass /10 skip /0 fail                                                                 |
| NC6 完整回归                                                     | 404 pass /10 skip /0 fail /1902 assertions /104 files，129.42s                            |
| NC7 审查修复后六组联合测试                                       | 50 pass /0 fail /400 assertions，103.49s                                                  |
| NC7 审查修复后完整回归                                           | 411 pass /10 既有 skip /0 fail /1930 assertions /104 files，135.82s                       |
| 包内源码 typecheck                                               | 退出0                                                                                     |
| 纳入源码、全部 linux-host 测试及三个 CLI 脚本的 scoped typecheck | 退出0                                                                                     |
| 本轮源码、测试与入口格式检查、git diff --check                   | 退出0                                                                                     |
| 拦截器下的合成 CLI 联合路径                                      | 3 pass /26 assertions；真实 Docker 0、WSL 0、外部 fetch 0；仅5次固定自有/系统 helper 调用 |

实际测试命令为：

```powershell
& $NativeCliBun --no-env-file test ./test/linux-host/desktop-bindings.test.ts ./test/linux-host/desktop-native-query.test.ts ./test/linux-host/desktop-native-audit.test.ts ./test/linux-host/desktop-confirmation.test.ts ./test/linux-host/desktop-interactive-command.test.ts ./test/linux-host/desktop-inventory.test.ts --timeout 30000
& $NativeCliBun --no-env-file test --timeout 30000 --only-failures
& $NativeCliBun --no-env-file run typecheck
& $NativeCliBun --no-env-file run typecheck --project "$NativeCliTemp\tsconfig.native-cli.json"
```

各任务新增用例先运行并观察到预期失败，再实现和重跑；没有删除旧断言、增加 skip 或扩大旧测试时限。NC4 原有防并发写入用例还捕获了只申请属性读取权限的回归；最终只读句柄包含 FILE_READ_DATA、不申请 DELETE，并继续拒绝并发修改。相关共享规则见 [Microsoft CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)。NC7 将原输入分支提取后复现 Shift 被拒绝（helper exit10），再修正修饰键、重复次数和长度边界，真实共享输入逻辑 RED→GREEN。

原10项 skip 与[既有交付](2026-10-18-task24b-d-drive-docker-launch-verification.md)一致：真实二进制安全隔离1、八点崩溃恢复1、浏览器集成5、隐藏输入隔离1、daemon 容器超时收尾1、浏览器 PDF 字节一致1。对应旧测试文件未改；它们不计为已完成真实验收。

## 原生门禁仍关闭

审查修复后重新运行合成 CLI 拦截验证，3项通过、26条断言，6.63s；三个外部 transport 计数仍为0。这是指定入口和夹具路径的计数，不是 OS 全局拦截证明。实际运行 `bun --no-env-file ./script/desktop-launch.ts` 无参数入口，退出2、`operation_required`、三项 readiness=false，没有查询或启动已安装 Docker/WSL。

原生 start/stop 继续明确拒绝，不猜测 argv 或停止通道。当前必须保留：

- `path_routing_unproved`：完整前后端、服务、日志与缓存落点未证明。
- `backend_environment_unproved`：服务与后端全链路环境传递未证明。
- `registration_reuse_unproved`：准确原注册与两块盘的完整复用流程未证明。
- `stop_owned_unproved`：候选 `/app/quit` 的完整收尾范围未证明。
- `settings_mutation_unproved`：设置自动重写与严格原合同兼容性未证明。
- `existing_workload_restart_unproved`：旧盘容器 restart policy 的恢复行为未证明。
- `automatic_behavior_unproved`：下载、升级、许可、服务写入等自动行为未证明。

代码已接入受限的真实离线 CLI 查询，但本轮没有执行已安装 Docker CLI、native audit、WSL list 或真实进程/管道观察。因此不把合成 CLI 输出冒充本机新证据；离线查询无法完成时仍有 `cli_default_unproved`。地址解析差异继续按[此前实测](2026-10-18-task24b-dl6-native-evidence-and-checklist.md)保留 `production_default_compatible=false`，不推断两个地址一定对应不同 daemon，不修改生产连接；新诊断未采样时值为 null，而非默认 true。

## 保护对象核对

部署 `D:\OpenCode-Local\bin\opencode-local.exe` SHA256 仍为 `ff814205889f709c3374aaa855f3f17be1974bac9e86893e8c62d5e7de4fe9ce`；真实 `.wslconfig` SHA256 仍为 `6a6432a0a5a905c76a7a4ae381deb63eec6c700f34741ab238ab71aa383d92e9`，身份与89字节大小未变。

旧 C 盘 Local/Docker、Roaming/Docker、Roaming/Docker Desktop 三目录均为普通目录，最后修改时间分别保持 `2026-10-06T15:39:42.7418802Z`、`2026-10-06T15:39:40.8646486Z`、`2026-10-11T15:41:07.2115588Z`。没有复制、迁移、删除、恢复或改 ACL；元数据比对不等于 OS 级零写入审计。

只读读取原注册 key `{df0675a2-c53b-4596-b91e-bbc3eb2eef63}` 的五个指定字段，仍为 docker-desktop、原 D main 路径、ext4.vhdx、Version2、build230596。没有枚举完整注册内容或改注册。

| VHD                   | fileID                                           | 大小        | 本轮前后 mtime UTC         |
| --------------------- | ------------------------------------------------ | ----------- | -------------------------- |
| runtime ext4.vhdx     | `2162922028:3940649673950210:1782392352710.1821` | 100663296   | `2026-10-18T03:20:33.666Z` |
| data docker_data.vhdx | `2162922028:1125899906862401:1782392356625.817`  | 13847494656 | `2026-10-11T15:42:22.791Z` |

两盘 volumeID 均为 `2162922028`；仅取文件元数据，不读盘内数据、挂载、复制或整盘 hash。真实 `control\desktop-launch`、`toolchain\docker-launch-dd479` 与 `reports\desktop-launch` 三处均不存在，没有为软件测试创建这些正式目录。

## 实现决策及后续边界

按执行计划记录四项最小实现决策：共用有界系统 transport（增加内部模块维护面）；复用句柄发布器提供只读映像租约（增加一种只读布局维护面）；只为固定系统 PowerShell 延长只读租约到75秒以容纳最多60秒确认（增加受限 C 只读分支，不允许 C 写入）；在消费时绑定报告祖先并保留失败收尾事实（增加只读事实登记，不改租约、重试或停止算法）。

一次独立整体审查提出5项 Important，无 Critical/Minor；修复覆盖报告父目录交换/意外创建、继承管道与自有后代进程收尾、系统映像和跨查询 WSL 映像漂移、原始失败与已知残留信息丢失、TEMP 所有权及祖先身份绑定。每项先复现再修复：真实 PowerShell 创建的继承管道后代在旧逻辑取消后仍耗时1997ms，超过1500ms断言；新逻辑通过自有 unnamed Windows Job 回收，不按名称或 PID 猜测清理。固定源码在私有 stdin 传入并校验编译前摘要，避免 Windows 命令行长度限制。编译前用内存 P/Invoke 创建自包含 Job 并固定 D TEMP/owner 句柄；环境不满足时失败关闭，无路径降级。

审查未作判断的6项由本次实现承担明确边界，不冒充已验证：

1. 原生生命周期仍未证明，保持阻断；代价是实际使用前仍需补证和另行批准。
2. 正向真人控制台/终端 UX 未实测，不自动输入确认；代价是可能仍有终端兼容问题。
3. 本机运行与保护对象核对是执行者的有界证据，不是独立真实运行或 OS 零写入审计；代价是实际运行副作用仍待后续验证。
4. 同 SID 恶意程序/管理员不在认证保证内；代价是确认入口不能提供敌对同用户环境下的密码学真人认证。
5. 不重设计旧生命周期/停止算法；代价是原有生命周期局限保留，本轮只补 transport 与诊断。
6. 草稿、提交、push、清理分开取证，不把未执行操作写成成功；代价是缺少实际证据的交付项必须明确保留未完成。

本轮提交使用正常 hooks；远端 `dev` 与本地 HEAD 的实际核对结果由同次交付消息给出，不将报告中的历史基线当作当前远端。清理仅限本次明确 owner 临时根和本计划工作日志；此前被拒绝清理的旧目录不重试，不换接口绕过。源码、规格、计划与本报告保留；精确清理结果在交付时报告，删除被拒绝则保留并列出，不绕过。

真实准备须等证据门禁通过，并另批准确清单与本地确认；真实启动还须再次另批。Linux Docker 验收、校准、真实执行循环、付费跑分及部署替换仍未执行，三项 readiness 始终为 false。
