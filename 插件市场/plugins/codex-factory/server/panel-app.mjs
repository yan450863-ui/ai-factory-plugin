import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { createModelSettingsPanel } from './model-panel.mjs';

const APP_VERSION = '0.4.5';
const app = new App({ name: 'AI工厂插件', version: APP_VERSION });
const $ = (id) => document.getElementById(id);

const WORKER_STATE_LABELS = Object.freeze({
  planned: '待开始',
  ready: '待运行',
  running: '进行中',
  waiting: '等待中',
  paused: '已暂停',
  needs_ack: '待确认',
  done: '已完成',
  failed: '失败',
  closed: '已关闭',
});

const PROJECT_STATE_LABELS = Object.freeze({
  active: '进行中',
  closed: '已关闭',
});

const MESSAGE_KIND_LABELS = Object.freeze({
  delta: '变化',
  blocker: '阻塞',
  result: '结果',
  decision: '决定',
  ack: '确认',
  error: '错误',
});

const EVENT_TYPE_LABELS = Object.freeze({
  project_created: '项目创建',
  project_updated: '项目更新',
  project_closed: '项目关闭',
  worker_created: '工作对话创建',
  worker_updated: '工作对话更新',
  worker_ack: '工作对话确认',
  worker_state: '工作对话状态变化',
  worker_retry: '工作对话重试',
  worker_reopen: '工作对话重新打开',
  coordinator_enabled: '协调助手开启',
  coordinator_state: '协调助手状态变化',
  evidence_added: '证据已记录',
  message_sent: '消息已保存',
  decision_added: '决定已保存',
  rules_updated: '规则更新',
});

const state = {
  overview: null,
  project: null,
  workerData: null,
  messages: [],
  busy: false,
  connected: false,
  loadSequence: 0,
  modelData: null,
  mode: new URLSearchParams(window.location.search).get('mode') === 'team' ? 'team' : 'factory',
};
let suppressWorkerDialogCloseClear = false;
let modelPanel = null;

function payload(result) {
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === 'text')?.text || '操作失败';
    throw new Error(message);
  }
  if (result?._meta?.factory) return result._meta.factory;
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

async function read(action, args = {}) {
  return payload(await app.callServerTool({
    name: 'factory_ui_read',
    arguments: { action, args },
  }));
}

async function write(action, args = {}) {
  return payload(await app.callServerTool({
    name: 'factory_call',
    arguments: { action, args },
  }));
}

function notice(message, type = '') {
  const element = state.mode === 'team' ? $('teamNotice') : $('notice');
  element.hidden = !message;
  element.className = `notice ${type}`.trim();
  element.textContent = message;
}

function setBusy(value) {
  state.busy = value;
  document.body.setAttribute('aria-busy', String(value));
  if (state.connected) {
    $('status').textContent = value ? '处理中' : '已连接';
    $('status').className = `badge${value ? ' waiting' : ' done'}`;
  }
  for (const element of document.querySelectorAll('button,input,textarea,select')) {
    element.disabled = value;
  }
  if (!value) syncControls();
}

async function withBusy(operation) {
  if (state.busy) return undefined;
  setBusy(true);
  try {
    return await operation();
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error), 'error');
    return undefined;
  } finally {
    setBusy(false);
  }
}

function stateLabel(value) {
  return WORKER_STATE_LABELS[value] || '未识别状态';
}

function projectStateLabel(value) {
  return PROJECT_STATE_LABELS[value] || '未识别状态';
}

function messageKindLabel(value) {
  return MESSAGE_KIND_LABELS[value] || '其他消息';
}

function eventTypeLabel(value) {
  return EVENT_TYPE_LABELS[value] || '其他事件';
}

function syncControls() {
  const connected = state.connected;
  const project = state.project;
  const projectOpen = Boolean(project && project.status !== 'closed');
  const worker = state.workerData?.worker;
  const workerClosed = worker?.state === 'closed';
  const pending = worker ? ackPending(state.workerData) : false;

  $('refresh').disabled = state.busy || !connected;
  $('newProject').disabled = state.busy || !connected || state.mode !== 'factory';
  $('modelSettings').disabled = state.busy || !connected;
  $('editRules').disabled = state.busy || !projectOpen;
  $('addWorker').disabled = state.busy || !projectOpen;
  $('requestProject').disabled = state.busy || !projectOpen;
  const retryApplicable = Boolean(worker && ['failed', 'paused', 'needs_ack', 'waiting', 'ready'].includes(worker.state));
  const reopenApplicable = Boolean(worker && ['done', 'failed', 'closed', 'needs_ack', 'paused'].includes(worker.state));
  $('ackWorker').hidden = !worker || workerClosed || !pending;
  $('retryWorker').hidden = !retryApplicable;
  $('reopenWorker').hidden = !reopenApplicable;
  $('closeWorker').hidden = !worker || workerClosed || !projectOpen;
  $('ackWorker').disabled = state.busy || !pending;
  $('retryWorker').disabled = state.busy || !retryApplicable;
  $('reopenWorker').disabled = state.busy || !reopenApplicable;
  $('continueWorker').disabled = state.busy || !projectOpen || !worker || workerClosed;
  $('pauseWorker').disabled = state.busy
    || !projectOpen
    || !worker
    || ['done', 'closed', 'failed'].includes(worker.state);
  $('closeWorker').disabled = state.busy || !projectOpen || !worker || workerClosed;
  $('saveWorker').disabled = state.busy || !projectOpen || workerClosed;
  $('startAfterSave').disabled = state.busy || !projectOpen || workerClosed;
  $('workerFields').disabled = Boolean(workerClosed);
  for (const id of [
    'teamEnabled',
    'teamKeepInCurrentChat',
    'teamAllowHelpers',
    'teamMaxAgents',
  ]) {
    $(id).disabled = state.busy || !connected || !state.modelData;
  }
}

function lineList(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function setText(id, value) {
  $(id).textContent = value ?? '';
}

function compactText(value, fallback = '—') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function makeBadge(text, className = '') {
  const badge = document.createElement('span');
  badge.className = `badge ${className}`.trim();
  badge.textContent = text;
  return badge;
}

function makeEmpty(message) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = message;
  return empty;
}

const COORDINATOR_STATUS_LABELS = Object.freeze({
  off: '未开启',
  waiting_binding: '待启动',
  monitoring: '跟进中',
  stopping: '正在停止',
  stopped: '已停止',
  lost: '待核实',
});

function coordinatorLabel(coordinator) {
  if (coordinator?.status === 'monitoring') {
    const heartbeat = coordinator.lastHeartbeatAt ? Date.parse(coordinator.lastHeartbeatAt) : NaN;
    const stale = !Number.isFinite(heartbeat)
      || Date.now() - heartbeat > (coordinator.waitSeconds || 180) * 2_000;
    if (stale) return '待核实';
  }
  return COORDINATOR_STATUS_LABELS[coordinator?.status] || '未开启';
}

function teamSettings() {
  return state.modelData?.settings?.modes?.team || null;
}

function renderTeamSettings() {
  const team = teamSettings();
  if (!team) {
    setText('teamPolicySummary', '正在读取团队模式设置…');
    return;
  }
  $('teamEnabled').checked = team.enabled;
  $('teamKeepInCurrentChat').checked = team.keepInCurrentChat;
  $('teamAllowHelpers').checked = !team.disableSubagents;
  $('teamMaxAgents').value = String(team.maxAgents);
  setText('teamEnabledHint', team.enabled
    ? '开启后按需派发；简单任务由主对话直接完成。'
    : '当前关闭；已有工作继续，不再新派发。');
  const policy = [];
  policy.push(team.keepInCurrentChat ? '不开独立工作对话' : '可按需开独立工作对话');
  policy.push(team.disableSubagents ? '不使用一层助手' : `最多 ${team.maxAgents} 个一层助手`);
  setText('teamPolicySummary', `当前策略：${policy.join(' · ')}。团队不会读取工厂项目、任务、规则或历史。`);
}

function setMode(mode, { refreshFactory = true } = {}) {
  state.mode = mode === 'team' ? 'team' : 'factory';
  const team = state.mode === 'team';
  $('appTitle').textContent = 'AI工厂插件';
  $('teamView').hidden = !team;
  $('factoryShell').hidden = team;
  $('modeFactory').classList.toggle('active', !team);
  $('modeTeam').classList.toggle('active', team);
  $('modeFactory').setAttribute('aria-selected', String(!team));
  $('modeTeam').setAttribute('aria-selected', String(team));
  $('refresh').hidden = team;
  $('newProject').hidden = team;
  if (team) {
    notice('');
    renderTeamSettings();
  } else if (refreshFactory && state.connected) {
    notice('');
    refresh();
  }
  syncControls();
}

async function saveTeamSettings() {
  if (!state.modelData?.settings) return false;
  const settings = structuredClone(state.modelData.settings);
  settings.modes.team = {
    enabled: $('teamEnabled').checked,
    keepInCurrentChat: $('teamKeepInCurrentChat').checked,
    disableSubagents: !$('teamAllowHelpers').checked,
    maxAgents: Number($('teamMaxAgents').value),
  };
  if (!Number.isInteger(settings.modes.team.maxAgents)
    || settings.modes.team.maxAgents < 1
    || settings.modes.team.maxAgents > 16) {
    notice('同时助手上限应为 1–16。', 'error');
    return false;
  }
  const result = await app.callServerTool({
    name: 'factory_models_save',
    arguments: settings,
  });
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === 'text')?.text || '团队设置保存失败');
  }
  state.modelData = result?._meta?.factoryModels || state.modelData;
  if (state.modelData?.settings && state.modelData?.catalog) modelPanel.accept(state.modelData);
  renderTeamSettings();
  notice('团队设置已保存；只影响后续派发。', 'ok');
  return true;
}

function renderCoordinator() {
  const coordinator = state.project?.coordinator || { enabled: false, status: 'off' };
  const worker = state.project?.workers?.find((item) => item.id === coordinator.workerId);
  const label = coordinatorLabel(coordinator);
  $('coordinatorStatus').textContent = label;
  $('coordinatorStatus').className = `badge ${
    coordinator.status === 'monitoring' && label === '跟进中'
      ? 'running'
      : coordinator.status === 'waiting_binding' || coordinator.status === 'stopping'
        ? 'waiting'
        : coordinator.status === 'lost'
          ? 'failed'
          : 'closed'
  }`;
  const targetCount = coordinator.targetWorkerIds?.length || 0;
  let meta = coordinator.enabled
    ? `已选择 ${targetCount} 个工作对话。`
    : '默认关闭。仅在需要持续跟进时启用。';
  if (coordinator.enabled && !worker?.sessionId) {
    meta += ' 尚未绑定宿主线程，不会显示为在线。';
  } else if (coordinator.status === 'monitoring') {
    const last = coordinator.lastHeartbeatAt
      ? new Date(coordinator.lastHeartbeatAt).toLocaleString()
      : '未知时间';
    meta += ` 上次确认 ${last}；需宿主在线，引用本身不等于 live。`;
  } else if (coordinator.status === 'lost') {
    meta += ' 宿主退出或心跳过期时只能标记待核实，不能证明任务已经停止。';
  }
  $('coordinatorMeta').textContent = meta;
  $('coordinatorToggle').textContent = coordinator.enabled ? '停止跟进' : '开始跟进';
  $('coordinatorToggle').className = coordinator.enabled ? 'danger' : 'secondary';
  $('coordinatorToggle').disabled = state.busy || !state.project || state.project.status === 'closed';
}

function ackPending(workerData) {
  return workerData.worker.acknowledgedRequirementsVersion < workerData.requirementsVersion
    || workerData.worker.acknowledgedTaskVersion < workerData.worker.taskVersion;
}

function workerModel(worker) {
  return String(worker?.model || worker?.worker?.model || 'auto');
}

function assignedWorkerModel(worker) {
  return String(
    worker?.assignedModel
      || worker?.assigned_model
      || worker?.worker?.assignedModel
      || worker?.worker?.assigned_model
      || '',
  );
}

function workerLaunch(worker) {
  return worker?.launch || worker?.worker?.launch || null;
}

function launchReportedModel(launch) {
  return launch?.hostReport?.model || launch?.hostReportedModel || '';
}

function isAvailableModel(modelId) {
  return modelPanel?.availableModels().some((model) => model.id === modelId) || false;
}

function workerModelLabel(worker) {
  const selected = workerModel(worker);
  const launch = workerLaunch(worker);
  const assigned = assignedWorkerModel(worker);
  if (selected === 'auto') {
    const reported = launchReportedModel(launch);
    if (reported) {
      return `自动选择 · 报告 ${reported}（待核实）`;
    }
    if (launch?.model) return `自动选择 · 请求 ${launch.model}`;
    if (assigned) return `自动选择 · 历史 ${assigned}（未核实）`;
    return '自动选择';
  }
  const knownCatalog = Boolean(state.modelData?.catalog?.length);
  const unavailable = knownCatalog && !isAvailableModel(selected);
  return `模型：${selected}${unavailable ? '（已禁用或不可用）' : ''}`;
}

function workerModelHint(
  modelId = $('workerModel').value,
  assignedModel = assignedWorkerModel(state.workerData?.worker),
  launch = workerLaunch(state.workerData?.worker),
) {
  if (!modelId || modelId === 'auto') {
    const reported = launchReportedModel(launch);
    if (reported) {
      return `自动选择；宿主报告 ${reported}，记录待核实，不等于已证明实际路由。`;
    }
    if (launch?.model) {
      return `自动选择已解析为 ${launch.model}；这是启动请求，不等于宿主实际路由。`;
    }
    return assignedModel
      ? `自动选择；历史 assignedModel ${assignedModel} 未核实。`
      : '自动选择会从当前启用且可用的模型中选择。';
  }
  if (!isAvailableModel(modelId)) {
    return '当前模型已禁用或不可用；保存会保留原选择，请明确改选。';
  }
  return '已指定模型；保存不会证明宿主实际路由。档位与能力沿用全局设置。';
}

function renderWorkerModelOptions(worker = null) {
  const select = $('workerModel');
  const selected = workerModel(worker);
  select.replaceChildren();
  const automatic = document.createElement('option');
  automatic.value = 'auto';
  automatic.textContent = '自动选择';
  select.append(automatic);
  for (const model of modelPanel?.availableModels() || []) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id;
    select.append(option);
  }
  if (selected !== 'auto' && !isAvailableModel(selected)) {
    const option = document.createElement('option');
    option.value = selected;
    option.textContent = `${selected}（已禁用或不可用，请重新选择）`;
    option.disabled = true;
    select.append(option);
  }
  select.value = selected === 'auto' || [...select.options].some((option) => option.value === selected)
    ? selected
    : 'auto';
  const hint = $('workerModelHint');
  const unavailable = selected !== 'auto' && !isAvailableModel(selected);
  hint.textContent = workerModelHint(select.value, assignedWorkerModel(worker), workerLaunch(worker));
  hint.className = `form-note${unavailable ? ' error' : ''}`;
  const launch = workerLaunch(worker);
  const reported = launchReportedModel(launch);
  $('workerNameModelHint').textContent = selected === 'auto'
    ? (reported
        ? `自动选择 · 报告 ${reported}（待核实）`
        : launch?.model
          ? `自动选择 · 请求 ${launch.model}`
          : assignedWorkerModel(worker)
            ? `自动选择 · 历史 ${assignedWorkerModel(worker)}（未核实）`
            : '自动选择')
    : `模型：${selected}${unavailable ? '（不可用）' : ''}`;
  $('workerNameModelHint').className = `worker-model-label${unavailable ? ' unavailable' : ''}`;
}

function workerName(workerId) {
  if (!workerId) return '系统';
  if (workerId === 'orchestrator') return '当前总指挥';
  if (workerId === 'user') return '用户';
  if (workerId === 'host') return '宿主';
  return state.project?.workers?.find((worker) => worker.id === workerId)?.name || '工作对话';
}

function renderProjects() {
  const list = $('projectList');
  list.replaceChildren();
  const projects = state.overview?.projects || [];
  $('projectCount').textContent = String(projects.length);
  if (projects.length === 0) {
    list.append(makeEmpty('暂无项目'));
    return;
  }
  for (const project of projects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `project-item${project.id === state.project?.id ? ' active' : ''}`;
    const name = document.createElement('div');
    name.className = 'project-name';
    const title = document.createElement('span');
    title.className = 'project-name-text';
    title.textContent = project.name;
    name.append(title, makeBadge(
      projectStateLabel(project.status),
      project.status === 'closed' ? 'closed' : 'running',
    ));
    const meta = document.createElement('div');
    meta.className = 'project-meta';
    meta.textContent = `${project.workers?.length || 0} 个工作对话`;
    button.append(name, meta);
    button.onclick = () => selectProject(project.id);
    list.append(button);
  }
}

function createWorkerRow(worker, { history = false } = {}) {
  const row = document.createElement('tr');
  row.className = worker.id === state.workerData?.workerId ? 'active' : '';
  row.tabIndex = 0;
  row.dataset.workerId = worker.id;
  row.setAttribute('aria-label', `${history ? '查看历史：' : '打开工作对话：'}${worker.name}`);
  row.onclick = () => {
    if (!state.busy) openWorkerDetails(worker.id);
  };
  row.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (state.busy) {
        notice('正在处理上一项操作，请稍候。');
        return;
      }
      openWorkerDetails(worker.id);
    }
  };

  const identity = document.createElement('td');
  const name = document.createElement('div');
  name.className = 'worker-name';
  name.textContent = worker.name;
  const model = document.createElement('div');
  model.className = `worker-model-label${
    workerModel(worker) !== 'auto' && !isAvailableModel(workerModel(worker)) ? ' unavailable' : ''
  }`;
  model.textContent = workerModelLabel(worker);
  model.title = model.textContent;
  identity.append(name, model);

  const scopeCell = document.createElement('td');
  const scope = document.createElement('div');
  scope.className = 'line-clamp';
  scope.textContent = compactText(worker.scope, '未填写分工');
  scope.title = String(worker.scope || '');
  scopeCell.append(scope);

  const taskCell = document.createElement('td');
  const task = document.createElement('div');
  task.className = 'line-clamp';
  task.textContent = compactText(worker.task, '暂无当前任务');
  task.title = String(worker.task || '');
  taskCell.append(task);

  const statusCell = document.createElement('td');
  statusCell.append(makeBadge(stateLabel(worker.state), worker.state));

  row.append(identity, scopeCell, taskCell, statusCell);
  return row;
}

function renderWorkerRows() {
  const workers = (state.project?.workers || []).filter((worker) => worker.roleKind !== 'coordinator');
  const activeWorkers = workers.filter((worker) => worker.state !== 'closed');
  const historyWorkers = workers.filter((worker) => worker.state === 'closed');
  const body = $('workerRows');
  const historyBody = $('historyRows');
  body.replaceChildren();
  historyBody.replaceChildren();
  $('workerCount').textContent = String(activeWorkers.length);
  $('historyCount').textContent = String(historyWorkers.length);

  if (activeWorkers.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.append(makeEmpty('还没有工作对话'));
    row.append(cell);
    body.append(row);
  } else {
    for (const worker of activeWorkers) body.append(createWorkerRow(worker));
  }

  if (historyWorkers.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.append(makeEmpty('暂无已关闭工作对话'));
    row.append(cell);
    historyBody.append(row);
  } else {
    for (const worker of historyWorkers) historyBody.append(createWorkerRow(worker, { history: true }));
  }
}

function projectSummary(project) {
  const workers = (project.workers || []).filter((worker) => worker.roleKind !== 'coordinator');
  const running = workers.filter((worker) => worker.state === 'running').length;
  const latest = workers
    .filter((worker) => worker.summary)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  const recent = compactText(latest?.summary, '尚未记录最近进展');
  return `${workers.length} 个工作对话，${running} 项进行中 · 最近：${recent}`;
}

function renderProject() {
  const project = state.project;
  $('emptyProject').hidden = Boolean(project);
  $('projectView').hidden = !project;
  if (!project) {
    syncControls();
    return;
  }
  setText('projectTitle', project.name);
  setText('projectSummary', projectSummary(project));
  $('projectSummary').title = `“进行中”来自宿主记录，不代表已核实 live 会话。\n需求：${project.requirements || '未填写'}`;
  $('projectStatus').replaceChildren(makeBadge(
    projectStateLabel(project.status),
    project.status === 'closed' ? 'closed' : 'running',
  ));
  setText('projectRevision', `项目 revision ${project.revision} · 需求版本 ${project.requirementsVersion}`);
  setText('projectPath', project.root);
  setText('projectRequirementsMore', project.requirements || '未填写');
  renderWorkerRows();
  renderMessages();
  renderEvents();
  renderDecisions();
  renderEvidence();
  renderRecipients();
  renderCoordinator();
  syncControls();
}

function renderMessages() {
  const list = $('messageList');
  list.replaceChildren();
  if (state.messages.length === 0) {
    list.append(makeEmpty('暂无内部消息'));
    return;
  }
  for (const message of state.messages) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `#${message.sequence} · ${messageKindLabel(message.kind)} · ${workerName(message.from)} → ${workerName(message.to)} · ${new Date(message.createdAt).toLocaleString()}`;
    const body = document.createElement('div');
    body.className = 'pre';
    body.textContent = message.body;
    item.append(meta, body);
    if (message.refs?.length) {
      const refs = document.createElement('div');
      refs.className = 'path';
      refs.textContent = message.refs.join('\n');
      item.append(refs);
    }
    list.append(item);
  }
}

function renderEvents() {
  const list = $('tab-events');
  list.replaceChildren();
  const events = (state.project?.events || []).slice(-30).reverse();
  if (events.length === 0) {
    list.append(makeEmpty('暂无事件'));
    return;
  }
  for (const event of events) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${eventTypeLabel(event.type)} · ${new Date(event.createdAt).toLocaleString()}${event.workerId ? ` · ${workerName(event.workerId)}` : ''}`;
    const body = document.createElement('div');
    body.textContent = event.summary || '—';
    item.append(meta, body);
    list.append(item);
  }
}

function renderDecisions() {
  const list = $('tab-decisions');
  list.replaceChildren();
  const decisions = (state.project?.decisions || []).slice(-30).reverse();
  if (decisions.length === 0) {
    list.append(makeEmpty('暂无已保存决定'));
    return;
  }
  for (const decision of decisions) {
    const item = document.createElement('div');
    item.className = 'list-item';
    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = new Date(decision.createdAt).toLocaleString();
    const body = document.createElement('div');
    body.className = 'pre';
    body.textContent = decision.text;
    item.append(meta, body);
    list.append(item);
  }
}

function renderEvidence() {
  const list = $('projectEvidence');
  list.replaceChildren();
  const evidence = (state.project?.evidence || []).slice(-30).reverse();
  if (evidence.length === 0) {
    list.append(makeEmpty('暂无证据记录'));
    return;
  }
  for (const item of evidence) {
    const element = document.createElement('div');
    element.className = 'list-item';
    const meta = document.createElement('div');
    meta.className = 'list-meta';
    meta.textContent = `${workerName(item.workerId)} · 退出码 ${item.exitCode ?? '未记录'} · 任务版本 ${item.taskVersion ?? '未记录'}`;
    const command = document.createElement('div');
    command.className = 'mono pre';
    command.textContent = item.command || item.summary || '—';
    const log = document.createElement('div');
    log.className = 'path';
    log.textContent = item.logPath || '';
    element.append(meta, command, log);
    list.append(element);
  }
}

function renderRecipients() {
  const select = $('messageTo');
  const previous = select.value;
  select.replaceChildren();
  const orchestrator = document.createElement('option');
  orchestrator.value = 'orchestrator';
  orchestrator.textContent = '当前总指挥';
  select.append(orchestrator);
  for (const worker of state.project?.workers || []) {
    const option = document.createElement('option');
    option.value = worker.id;
    option.textContent = worker.name;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function fillWorkerForm(data) {
  const worker = data.worker;
  $('workerName').value = worker.name;
  $('workerRole').value = worker.role;
  $('workerScope').value = worker.scope;
  $('editWorkerFiles').value = (worker.files || []).join('\n');
  $('editWorkerTask').value = worker.task;
  $('editWorkerAcceptance').value = worker.acceptance;
  $('editWorkerDependencies').value = (worker.dependencies || []).join('\n');
  $('editWorkerSession').value = worker.sessionId || '';
  $('workerWorktree').value = worker.worktree || '';
  renderWorkerModelOptions(worker);
  $('workerStatus').replaceChildren(makeBadge(stateLabel(worker.state), worker.state));
  $('workerStatus').hidden = false;
  $('workerStateActions').hidden = false;
  $('workerAdvancedActions').hidden = false;
  const pending = ackPending(data);
  const dependencyNames = data.dependencies?.length
    ? data.dependencies.map((item) => `${item.name || item.id}（${stateLabel(item.state)}）`).join('、')
    : '无';
  $('workerTechnical').textContent = [
    `工作对话 revision ${data.revision} · 任务版本 ${worker.taskVersion} · 已确认 ${worker.acknowledgedTaskVersion}`,
    `需求版本 ${data.requirementsVersion} · 已确认 ${worker.acknowledgedRequirementsVersion}${pending ? ' · 等待确认' : ''}`,
    `依赖：${dependencyNames}`,
    worker.sessionId
      ? '会话引用：已记录；是否仍在运行：未核实。'
      : '会话引用：未记录。',
  ].join(' · ');
  $('workerTechnical').hidden = false;
}

function resetWorkerForm() {
  $('workerForm').reset();
  $('workerFields').disabled = false;
  $('workerStatus').hidden = true;
  $('workerStatus').replaceChildren();
  $('workerStateActions').hidden = true;
  $('workerAdvancedActions').hidden = true;
  $('workerTechnical').hidden = true;
  $('workerTechnical').textContent = '';
  $('startAfterSave').checked = false;
  renderWorkerModelOptions(null);
}

function openWorkerDialog(edit = false) {
  const dialog = $('workerDialog');
  resetWorkerForm();
  $('workerDialogTitle').textContent = edit ? '工作对话详情' : '添加工作对话';
  $('saveWorker').textContent = edit ? '保存修改' : '保存工作对话';
  if (edit && state.workerData) fillWorkerForm(state.workerData);
  if (!dialog.open) dialog.showModal();
  syncControls();
}

function closeWorkerDialog({ clear = true } = {}) {
  suppressWorkerDialogCloseClear = !clear;
  $('workerDialog').close();
  if (clear) {
    state.workerData = null;
    renderWorkerRows();
  }
}

async function loadProjectInternal(projectId, { workerId } = {}) {
  const sequence = ++state.loadSequence;
  const project = await read('project_get', { projectId });
  if (sequence !== state.loadSequence) return;
  state.project = project;
  state.workerData = null;
  state.messages = (project.messages || []).slice(-20);
  renderProjects();
  renderProject();
  if (workerId) await loadWorkerInternal(workerId);
}

async function selectProject(projectId) {
  $('historyPanel').open = false;
  $('morePanel').open = false;
  await withBusy(() => loadProjectInternal(projectId));
}

async function loadWorkerInternal(workerId) {
  const data = await read('worker_get', {
    projectId: state.project.id,
    workerId,
  });
  state.workerData = data;
  renderWorkerRows();
  if ($('workerDialog').open) fillWorkerForm(data);
  syncControls();
  return data;
}

async function openWorkerDetails(workerId) {
  await withBusy(async () => {
    await loadWorkerInternal(workerId);
    openWorkerDialog(true);
  });
}

async function refreshInternal() {
  const previousProject = state.project?.id;
  state.overview = await read('overview');
  const projects = state.overview.projects || [];
  const projectId = projects.some((project) => project.id === previousProject)
    ? previousProject
    : projects[0]?.id;
  if (!projectId) {
    state.project = null;
    state.workerData = null;
    state.messages = [];
    renderProjects();
    renderProject();
    return;
  }
  await loadProjectInternal(projectId);
}

async function refresh() {
  await withBusy(refreshInternal);
}

function openProjectDialog() {
  $('projectForm').reset();
  $('projectMaxRetries').value = '2';
  $('projectDialog').showModal();
}

function openRulesDialog() {
  if (!state.project) return;
  $('editRequirements').value = state.project.requirements || '';
  $('editRulesText').value = state.project.rules || '';
  $('rulesDialog').showModal();
}

function coordinatorRecipients() {
  const targets = [...document.querySelectorAll('#coordinatorTargets input:checked')]
    .map((input) => input.value);
  return [...new Set([...targets, 'orchestrator'])];
}

function renderCoordinatorAuthorization() {
  const recipients = coordinatorRecipients();
  $('coordinatorAuthorization').textContent = recipients.length > 1
    ? '可联系：所选工作对话和总指挥。'
    : '请至少选择一个要跟进的工作对话。';
}

function openCoordinatorDialog() {
  const workers = (state.project?.workers || [])
    .filter((worker) => worker.roleKind !== 'coordinator' && worker.state !== 'closed');
  if (workers.length === 0) {
    notice('当前项目还没有可监控的工作对话。请先添加工作对话。', 'error');
    return;
  }
  const coordinator = state.project.coordinator || {};
  const selected = new Set(coordinator.targetWorkerIds || []);
  const list = $('coordinatorTargets');
  list.replaceChildren();
  for (const worker of workers) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = worker.id;
    input.checked = selected.has(worker.id) || selected.size === 0;
    input.onchange = renderCoordinatorAuthorization;
    const copy = document.createElement('span');
    copy.textContent = `${worker.name}（${worker.sessionId ? '已有线程引用' : '待绑定线程'}）`;
    label.append(input, copy);
    list.append(label);
  }
  $('coordinatorScope').value = coordinator.generalScope
    || '汇总进展、跟进依赖、补充必要信息；在现有重试额度内请求原执行者修复并自验。';
  renderCoordinatorAuthorization();
  $('coordinatorDialog').showModal();
}

async function sendHostRequest(body) {
  try {
    const result = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: body }],
    });
    if (result?.isError) throw new Error('宿主拒绝发送');
    notice('请求已交给当前宿主对话；是否启动以真实线程和宿主状态为准。', 'ok');
    return true;
  } catch (error) {
    $('fallbackText').value = body;
    $('fallbackDialog').showModal();
    notice(`配置已保存，但宿主未接收请求：${error.message}`, 'error');
    return false;
  }
}

async function stopCoordinator() {
  const coordinator = state.project.coordinator;
  const worker = state.project.workers?.find((item) => item.id === coordinator.workerId);
  await write('coordinator_control', {
    projectId: state.project.id,
    op: 'request_stop',
    revision: state.project.revision,
    reason: '用户点击停止跟进',
  });
  const body = [
    '【软件工厂｜停止长任务跟进】',
    `project: ${state.project.id}`,
    `coordinator: ${coordinator.workerId || '未绑定'}`,
    worker?.sessionId ? `thread: ${worker.sessionId}` : 'thread: 未绑定',
    '请停止当前协调工作对话的有界等待或原生任务，确认后再调用 factory_coordinator op=stop；不要创建额外代理或常驻服务。',
  ].join('\n');
  await sendHostRequest(body);
  await loadProjectInternal(state.project.id);
}

async function enableCoordinator() {
  const targetWorkerIds = [...document.querySelectorAll('#coordinatorTargets input:checked')]
    .map((input) => input.value);
  if (targetWorkerIds.length === 0) {
    notice('请至少选择一个要跟进的工作对话。', 'error');
    return;
  }
  const authorizedRecipients = [...new Set([...targetWorkerIds, 'orchestrator'])];
  const generalScope = $('coordinatorScope').value.trim();
  if (!generalScope) {
    notice('请填写一般处理范围。', 'error');
    return;
  }
  const data = await write('coordinator_control', {
    projectId: state.project.id,
    op: 'enable',
    revision: state.project.revision,
    targetWorkerIds,
    authorizedRecipients,
    generalScope,
    waitSeconds: 180,
  });
  $('coordinatorDialog').close();
  const body = [
    '【软件工厂｜开始长任务跟进】',
    `project: ${state.project.id}`,
    `coordinator: ${data.workerId}`,
    `targets: ${targetWorkerIds.join(', ')}`,
    `authorizedRecipients: ${authorizedRecipients.join(', ')}`,
    `generalScope: ${generalScope}`,
    `projectRevision: ${data.projectRevision}`,
    `taskVersion: ${data.taskVersion ?? '待读取'}`,
    '请加载 factory-coordinator 技能，优先复用该协调工作对话；如尚无真实线程，按一层限制创建一个并保存真实 thread 引用。',
    '先读取最新 worker_get 并确认，再调用 factory_coordinator start。使用增量游标和宿主有界等待，不创建下属、不启动 CLI 或常驻服务。',
    '主界面只显示“开始/停止跟进”；绑定、心跳、游标和关键升级由协调工作流处理。',
  ].join('\n');
  await sendHostRequest(body);
  await loadProjectInternal(state.project.id);
}

async function dispatchIntentInternal(kind, workerId = state.workerData?.workerId) {
  if (!state.project) return;
  const modelSettings = state.modelData?.settings?.modes?.factory
    || modelPanel?.data?.settings?.modes?.factory;
  if (modelSettings?.enabled === false && ['create', 'continue'].includes(kind)) {
    notice('自动团队已关闭，不会新派发；项目、规则和工作记录仍可管理。请在模型设置中开启后重试。', 'error');
    return;
  }
  const projectId = state.project.id;
  const worker = workerId
    ? state.project.workers?.find((item) => item.id === workerId)
    : null;
  const target = worker ? `${worker.name}（${worker.id}）` : '项目全部工作对话';
  let behaviorHint = '';
  if (modelSettings?.enabled === false) {
    behaviorHint = '软件工厂模式已关闭：仅管理或读取现有记录，不新派发';
  } else if (modelSettings?.disableSubagents && modelSettings?.keepInCurrentChat) {
    behaviorHint = '软件工厂：不创建独立工作对话，也不创建子代理；普通工作由当前对话直接执行';
  } else if (modelSettings?.disableSubagents) {
    behaviorHint = '软件工厂：优先复用；可创建或继续一层独立工作对话，但不得创建子代理';
  } else if (modelSettings?.keepInCurrentChat) {
    behaviorHint = '软件工厂：不创建独立用户聊天，只允许当前聊天内的一层临时子代理';
  }
  const actionText = {
    pause: '核实会话后暂停对应原生任务',
    close: '实际停止对应原生任务后再关闭记录',
    continue: '核实并继续已有原生执行者',
    ack: '通知执行者本人读取最新 worker_get 后确认；总指挥不得代替执行者 ack',
    create: '先用 factory_task action=prepare 生成 prompt/model/thinking/target，再创建或继续一层原生工作对话；禁止继续分派',
    'create-or-check': '检查当前项目是否已有可复用执行者',
  }[kind] || `处理 ${kind}`;
  const body = [
    `【软件工厂｜${kind}】`,
    `project: ${projectId}`,
    worker ? `worker: ${worker.id}` : 'worker: 当前项目',
    `用户增量：${actionText}；对象 ${target}`,
    ...(worker ? [
      `任务指定模型：${workerModel(worker)}`
      + `${workerLaunch(worker)?.model ? `；启动请求：${workerLaunch(worker).model}` : ''}`
      + `${launchReportedModel(workerLaunch(worker)) ? `；宿主报告：${launchReportedModel(workerLaunch(worker))}（待核实）` : ''}`
      + `${assignedWorkerModel(worker) ? `；历史 assignedModel：${assignedWorkerModel(worker)}（未核实）` : ''}`,
    ] : []),
    ...(behaviorHint ? [`开关：${behaviorHint}`] : []),
    '请按需读取最新 factory 模式 settings、project_get、worker_get；后续只传 delta + refs。',
  ].filter(Boolean).join('\n');
  const receipt = await write('message_send', {
    projectId,
    from: 'user',
    to: 'orchestrator',
    kind: 'decision',
    body,
    refs: [`project:${projectId}`, ...(worker ? [`worker:${worker.id}`] : [])],
    requestId: crypto.randomUUID(),
  });
  const reference = [
    `【软件工厂｜${kind}】`,
    `project: ${projectId}`,
    `worker: ${worker?.id || '当前项目'}`,
    `message: ${receipt.id}`,
    `cursor: m:${receipt.sequence}`,
    '正文已持久化。请用 factory_message action=read（或按需 original）读取，不在宿主通知里重复正文。',
  ].join('\n');
  try {
    const result = await app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: reference }],
    });
    if (result?.isError) throw new Error('宿主拒绝发送');
    notice('请求已保存，宿主只收到消息引用；是否执行以宿主实际原生工作对话状态为准。', 'ok');
  } catch (error) {
    $('fallbackText').value = reference;
    $('fallbackDialog').showModal();
    notice(`请求已保存，但宿主通知未送达：${error.message}；可按消息引用恢复`, 'error');
  }
  const dialogOpen = $('workerDialog').open;
  await loadProjectInternal(projectId, workerId ? { workerId } : {});
  if (dialogOpen && state.workerData) openWorkerDialog(true);
}

async function dispatchIntent(kind, workerId = state.workerData?.workerId) {
  await withBusy(() => dispatchIntentInternal(kind, workerId));
}

function applyHostContext(context) {
  if (context?.theme) {
    applyDocumentTheme(context.theme);
    document.body.dataset.theme = context.theme;
  }
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context?.safeAreaInsets) {
    for (const [key, value] of Object.entries(context.safeAreaInsets)) {
      document.documentElement.style.setProperty(`--safe-area-inset-${key}`, `${value}px`);
    }
  }
}

modelPanel = createModelSettingsPanel({
  app,
  $,
  setBusy,
  getMode: () => state.mode,
  onChange(data) {
    state.modelData = data;
    renderTeamSettings();
    renderWorkerRows();
    if ($('workerDialog').open) renderWorkerModelOptions(state.workerData?.worker);
  },
  confirmAction: (text) => window.confirm(text),
});

$('refresh').onclick = refresh;
$('newProject').onclick = openProjectDialog;
$('modelSettings').onclick = () => modelPanel.open();
$('modeFactory').onclick = () => setMode('factory');
$('modeTeam').onclick = () => setMode('team');
$('addWorker').onclick = () => openWorkerDialog(false);
$('editRules').onclick = openRulesDialog;
$('coordinatorToggle').onclick = () => {
  if (state.project?.coordinator?.enabled) {
    withBusy(stopCoordinator);
  } else {
    openCoordinatorDialog();
  }
};
$('requestProject').onclick = () => dispatchIntent('create-or-check', null);
$('continueWorker').onclick = () => dispatchIntent('continue');
$('pauseWorker').onclick = () => dispatchIntent('pause');
$('ackWorker').onclick = () => dispatchIntent('ack');

for (const id of ['teamEnabled', 'teamKeepInCurrentChat', 'teamAllowHelpers']) {
  $(id).onchange = () => withBusy(saveTeamSettings);
}
$('teamMaxAgents').onchange = () => withBusy(saveTeamSettings);

$('retryWorker').onclick = () => withBusy(async () => {
  await write('worker_retry', {
    projectId: state.project.id,
    workerId: state.workerData.workerId,
    revision: state.workerData.revision,
  });
  notice('工作对话已进入可重试状态；实际运行仍需宿主创建或继续原生 Agent。', 'ok');
  await loadProjectInternal(state.project.id, { workerId: state.workerData.workerId });
  openWorkerDialog(true);
});

$('reopenWorker').onclick = () => withBusy(async () => {
  await write('worker_reopen', {
    projectId: state.project.id,
    workerId: state.workerData.workerId,
    revision: state.workerData.revision,
  });
  notice('工作对话已重新打开；旧证据不会用于新任务轮次。', 'ok');
  await loadProjectInternal(state.project.id, { workerId: state.workerData.workerId });
  openWorkerDialog(true);
});

$('closeWorker').onclick = () => {
  dispatchIntent('close');
};

$('workerModel').onchange = () => {
  renderWorkerModelOptions(state.workerData?.worker
    ? { ...state.workerData.worker, model: $('workerModel').value }
    : { model: $('workerModel').value });
};

$('projectForm').onsubmit = (event) => {
  event.preventDefault();
  withBusy(async () => {
    const project = await write('project_save', {
      name: $('projectName').value,
      root: $('projectRoot').value,
      requirements: $('projectRequirements').value,
      rules: $('projectRules').value,
      maxRetries: Number($('projectMaxRetries').value),
    });
    $('projectDialog').close();
    notice('项目已保存。', 'ok');
    state.overview = await read('overview');
    await loadProjectInternal(project.id);
  });
};

$('coordinatorForm').onsubmit = (event) => {
  event.preventDefault();
  withBusy(enableCoordinator);
};

$('workerForm').onsubmit = (event) => {
  event.preventDefault();
  const editingId = state.workerData?.workerId || '';
  const shouldRequest = $('startAfterSave').checked;
  withBusy(async () => {
    const args = {
      projectId: state.project.id,
      name: $('workerName').value,
      role: $('workerRole').value,
      scope: $('workerScope').value,
      files: lineList($('editWorkerFiles').value),
      task: $('editWorkerTask').value,
      acceptance: $('editWorkerAcceptance').value,
      dependencies: lineList($('editWorkerDependencies').value),
      model: $('workerModel').value || 'auto',
      sessionId: $('editWorkerSession').value || undefined,
      worktree: $('workerWorktree').value || undefined,
    };
    if (editingId) {
      args.id = editingId;
      args.revision = state.workerData.revision;
    }
    const saved = await write('worker_save', args);
    const workerId = saved.workerId || saved.id || editingId;
    closeWorkerDialog({ clear: false });
    await loadProjectInternal(state.project.id);
    if (shouldRequest) {
      await dispatchIntentInternal(editingId ? 'continue' : 'create', workerId);
    } else {
      notice('工作对话已保存；尚未创建或继续原生 Agent。', 'ok');
    }
  });
};

$('rulesForm').onsubmit = (event) => {
  event.preventDefault();
  withBusy(async () => {
    await write('rules_save', {
      projectId: state.project.id,
      requirements: $('editRequirements').value,
      rules: $('editRulesText').value,
      revision: state.project.revision,
    });
    $('rulesDialog').close();
    notice('规则已保存；未关闭工作对话需要确认新版本。', 'ok');
    await loadProjectInternal(state.project.id);
  });
};

$('messageForm').onsubmit = (event) => {
  event.preventDefault();
  if (!state.project) return;
  withBusy(async () => {
    const receipt = await write('message_send', {
      projectId: state.project.id,
      from: 'user',
      to: $('messageTo').value,
      kind: $('messageKind').value,
      body: $('messageBody').value,
      refs: [],
      requestId: crypto.randomUUID(),
    });
    $('messageBody').value = '';
    notice(`短消息已保存（${receipt.id}，m:${receipt.sequence}）；宿主通知只应携带该引用，Agent 按需读取原文。`, 'ok');
    await loadProjectInternal(state.project.id);
  });
};

for (const button of document.querySelectorAll('[data-close]')) {
  button.onclick = () => {
    if (button.dataset.close === 'workerDialog') {
      closeWorkerDialog();
    } else {
      $(button.dataset.close).close();
    }
  };
}

$('workerDialog').addEventListener('close', () => {
  const suppressClear = suppressWorkerDialogCloseClear;
  suppressWorkerDialogCloseClear = false;
  if (suppressClear) return;
  state.workerData = null;
  renderWorkerRows();
});

$('copyFallback').onclick = async () => {
  const text = $('fallbackText').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('fallbackText').select();
    document.execCommand('copy');
  }
  notice('请求文字已复制。', 'ok');
};

app.ontoolresult = (result) => {
  try {
    const data = payload(result);
    if (data?.projects) {
      state.overview = data;
      renderProjects();
    } else if (data?.workers) {
      state.project = data;
      state.messages = (data.messages || []).slice(-20);
      renderProject();
    }
  } catch {
    // Initial host data is optional; the panel reads through app-only tools below.
  }
};
app.onhostcontextchanged = applyHostContext;

try {
  await app.connect();
  applyHostContext(app.getHostContext());
  state.connected = true;
  $('status').textContent = '已连接';
  $('status').className = 'badge done';
  setMode(state.mode, { refreshFactory: false });
  await modelPanel.refresh();
  renderTeamSettings();
  if (state.mode === 'factory' && (!state.overview || !state.project)) await refresh();
} catch (error) {
  state.connected = false;
  $('status').textContent = '连接失败';
  $('status').className = 'badge failed';
  syncControls();
  notice(`无法连接 Codex 内置面板：${error.message}`, 'error');
}
