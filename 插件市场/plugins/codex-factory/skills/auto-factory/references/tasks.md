# 任务与证据

新建项目用 `factory_call` 的 `project_save`。项目根默认必须已存在；缺失时先按用户确认的路径创建，或显式传 `createRoot=true` 仅创建最后一级（父目录仍须存在，不递归、不猜路径）。

新建执行者用 `factory_task` 的 `save`，必须提供 `name`、`role`、`scope`、`task` 和 `acceptance`。更新已有执行者时携带当前 `revision`，只提交变化字段，未传字段保持原值；`REVISION_CONFLICT` 后重新读取。`workerId` 与旧 `id` 等价，同时给出不同值会拒绝。任务字段变化照常升版本并要求确认，`assignedModel` 和换 session 的归因保护不能绕过。

执行者首次用 `factory_task action=get view=full` 读取完整任务、需求、规则和验收；之后用 `view=status` 只取版本与状态。`refreshRequired=true` 时必须重新取完整版本，不能用旧缓存确认新任务。任务内容变化后进入 `needs_ack`，执行者本人确认后才能 `running` 或 `done`。

原生创建或继续前用 `factory_task action=prepare` 生成参数包；首次和 schema 错误重试保持同一 `launchId`。`record` 只记录启动请求、宿主报告（待核实）或停止原因，不改变任务版本，也不把历史 `assignedModel` 升级成实际模型。

验证时运行与改动对应的真实命令，日志放项目内，再用 `evidence_add` 记录 command、cwd、exitCode、logPath 和 summary。核心计算日志大小与 SHA-256。完成前确认依赖已 `done`、当前需求与任务版本已确认、证据对应当前任务版本。

项目关闭保留数据。恢复、重试或重开使用对应 action，不覆盖旧记录。内部消息只写 delta、block、result、refs。
