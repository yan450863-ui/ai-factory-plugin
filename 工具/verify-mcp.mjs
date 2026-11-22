import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDependency } from './dependencies.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(toolDir);
const pluginDir = path.join(root, '插件市场', 'plugins', 'codex-factory');
const distDir = path.join(pluginDir, 'dist');
const verifyDir = path.join(root, '验证');
const { Client } = await importDependency(
  '@modelcontextprotocol/sdk/client/index.js',
  toolDir,
);
const { StdioClientTransport } = await importDependency(
  '@modelcontextprotocol/sdk/client/stdio.js',
  toolDir,
);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const recordPath = path.join(verifyDir, `mcp-${stamp}.json`);

function resultData(result) {
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === 'text')?.text || 'MCP 调用失败');
  }
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

function entrypoint(tool, type) {
  return tool?._meta?.['openai/ui']?.entrypoints?.some((item) => item.type === type);
}

function assertContainedTemp(target) {
  const resolved = path.resolve(target);
  const tempRoot = path.resolve(os.tmpdir());
  const normalizedResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const normalizedRoot = process.platform === 'win32' ? tempRoot.toLowerCase() : tempRoot;
  if (normalizedResolved === normalizedRoot
    || !normalizedResolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`拒绝删除临时目录范围外的路径：${resolved}`);
  }
}

async function main() {
  const plugin = JSON.parse(await fs.readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await fs.readFile(path.join(pluginDir, 'mcp.json'), 'utf8'));
  const skill = await fs.readFile(path.join(pluginDir, 'skills', 'auto-factory', 'SKILL.md'), 'utf8');
  const teamSkill = await fs.readFile(path.join(pluginDir, 'skills', 'factory-team', 'SKILL.md'), 'utf8');
  const coordinatorSkill = await fs.readFile(
    path.join(pluginDir, 'skills', 'factory-coordinator', 'SKILL.md'),
    'utf8',
  );
  const taskRef = await fs.readFile(path.join(pluginDir, 'skills', 'auto-factory', 'references', 'tasks.md'), 'utf8');
  const dispatchRef = await fs.readFile(path.join(pluginDir, 'skills', 'auto-factory', 'references', 'dispatch.md'), 'utf8');
  const sharedRef = await fs.readFile(path.join(pluginDir, 'references', 'collaboration.md'), 'utf8');
  const serverFile = path.join(distDir, 'mcp.mjs');
  const panelFile = path.join(distDir, 'panel.html');
  const serverBytes = await fs.readFile(serverFile);
  const panelBytes = await fs.readFile(panelFile);

  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name, 'codex-factory');
  assert.equal(plugin.version, '0.4.2');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.equal(mcp.mcpServers.codex_factory.type, 'stdio');
  assert.match(skill, /^---\nname: auto-factory\n/m);
  assert.match(skill, /仅在用户明确要求/);
  assert.match(skill, /不得继续分派/);
  assert.match(skill, /keepInCurrentChat=false, disableSubagents=true/);
  assert.match(skill, /references\/dispatch\.md/);
  assert.match(skill, /\.\.\/\.\.\/references\/collaboration\.md/);
  assert.match(taskRef, /evidence_add/);
  assert.match(dispatchRef, /sessionId/);
  assert.match(teamSkill, /^---\nname: factory-team\n/m);
  assert.match(teamSkill, /普通问答/);
  assert.match(teamSkill, /factory_models/);
  assert.match(teamSkill, /不读取或发送工厂项目/);
  assert.match(teamSkill, /\.\.\/\.\.\/references\/collaboration\.md/);
  assert.match(coordinatorSkill, /^---\nname: factory-coordinator\n/m);
  assert.match(coordinatorSkill, /不要创建或分派下属/);
  assert.match(coordinatorSkill, /关键事项/);
  assert.match(coordinatorSkill, /\.\.\/\.\.\/references\/collaboration\.md/);
  assert.match(sharedRef, /超时本身不算失败/);
  assert.match(sharedRef, /wait_threads/);
  assert.match(sharedRef, /不新建常驻服务/);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-factory-mcp-'));
  const codexHome = path.join(tempDir, 'codex-home');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model_catalog_json = "models.json"\n', 'utf8');
  await fs.writeFile(path.join(codexHome, 'models.json'), `${JSON.stringify({
    models: [
      {
        slug: 'alpha',
        display_name: 'Alpha',
        supported_reasoning_levels: [{ effort: 'high' }],
        default_reasoning_level: 'high',
      },
      {
        slug: 'beta',
        display_name: 'Beta',
        supported_reasoning_levels: [{ effort: 'low' }],
        default_reasoning_level: 'low',
      },
    ],
  }, null, 2)}\n`, 'utf8');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
  );
  env.CODEX_FACTORY_DATA_DIR = path.join(tempDir, 'data');
  env.CODEX_HOME = codexHome;
  env.CODEX_FACTORY_CODEX_HOME = codexHome;
  env.CODEX_FACTORY_LEGACY_DATA_DIR = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverFile],
    cwd: pluginDir,
    env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'codex-factory-mcp-verifier', version: '0.4.2' },
    { capabilities: {} },
  );

  const report = {
    checkedAt: new Date().toISOString(),
    node: process.version,
    plugin: {
      name: plugin.name,
      version: plugin.version,
      serverBytes: serverBytes.length,
      serverSha256: crypto.createHash('sha256').update(serverBytes).digest('hex'),
      panelBytes: panelBytes.length,
      panelSha256: crypto.createHash('sha256').update(panelBytes).digest('hex'),
    },
    tools: [],
    calls: [],
  };

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools ?? [];
    report.tools = tools.map((tool) => ({
      name: tool.name,
      visibility: tool._meta?.ui?.visibility,
      entrypoints: tool._meta?.['openai/ui']?.entrypoints,
    }));

    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      'factory_panel',
      'factory_panel_tab',
      'factory_ui_read',
      'factory_context',
      'factory_models',
      'factory_models_ui',
      'factory_models_save',
      'factory_models_draft_save',
      'factory_models_draft_clear',
      'factory_task',
      'factory_message',
      'factory_call',
      'factory_coordinator',
    ]) {
      assert.ok(byName.has(name), `缺少工具 ${name}`);
    }
  assert.equal(tools.length, 13, '0.4.2 必须恰好暴露 13 个工具');
    assert.ok(entrypoint(byName.get('factory_panel'), 'global'), 'factory_panel 缺少 global 入口');
    assert.ok(entrypoint(byName.get('factory_panel_tab'), 'thread'), 'factory_panel_tab 缺少 thread 入口');

    const panel = await client.callTool({ name: 'factory_panel', arguments: {} });
    assert.ok(panel._meta?.factory, 'factory_panel 未返回 _meta.factory');
    assert.ok(panel.structuredContent, 'factory_panel 缺少 structuredContent');
    report.calls.push({
      name: 'factory_panel',
      fullDataInMeta: true,
      structuredProjectCount: panel.structuredContent.projectCount,
    });

    const context = await client.callTool({ name: 'factory_context', arguments: {} });
    const contextData = resultData(context);
    assert.equal(context.structuredContent, undefined, '模型工具不得同时重复 structuredContent');
    assert.equal(contextData.projectCount, 0);
    report.calls.push({ name: 'factory_context', projectCount: 0 });

    const uiRead = await client.callTool({ name: 'factory_models_ui', arguments: {} });
    assert.ok(uiRead._meta?.factoryModels?.settings, 'factory_models_ui 缺少完整 settings');
    assert.equal(uiRead._meta.factoryModels.catalog.length, 2);
    const modelSettings = uiRead._meta.factoryModels.settings;
    assert.deepEqual(modelSettings.modes.factory, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: false,
      disableSubagents: true,
    });
    assert.deepEqual(modelSettings.modes.team, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: true,
      disableSubagents: false,
    });
    const modelSave = await client.callTool({
      name: 'factory_models_save',
      arguments: {
        modes: {
          factory: {
            enabled: true,
            maxAgents: 5,
            keepInCurrentChat: false,
            disableSubagents: true,
          },
          team: {
            enabled: true,
            maxAgents: 6,
            keepInCurrentChat: true,
            disableSubagents: false,
          },
        },
        revision: modelSettings.revision,
        models: [
          { id: 'beta', enabled: true, effort: 'low', ability: 4 },
          { id: 'alpha', enabled: false, effort: 'high', ability: 5 },
        ],
      },
    });
    assert.ok(!modelSave.isError, modelSave.content?.[0]?.text ?? 'factory_models_save 失败');
    assert.deepEqual(modelSave._meta.factoryModels.settings.modes, {
      factory: {
        enabled: true,
        maxAgents: 5,
        keepInCurrentChat: false,
        disableSubagents: true,
      },
      team: {
        enabled: true,
        maxAgents: 6,
        keepInCurrentChat: true,
        disableSubagents: false,
      },
    });
    const factoryModels = await client.callTool({
      name: 'factory_models',
      arguments: { mode: 'factory' },
    });
    const teamModels = await client.callTool({
      name: 'factory_models',
      arguments: { mode: 'team' },
    });
    const factoryModelsData = resultData(factoryModels);
    assert.deepEqual(factoryModelsData, {
      mode: 'factory',
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: false,
      disableSubagents: true,
      models: [{ priority: 1, model: 'beta', reasoning_effort: 'low', ability: 4 }],
    });
    const teamModelsData = resultData(teamModels);
    assert.deepEqual(teamModelsData, {
      mode: 'team',
      enabled: true,
      maxAgents: 6,
      keepInCurrentChat: true,
      disableSubagents: false,
      models: [{ priority: 1, model: 'beta', reasoning_effort: 'low', ability: 4 }],
    });
    report.calls.push({
      name: 'factory_models_save',
      modesIndependent: true,
      enabledModels: 1,
    });

    const save = await client.callTool({
      name: 'factory_call',
      arguments: {
        action: 'project_save',
        args: {
          name: 'MCP 验证项目',
          root: tempDir,
          requirements: '只验证插件接口。',
          rules: '执行者不得继续分派。',
          maxRetries: 1,
        },
      },
    });
    assert.ok(!save.isError, save.content?.[0]?.text ?? 'project_save 失败');
    const saveData = resultData(save);
    const projectId = saveData.id;
    report.calls.push({ name: 'factory_call', action: 'project_save' });

    const worker = await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'save',
        projectId,
        id: 'model_worker',
        name: '模型执行者',
        role: '实现',
        scope: '验证模型字段',
        files: ['src/**'],
        task: '验证 worker 模型引用。',
        acceptance: '指定与实际模型字段可保存。',
        dependencies: [],
        model: 'beta',
      },
    });
    assert.ok(!worker.isError, worker.content?.[0]?.text ?? 'worker_save 失败');
    const workerData = resultData(worker);
    assert.equal(workerData.model, 'beta');
    assert.equal(workerData.state, 'planned');
    const firstTaskVersion = workerData.taskVersion;
    const assigned = await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'save',
        projectId,
        id: 'model_worker',
        name: '模型执行者',
        role: '实现',
        scope: '验证模型字段',
        files: ['src/**'],
        task: '验证 worker 模型引用。',
        acceptance: '指定与实际模型字段可保存。',
        dependencies: [],
        model: 'beta',
        assignedModel: 'beta',
        revision: workerData.revision,
      },
    });
    assert.ok(!assigned.isError, assigned.content?.[0]?.text ?? 'assignedModel 保存失败');
    const assignedData = resultData(assigned);
    assert.equal(assignedData.taskVersion, firstTaskVersion);
    assert.equal(assignedData.assignedModel, 'beta');
    const changed = await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'save',
        projectId,
        id: 'model_worker',
        name: '模型执行者',
        role: '实现',
        scope: '验证模型字段',
        files: ['src/**'],
        task: '验证 worker 模型引用。',
        acceptance: '指定与实际模型字段可保存。',
        dependencies: [],
        model: 'alpha',
        revision: assignedData.revision,
      },
    });
    assert.ok(!changed.isError, changed.content?.[0]?.text ?? '模型变更保存失败');
    const changedData = resultData(changed);
    assert.equal(changedData.taskVersion, firstTaskVersion + 1);
    assert.equal(changedData.state, 'needs_ack');
    report.calls.push({
      name: 'factory_task',
      workerModel: changedData.model,
      assignedDoesNotBumpTask: true,
    });

    const fullRequirements = `完整需求-${'R'.repeat(4200)}`;
    const fullRules = `完整规则-${'Q'.repeat(4200)}`;
    const beforeProtocolRules = resultData(await client.callTool({
      name: 'factory_call',
      arguments: { action: 'project_get', args: { projectId } },
    }));
    const rulesReceipt = resultData(await client.callTool({
      name: 'factory_call',
      arguments: {
        action: 'rules_save',
        args: {
          projectId,
          requirements: fullRequirements,
          rules: fullRules,
          revision: beforeProtocolRules.revision,
        },
      },
    }));
    assert.equal(rulesReceipt.changed, true);
    assert.equal(rulesReceipt.requirementsVersion, 2);

    const longTask = `首次完整任务-${'T'.repeat(7000)}`;
    const longAcceptance = `完整验收-${'A'.repeat(3000)}`;
    const protocolWorkerReceipt = resultData(await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'save',
        projectId,
        id: 'protocol_worker',
        name: '协议执行者',
        role: '协议验证',
        scope: '完整任务、状态、消息与协调包',
        files: ['protocol/**'],
        task: longTask,
        acceptance: longAcceptance,
        dependencies: [],
        sessionId: 'fixture-thread',
      },
    }));
    assert.equal(protocolWorkerReceipt.taskVersion, 1);
    assert.equal(protocolWorkerReceipt.sessionBound, true);
    assert.equal(Object.hasOwn(protocolWorkerReceipt, 'worker'), false, '写回执不得回显完整 worker');
    const fullTask = resultData(await client.callTool({
      name: 'factory_task',
      arguments: { action: 'get', projectId, workerId: 'protocol_worker', view: 'full' },
    }));
    assert.equal(fullTask.requirements, fullRequirements, '首次任务领取不得截断需求');
    assert.equal(fullTask.rules, fullRules, '首次任务领取不得截断规则');
    assert.equal(fullTask.worker.task, longTask, '首次任务领取不得截断任务');
    assert.equal(fullTask.worker.acceptance, longAcceptance, '首次任务领取不得截断验收');
    const unchangedStatus = resultData(await client.callTool({
      name: 'factory_task',
      arguments: { action: 'get', projectId, workerId: 'protocol_worker', view: 'status' },
    }));
    assert.equal(unchangedStatus.refreshRequired, false);
    assert.equal(unchangedStatus.requiresFullTask, false);

    const updatedTask = `${longTask}\n新增任务版本约束`;
    const taskChangeReceipt = resultData(await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'save',
        projectId,
        id: 'protocol_worker',
        name: '协议执行者',
        role: '协议验证',
        scope: '完整任务、状态、消息与协调包',
        files: ['protocol/**'],
        task: updatedTask,
        acceptance: longAcceptance,
        dependencies: [],
        sessionId: 'fixture-thread',
        revision: fullTask.revision,
      },
    }));
    assert.equal(taskChangeReceipt.taskVersion, 2);
    assert.equal(taskChangeReceipt.state, 'needs_ack');
    const changedStatus = resultData(await client.callTool({
      name: 'factory_task',
      arguments: { action: 'get', projectId, workerId: 'protocol_worker', view: 'status' },
    }));
    assert.equal(changedStatus.taskChanged, true);
    assert.equal(changedStatus.refreshRequired, true);
    assert.equal(changedStatus.requiresFullTask, true);
    const ackReceipt = resultData(await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'ack',
        projectId,
        workerId: 'protocol_worker',
        revision: taskChangeReceipt.revision,
      },
    }));
    assert.equal(ackReceipt.acknowledgedTaskVersion, 2);
    assert.equal(ackReceipt.state, 'planned');

    const projectContext = resultData(await client.callTool({
      name: 'factory_context',
      arguments: { projectId },
    }));
    assert.equal(Object.hasOwn(projectContext, 'requirements'), false);
    assert.equal(Object.hasOwn(projectContext, 'rules'), false);
    assert.equal(Object.hasOwn(projectContext, 'decisions'), false);
    assert.equal(Object.hasOwn(projectContext, 'recentEvents'), false);
    const includedContext = resultData(await client.callTool({
      name: 'factory_context',
      arguments: { projectId, include: ['requirements', 'rules'] },
    }));
    assert.equal(includedContext.requirements, fullRequirements);
    assert.equal(includedContext.rules, fullRules);

    const oldBody = '旧格式 body 消息';
    const oldMessage = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'send',
        projectId,
        from: 'orchestrator',
        to: 'protocol_worker',
        kind: 'delta',
        body: oldBody,
        requestId: 'protocol-old-body',
      },
    }));
    assert.equal(oldMessage.notification.bodyIncluded, false);
    assert.equal(Object.hasOwn(oldMessage.notification, 'body'), false);
    const largeBody = `大消息-${'L'.repeat(3000)}`;
    const largeMessage = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'send',
        projectId,
        from: 'orchestrator',
        to: 'protocol_worker',
        kind: 'delta',
        body: largeBody,
        requestId: 'protocol-large-body',
      },
    }));
    const envelopeMessage = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'send',
        projectId,
        from: 'orchestrator',
        to: 'protocol_worker',
        envelope: {
          v: 1,
          type: 'blocker',
          summary: '需要用户授权',
          block: { code: 'AUTH', message: '缺少发布权限', needs: '用户确认' },
        },
        refs: ['project:auth'],
        requestId: 'protocol-envelope',
      },
    }));
    assert.equal(envelopeMessage.notification.bodyIncluded, false);
    const duplicateEnvelope = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'send',
        projectId,
        from: 'orchestrator',
        to: 'protocol_worker',
        envelope: {
          v: 1,
          type: 'blocker',
          summary: '需要用户授权',
          block: { code: 'AUTH', message: '缺少发布权限', needs: '用户确认' },
        },
        refs: ['project:auth'],
        requestId: 'protocol-envelope',
      },
    }));
    assert.equal(duplicateEnvelope.duplicate, true);
    assert.equal(duplicateEnvelope.id, envelopeMessage.id);
    const requestConflict = await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'send',
        projectId,
        from: 'orchestrator',
        to: 'protocol_worker',
        envelope: { v: 1, type: 'delta', summary: '不同内容' },
        requestId: 'protocol-envelope',
      },
    });
    assert.equal(requestConflict.isError, true);
    assert.match(requestConflict.content?.[0]?.text ?? '', /REQUEST_CONFLICT/);

    const firstPage = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'read',
        projectId,
        workerId: 'protocol_worker',
        limit: 1,
        maxChars: 1200,
        detail: 'summary',
      },
    }));
    assert.equal(firstPage.messages.length, 1);
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.messages[0].body, oldBody, '旧 body 消息必须继续可读');
    const secondPage = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'read',
        projectId,
        workerId: 'protocol_worker',
        after: firstPage.cursor,
        limit: 1,
        maxChars: 1200,
        detail: 'summary',
      },
    }));
    assert.equal(secondPage.messages[0].truncated, true);
    assert.equal(secondPage.messages[0].originalAvailable, true);
    assert.ok(secondPage.messages[0].body.length < largeBody.length);
    assert.equal(secondPage.page.budgetExceeded, true);
    const original = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'original',
        projectId,
        workerId: 'protocol_worker',
        messageId: largeMessage.id,
      },
    }));
    assert.equal(original.message.body, largeBody, '按需原文必须完整取回');
    const thirdPage = resultData(await client.callTool({
      name: 'factory_message',
      arguments: {
        action: 'read',
        projectId,
        workerId: 'protocol_worker',
        after: secondPage.cursor,
        limit: 1,
        maxChars: 1200,
        detail: 'summary',
      },
    }));
    assert.equal(thirdPage.messages[0].kind, 'blocker');
    assert.match(thirdPage.messages[0].body, /缺少发布权限/, '阻塞消息不得被摘要静默截掉');
    report.calls.push({
      name: 'factory_task',
      fullTask: true,
      statusDelta: true,
      receiptOnly: true,
    });
    report.calls.push({
      name: 'factory_message',
      envelope: true,
      idempotent: true,
      paged: true,
      original: true,
      notificationBodyIncluded: false,
    });

    const teamContext = await client.callTool({
      name: 'factory_context',
      arguments: { mode: 'team' },
    });
    const teamContextData = resultData(teamContext);
    assert.equal(teamContextData.mode, 'team');
    assert.equal(teamContextData.projectContextRead, false);
    assert.equal(teamContextData.mainConversationExecutes, true);
    assert.equal(Object.hasOwn(teamContextData, 'projectCount'), false);
    assert.equal(Object.hasOwn(teamContextData, 'projects'), false);
    const teamPanel = await client.callTool({
      name: 'factory_panel',
      arguments: { mode: 'team' },
    });
    assert.equal(teamPanel._meta.factory.mode, 'team');
    assert.equal(Object.hasOwn(teamPanel._meta.factory, 'projects'), false);
    assert.equal(teamPanel.structuredContent.projectContextRead, false);
    assert.equal(Object.hasOwn(teamPanel.structuredContent, 'projectCount'), false);
    report.calls.push({
      name: 'factory_context',
      mode: 'team',
      projectContextRead: false,
      projectCountPresent: false,
    });

    const coordinatorBefore = await client.callTool({
      name: 'factory_coordinator',
      arguments: { projectId, op: 'get' },
    });
    const coordinatorBeforeData = resultData(coordinatorBefore);
    assert.equal(coordinatorBeforeData.enabled, false);
    assert.equal(coordinatorBeforeData.status, 'off');
    assert.equal(coordinatorBeforeData.sessionLive, false);
    const coordinatorProject = await client.callTool({
      name: 'factory_call',
      arguments: { action: 'project_get', args: { projectId } },
    });
    const coordinatorProjectData = resultData(coordinatorProject);
    const coordinatorEnabled = await client.callTool({
      name: 'factory_coordinator',
      arguments: {
        projectId,
        op: 'enable',
        revision: coordinatorProjectData.revision,
        targetWorkerIds: ['protocol_worker'],
        authorizedRecipients: ['protocol_worker', 'orchestrator'],
        generalScope: '汇总进展并跟进依赖；关键事项请示总指挥。',
        waitSeconds: 60,
      },
    });
    assert.ok(
      !coordinatorEnabled.isError,
      coordinatorEnabled.content?.[0]?.text ?? 'factory_coordinator enable 失败',
    );
    const coordinatorEnabledData = resultData(coordinatorEnabled);
    assert.equal(coordinatorEnabledData.enabled, true);
    assert.equal(coordinatorEnabledData.status, 'waiting_binding');
    assert.equal(coordinatorEnabledData.sessionBound, false);
    assert.equal(coordinatorEnabledData.sessionLive, false);
    assert.equal(coordinatorEnabledData.taskVersion, 1);
    const coordinatorTask = resultData(await client.callTool({
      name: 'factory_task',
      arguments: {
        action: 'get',
        projectId,
        workerId: coordinatorEnabledData.workerId,
        view: 'full',
      },
    }));
    assert.match(coordinatorTask.worker.task, /protocol_worker/);
    assert.match(coordinatorTask.worker.task, /fixture-thread/);
    assert.match(coordinatorTask.worker.task, /authorizedRecipients|已授权消息对象/);
    assert.match(coordinatorTask.worker.task, /一般处理范围/);
    assert.match(coordinatorTask.worker.task, /协调任务版本=1/);
    assert.match(coordinatorTask.worker.task, /项目 revision=\d+/);
    assert.match(coordinatorTask.worker.task, /需求版本=2/);
    assert.match(coordinatorTask.worker.task, /超时不失败、不催问/);
    const coordinatorProjectAfter = await client.callTool({
      name: 'factory_call',
      arguments: { action: 'project_get', args: { projectId } },
    });
    const coordinatorProjectAfterData = resultData(coordinatorProjectAfter);
    assert.equal(
      coordinatorProjectAfterData.workers
        .filter((item) => item.roleKind === 'coordinator').length,
      1,
    );
    const coordinatorStart = await client.callTool({
      name: 'factory_coordinator',
      arguments: {
        projectId,
        op: 'start',
        revision: coordinatorProjectAfterData.revision,
      },
    });
    assert.equal(coordinatorStart.isError, true);
    assert.match(
      coordinatorStart.content?.[0]?.text ?? '',
      /尚未绑定真实线程/,
    );
    report.calls.push({
      name: 'factory_coordinator',
      defaultOff: true,
      uniqueCoordinator: true,
      startRequiresRealThread: true,
      sessionLive: false,
    });
  } finally {
    await client.close().catch(() => {});
    assertContainedTemp(tempDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  await fs.mkdir(verifyDir, { recursive: true });
  await fs.writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    record: path.relative(root, recordPath),
    tools: report.tools.map((tool) => tool.name),
    calls: report.calls,
  }, null, 2));
}

await main();
