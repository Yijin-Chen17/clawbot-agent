# Clawbot 业务逻辑审查与流程重设计

审查基线为 `04ff512`（2026-11-23）。重设计见[业务逻辑流程](business-flow.drawio.svg)与[任务处理逻辑流架构](task-processing.drawio.svg)。优先修复三处写入边界：任务进度由谁更新、计划何时生效、提醒何时算送达。否则，即使排程算法找到合理时段，重排、打卡或投递失败仍会让用户看到错误的结果。

## 项目现在怎样运转

| 入口 | 实际执行路径 | 用户最终看到什么 |
| --- | --- | --- |
| 注册、登录、设置 | 邮箱验证码 → 写用户和设置 → 签发 JWT；网页 API 每次读取账号状态；设置页自动保存 | 个人控制台、模型模式、工作时段、提醒与日历订阅 |
| 网页任务 | 四象限工作区 / 日历表单 → 任务 API → 可选模型估时与拆段 → SQLite → 全用户重排 | 看板重新计算分数，日历读取任务与外部事件 |
| 扫码微信 | 绑定 → 每用户长轮询 → 首次激活、快捷指令或模型解析 → 追问、改单或调整建议 → 写库 → 微信回复 | 文字回执、周历和待办卡片 |
| Webhook | 回调 Token → 单独的模型解析与任务处理器 → 回推并返回 HTTP 回复 | 与扫码微信共用数据库和会话表，但命令覆盖不同 |
| 计划与提醒 | 工作时段扣除占用 → 独占 / 并行轨 → 14 天滚动安排 → 写首尾和分段；每 30 秒运行日切、提醒与同步检查 | 工作块、开始提醒、结束确认、部分排入或待安排 |
| 外部日历 | 定时 / 手动拉取 ICS → 在事务内替换该订阅事件 → 重排；另一路用任务生成可订阅 ICS | 外部忙时与本地待办；导入、导出是两条独立数据流 |
| 管理与计费 | 审核、封禁、绑定诊断、模型主备、充值 / 兑换 → 调用模型 → 用量入库、官方余额扣减 | 账号权限、余额、统计、调试结果 |

入口核对：[App L111](../client/src/App.tsx#L111)、[api L56](../server/src/routes/api.ts#L56)、[index L32](../server/src/index.ts#L32)。四象限主界面实际从 API 加载任务（[EisenhowerWorkspace L376](../client/src/components/EisenhowerWorkspace.tsx#L376)）。库中另有 localStorage 任务 Hook，本报告对线上行为的判断以挂载入口为准。

## 怎么改图

直接打开 SVG 可查看全图。在 draw.io 中选择“文件 → 从设备打开”，选择要修改的图，双击节点改文字，拖动节点改布局，拖动箭头端点改连接。保存或导出 SVG 时保留嵌入的图表数据，即可继续编辑。[图表编辑器](https://app.diagrams.net/) · [可编辑 SVG 格式说明](https://www.drawio.com/docs/manual/export/export-to-svg/)

| 可编辑主图 | 阅读重点 |
| --- | --- |
| [业务逻辑流程](business-flow.drawio.svg) | 用户怎样提出需求、看到可执行的安排、决策冲突、报进度，以及日历变化或每日到期如何影响安排 |
| [任务处理逻辑流架构](task-processing.drawio.svg) | 一条命令怎样在接入、解析、实例服务、规划器、版本提交和投递之间流转；每个环节读写什么，异常回到哪里 |

P1 表示可能改错数据、突破承诺、造成丢失或产生错误费用，P2 表示结果不一致、错误反馈或恢复困难。标有 **实测** 的条目有隔离数据复核，其余为静态路径推导。涉及部署方式的情况已写明前提。

## 指令、对话与绑定

| 编号 | 触发条件与实际后果 | 目标行为及代码位置 |
| --- | --- | --- |
| M01 · P1 | 用户点名的任务没找到时，扫码入口回退到首个进行中或已排任务。修改时空名称也能匹配最新任务；删除时同名取最新，优先删任务，忽略已解析的类型和日期。Webhook 状态更新直接取首项。 | 先按类型、日期、回复关联筛选，再让用户选择唯一 ID；没匹配保留原状。[weixinGateway L872](../server/src/services/weixinGateway.ts#L872)、[weixinGateway L959](../server/src/services/weixinGateway.ts#L959)、[weixinGateway L1001](../server/src/services/weixinGateway.ts#L1001)、[webhookController L73](../server/src/controllers/webhookController.ts#L73) |
| M02 · P1 | 回调重送没有消息去重。扫码轮询在逐条处理前推进整批游标；中途退出会跳过后续消息。业务完成后回推失败也没有可恢复的回复记录。 | 消息唯一键与批次入箱一同持久化，再推进游标；命令和回复各自去重。[webhookController L34](../server/src/controllers/webhookController.ts#L34)、[weixinGateway L1537](../server/src/services/weixinGateway.ts#L1537)、[weixinGateway L1565](../server/src/services/weixinGateway.ts#L1565) |
| M03 · P2 | 两种微信入口都向未指定期限的普通灵活任务追问截止。扫码默认重要度、Webhook 会追问；Webhook 缺少修改、删除、部分完成、取消的完整分支，某些状态动作得到空回复。 | 统一命令表与必填字段，允许无截止的灵活任务，未知动作返回可执行选项。[weixinGateway L1104](../server/src/services/weixinGateway.ts#L1104)、[weixinGateway L1147](../server/src/services/weixinGateway.ts#L1147)、[webhookController L69](../server/src/controllers/webhookController.ts#L69)、[webhookController L210](../server/src/controllers/webhookController.ts#L210) |
| M04 · P1 | 两条通道仅按用户共享一条会话草稿。Webhook 读取时忽略意图；补问和确认缺少版本、过期时间，并有先删草稿后写任务的路径。并发消息或写入失败可能覆盖或丢失上下文。 | 草稿绑定会话、意图、版本和期限，按会话排序消费，业务写入成功再消费草稿。[database L100](../server/src/config/database.ts#L100)、[webhookController L50](../server/src/controllers/webhookController.ts#L50)、[weixinGateway L565](../server/src/services/weixinGateway.ts#L565)、[weixinGateway L1174](../server/src/services/weixinGateway.ts#L1174) |
| M05 · P2 | 首条扫码消息即使是建任务也只返回欢迎。解除绑定没有清除激活时间、上下文及旧收件人；凭证失效时停止 worker，却仍可在状态页显示已连接。 | 首条有效指令照常执行；解绑清理投递上下文，凭证失效转为“待重新绑定”。[weixinGateway L433](../server/src/services/weixinGateway.ts#L433)、[weixinController L31](../server/src/controllers/weixinController.ts#L31)、[weixinController L62](../server/src/controllers/weixinController.ts#L62)、[weixinGateway L1524](../server/src/services/weixinGateway.ts#L1524) |
| M06 · P2 | 非固定任务的扫码成功回执也传入固定标记；两种入口改单重排后仍可能回复单次试排时间。Webhook 对处理异常仍回 success，扫码新建在最终时段为空时会回退到试排时间。 | 根据提交结果的任务 ID、版本和状态构建一次回执，区分已安排、待安排和处理失败。[weixinGateway L938](../server/src/services/weixinGateway.ts#L938)、[weixinGateway L1303](../server/src/services/weixinGateway.ts#L1303)、[webhookController L127](../server/src/controllers/webhookController.ts#L127)、[webhookController L280](../server/src/controllers/webhookController.ts#L280)、[webhookController L329](../server/src/controllers/webhookController.ts#L329) |
| M07 · P2 | 解析结果只做 JSON 解析和类型断言。固定意图缺开始可能被转为非固定；缺有效结束会进入追问，但模板没有固定起止的提问项。分数已经是百分制时仍按数值大小猜旧量纲。 | 用共享命令契约验证类型、单位、时间和分值版本，逐项说明缺什么。[llm L284](../server/src/services/llm.ts#L284)、[fixedTaskTime L9](../server/src/services/fixedTaskTime.ts#L9)、[clawbot L18](../server/src/services/clawbot.ts#L18)、[weixinGateway L1110](../server/src/services/weixinGateway.ts#L1110) |
| M08 · P1 | 消息入口按回调 Token 或 worker 所属账号写数据；回调只在收件人为空时记录发送者，后续未核对绑定关系；扫码仅过滤机器人自己的消息。是否出现其他发件人取决于上游。 | 入箱时验证通道、绑定和发件人，按真实对话隔离上下文。[webhookController L25](../server/src/controllers/webhookController.ts#L25)、[weixinGateway L1547](../server/src/services/weixinGateway.ts#L1547)、[weixinGateway L405](../server/src/services/weixinGateway.ts#L405) |

## 任务、排程与进度

| 编号 | 触发条件与实际后果 | 目标行为及代码位置 |
| --- | --- | --- |
| T01 · P1 | 四象限表单有“硬截止”，保存载荷却遗漏 deadline_kind；载入仅保留日期，已有精确时间编辑后可能变成当日末。相同弹窗在日历入口会传硬截止。标签也在表单收集后丢失。 | 共用读取 / 保存映射；逐字段往返校验截止种类、时分和标签。[TaskModal L309](../client/src/components/TaskModal.tsx#L309)、[EisenhowerWorkspace L337](../client/src/components/EisenhowerWorkspace.tsx#L337)、[EisenhowerWorkspace L546](../client/src/components/EisenhowerWorkspace.tsx#L546)、[CalendarView L382](../client/src/components/CalendarView.tsx#L382) |
| T02 · P1 | 新建固定任务仅凭首尾存在就标为已排，没有统一校验正向区间、分钟数匹配和固定占用冲突。更新接口缺少创建接口的耗时范围检查，允许直接写状态；微信修改固定时间只改首尾，重排可从旧块还原旧时间。 | 所有入口共用约束与状态迁移，固定时间修改同时替换对应块。[taskController L93](../server/src/controllers/taskController.ts#L93)、[taskController L183](../server/src/controllers/taskController.ts#L183)、[taskController L269](../server/src/controllers/taskController.ts#L269)、[taskController L394](../server/src/controllers/taskController.ts#L394)、[weixinGateway L1036](../server/src/services/weixinGateway.ts#L1036)、[scheduler L1068](../server/src/services/scheduler.ts#L1068) |
| T03 · P1 · **实测** | 同一固定块重排后，进行中变回已排期，已发提醒标记消失。非固定的进行中任务还会重新参与选位。重排逐任务写入，常规调用未用事务包住整版。 | 保留已开始、已完成事实；仅替换未来可移动块，一个计划版本一次提交。[scheduler L947](../server/src/services/scheduler.ts#L947)、[scheduler L1051](../server/src/services/scheduler.ts#L1051)、[scheduler L1154](../server/src/services/scheduler.ts#L1154)、[scheduler L1168](../server/src/services/scheduler.ts#L1168) |
| T04 · P1 · **实测** | 日历点某一节只传任务 ID。服务端找不到指定分段、号码已过期或没有可认领的块时，仍默认减最多 60 分钟；60 分钟任务传第 99 段会直接完成。跨天分段序号按天重新计数，更容易点错。 | 用稳定的块 / 实例 ID 和进度事件键；过期返回新计划，重复提交回原结果。[CalendarView L912](../client/src/components/CalendarView.tsx#L912)、[scheduler L808](../server/src/services/scheduler.ts#L808)、[scheduler L1713](../server/src/services/scheduler.ts#L1713)、[scheduler L1729](../server/src/services/scheduler.ts#L1729) |
| T05 · P1 · **实测** | 延长直接追加在最后一段，再要求重排保留该任务。实测能比硬截止晚 30 分钟；也未先检查正在延长的块、同轨固定事件、工作窗口及任务终态。 | 带当前实例与块试算延长，校验失败保留原计划，冲突交给用户。[scheduler L1839](../server/src/services/scheduler.ts#L1839)、[scheduler L1856](../server/src/services/scheduler.ts#L1856)、[scheduler L1866](../server/src/services/scheduler.ts#L1866) |
| T06 · P1 · **实测部分** | 网页完成每日任务只写当天打卡，仍符合提醒查询条件；两种微信“完成”都会终结整项。部分完成仅对带锁的每日任务走打卡路径。普通任务整项完成或最后一段完成后也没立即重排待办。 | 每日模板生成日期实例；所有渠道更新同一实例，释放剩余时段，取消后续提醒并触发重排。[taskController L570](../server/src/controllers/taskController.ts#L570)、[weixinGateway L901](../server/src/services/weixinGateway.ts#L901)、[webhookController L85](../server/src/controllers/webhookController.ts#L85)、[scheduler L1686](../server/src/services/scheduler.ts#L1686)、[scheduler L1736](../server/src/services/scheduler.ts#L1736)、[reminder L103](../server/src/services/reminder.ts#L103) |
| T07 · P1 | Web 建任务直接全局重排；扫码会提出换位建议。确认逻辑使用旧方案逐项写，缺少版本、当前占用校验和事务；网页接口甚至接受客户端给出的完整时段。拒绝也可能采用已过期的备用试排。 | 服务端保存有期限的提案；以计划版本校验确认和拒绝，失效重新计算。[taskController L226](../server/src/controllers/taskController.ts#L226)、[taskController L484](../server/src/controllers/taskController.ts#L484)、[weixinGateway L589](../server/src/services/weixinGateway.ts#L589)、[weixinGateway L645](../server/src/services/weixinGateway.ts#L645)、[weixinGateway L1229](../server/src/services/weixinGateway.ts#L1229) |
| T08 · P2 | “提前截止天数”进入配置与调度参数，但实际选块未使用；日上限在送入优化器前加了 30 分钟。全局和单任务对已有固定段的每日负荷取法也不同。 | 明确目标提前日期和每日容量单位；预览与正式排程共享约束及扣减方式。[scheduler L797](../server/src/services/scheduler.ts#L797)、[scheduler L901](../server/src/services/scheduler.ts#L901)、[scheduler L1136](../server/src/services/scheduler.ts#L1136)、[scheduler L1440](../server/src/services/scheduler.ts#L1440) |
| T09 · P2 | 重排主要刷新每日任务紧迫度；普通任务仍用持久化分数判是否属于被过滤的第四象限。看板每分钟重算且把分段首尾间的空档也算忙，后端按真实块扣除并排除并行轨。看板显示变急不保证任务进入排程。 | 排程和视图在相同时区、同一时点从真实块计算分数及原因。[scheduler L785](../server/src/services/scheduler.ts#L785)、[scheduler L982](../server/src/services/scheduler.ts#L982)、[scheduler L448](../server/src/services/scheduler.ts#L448)、[EisenhowerWorkspace L194](../client/src/components/EisenhowerWorkspace.tsx#L194)、[EisenhowerWorkspace L301](../client/src/components/EisenhowerWorkspace.tsx#L301) |
| T10 · P2 | 软截止部分排入只在本次汇总计数，任务仍写 scheduled，失败任务又被结果明细查询排除。搜索预算耗尽与确实放不下也没有不同的对外结果；更新接口直接回复“已排程”。 | 记录已分配 / 未分配分钟及原因，区别容量不足、策略过滤、窗口或搜索限制；由持久结果生成响应。[scheduler L1183](../server/src/services/scheduler.ts#L1183)、[scheduler L1206](../server/src/services/scheduler.ts#L1206)、[calendarOptimizer L138](../server/src/services/calendarOptimizer.ts#L138)、[taskController L431](../server/src/controllers/taskController.ts#L431) |
| T11 · P2 | 编辑先改任务，再等待模型重新给出分段。第二次编辑可先完成，晚返回的旧结果仍覆盖分段。修改耗时、部分完成、延长和重开共用 duration_minutes，却没有对应地维护原始估算和已完成工时。 | 估算、投入与剩余分开保存；模型结果带任务版本，过期丢弃。[taskController L375](../server/src/controllers/taskController.ts#L375)、[taskController L421](../server/src/controllers/taskController.ts#L421)、[taskController L632](../server/src/controllers/taskController.ts#L632)、[scheduler L861](../server/src/services/scheduler.ts#L861)、[scheduler L1747](../server/src/services/scheduler.ts#L1747)、[scheduler L1857](../server/src/services/scheduler.ts#L1857) |
| T12 · P2 | 固定每日事项会在调度内投影未来占用，但任务只保存一组当前首尾，日切覆盖日期。浮动每日只在今天入选；导出只按现存块生成事件。未来日历不一定能看见已预留的习惯时段，过往也难以回溯。 | 建立“模板＋本地日期”的实例键，调度、历史、日历和导出共享实例。[scheduler L298](../server/src/services/scheduler.ts#L298)、[scheduler L784](../server/src/services/scheduler.ts#L784)、[scheduler L984](../server/src/services/scheduler.ts#L984)、[calendarSync L166](../server/src/services/calendarSync.ts#L166) |
| T13 · P2 | 模型估时发生在部分截止校验之前，显式耗时也会走规划（与 README 的“仅微信调用”约定冲突）。创建先插入、再写分段和重排，后半段失败时重试可能创建重复任务。auto_schedule 被接收但未参与决策。 | 先校验；模型工作按用途及费用策略执行一次；命令、任务、重排请求原子落库。[taskController L84](../server/src/controllers/taskController.ts#L84)、[taskController L101](../server/src/controllers/taskController.ts#L101)、[taskController L195](../server/src/controllers/taskController.ts#L195)、[taskController L227](../server/src/controllers/taskController.ts#L227) |

## 日历、提醒与数据恢复

| 编号 | 触发条件与实际后果 | 目标行为及代码位置 |
| --- | --- | --- |
| C01 · P1 | 周期事件只展开 RRULE，未合并单次取消、改期例外或透明忙闲标记。展开单个系列出错只记警告，仍提交快照并记同步成功。微信删除外部事件只删本地，下次同步可能重新出现。 | 按订阅、UID、实例时间归并例外；校验完整后切换快照。只读源允许本地忽略实例，并标明范围。[calendarSync L38](../server/src/services/calendarSync.ts#L38)、[calendarSync L50](../server/src/services/calendarSync.ts#L50)、[calendarSync L96](../server/src/services/calendarSync.ts#L96)、[weixinGateway L980](../server/src/services/weixinGateway.ts#L980) |
| C02 · P1 | 开始和结束提醒都先写已发再发送，返回失败也打印成功；无任何可用通道时只打印却返回成功。提前提醒还会把任务直接改成进行中。 | 按块和提醒类型记待投递，网关接受后记已投递；开工由独立事件确认。[reminder L123](../server/src/services/reminder.ts#L123)、[reminder L150](../server/src/services/reminder.ts#L150)、[reminder L189](../server/src/services/reminder.ts#L189)、[clawbot L181](../server/src/services/clawbot.ts#L181) |
| C03 · P2 | 只能在开始后 3 分钟、结束后 15 分钟内补发。30 秒轮次串行等待推送和同步；失败订阅不更新最近尝试时间，下一轮可立即重试。并行的手动和定时同步缺少订阅版本，较旧响应可覆盖新快照。 | 投递与同步独立执行；持久化已过期、重试时间及快照代次。[reminder L40](../server/src/services/reminder.ts#L40)、[reminder L68](../server/src/services/reminder.ts#L68)、[reminder L237](../server/src/services/reminder.ts#L237)、[calendarSync L25](../server/src/services/calendarSync.ts#L25) |
| C04 · P2 | 添加订阅返回的是同步前读取的记录；全量同步吞掉各订阅错误，全数失败仍可回复“同步与自适应排程完成”。删除订阅释放忙时后没有重排。 | 返回各订阅结果及快照时间；增删或内容变化才触发一次重排，保留失败订阅上次可用数据。[calendarController L48](../server/src/controllers/calendarController.ts#L48)、[calendarController L70](../server/src/controllers/calendarController.ts#L70)、[calendarController L285](../server/src/controllers/calendarController.ts#L285)、[calendarSync L121](../server/src/services/calendarSync.ts#L121) |
| C05 · P2 | 自然语言“今日日程”按任务首次开始筛选，可能漏掉昨日开始、今天继续的分段，也没有读取外部事件；任务区间命中日历 API 后却会返回它的所有分段。待办卡片只统计截取的 12 项，并使用旧 pending 状态。 | 所有渠道共享按块与查询区间相交的读模型；总数单独统计。[webhookController L142](../server/src/controllers/webhookController.ts#L142)、[weixinGateway L1082](../server/src/services/weixinGateway.ts#L1082)、[calendarController L139](../server/src/controllers/calendarController.ts#L139)、[calendarController L187](../server/src/controllers/calendarController.ts#L187)、[cardRenderer L713](../server/src/services/cardRenderer.ts#L713) |
| C06 · P2 | 模型和导出使用上海时区，排程、日切及无偏移表单时间按执行环境本地时区解释。服务器、浏览器异区或跨午夜时可错日。ICS 的提醒固定为 5 分钟，块 UID 按数组下标生成，重排后外部客户端可能把不同节次认作同一事件。 | 保存账户业务时区和稳定块 ID，瞬时时间统一入库；导出沿用提醒偏好。[llm L175](../server/src/services/llm.ts#L175)、[TaskModal L295](../client/src/components/TaskModal.tsx#L295)、[scheduler L112](../server/src/services/scheduler.ts#L112)、[reminder L71](../server/src/services/reminder.ts#L71)、[calendarSync L201](../server/src/services/calendarSync.ts#L201) |
| C07 · P1 | “完整 JSON 备份”导出的是看板投影，恢复逐项用普通创建接口，遗漏完成、每日、锁定、精确截止等字段。重复导入会增项，每条可能重新调用模型。弹窗没有等待导入完成就提示成功；清空逐条失败也会在本地清空。 | 版本化备份，先预览合并 / 替换，提交批次并返回逐项结果，成功后刷新一次。[BackupModal L76](../client/src/components/BackupModal.tsx#L76)、[BackupModal L85](../client/src/components/BackupModal.tsx#L85)、[EisenhowerWorkspace L730](../client/src/components/EisenhowerWorkspace.tsx#L730)、[EisenhowerWorkspace L751](../client/src/components/EisenhowerWorkspace.tsx#L751) |
| C08 · P2 | 看板删除成功后只移除该行，后端已重排其他任务，当前页面仍持有旧时段。快速新建在保存函数捕获错误后仍清空输入。 | 收到版本变更刷新受影响项；失败展示原因并保留用户输入。[EisenhowerWorkspace L569](../client/src/components/EisenhowerWorkspace.tsx#L569)、[EisenhowerWorkspace L617](../client/src/components/EisenhowerWorkspace.tsx#L617)、[EisenhowerWorkspace L715](../client/src/components/EisenhowerWorkspace.tsx#L715)、[taskController L451](../server/src/controllers/taskController.ts#L451) |

## 账号、设置、管理与费用

| 编号 | 触发条件与实际后果 | 目标行为及代码位置 |
| --- | --- | --- |
| A01 · P2 · 规则冲突 | README 说注册后待审，实际邮箱验证后直接 approved 并签发登录凭证，后台仍有审核队列。审批 / 解封也未限定来源状态，权限决策含义不清。 | 明确准入策略和合法状态迁移；注册、后台与说明共用同一选择。[README L9](../README.md#L9)、[authController L147](../server/src/controllers/authController.ts#L147)、[adminController L36](../server/src/controllers/adminController.ts#L36)、[adminController L131](../server/src/controllers/adminController.ts#L131) |
| A02 · P1 | 封禁在网页鉴权生效，但回调、已绑定 worker、日历公开订阅与提醒 / 同步作业未按账号状态统一检查。改密和找回密码只更新密码，既有 30 天会话仍按原凭证校验。 | 统一检查账号资格；封禁暂停用户作业、外部读写，改密增加会话版本并撤销旧会话。[auth L20](../server/src/middleware/auth.ts#L20)、[authController L78](../server/src/controllers/authController.ts#L78)、[authController L230](../server/src/controllers/authController.ts#L230)、[webhookController L26](../server/src/controllers/webhookController.ts#L26)、[weixinGateway L1481](../server/src/services/weixinGateway.ts#L1481)、[calendarController L262](../server/src/controllers/calendarController.ts#L262)、[reminder L224](../server/src/services/reminder.ts#L224) |
| A03 · P2 | 邮件发送前就创建可用验证码并计入冷却，SMTP 失败后用户仍需等待；重发未撤销旧码。注册码消费、建用户、建设置是分开的写入。 | 记录发信状态，仅最新成功发送的挑战可用；验证码消费和账号写入在同一事务内完成。[emailService L117](../server/src/services/emailService.ts#L117)、[emailService L137](../server/src/services/emailService.ts#L137)、[emailService L230](../server/src/services/emailService.ts#L230)、[emailService L261](../server/src/services/emailService.ts#L261)、[authController L147](../server/src/controllers/authController.ts#L147) |
| A04 · P1 · **实测** | 设置 API 对未提供字段填默认；只改结束提醒也会重置模型模式及其他偏好。真实设置页自动保存没有发送 outbound 地址、密钥、收件人，因此保存偏好会清除既有回推配置。页面每次都发送排程字段，还会触发不必要的全量重排。 | 只更新显式字段，与旧值比较后按影响范围触发变更；并发保存校验版本。[SettingsView L709](../client/src/components/SettingsView.tsx#L709)、[settingsController L124](../server/src/controllers/settingsController.ts#L124)、[settingsController L142](../server/src/controllers/settingsController.ts#L142) |
| A05 · P1 | 官方调用只检查余额为正，调用后分别写用量和扣款，并把余额截到零。余额不足一笔实际费用或多笔同时进行时，账单和实扣会不同；写账失败也没有持久待结算记录。 | 预留额度，记录费用上限与费率版本，以请求 ID 原子结算 / 释放，异常进入对账队列。[llm L159](../server/src/services/llm.ts#L159)、[llm L271](../server/src/services/llm.ts#L271)、[llm L297](../server/src/services/llm.ts#L297)、[llmPricing L212](../server/src/services/llmPricing.ts#L212) |
| A06 · P1 | 清除个人用量直接删除管理员统计的数据源；充值直接改余额，使用过的兑换码也可删除。兑换虽有事务，但 active 判断在事务外，更新没有状态条件；多进程共享数据库时有重复兑付风险。 | 独立不可变流水；个人清屏仅改可见范围，兑换在事务内条件认领并核对行数。[llmPricing L515](../server/src/services/llmPricing.ts#L515)、[llmPricing L680](../server/src/services/llmPricing.ts#L680)、[adminController L478](../server/src/controllers/adminController.ts#L478)、[adminController L585](../server/src/controllers/adminController.ts#L585)、[settingsController L258](../server/src/controllers/settingsController.ts#L258) |
| A07 · P2 | 界面把仅配置备用节点也算作已配置；解析在主密钥空时先报错，网页估时也未走聊天的备用切换。旧数据兼容逻辑在每次启动时重写部分用户选定的模型模式。 | 所有用途读取同一套健康节点及费用策略；历史迁移只运行一次。[settingsController L19](../server/src/controllers/settingsController.ts#L19)、[llm L161](../server/src/services/llm.ts#L161)、[llm L294](../server/src/services/llm.ts#L294)、[database L183](../server/src/config/database.ts#L183) |
| A08 · P1 | 管理员的“模拟来信”直接对选中用户执行正常处理，会改激活状态、写真实任务或消耗其模型额度。 | 默认在隔离快照上预演；明确发起的真实测试记录操作者与费用归属。[adminController L193](../server/src/controllers/adminController.ts#L193)、[weixinGateway L424](../server/src/services/weixinGateway.ts#L424)、[llm L271](../server/src/services/llm.ts#L271) |
| A09 · P2 | 注销和管理员删人直接删 users；兑换记录的创建人、使用人外键没有注销处理，关联账号可因约束失败。头像在独立文件目录，数据库级联不能清理该文件。 | 定义注销与账务保留规则，解除或匿名化关联，清理绑定、个人文件和会话，完成后再回执。[database L147](../server/src/config/database.ts#L147)、[authController L310](../server/src/controllers/authController.ts#L310)、[authController L461](../server/src/controllers/authController.ts#L461)、[adminController L164](../server/src/controllers/adminController.ts#L164) |
| A10 · P2 | 全局模型配置优先读文件，同时另写数据库；文件和数据库写异常被内部记录后继续。保存成功的回执可能和重启后的实际配置不同。 | 选定一个带版本的权威配置，提交成功后刷新副本；展示实际生效版本。[globalApiConfig L59](../server/src/services/globalApiConfig.ts#L59)、[globalApiConfig L74](../server/src/services/globalApiConfig.ts#L74)、[globalApiConfig L148](../server/src/services/globalApiConfig.ts#L148)、[adminController L341](../server/src/controllers/adminController.ts#L341) |
| A11 · P1 | 管理配置允许把非 DeepSeek 模型单价设为零，但计费读取使用数值或默认值，零会变成正费率。免费时段或免费模型可能有实际扣款。 | 仅在单价缺失或无效时回退；结算保存本次费率。[globalApiConfig L211](../server/src/services/globalApiConfig.ts#L211)、[llmPricing L123](../server/src/services/llmPricing.ts#L123)、[llm L280](../server/src/services/llm.ts#L280) |

## 目标规则与取舍

| 核心对象 | 谁能改什么 | 需要始终成立的约束 |
| --- | --- | --- |
| 任务、每日模板、日期实例 | 用户命令修改意图；日切按账户时区生成实例 | 一次性任务有独立实例；每日模板每个本地日期最多一个实例，完成某天不终结模板 |
| 实例进度事件 | 开始、部分完成、完成、取消、重开分别记录原因和目标 | 剩余工时由估算修订与有效进度推导；同一动作重试只生效一次；重开明确恢复多少工时 |
| 计划版、分段、提案 | 规划器产生候选；提交前检查账号、任务、日历及计划版本 | 进行中与已执行事实受保护；固定起止有效；独占任务避让外部忙时；并行轨内部互斥；硬截止必须完整满足 |
| 订阅与通知 | 外部日历提供按实例识别的忙时快照；投递服务消费已提交计划的通知 | 失败保留上版；取消、打卡、重排会撤销过期通知；“渠道已接受”与“用户已开始”可独立查询 |
| 模型、费用、批处理 | 模型产出待校验建议；账本登记实际调用；导入和模拟走专有命令 | 显式耗时可在模型不可用时继续；同笔调用最多结算一次；批处理输出可核对的成功、失败和跳过数 |

**图中采用的产品假设，可直接修改。** 邮箱验证后开放账号。未来未锁定的分段可自动安排，移动已向用户承诺的时段需要确认。拒绝后优先采用保留旧承诺的备选，无法安排则列入待办。“完成每日任务”只完成指定日期的实例。外部 ICS 提供只读忙时，渠道接受消息计为已投递，实际开工由用户确认。每日容量、提前天数、第四象限过滤和软截止容忍度属于可配置的排程策略。

## 验收与落地顺序

1. **先约束写入**。同一条任务从看板、日历、扫码和回调执行，应得到相同的任务 ID、实例和剩余时间。名称匹配两条时先列候选；重复完成同一节只扣一次。封禁后各入口和后台作业遵守同一资格判断。
2. **再统一计划**。给 10:00–11:00 的硬截止任务延长 30 分钟，冲突时保留原计划并列出可选动作；导入会议挤占未锁定块时只更新未来安排。提案等待确认期间插入另一会议，旧确认必须返回差异。模拟跨午夜、源日历取消单次周会、同步失败与重启。
3. **接上投递与账务**。渠道失败、进程重启和消息重送时可追踪处理结果；一条来信建一项任务且同笔模型调用只结算一次。提醒失败时允许重试或过期，任务仍保持原执行状态。外部渠道未提供幂等回执时保留“结果未知”，按回执核对后再决定补发。
4. **最后切换视图与备份**。各界面展示同一版计划、同一块、同一截止时间和硬度。将含每日打卡、部分完成、并行块、硬截止的备份导入两次，第二次给出跳过 / 冲突明细；资金和审计记录独立保存。
5. **存量过渡**。先从现有 tasks、schedule_blocks、completed_dates 回填任务、实例及计划，保留源 ID。无法从旧数据恢复的真实开始时间、历史投递和已投入工时标为未知。对同一份脱敏快照并行计算新旧计划，按占用冲突、截止违约、剩余工时和通知数对账后，再按用户切换写入入口。

**验证边界。** 已在临时工作目录运行仓库四个现有测试文件，35 项通过。另用新建的临时 SQLite 库、真实服务函数及控制器复核 T03、T04、T05、T06 的网页分支和 A04。没有连接真实微信、邮件、付费模型或远程日历，也没有读写现有用户数据库。其余发现以所列代码路径为依据；外部投递、模型账单与多进程故障仍需集成验收。图中描述的是目标系统。
