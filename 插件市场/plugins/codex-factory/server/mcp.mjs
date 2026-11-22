import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { parse as parseToml } from 'smol-toml';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.mjs';
import { createModelSettings } from './model-settings.mjs';

const version = '0.4.2';
const here = path.dirname(fileURLToPath(import.meta.url));
const resourceUri = 'ui://codex-factory/panel-v1';
const panelPath = path.join(here, 'panel.html');
const dataDir = process.env.CODEX_FACTORY_DATA_DIR?.trim();
const modelSettings = createModelSettings({
  ...(dataDir ? { dataDir } : {}),
  parseToml,
});
const store = await createStore({
  ...(dataDir ? { dataDir } : {}),
  modelSettings,
});

const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 16V8l4-2 4 2v8M4.8 9.2V15m2.4-5.8V15M11 16V4h5v4h-3v2h3v2h-3v4h-2ZM3 16h13"/><circle cx="16" cy="3" r="1.5" fill="currentColor" stroke="none"/></svg>';
const icon = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;
const icons = [{ src: icon, mimeType: 'image/svg+xml', sizes: ['any'] }];
const readonly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const writable = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const appOnly = { ui: { visibility: ['app'] } };
const appAndModel = { ui: { visibility: ['app', 'model'] } };
const panelMeta = {
  ui: {
    resourceUri,
    visibility: ['app', 'model'],
  },
  'openai/ui': {
    entrypoints: [{ type: 'thread' }],
  },
  'openai/iconStyle': 'monochrome',
};

const server = new McpServer(
  { name: 'codex-factory', version, icons },
  { capabilities: { resources: {}, tools: {} } },
);

function toolResult(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
  };
}

function panelResult(data, summary) {
  return {
    content: [],
    structuredContent: summary,
    _meta: { factory: data },
  };
}

function modelResult(data, mode = 'factory') {
  const { settings, catalog, draft, migration, stored, cleared, message } = data;
  return {
    content: [],
    structuredContent: compactResult('models', data, mode),
    _meta: {
      factoryModels: {
        settings,
        catalog,
        draft: cleared === true ? null : draft ?? null,
        migration: migration ?? null,
        ...(stored === undefined ? {} : { stored }),
        ...(cleared === undefined ? {} : { cleared }),
        ...(message === undefined ? {} : { message }),
      },
    },
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error?.code ? String(error.code) : null;
  const details = error?.details;
  const text = code
    ? `${message}\ncode: ${code}${details === undefined ? '' : `\n${JSON.stringify(details)}`}`
    : message;
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...(code ? { _meta: { factoryError: { code, message, details } } } : {}),
  };
}

const handle = (fn) => async (args = {}) => {
  try {
    return await fn(args);
  } catch (error) {
    return errorResult(error);
  }
};

const handleModel = (fn) => handle(async (args) => toolResult(await fn(args)));
const handlePanel = (summary, fn) => handle(async (args) => {
  const data = await fn(args);
  const action = typeof summary === 'function' ? summary(args) : summary;
  return panelResult(data, compactResult(action, data));
});

function truncate(value, limit = 1200) {
  if (typeof value !== 'string') return value;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function compactWorker(worker = {}) {
  return {
    id: worker.id,
    name: worker.name,
    role: worker.role,
    roleKind: worker.roleKind || 'worker',
    state: worker.state,
    revision: worker.revision,
    scope: truncate(worker.scope, 400),
    dependencies: worker.dependencies,
    sessionBound: Boolean(worker.sessionId),
    sessionStatus: worker.sessionStatus,
    sessionLive: false,
    model: worker.model || 'auto',
    assignedModel: worker.assignedModel || null,
    taskVersion: worker.taskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    worktree: worker.worktree,
    updatedAt: worker.updatedAt,
  };
}

function compactOverview(data = {}) {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  return {
    projectCount: projects.length,
    projects: projects.slice(0, 50).map((project) => ({
      id: project.id,
      name: project.name,
      root: project.root,
      status: project.status,
      revision: project.revision,
      workerCount: Array.isArray(project.workers) ? project.workers.length : 0,
      workerStates: (Array.isArray(project.workers) ? project.workers : [])
        .slice(0, 30)
        .map((worker) => ({ id: worker.id, state: worker.state })),
    })),
    ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
  };
}

function compactProject(project = {}, include = []) {
  const workers = Array.isArray(project.workers) ? project.workers : [];
  const events = Array.isArray(project.events) ? project.events : [];
  const decisions = Array.isArray(project.decisions) ? project.decisions : [];
  const selected = new Set(include);
  const result = {
    id: project.id,
    name: project.name,
    root: project.root,
    status: project.status,
    revision: project.revision,
    requirementsVersion: project.requirementsVersion,
    maxRetries: project.maxRetries,
    coordinator: project.coordinator
      ? {
          enabled: project.coordinator.enabled,
          status: project.coordinator.status,
          workerId: project.coordinator.workerId,
          sessionBound: Boolean(project.workers?.find(
            (worker) => worker.id === project.coordinator.workerId,
          )?.sessionId),
          sessionLive: false,
          targetWorkerIds: project.coordinator.targetWorkerIds,
          lastHeartbeatAt: project.coordinator.lastHeartbeatAt,
          waitSeconds: project.coordinator.waitSeconds,
        }
      : null,
    workers: workers.slice(0, 50).map(compactWorker),
    counts: {
      workers: workers.length,
      events: events.length,
      decisions: decisions.length,
    },
  };
  if (selected.has('requirements')) result.requirements = project.requirements;
  if (selected.has('rules')) result.rules = project.rules;
  if (selected.has('decisions')) {
    result.decisions = decisions.slice(-8).map((decision) => ({
      id: decision.id,
      text: truncate(decision.text, 800),
      refs: decision.refs,
      createdAt: decision.createdAt,
    }));
  }
  if (selected.has('events')) {
    result.recentEvents = events.slice(-12).map((event) => ({
      id: event.id,
      type: event.type,
      workerId: event.workerId,
      state: event.state,
      summary: truncate(event.summary, 500),
      createdAt: event.createdAt,
    }));
  }
  if (selected.has('workers')) result.workers = workers.slice(0, 50).map(compactWorker);
  if (selected.has('coordinator') && project.coordinator) {
    result.coordinator = {
      ...result.coordinator,
      generalScope: project.coordinator.generalScope,
      authorizedRecipients: project.coordinator.authorizedRecipients,
      cursor: project.coordinator.cursor,
    };
  }
  return result;
}

function workerReceipt(data = {}) {
  return {
    id: data.workerId ?? data.id,
    projectId: data.projectId,
    workerId: data.workerId ?? data.id,
    state: data.state,
    revision: data.revision,
    projectRevision: data.projectRevision,
    requirementsVersion: data.requirementsVersion,
    taskVersion: data.taskVersion,
    requiredTaskVersion: data.requiredTaskVersion,
    acknowledgedTaskVersion: data.acknowledgedTaskVersion,
    sessionId: data.sessionId,
    sessionBound: Boolean(data.sessionId),
    sessionLive: false,
    model: data.model,
    assignedModel: data.assignedModel,
    retryCount: data.retryCount,
    duplicate: data.duplicate,
  };
}

function messageReceipt(data = {}) {
  return {
    id: data.id,
    projectId: data.projectId,
    sequence: data.sequence,
    to: data.to,
    kind: data.kind,
    projectRevision: data.projectRevision,
    duplicate: data.duplicate === true,
    notification: data.notification,
  };
}

function operationReceipt(action, data = {}) {
  if (['worker_save', 'worker_state', 'worker_ack', 'worker_retry', 'worker_reopen'].includes(action)) {
    return workerReceipt(data);
  }
  if (action === 'message_send') return messageReceipt(data);
  if (action === 'rules_save') {
    return {
      id: data.id,
      revision: data.revision,
      requirementsVersion: data.requirementsVersion,
      changed: data.changed,
      updatedAt: data.updatedAt,
    };
  }
  if (action === 'project_save') {
    return {
      id: data.id,
      revision: data.revision,
      requirementsVersion: data.requirementsVersion,
      status: data.status,
      updatedAt: data.updatedAt,
    };
  }
  if (action === 'decision_add') {
    return { id: data.id, projectRevision: data.projectRevision, createdAt: data.createdAt };
  }
  if (action === 'evidence_add') {
    return {
      id: data.id,
      projectId: data.projectId,
      workerId: data.workerId,
      taskVersion: data.taskVersion,
      logHash: data.logHash,
      logBytes: data.logBytes,
      workerRevision: data.workerRevision,
      projectRevision: data.projectRevision,
    };
  }
  if (action === 'project_close') {
    return {
      id: data.id,
      status: data.status,
      revision: data.revision,
      closed: data.closed,
      updatedAt: data.updatedAt,
    };
  }
  return {
    id: data.id,
    projectId: data.projectId,
    workerId: data.workerId,
    state: data.state,
    revision: data.revision,
    projectRevision: data.projectRevision,
    requirementsVersion: data.requirementsVersion,
    cursor: data.cursor,
    updatedAt: data.updatedAt,
  };
}

function compactResult(action, data, mode = 'factory', include = []) {
  if (action === 'models') return modelSettings.compact(data, mode);
  if (action === 'team_context') {
    return {
      mode: 'team',
      mainConversationExecutes: true,
      oneLevelHelpersOnly: true,
      projectContextRead: false,
      enabled: data.enabled,
      maxAgents: data.maxAgents,
      keepInCurrentChat: data.keepInCurrentChat,
      disableSubagents: data.disableSubagents,
      models: data.models,
    };
  }
  if (action === 'overview') return compactOverview(data);
  if (action === 'project_get') return compactProject(data, include);
  if (action === 'worker_get') {
    return {
      projectId: data.projectId,
      projectRevision: data.projectRevision,
      workerId: data.workerId,
      revision: data.revision,
      state: data.state,
      projectName: data.projectName,
      projectRoot: data.projectRoot,
      requirements: truncate(data.requirements, 12000),
      worker: data.worker ?? compactWorker(data),
      rules: truncate(data.rules, 3000),
      requirementsVersion: data.requirementsVersion,
      taskVersion: data.taskVersion,
      acknowledgedTaskVersion: data.acknowledgedTaskVersion,
      sessionLive: false,
      model: data.worker?.model || data.model || 'auto',
      assignedModel: data.worker?.assignedModel || data.assignedModel || null,
      dependencies: data.dependencies,
      blockedBy: data.blockedBy,
      unread: data.unread,
    };
  }
  if (action === 'worker_status') return data;
  if (action === 'messages_read') {
    return {
      workerId: data.workerId,
      cursor: data.cursor,
      nextCursor: data.nextCursor,
      hasMore: data.hasMore,
      unread: data.unread,
      page: data.page,
      messages: (Array.isArray(data.messages) ? data.messages : []).slice(0, 50),
    };
  }
  if (action === 'message_get') return data;
  if (action === 'coordinator_control') {
    return {
      projectId: data.projectId,
      projectRevision: data.projectRevision,
      enabled: data.enabled,
      status: data.status,
      workerId: data.workerId,
      sessionBound: data.sessionBound,
      sessionLive: false,
      stale: data.stale,
      heartbeatAgeMs: data.heartbeatAgeMs,
      cursor: data.cursor,
      taskVersion: data.taskVersion,
      acknowledgedTaskVersion: data.acknowledgedTaskVersion,
      waitSeconds: data.waitSeconds,
      targetRefs: data.targetRefs,
    };
  }
  return operationReceipt(action, data);
}

await registerAppResource(
  server,
  '软件工厂面板',
  resourceUri,
  {},
  async () => ({
    contents: [{
      uri: resourceUri,
      mimeType: RESOURCE_MIME_TYPE,
      text: await fs.readFile(panelPath, 'utf8'),
      _meta: {
        ui: {
          prefersBorder: false,
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
        'openai/ui': {
          availableDisplayModes: ['inline', 'fullscreen'],
          preferredDisplayMode: 'fullscreen',
        },
      },
    }],
  }),
);

const globalView = {
  _meta: {
    ui: {
      resourceUri,
      visibility: ['app'],
    },
    'openai/ui': {
      entrypoints: [{ type: 'global' }],
    },
    'openai/iconStyle': 'monochrome',
  },
  icons,
  annotations: readonly,
  inputSchema: {
    mode: z.enum(['factory', 'team']).optional(),
  },
};

const threadView = {
  _meta: panelMeta,
  icons,
  annotations: readonly,
  inputSchema: {
    projectId: z.string().min(1).max(200).optional(),
    mode: z.enum(['factory', 'team']).optional(),
  },
};

registerAppTool(
  server,
  'factory_panel',
  {
    title: '软件工厂',
    description: '在 Codex 全局入口打开软件工厂。完整项目数据只交给面板，模型只收到摘要。',
    ...globalView,
  },
  handlePanel(
    ({ mode } = {}) => mode === 'team' ? 'team_context' : 'overview',
    async ({ mode } = {}) => (
      mode === 'team'
        ? modelSettings.compact(await modelSettings.read(), 'team')
        : store.call('overview')
    ),
  ),
);

registerAppTool(
  server,
  'factory_panel_tab',
  {
    title: '软件工厂',
    description: '在对话旁打开软件工厂。可传 projectId 直接进入项目。',
    ...threadView,
  },
  handlePanel(
    ({ projectId, mode } = {}) => mode === 'team'
      ? 'team_context'
      : projectId ? 'project_get' : 'overview',
    async ({ projectId, mode } = {}) => (
      mode === 'team'
        ? modelSettings.compact(await modelSettings.read(), 'team')
        : projectId
          ? store.call('project_get', { projectId })
          : store.call('overview')
    ),
  ),
);

server.registerTool(
  'factory_ui_read',
  {
    title: '读取软件工厂完整数据',
    description: '仅供软件工厂面板读取完整数据，不作为模型上下文注入。',
    inputSchema: {
      action: z.enum([
        'overview',
        'project_get',
        'worker_get',
        'worker_status',
        'messages_read',
        'message_get',
        'coordinator_control',
      ]),
      args: z.record(z.string(), z.unknown()).default({}),
    },
    annotations: readonly,
    _meta: appOnly,
  },
  handlePanel(({ action }) => action, async ({ action, args }) => store.call(action, args)),
);

server.registerTool(
  'factory_context',
  {
    title: '读取软件工厂上下文',
    description: '读取精简的项目或工作摘要；需求、规则、决定、事件用 include 按需展开。不返回其他执行者的完整会话历史。',
    inputSchema: {
      projectId: z.string().min(1).max(200).optional(),
      mode: z.enum(['factory', 'team']).optional(),
      include: z.array(z.enum(['requirements', 'rules', 'decisions', 'events', 'workers', 'coordinator']))
        .max(6)
        .optional(),
    },
    annotations: readonly,
    _meta: appAndModel,
  },
  handleModel(async ({ projectId, mode = 'factory', include = [] } = {}) => {
    if (mode === 'team') {
      return {
        mode: 'team',
        mainConversationExecutes: true,
        oneLevelHelpersOnly: true,
        projectContextRead: false,
        ...modelSettings.compact(await modelSettings.read(), 'team'),
      };
    }
    const action = projectId ? 'project_get' : 'overview';
    const data = await store.call(action, projectId ? { projectId } : {});
    return compactResult(action, data, 'factory', include);
  }),
);

server.registerTool(
  'factory_models',
  {
    title: '读取自动团队模型',
    description: '按需读取精简的启用模型名单、优先级、思考强度、能力和派发策略。',
    inputSchema: {
      mode: z.enum(['factory', 'team']).optional(),
    },
    annotations: readonly,
    _meta: appAndModel,
  },
  handleModel(async ({ mode = 'factory' } = {}) => (
    modelSettings.compact(await modelSettings.read(), mode)
  )),
);

server.registerTool(
  'factory_models_ui',
  {
    title: '读取完整模型设置',
    description: '仅供软件工厂模型设置面板读取完整目录、草稿与迁移状态。',
    inputSchema: {},
    annotations: readonly,
    _meta: appOnly,
  },
  handle(async () => modelResult(await modelSettings.read())),
);

const modelRowSchema = z.object({
  id: z.string().min(1).max(200),
  enabled: z.boolean(),
  effort: z.string().max(40),
  ability: z.number().int().min(1).max(5),
});
const modeSettingsSchema = z.object({
  enabled: z.boolean(),
  maxAgents: z.number().int().min(1).max(16),
  keepInCurrentChat: z.boolean(),
  disableSubagents: z.boolean(),
});
const modelSettingsSchema = {
  modes: z.object({
    factory: modeSettingsSchema,
    team: modeSettingsSchema,
  }),
  revision: z.number().int().nonnegative(),
  models: z.array(modelRowSchema).max(200),
};

server.registerTool(
  'factory_models_save',
  {
    title: '保存模型设置',
    description: '仅供模型设置面板保存正式设置。切换策略只影响后续派发。',
    inputSchema: modelSettingsSchema,
    annotations: writable,
    _meta: appOnly,
  },
  handle(async (input) => modelResult(await modelSettings.save(input))),
);

server.registerTool(
  'factory_models_draft_save',
  {
    title: '暂存模型设置草稿',
    description: '仅供模型设置面板暂存未提交修改，不改变正式设置。',
    inputSchema: {
      ...modelSettingsSchema,
      draftId: z.string().uuid(),
      sequence: z.number().int().positive(),
    },
    annotations: writable,
    _meta: appOnly,
  },
  handle(async (input) => modelResult(await modelSettings.saveDraft(input))),
);

server.registerTool(
  'factory_models_draft_clear',
  {
    title: '处理模型设置草稿',
    description: '仅供模型设置面板标记草稿已保存或已丢弃。',
    inputSchema: {
      draftId: z.string().uuid(),
      sequence: z.number().int().positive(),
      reason: z.enum(['saved', 'discarded']).optional(),
    },
    annotations: writable,
    _meta: appOnly,
  },
  handle(async (input) => modelResult({
    ...(await modelSettings.read()),
    ...(await modelSettings.clearDraft(input)),
  })),
);

server.registerTool(
  'factory_task',
  {
    title: '管理软件工厂任务',
    description: '读取、保存、确认或更新执行者任务。首次用 view=full，后续用 view=status；写操作只回执。实际执行必须由宿主原生代理工具完成。',
    inputSchema: {
      action: z.enum(['save', 'get', 'state', 'ack', 'retry', 'reopen']),
      projectId: z.string().min(1).max(200),
      workerId: z.string().min(1).max(200).optional(),
      id: z.string().min(1).max(200).optional(),
      name: z.string().min(1).max(300).optional(),
      role: z.string().min(1).max(100).optional(),
      roleKind: z.enum(['worker', 'coordinator']).optional(),
      scope: z.string().min(1).max(4000).optional(),
      files: z.array(z.string().min(1).max(1000)).max(200).optional(),
      task: z.string().min(1).max(20000).optional(),
      acceptance: z.string().min(1).max(10000).optional(),
      dependencies: z.array(z.string().min(1).max(200)).max(100).optional(),
      sessionId: z.string().max(500).optional(),
      model: z.string().max(200).optional(),
      assignedModel: z.string().max(200).optional(),
      worktree: z.string().max(2000).optional(),
      state: z.enum([
        'planned',
        'ready',
        'running',
        'waiting',
        'paused',
        'needs_ack',
        'done',
        'failed',
        'closed',
      ]).optional(),
      summary: z.string().max(10000).optional(),
      evidence: z.array(z.string().min(1).max(3000)).max(100).optional(),
      refs: z.array(z.string().min(1).max(3000)).max(100).optional(),
      revision: z.number().int().nonnegative().optional(),
      view: z.enum(['full', 'status']).optional(),
    },
    annotations: writable,
    _meta: appAndModel,
  },
  handleModel(async (input) => {
    const { action, projectId, workerId } = input;
    if (action === 'save') {
      for (const field of ['name', 'role', 'scope', 'task', 'acceptance']) {
        if (!input[field]) throw new Error(`worker_save 缺少 ${field}`);
      }
      const data = await store.call('worker_save', {
        projectId,
        id: input.id ?? input.workerId,
        name: input.name,
        role: input.role,
        roleKind: input.roleKind,
        scope: input.scope,
        files: input.files ?? [],
        task: input.task,
        acceptance: input.acceptance,
        dependencies: input.dependencies ?? [],
        sessionId: input.sessionId,
        model: input.model,
        assignedModel: input.assignedModel,
        worktree: input.worktree,
        revision: input.revision,
      });
      return operationReceipt('worker_save', data);
    }
    if (!workerId) throw new Error(`${action} 缺少 workerId`);
    if (action === 'get') {
      return store.call(input.view === 'status' ? 'worker_status' : 'worker_get', {
        projectId,
        workerId,
      });
    }
    if (action === 'state') {
      const data = await store.call('worker_state', {
        projectId,
        workerId,
        state: input.state,
        summary: input.summary,
        evidence: input.evidence ?? [],
        refs: input.refs ?? [],
        revision: input.revision,
      });
      return operationReceipt('worker_state', data);
    }
    const extra = {
      projectId,
      workerId,
      summary: input.summary,
      evidence: input.evidence ?? [],
      refs: input.refs ?? [],
      revision: input.revision,
    };
    const data = await store.call(`worker_${action}`, extra);
    return operationReceipt(`worker_${action}`, data);
  }),
);

server.registerTool(
  'factory_coordinator',
  {
    title: '长任务协调助手',
    description: '按需配置并控制项目内唯一的一层协调助手。只保存状态；实际线程由宿主原生工具创建、等待和停止。',
    inputSchema: {
      projectId: z.string().min(1).max(200),
      op: z.enum(['get', 'enable', 'start', 'heartbeat', 'request_stop', 'stop', 'lost']),
      targetWorkerIds: z.array(z.string().min(1).max(200)).max(100).optional(),
      authorizedRecipients: z.array(z.string().min(1).max(200)).max(100).optional(),
      generalScope: z.string().min(1).max(4000).optional(),
      waitSeconds: z.number().int().min(10).max(3600).optional(),
      revision: z.number().int().nonnegative().optional(),
      summary: z.string().max(10000).optional(),
      cursor: z.number().int().nonnegative().optional(),
      reason: z.string().max(10000).optional(),
    },
    annotations: writable,
    _meta: appAndModel,
  },
  handleModel(async (input) => compactResult(
    'coordinator_control',
    await store.call('coordinator_control', input),
  )),
);

const messageEnvelopeSchema = z.object({
  v: z.literal(1),
  type: z.enum(['delta', 'blocker', 'result', 'decision', 'ack', 'error']),
  summary: z.string().min(1).max(1600),
  changes: z.array(z.string().min(1).max(500)).max(12).optional(),
  checks: z.array(z.string().min(1).max(800)).max(12).optional(),
  block: z.union([
    z.string().min(1).max(1000),
    z.object({
      code: z.string().max(80).optional(),
      message: z.string().min(1).max(1000),
      needs: z.string().max(500).optional(),
    }),
  ]).optional(),
  decision: z.string().max(1600).optional(),
});

server.registerTool(
  'factory_message',
  {
    title: '收发软件工厂消息',
    description: '发送、增量读取或按需读取结构化短消息。正文只持久化一处；宿主通知只带消息 ID/游标。',
    inputSchema: {
      action: z.enum(['send', 'read', 'original']),
      projectId: z.string().min(1).max(200),
      from: z.string().min(1).max(200).optional(),
      to: z.string().min(1).max(200).optional(),
      workerId: z.string().min(1).max(200).optional(),
      kind: z.enum(['delta', 'blocker', 'result', 'decision', 'ack', 'error']).optional(),
      body: z.string().min(1).max(12000).optional(),
      envelope: messageEnvelopeSchema.optional(),
      refs: z.array(z.string().min(1).max(3000)).max(100).optional(),
      requestId: z.string().max(300).optional(),
      after: z.string().max(500).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      maxChars: z.number().int().min(500).max(50000).optional(),
      detail: z.enum(['summary', 'full']).optional(),
      messageId: z.string().min(1).max(200).optional(),
    },
    annotations: writable,
    _meta: appAndModel,
  },
  handleModel(async (input) => {
    if (input.action === 'send') {
      if (!input.from) throw new Error('message_send 缺少 from');
      if (!input.to) throw new Error('message_send 缺少 to');
      if (!input.kind && !input.envelope) throw new Error('message_send 缺少 kind 或 envelope');
      if (!input.body && !input.envelope) throw new Error('message_send 缺少 body 或 envelope');
      const data = await store.call('message_send', {
        projectId: input.projectId,
        from: input.from,
        to: input.to,
        kind: input.kind,
        body: input.body,
        envelope: input.envelope,
        refs: input.refs ?? [],
        requestId: input.requestId,
      });
      return messageReceipt(data);
    }
    if (input.action === 'original') {
      if (!input.workerId) throw new Error('message_get 缺少 workerId');
      if (!input.messageId) throw new Error('message_get 缺少 messageId');
      return compactResult('message_get', await store.call('message_get', {
        projectId: input.projectId,
        workerId: input.workerId,
        messageId: input.messageId,
      }));
    }
    if (!input.workerId) throw new Error('messages_read 缺少 workerId');
    const data = await store.call('messages_read', {
      projectId: input.projectId,
      workerId: input.workerId,
      after: input.after,
      limit: input.limit ?? 20,
      maxChars: input.maxChars,
      detail: input.detail,
    });
    return compactResult('messages_read', data);
  }),
);

const storeActions = z.enum([
  'overview',
  'project_save',
  'project_get',
  'worker_save',
  'worker_get',
  'worker_status',
  'worker_state',
  'rules_save',
  'message_send',
  'messages_read',
  'message_get',
  'decision_add',
  'evidence_add',
  'project_close',
  'worker_ack',
  'worker_retry',
  'worker_reopen',
  'coordinator_control',
]);

server.registerTool(
  'factory_call',
  {
    title: '调用软件工厂',
    description: '调用软件工厂状态 API。返回精简结果；此调用不会自行启动代理或执行产品任务。',
    inputSchema: {
      action: storeActions,
      args: z.record(z.string(), z.unknown()).default({}),
    },
    annotations: writable,
    _meta: appAndModel,
  },
  handleModel(async ({ action, args }) => {
    const data = await store.call(action, args);
    return compactResult(action, data);
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

let closing = false;
async function closeStore() {
  if (closing) return;
  closing = true;
  try {
    await store.close();
  } catch (error) {
    console.error(`codex-factory: close failed: ${error instanceof Error ? error.message : error}`);
  }
}

process.once('SIGINT', async () => {
  await closeStore();
  process.exit(0);
});
process.once('SIGTERM', async () => {
  await closeStore();
  process.exit(0);
});
server.server.onclose = () => {
  void closeStore();
};
