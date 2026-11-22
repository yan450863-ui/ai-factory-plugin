# 派发与模型

使用宿主原生 `spawn_agent`、`followup_task`、`interrupt_agent`、`wait_agent` 等能力，不启动模型 CLI 或外部调度器。仅一层执行者，禁止继续分派。并发取设置上限与宿主上限的较小值，不必开满。

## 先准备再调用宿主

创建或继续前调用 `factory_task action=prepare`，传 `projectId`、`workerId` 和已解析的宿主 `target`。`create_thread` 返回的 `prompt`、`launchModel`、`effort`/`effortField` 和 `target` 必须原样使用；`spawn_agent` 使用 `prompt`、`launchModel`、`reasoning_effort`。调用者也可提供更完整的 prompt，但空 prompt 会被拒绝；未提供时由完整任务、验收和范围生成并校验非空。

`prepare` 缺 prompt、缺可用模型、模型未启用或 target 不完整时直接失败，不得改调宿主默认模型。`auto` 会按启用名单解析为具体模型；解析失败就保留任务并报告，不猜模型。

首次调用和 schema 错误重试使用同一 `launchId` 和参数包。schema 错误用 `factory_task action=record phase=schema_error` 记录后重试同一包，只修具体字段，禁止删掉 model/effort 换取成功。权限拒绝、用户取消和任务错误不自动重试换模；响应不明确先核对真实线程。宿主不接受模型时报告阻塞或在已启用策略中明确改选。

`factory_task action=record` 只记录事实：`requested` 记录启动请求，`host_report` 记录宿主报告模型并固定标为“待核实”，`blocked|failed|cancelled` 记录停止原因。插件不能拦截绕过它的原生工具调用，这套 prepare/record 是流程门禁，不是宿主权限系统。

通用协作规则见 `../../../references/collaboration.md`。发给执行者的消息优先使用版本化 envelope，只写变化、结论、检查、引用、阻塞或决定；宿主通知只带消息 ID/游标，不重复正文。

`factory_models` 关闭时返回 `{enabled:false}`。开启时按需使用 `models` 中的优先级、模型、`reasoning_effort` 和能力；团队关闭后不得用宿主默认模型绕过。模型不可用时按最新名单换到下一候选，每候选最多一次；全部失败保留任务报告，总指挥不代做。

两开关只影响后续派发，不终止本轮已经运行的原生执行者：

- `keepInCurrentChat=true, disableSubagents=false`：当前聊天内按需用临时子代理，不创建独立长期聊天。
- `keepInCurrentChat=false, disableSubagents=true`：工厂默认。优先复用，必要时创建或继续一层独立工作对话，但不新建子代理。
- 两者都 true：不创建独立聊天或子代理；普通工作对话自己执行，工厂总指挥无执行者时等待说明。
- 两者都 false：按任务选择，仍优先复用并遵守一层与并发上限。

已有运行和任务不被切换终止。实际创建原生代理后才能记录 `sessionId`，这不代表在线或可恢复。

主指挥只处理需求判断、分派决策、必要验收摘要和最终交付，不读取大量源码或日志、不代执行者排错。调查、实现、测试和返修由同一执行者闭环。报告只保留 delta、关键 checks、refs 和 block，除必要审批、重大风险或完成外不频繁 poll。能力与优先级用于任务适配，不要求开满并发。

“继续”请求也必须遵守当前工厂设置。`disableSubagents=true` 时不得通过换名或嵌套调用创建子代理；可以继续既有的一层独立工作对话。工厂默认不能成为普通开发任务的全量注入路径。

任务指定模型、启动请求模型和宿主报告模型分开：`worker.model` 是任务指定，`launch.model` 是启动请求，`launch.hostReport.model` 是宿主报告但待核实。`assignedModel` 只保留历史记录，界面标“未核实”，不能事后补写成实际模型。换 thread/session 时旧派发回执和旧模型归因失效。没有宿主或 provider usage 证据时，不得声称已经节省 token 或费用，也不得推测账单或计费数据。

按 `ability` 与 `priority` 匹配任务，不要求为了路由而开满。执行者先自验；渠道不可用与能力不足分开处理。渠道失败按最新名单换下一个候选，每候选最多一次。能力不足的同类返工升级到已启用且能力更高的模型；受项目重试上限约束，不循环交给同一弱档模型。没有更合适的启用模型时保留任务与报告，不擅自让主账号全量重做或自动接手。
