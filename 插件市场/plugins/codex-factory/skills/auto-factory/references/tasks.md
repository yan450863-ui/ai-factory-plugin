# 任务与证据

新建项目用 `factory_call` 的 `project_save`。新建或更新执行者用 `factory_task` 的 `save`，必须提供 `name`、`role`、`scope`、`files`、`task`、`acceptance` 和 `dependencies`。更新时携带当前 revision；`REVISION_CONFLICT` 后重新读取。

执行者首次用 `factory_task action=get view=full` 读取完整任务、需求、规则和验收；之后用 `view=status` 只取版本与状态。`refreshRequired=true` 时必须重新取完整版本，不能用旧缓存确认新任务。任务内容变化后进入 `needs_ack`，执行者本人确认后才能 `running` 或 `done`。

验证时运行与改动对应的真实命令，日志放项目内，再用 `evidence_add` 记录 command、cwd、exitCode、logPath 和 summary。核心计算日志大小与 SHA-256。完成前确认依赖已 `done`、当前需求与任务版本已确认、证据对应当前任务版本。

项目关闭保留数据。恢复、重试或重开使用对应 action，不覆盖旧记录。内部消息只写 delta、block、result、refs。
