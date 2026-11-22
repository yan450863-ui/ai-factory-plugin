# 0.4.2 发布说明

AI工厂插件 0.4.2 是首次公开开源版本，提供“软件工厂”和“团队”两种模式，以及可选的宿主内长任务协调。公开副本保留内部插件 ID `codex-factory`，显示名统一为“AI工厂插件”；MCP 启动改为 `node` + `${PLUGIN_ROOT}`，不包含个人 PATH，也不会自动读取作者机器上的旧模型团队目录。项目使用 MIT 许可证，提供完整源码包和单插件包；两者都不是插件商店提交包。

用户反馈其实际工作流中主对话消耗降至约 1/10，但消耗主要分摊到执行或辅助对话。该结果是用户自述观察，未附公开复现实验或账单审计；总 token、总费用不保证下降 10 倍，实际成本取决于模型定价、调用量、重试和返工。

## English

AI Factory Plugin 0.4.2 is the first public open-source release. It provides Software Factory and Team modes plus optional in-host long-task coordination. The public build keeps the internal plugin ID `codex-factory`; its English title is “AI Factory Plugin” and its UI display name is the Chinese name “AI工厂插件”. MCP startup now uses `node` and `${PLUGIN_ROOT}` without a machine-specific PATH, and it does not automatically read the author's legacy model-team directory. The project is MIT-licensed and offers a full source archive and a single-plugin archive; neither is a plugin-store submission package.

The user reports that main-conversation consumption in their workflow fell to roughly 1/10, with most consumption moving to execution or helper conversations. This is a user-reported observation without a public reproduction or billing audit. Total tokens and total cost are not guaranteed to fall by 10x; actual cost depends on model pricing, call volume, retries, and rework.
