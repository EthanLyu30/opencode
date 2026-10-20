# Task24B CV1 厂商契约有界取证与裁决

实际执行日期：2026-10-20，Asia/Shanghai。基线：`dev / 156055ed9709adfa62555f3317b3b44c4d97cced`。依据[已确认规格](../specs/2026-10-20-task24b-vendor-contract-target-version-design.md)及[CV1计划](../plans/2026-10-20-task24b-cv1-vendor-contract-evidence.md)。用户本次明确批准CV1有界官方材料取证、报告验证、提交和正常push；旧文档成文时“未批准执行/不push”不覆盖本次新授权，其他限制保持。

Task1有限检索已结束：两条冻结查询均未返回结果，其中Q1首次连接失败、原样重试一次后为零结果；无选定官方原文，材料集合为空。尚待本报告后续义务/反例及最终裁决提交。**操作状态始终blocked，本机适用性unknown。** 本包不执行CV2–CV4、NW2–NW13，不做外联、系统元数据查询、安装/原盘文件读取、实验或启停；不改变旧C目录或部署。

## Inputs

开始检查为dev、正常checkout，`.git`为git-dir/common-dir，无submodule；工作区仅既有旧未跟踪报告。新报告和本包技能中间根此前均不存在。用户没有提供新厂商材料，`suppliedSources=[]`；不接收保密/本地附件，不联系厂商。

以下摘要是本轮对准确仓库文档原始字节的核对，不是系统或安装取证；既有文件均不修改：

| id / 输入                                                                                            | SHA256                                                             | 作用及限制                                                         |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| R1 `docs/superpowers/specs/2026-10-20-task24b-vendor-contract-target-version-design.md`              | `2d7eeb78f89d7b76cb35f1633c692ec7dcb27b3c15937d428eb7abba12d97628` | 已确认K1–K8及分级授权；不是厂商实现                                |
| R2 `docs/superpowers/plans/2026-10-20-task24b-cv1-vendor-contract-evidence.md`                       | `cbf1b6323da124edf6f489291294a1d26d4f63191e6ec8e5a7c30db6eb4bd68b` | 3任务15步、冻结查询/预算/停止规则；不是执行许可来源                |
| R3 `docs/superpowers/reports/2026-10-19-task24b-native-handoff-source-applicability-verification.md` | `3f3bb4cfbbeb3a9ce305cc410dac66b0bd73b516efc6aedc3ead8a3c58c81847` | HS历史来源/反例/偏差；不复用为新增契约，不复采安装                 |
| R4 `docs/superpowers/reports/2026-10-19-task24b-dl6-native-followup-and-operation-checklist.md`      | `cc19867992978e3dcf10c2a9b896031fde36df8ce20e8e7c29d6c830fbfebe07` | 仅核摘要；原样未跟踪，不stage/移动/ignore/清理，保留clean-tree阻断 |

历史Desktop `4.79.0 / 230596`、backend摘要及七成员canonical pin仅引用R3作寻址；本轮没有访问安装、重新核hash或取得当前Windows/WSL/HCS/卷事实。HS误采三函数继续排除；HS及其他旧中间根均不读、不复用、不再清理。

### 取证前预列命题和拒绝条件

K1连续OPEN_EXISTING/只读/deny-write-delete共享/父链保护；K2准确controller/request/nonce→进程句柄/创建时间/SID/映像/VM绑定；K3双盘整体准入；K4其他writer/mapping/路径竞争排除；K5取消/超时/部分失败/崩溃全分支；K6晚到请求撤销、完整有界join和仅归属收尾；K7准确构建适用范围（本机匹配另批）；K8不需升级/补丁/驱动/ACL/share/服务变化或预取可写句柄。

C1先解锁再打开不接受；C2第一盘先可写而第二盘失败不接受；C3不能认定首writer为授权者；C4不能凭同PID/假pipe认定VM/进程；C5取消后晚到writer必须可终止；C6持有者关闭/崩溃不等于等待者取消；C7已有mapping/父链替换须有拒绝保证；C8不以普通break/ACK概括全部create；C9需要改变边界不实施；C10 helper/网页/签名/hash/旧报告均不产生许可。以上先于本轮查询列出，不是已运行的实验。

## Search

使用R2冻结查询，未改词、翻译、变更检索范围或追加搜索引擎。表内时间是请求发起前由工具取得的UTC时间，不是厂商发表时间：

| 查询 / 次数 | 发起时间（2026-10-20 UTC） | 原样query                                                                                                                   | 实际结果 / 前4结果URL / 处理                                                                                          |
| ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Q1 首次     | 14:29:39                   | `site:docs.docker.com "4.79" "disk" ("handoff" OR "transaction" OR "reservation")`                                          | 工具连接失败：`connection failed: error sending request`；未取得结果/URL。只允许同源原样重试一次                      |
| Q1 唯一重试 | 14:30:17                   | `site:docs.docker.com "4.79" "disk" ("handoff" OR "transaction" OR "reservation")`                                          | 工具返回 `Empty search results / No results were found for the provided queries`；URL列表为空，不向后补位、不放宽条件 |
| Q2 首次     | 14:30:31                   | `site:learn.microsoft.com/virtualization/api/hcs ("disk" OR "VHD") ("transaction" OR "reservation") ("cancel" OR "commit")` | 同样返回零结果；URL列表为空；此为正常零结果而非连接失败，不重试                                                       |

共2条不同查询、3次搜索请求（含1次连接失败及唯一重试）；没有任何结果可供查看前4项，候选URL并集为空。未执行网页open/click、官方原文HTTP取得、tag/commit定位或源码请求，未产生来自标题/摘要的正向契约结论，也没有排除某个已取得页面却声称其全文无契约。

**零结果只是这两条有限查询的实际结果，不是全网无资料、厂商不支持或机制永远不可能的证明。** 首次网络失败不隐藏；成功重试仍不能把搜索服务覆盖率当作来源完整性。

## Sources

`SourceRecord=[]`：没有选定或取得任何新官方原文，不创建虚假的S1–S8记录，不填零hash或用搜索消息摘要假作厂商源码摘要。官方出处、revision/适用构建、完整原文、sha256、命题位置均 **missing：冻结查询未给出候选URL，亦无用户提供的新厂商材料**。

| 预算项                 |         上限 | 本轮实际                           |
| ---------------------- | -----------: | ---------------------------------- |
| 不同冻结查询           |            2 | 2                                  |
| 搜索失败重试           |  每条最多1次 | Q1为1次；Q2为0次                   |
| 官方文本材料/定位响应  |          8份 | 0份，未占用S编号                   |
| 单份官方原文实际响应   |  2097152字节 | 未请求，无单份响应                 |
| 官方材料合计实际响应   | 16777216字节 | 0字节；没有原文/重试/重定向响应    |
| 官方来源失败/重试      |  同源最多1次 | 没有来源取得尝试；搜索失败单列上表 |
| 持久原文/安装副本/缓存 |         禁止 | 未创建                             |

“官方材料0字节”不等于全部网络通信0字节：搜索服务请求/返回消息确实发生，其传输字节工具未提供；消息仅为检索记录，不充当官方材料，不声称原始HTTP已量测。没有候选来源，故未触发原文流式预算/pin验证，不把这些未执行检查标为通过。

材料取得至此收口，剩余8份名额不是继续探索的理由。后续Task2/Task3只完成缺证的义务、反例、未发送问题稿及停止报告；不追加查询，不转CV2或外联。
