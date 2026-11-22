# 0.4.5 发布说明

0.4.5 仅同步版本清单：主 manifest、`.codex-plugin` 兼容 manifest、构建清单和界面版本统一为 0.4.5，避免同版本缓存与公开副本版本不一致。不改变产品逻辑、任务数据或设置。

## English

0.4.5 is a version-consistency release. The primary manifest, the `.codex-plugin` compatibility manifest, the build manifest, and the UI version are all aligned to 0.4.5 to avoid same-version cache conflicts and public-copy version drift. Product logic, task data, and settings are unchanged.

## 0.4.4

0.4.4 修复新项目与执行者更新中的四处接口问题：`project_save` 在项目根缺失时默认拒绝并给出可操作提示，显式 `createRoot=true` 只创建最后一级目录，不递归、不猜拼错路径；文件归属改用分段 glob 判断，`logs/frontend*` 与 `logs/backend*` 不再误判，真正重叠仍拒绝；更新已有执行者携带 `revision` 时可只提交变化字段，新建仍要求完整字段；`factory_call` 与 `factory_task` 统一 `workerId`/`id` 别名，冲突值明确拒绝。任务版本、确认、session 与模型归因保护保持不变。

## English

0.4.4 fixes four interface issues in project initialization and worker updates. `project_save` now rejects a missing project root with an actionable message; explicit `createRoot=true` creates only the final directory and never recurses or guesses a mistyped path. File ownership uses segment-aware glob matching, so `logs/frontend*` and `logs/backend*` no longer conflict while real overlaps are still rejected. Updating an existing worker with `revision` accepts only changed fields; creation still requires the full set. `factory_call` and `factory_task` share the `workerId`/`id` alias and reject conflicting values. Task versions, acknowledgement, session, and model-attribution protections are unchanged.

## 0.4.3

0.4.3 修复原生派发参数与模型记录不一致：`factory_task action=prepare` 在调用宿主前生成并校验 `prompt`、具体 `model`、`thinking`/`reasoning_effort` 和 `target`，缺字段或没有可用启用模型时拒绝准备，不靠宿主默认模型补齐。首次调用与 schema 错误重试使用同一参数包，只修具体字段；权限拒绝、用户取消和任务错误不自动换模重发。

任务指定模型、启动请求模型和宿主报告分开记录。`assignedModel` 只保留历史值并在界面标“未核实”，不能事后补写冒充实际模型；换 thread/session 会清空旧派发回执和旧模型归因。插件不能拦截绕过它的宿主原生调用，prepare/record 是流程门禁，不是宿主权限系统。

## English (0.4.3)

0.4.3 fixes native dispatch parameters and model attribution. `factory_task action=prepare` builds and validates `prompt`, a concrete `model`, `thinking`/`reasoning_effort`, and `target` before the host call; missing fields or no enabled model are rejected instead of falling back to a host default. First calls and schema-error retries reuse the same pack and only repair specific fields. Permission denial, user cancellation, and task errors are not retried with a different model.

Task-specified, requested, and host-reported models are recorded separately. Legacy `assignedModel` is retained only as unverified history and cannot be written after the fact; changing thread/session clears old dispatch receipts and model attribution. The plugin cannot intercept native host calls that bypass it; prepare/record is a procedural gate, not a host permission system.

## 0.4.2

AI工厂插件 0.4.2 是首次公开开源版本，提供“软件工厂”和“团队”两种模式，以及可选的宿主内长任务协调。公开副本保留内部插件 ID `codex-factory`，显示名统一为“AI工厂插件”；MCP 启动改为 `node` + `${PLUGIN_ROOT}`，不包含个人 PATH，也不会自动读取作者机器上的旧模型团队目录。项目使用 MIT 许可证，提供完整源码包和单插件包；两者都不是插件商店提交包。

用户反馈其实际工作流中主对话消耗降至约 1/10，但消耗主要分摊到执行或辅助对话。该结果是用户自述观察，未附公开复现实验或账单审计；总 token、总费用不保证下降 10 倍，实际成本取决于模型定价、调用量、重试和返工。

## English

AI Factory Plugin 0.4.2 is the first public open-source release. It provides Software Factory and Team modes plus optional in-host long-task coordination. The public build keeps the internal plugin ID `codex-factory`; its English title is “AI Factory Plugin” and its UI display name is the Chinese name “AI工厂插件”. MCP startup now uses `node` and `${PLUGIN_ROOT}` without a machine-specific PATH, and it does not automatically read the author's legacy model-team directory. The project is MIT-licensed and offers a full source archive and a single-plugin archive; neither is a plugin-store submission package.

The user reports that main-conversation consumption in their workflow fell to roughly 1/10, with most consumption moving to execution or helper conversations. This is a user-reported observation without a public reproduction or billing audit. Total tokens and total cost are not guaranteed to fall by 10x; actual cost depends on model pricing, call volume, retries, and rework.
