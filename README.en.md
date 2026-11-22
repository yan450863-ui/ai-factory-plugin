# AI Factory Plugin

English | [简体中文](README.md)

AI Factory Plugin is a local plugin for Codex. It provides two collaboration modes, Software Factory and Team, in one entry point, together with shared model management, projects, tasks, messages, decisions, and evidence. Codex still creates conversations, runs tasks and commands, and performs acceptance. The plugin does not start a separate model CLI, background scheduler, or resident daemon.

The public version is **0.4.5**. The English title is “AI Factory Plugin”; the plugin UI display name is the Chinese name “AI工厂插件”. The internal plugin ID remains `codex-factory`, and the local marketplace name is `ai-factory-plugin`. Keeping the internal ID preserves compatibility with existing tasks, skill references, and data formats.

## What it does

- Shows a project summary and four worker-conversation columns: name, responsibility, current task, and state.
- Matches work to models by configured priority and capability level, and distinguishes provider failures from capability gaps.
- Prepares native dispatch arguments with an explicit prompt, concrete model, thinking/effort, and target; schema-error retries keep the same pack. Task-specified, requested, and host-reported models stay separate, and legacy `assignedModel` is marked unverified.
- In Software Factory mode, keeps the orchestrator focused on communication, dispatch, coordination, and acceptance while worker conversations perform implementation; Team mode has the main conversation perform the core work directly.
- Stores tasks, rules, messages, decisions, and evidence with on-demand retrieval instead of injecting the full history every turn.
- Enables optional long-task coordination inside real host conversations without creating a background service.

## Two modes

### Software Factory

The orchestrator splits, assigns, follows up, and accepts work. Independent worker conversations perform investigation, implementation, testing, and repair. Subagents are disabled by default, and multiple one-level worker conversations may run in parallel. The home view stays compact; task details, internal messages, events, and evidence are expanded on demand.

### Team

The main conversation performs the core work and may use one-level helper subagents only for search, document organization, repetitive handling, or independent verification. Team mode does not read Software Factory projects, tasks, rules, or history.

Both modes share the model catalog currently visible to Codex, but save their enabled state, concurrency limit, keep-in-current-chat setting, and subagent policy independently. When both behaviors are enabled, the plugin does not create an additional execution conversation.

### Long-task coordinator

The coordinator is off by default. When needed, a project can select one or more worker conversations to monitor plus a general handling scope, then bind the coordinator to a real host thread. Each project has at most one coordinator. It handles ordinary progress, dependencies, necessary information, and bounded repair work. Requirement changes, acceptance changes, architecture changes, and scope expansion remain escalation points for the orchestrator. Coordination depends on the host conversation; it is not an unattended background service.

## Requirements

- A Codex version that supports local executors and Agent Plugins.
- Node.js 22 or later, with `node` and `npm` available on `PATH`.
- The `codex` CLI, with permission to install a local plugin marketplace.

On Windows, PowerShell 7 (`pwsh`) is recommended. The install script checks the build dependencies, runs `npm ci` when they are missing, builds the plugin, registers the local marketplace, and installs `codex-factory@ai-factory-plugin`:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\工具\install.ps1
```

After installation, enable or open “AI Factory Plugin” from Codex plugin management. If the current window still shows an older panel, close and reopen it; disable and re-enable the plugin if necessary.

### Manual build and install

```powershell
cd .\工具
npm ci
npm run build
cd ..
codex plugin marketplace add .\插件市场
codex plugin add codex-factory@ai-factory-plugin
```

Linux and macOS can use the same `npm ci`, `npm run build`, and `codex plugin` commands. The PowerShell install script is Windows-only.

### Release package formats

- **Full source archive**: contains `插件市场/`, `工具/`, source, build output, licenses, and CI. Use this to build, review, and install.
- **Single-plugin archive**: has `plugin.json`, `mcp.json`, `dist/`, `assets/`, `skills/`, `references/`, and licenses at its root. Use it for inspection or to connect the plugin directory to a local marketplace.

Both are GitHub open-source distributions, not plugin-store submission packages. This project does not claim store review, demo approval, or store-policy materials.

## Data locations

The plugin includes no telemetry or external data service. Project and task data stay on the local machine:

- Windows default: `%LOCALAPPDATA%\CodexFactory`
- Linux/macOS default: `$XDG_DATA_HOME/codex-factory`, or `~/.codex-factory` when unset
- `CODEX_FACTORY_DATA_DIR` overrides the data directory.
- A project also keeps a primary copy at `.codex-factory/project.json`.
- Model settings are stored in `models/settings.json` under the data directory.

The public build does not automatically read the author's old model-team directory. It attempts a legacy import only when `CODEX_FACTORY_LEGACY_DATA_DIR` is explicitly set; without that variable, no machine-specific migration path is used.

Project paths, tasks, messages, and evidence are local working data. Whether to put them under version control is the user's decision.

Local storage does not mean the plugin runs fully offline. When tasks execute, relevant prompts, context, and tool results are sent to the model service selected by the user and are subject to that provider's privacy policy and terms of service.

## User report and cost boundary

The user reports that, in their real workflow, main-conversation consumption fell to roughly **1/10** of the previous level, while most consumption moved to execution or helper conversations. Cheaper models that fit the task can reduce main-conversation load and context pressure.

This is a user-reported workflow observation. It is not a public reproduction, statistical sample, or billing audit from this project. **Total tokens, total calls, and total cost are not guaranteed to fall by 10x.** Actual cost depends on each model's pricing, call volume, retries, and rework. Lower main-conversation load does not imply a proportional reduction in total cost.

## Known limitations

- The plugin relies on Codex to create and continue native conversations; it cannot execute independently of the host.
- Saving a task, sending a message, or clicking a button only records a request. It does not prove that a native task started or is still running.
- Long-task coordination depends on the host conversation and native bounded waiting. Continued monitoring after the host exits is not guaranteed.
- Coordinator permissions and role boundaries rely mainly on skills and persistent task constraints, not a host-enforced permission system.
- Long-running, unattended cross-chat coordination has not been validated as a separate scenario.
- An older installed cache may be locked by a running host. Upgrade with a new version number and reinstall; do not edit the cache by hand.

## Development and verification

```powershell
cd .\工具
npm ci
npm run build
npm run verify
```

`npm run verify` runs MCP protocol, core store, model-settings, and isolated UI checks in temporary directories. It does not read real user data. After installation, an optional host check is available:

```powershell
node .\工具\verify-host.mjs
```

This starts an isolated Codex app-server and checks that the installed plugin exposes 13 MCP tools and the team/coordinator skills. It requires a local Codex host, so CI does not run it.

Build output is written to `插件市场/plugins/codex-factory/dist/` and does not include source maps. CI uses `npm ci`, a build, and checks that do not require a host.

## License

This project is licensed under the MIT License, copyright the repository owner `yan450863-ui`. Third-party dependencies and licenses for bundled artifacts are listed in `NOTICE` and `licenses/`.
