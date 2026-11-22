import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACTION_NAMES,
  COORDINATOR_STATUSES,
  FactoryError,
  LIMITS,
  MESSAGE_KINDS,
  SCHEMA_VERSION,
  WORKER_ROLE_KINDS,
  WORKER_STATES,
  assertKnownKeys,
  assertPlainObject,
  clone,
  fail,
  integer,
  isActiveWorkerState,
  normalizeId,
  normalizeMessageKind,
  normalizeMessageEnvelope,
  normalizeOwnedFile,
  normalizeRefArray,
  normalizeWorkerState,
  optionalRevision,
  optionalString,
  ownedFileArray,
  parseCursor,
  requiredString,
  requireRevision,
  stringArray,
  messageBodyFromEnvelope,
} from './schemas.mjs';

const FACTORY_DIR = '.codex-factory';
const PROJECT_FILE = 'project.json';
const INDEX_FILE = 'index.json';
const MIRROR_DIR = 'projects';
const LOCK_DIR = '.store.lock';
const LOCK_OWNER = 'owner.json';
const LOCK_TIMEOUT_MS = positiveInteger(process.env.CODEX_FACTORY_LOCK_TIMEOUT_MS, 20_000);
const LOCK_STALE_MS = positiveInteger(process.env.CODEX_FACTORY_LOCK_STALE_MS, 120_000);
const MAX_LOCK_AGE_MS = Math.max(LOCK_STALE_MS, 10 * 60_000);
const DISPATCH_TOOLS = Object.freeze(['create_thread', 'spawn_agent']);
const DISPATCH_STATUSES = Object.freeze([
  'prepared',
  'requested',
  'host_reported',
  'blocked',
  'failed',
  'cancelled',
]);
const HOST_REPORT_STATUSES = Object.freeze(['none', 'unverified']);
const ASSIGNED_MODEL_STATUSES = Object.freeze(['none', 'legacy_unverified']);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomUUID().replaceAll('-', '');
}

function makeId(prefix) {
  return `${prefix}_${randomToken().slice(0, 20)}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function defaultDataDir() {
  const explicit = process.env.CODEX_FACTORY_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'CodexFactory');
  }
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'codex-factory');
  }
  return path.join(os.homedir(), '.codex-factory');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function readJsonFile(file) {
  const text = await fs.readFile(file, 'utf8');
  if (!text.trim()) throw new Error(`JSON 文件为空：${file}`);
  return JSON.parse(text);
}

async function readJsonWithBackup(file) {
  const backup = `${file}.bak`;
  let primaryError;
  try {
    return { value: await readJsonFile(file), source: 'primary', primaryError: undefined };
  } catch (error) {
    primaryError = error;
  }
  try {
    return { value: await readJsonFile(backup), source: 'backup', primaryError };
  } catch (backupError) {
    return {
      value: undefined,
      source: 'none',
      primaryError,
      backupError,
    };
  }
}

async function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomToken()}.tmp`);
  const text = canonicalJson(value);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      const currentText = await fs.readFile(file, 'utf8');
      JSON.parse(currentText);
      await fs.copyFile(file, `${file}.bak`);
    } catch (error) {
      if (!isMissing(error) && !(error instanceof SyntaxError)) {
        // A backup is best effort. The fully synced temporary file remains authoritative.
      }
    }

    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function pathState(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function projectFilePath(root) {
  return path.join(root, FACTORY_DIR, PROJECT_FILE);
}

function mirrorFilePath(dataDir, projectId) {
  return path.join(dataDir, MIRROR_DIR, `${projectId}.json`);
}

function normalizeDate(value, fallback) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return fallback;
}

function normalizeProjectStatus(value) {
  return value === 'closed' ? 'closed' : 'active';
}

function normalizeEvidenceRecord(record, projectId) {
  assertPlainObject(record, 'evidence record');
  const exitCode = Number.isInteger(record.exitCode) ? record.exitCode : 1;
  return {
    id: normalizeId(record.id ?? makeId('ev'), 'evidence.id'),
    projectId,
    workerId: normalizeId(record.workerId, 'evidence.workerId'),
    command: requiredString(record.command, 'evidence.command', LIMITS.command),
    cwd: requiredString(record.cwd, 'evidence.cwd', LIMITS.cwd),
    exitCode,
    logPath: requiredString(record.logPath, 'evidence.logPath', LIMITS.logPath),
    logHash: requiredString(record.logHash, 'evidence.logHash', 64),
    logBytes: integer(record.logBytes ?? 0, 'evidence.logBytes', { min: 0 }),
    taskVersion: integer(record.taskVersion ?? 1, 'evidence.taskVersion', { min: 1 }),
    summary: typeof record.summary === 'string'
      ? optionalString(record.summary, 'evidence.summary', LIMITS.summary)
      : '',
    createdAt: normalizeDate(record.createdAt, nowIso()),
  };
}

function normalizeMessage(record, projectId) {
  assertPlainObject(record, 'message');
  const envelope = record.envelope
    ? normalizeMessageEnvelope(record.envelope)
    : null;
  const kind = envelope?.type
    ?? (MESSAGE_KINDS.includes(record.kind) ? record.kind : 'delta');
  const body = envelope
    ? messageBodyFromEnvelope(envelope)
    : requiredString(record.body, 'message.body', LIMITS.messageBody);
  const refs = normalizeRefArray(record.refs ?? []);
  return {
    id: normalizeId(record.id ?? makeId('msg'), 'message.id'),
    projectId,
    sequence: integer(record.sequence, 'message.sequence', { min: 1 }),
    from: requiredString(record.from, 'message.from', LIMITS.id),
    to: requiredString(record.to, 'message.to', LIMITS.id),
    kind,
    version: envelope ? 1 : 0,
    envelope,
    body,
    refs,
    requestId: typeof record.requestId === 'string'
      ? optionalString(record.requestId, 'message.requestId', LIMITS.requestId)
      : null,
    requestHash: typeof record.requestHash === 'string'
      ? optionalString(record.requestHash, 'message.requestHash', 128)
      : null,
    createdAt: normalizeDate(record.createdAt, nowIso()),
  };
}

function normalizeHostReport(value) {
  if (!value || typeof value !== 'object') return null;
  const model = typeof value.model === 'string' && value.model.trim()
    ? optionalString(value.model, 'launch.hostReport.model', LIMITS.model)
    : null;
  if (!model) return null;
  return {
    model,
    source: typeof value.source === 'string'
      ? optionalString(value.source, 'launch.hostReport.source', 80)
      : 'caller_submission',
    tool: DISPATCH_TOOLS.includes(value.tool) ? value.tool : null,
    sessionId: typeof value.sessionId === 'string' && value.sessionId
      ? optionalString(value.sessionId, 'launch.hostReport.sessionId', LIMITS.sessionId)
      : null,
    status: value.status === 'unverified' ? 'unverified' : 'unverified',
    at: value.at ? normalizeDate(value.at, nowIso()) : null,
  };
}

function normalizeLaunch(value) {
  if (!value || typeof value !== 'object') return null;
  const prompt = typeof value.prompt === 'string' && value.prompt.trim()
    ? optionalString(value.prompt, 'launch.prompt', LIMITS.dispatchPrompt)
    : null;
  const model = typeof value.model === 'string' && value.model.trim()
    ? optionalString(value.model, 'launch.model', LIMITS.model)
    : null;
  if (!prompt || !model) return null;
  const status = DISPATCH_STATUSES.includes(value.status) ? value.status : 'prepared';
  const tool = DISPATCH_TOOLS.includes(value.tool) ? value.tool : 'create_thread';
  const hostReport = normalizeHostReport(value.hostReport);
  return {
    id: normalizeId(value.id ?? makeId('dp'), 'launch.id'),
    status,
    tool,
    prompt,
    promptHash: typeof value.promptHash === 'string'
      ? optionalString(value.promptHash, 'launch.promptHash', 64)
      : crypto.createHash('sha256').update(prompt).digest('hex'),
    promptChars: prompt.length,
    model,
    modelSource: value.modelSource === 'auto' ? 'auto' : 'specified',
    effort: typeof value.effort === 'string' && value.effort
      ? optionalString(value.effort, 'launch.effort', LIMITS.dispatchEffort)
      : null,
    effortField: value.effortField === 'reasoning_effort'
      ? 'reasoning_effort'
      : value.effortField === 'thinking' ? 'thinking' : null,
    target: value.target && typeof value.target === 'object' ? clone(value.target) : null,
    requestId: typeof value.requestId === 'string' && value.requestId
      ? optionalString(value.requestId, 'launch.requestId', LIMITS.requestId)
      : null,
    attempts: integer(value.attempts ?? 0, 'launch.attempts', { min: 0 }),
    lastError: value.lastError && typeof value.lastError === 'object'
      ? {
          code: typeof value.lastError.code === 'string'
            ? optionalString(value.lastError.code, 'launch.lastError.code', LIMITS.dispatchErrorCode)
            : null,
          message: typeof value.lastError.message === 'string'
            ? optionalString(value.lastError.message, 'launch.lastError.message', LIMITS.dispatchErrorMessage)
            : '',
        }
      : null,
    sessionId: typeof value.sessionId === 'string' && value.sessionId
      ? optionalString(value.sessionId, 'launch.sessionId', LIMITS.sessionId)
      : null,
    requestedAt: value.requestedAt ? normalizeDate(value.requestedAt, nowIso()) : null,
    hostReport,
    hostReportStatus: hostReport ? 'unverified' : 'none',
    modelMismatch: value.modelMismatch === true,
    createdAt: value.createdAt ? normalizeDate(value.createdAt, nowIso()) : nowIso(),
    updatedAt: value.updatedAt ? normalizeDate(value.updatedAt, nowIso()) : nowIso(),
  };
}

function normalizeAssignedModel(worker) {
  const raw = typeof worker.assignedModel === 'string' && worker.assignedModel.trim()
    ? optionalString(worker.assignedModel, 'worker.assignedModel', LIMITS.model)
    : null;
  let status = ASSIGNED_MODEL_STATUSES.includes(worker.assignedModelStatus)
    ? worker.assignedModelStatus
    : null;
  if (!status) status = raw ? 'legacy_unverified' : 'none';
  if (status === 'legacy_unverified' && !raw) status = 'none';
  return {
    assignedModel: status === 'none' ? null : raw,
    assignedModelStatus: status,
    assignedModelSource: status === 'legacy_unverified' ? 'legacy' : null,
  };
}

function normalizeWorker(worker, project) {
  assertPlainObject(worker, 'worker');
  const fallback = nowIso();
  const state = WORKER_STATES.includes(worker.state) ? worker.state : 'planned';
  const evidenceIds = stringArray(worker.evidenceIds ?? [], 'worker.evidenceIds', {
    maxItems: 1_000,
    maxLength: LIMITS.id,
  });
  const refs = stringArray(worker.refs ?? [], 'worker.refs', {
    maxItems: 1_000,
    maxLength: LIMITS.ref,
  });
  const sessionId = typeof worker.sessionId === 'string' && worker.sessionId
    ? optionalString(worker.sessionId, 'worker.sessionId', LIMITS.sessionId)
    : null;
  const model = typeof worker.model === 'string' && worker.model.trim()
    ? optionalString(worker.model, 'worker.model', LIMITS.model)
    : 'auto';
  const assigned = normalizeAssignedModel(worker);
  const launch = normalizeLaunch(worker.launch);
  const roleKind = WORKER_ROLE_KINDS.includes(worker.roleKind)
    ? worker.roleKind
    : 'worker';
  return {
    id: normalizeId(worker.id, 'worker.id'),
    name: requiredString(worker.name, 'worker.name', LIMITS.workerName),
    role: requiredString(worker.role, 'worker.role', LIMITS.workerRole),
    roleKind,
    scope: requiredString(worker.scope, 'worker.scope', LIMITS.workerScope),
    files: ownedFileArray(worker.files ?? []),
    task: requiredString(worker.task, 'worker.task', LIMITS.workerTask),
    acceptance: requiredString(worker.acceptance, 'worker.acceptance', LIMITS.workerAcceptance),
    dependencies: stringArray(worker.dependencies ?? [], 'worker.dependencies', {
      maxItems: LIMITS.dependencies,
      maxLength: LIMITS.id,
    }).map((id) => normalizeId(id, 'worker.dependencies[]')),
    state,
    stateBeforeAck: WORKER_STATES.includes(worker.stateBeforeAck)
      ? worker.stateBeforeAck
      : null,
    revision: integer(worker.revision ?? 1, 'worker.revision', { min: 1 }),
    retryCount: integer(worker.retryCount ?? 0, 'worker.retryCount', { min: 0 }),
    summary: typeof worker.summary === 'string'
      ? optionalString(worker.summary, 'worker.summary', LIMITS.summary)
      : '',
    evidenceIds,
    refs,
    sessionId,
    model,
    assignedModel: assigned.assignedModel,
    assignedModelStatus: assigned.assignedModelStatus,
    assignedModelSource: assigned.assignedModelSource,
    launch,
    sessionStatus: sessionId ? 'recorded' : 'none',
    sessionRecordedAt: sessionId
      ? normalizeDate(worker.sessionRecordedAt, fallback)
      : null,
    worktree: typeof worker.worktree === 'string' && worker.worktree
      ? optionalString(worker.worktree, 'worker.worktree', LIMITS.worktree)
      : null,
    requirementsVersion: integer(
      worker.requirementsVersion ?? project.requirementsVersion,
      'worker.requirementsVersion',
      { min: 1 },
    ),
    requiredRequirementsVersion: integer(
      worker.requiredRequirementsVersion ?? project.requirementsVersion,
      'worker.requiredRequirementsVersion',
      { min: 1 },
    ),
    acknowledgedRequirementsVersion: integer(
      worker.acknowledgedRequirementsVersion ?? worker.requirementsVersion ?? project.requirementsVersion,
      'worker.acknowledgedRequirementsVersion',
      { min: 0 },
    ),
    taskVersion: integer(worker.taskVersion ?? 1, 'worker.taskVersion', { min: 1 }),
    requiredTaskVersion: integer(
      worker.requiredTaskVersion ?? worker.taskVersion ?? 1,
      'worker.requiredTaskVersion',
      { min: 1 },
    ),
    acknowledgedTaskVersion: integer(
      worker.acknowledgedTaskVersion ?? worker.taskVersion ?? 1,
      'worker.acknowledgedTaskVersion',
      { min: 0 },
    ),
    sessionLive: false,
    depth: 1,
    readCursor: integer(worker.readCursor ?? 0, 'worker.readCursor', { min: 0 }),
    lastReadAt: worker.lastReadAt ? normalizeDate(worker.lastReadAt, fallback) : null,
    lastRetryAt: worker.lastRetryAt ? normalizeDate(worker.lastRetryAt, fallback) : null,
    startedAt: worker.startedAt ? normalizeDate(worker.startedAt, fallback) : null,
    completedAt: worker.completedAt ? normalizeDate(worker.completedAt, fallback) : null,
    createdAt: normalizeDate(worker.createdAt, fallback),
    updatedAt: normalizeDate(worker.updatedAt, fallback),
  };
}

function normalizeCoordinator(value) {
  const source = value && typeof value === 'object' ? value : {};
  const status = COORDINATOR_STATUSES.includes(source.status)
    ? source.status
    : 'off';
  const optionalId = (item, name) => {
    if (item === undefined || item === null || item === '') return null;
    return normalizeId(item, name);
  };
  return {
    enabled: source.enabled === true,
    status,
    workerId: optionalId(source.workerId, 'coordinator.workerId'),
    targetWorkerIds: stringArray(source.targetWorkerIds ?? [], 'coordinator.targetWorkerIds', {
      maxItems: 100,
      maxLength: LIMITS.id,
    }).map((id) => normalizeId(id, 'coordinator.targetWorkerIds[]')),
    authorizedRecipients: stringArray(
      source.authorizedRecipients ?? [],
      'coordinator.authorizedRecipients',
      { maxItems: 100, maxLength: LIMITS.id },
    ).map((id) => normalizeId(id, 'coordinator.authorizedRecipients[]')),
    generalScope: typeof source.generalScope === 'string'
      ? optionalString(source.generalScope, 'coordinator.generalScope', LIMITS.workerScope) || ''
      : '',
    waitSeconds: Number.isInteger(source.waitSeconds) && source.waitSeconds >= 10 && source.waitSeconds <= 3600
      ? source.waitSeconds
      : 180,
    cursor: Number.isInteger(source.cursor) && source.cursor >= 0 ? source.cursor : 0,
    lastCheckedAt: source.lastCheckedAt ? normalizeDate(source.lastCheckedAt, nowIso()) : null,
    lastHeartbeatAt: source.lastHeartbeatAt ? normalizeDate(source.lastHeartbeatAt, nowIso()) : null,
    startedAt: source.startedAt ? normalizeDate(source.startedAt, nowIso()) : null,
    stoppedAt: source.stoppedAt ? normalizeDate(source.stoppedAt, nowIso()) : null,
    stopReason: typeof source.stopReason === 'string'
      ? optionalString(source.stopReason, 'coordinator.stopReason', LIMITS.summary) || ''
      : '',
  };
}

function normalizeProjectRecord(value) {
  assertPlainObject(value, 'project');
  const id = normalizeId(value.id, 'project.id');
  const createdAt = normalizeDate(value.createdAt, nowIso());
  const project = {
    schemaVersion: SCHEMA_VERSION,
    id,
    name: requiredString(value.name, 'project.name', LIMITS.projectName),
    root: requiredString(value.root, 'project.root', LIMITS.projectRoot),
    status: normalizeProjectStatus(value.status),
    revision: integer(value.revision ?? 1, 'project.revision', { min: 1 }),
    requirements: typeof value.requirements === 'string' ? value.requirements : '',
    requirementsVersion: integer(value.requirementsVersion ?? 1, 'project.requirementsVersion', {
      min: 1,
    }),
    rules: typeof value.rules === 'string' ? value.rules : '',
    maxRetries: integer(value.maxRetries ?? 2, 'project.maxRetries', { min: 0, max: 20 }),
    messageCursor: integer(value.messageCursor ?? 0, 'project.messageCursor', { min: 0 }),
    coordinator: normalizeCoordinator(value.coordinator),
    workers: [],
    events: Array.isArray(value.events) ? value.events : [],
    decisions: Array.isArray(value.decisions) ? value.decisions : [],
    evidence: [],
    messages: [],
    createdAt,
    updatedAt: normalizeDate(value.updatedAt, createdAt),
    closedAt: value.closedAt ? normalizeDate(value.closedAt, createdAt) : null,
    recovery: value.recovery && typeof value.recovery === 'object' ? value.recovery : null,
  };
  project.workers = (Array.isArray(value.workers) ? value.workers : [])
    .map((worker) => normalizeWorker(worker, project));
  project.evidence = (Array.isArray(value.evidence) ? value.evidence : [])
    .map((record) => normalizeEvidenceRecord(record, id));
  project.messages = (Array.isArray(value.messages) ? value.messages : [])
    .map((record) => normalizeMessage(record, id));
  project.messageCursor = Math.max(
    project.messageCursor,
    ...project.messages.map((message) => message.sequence),
    0,
  );
  return project;
}

function projectMetadata(project) {
  return {
    id: project.id,
    name: project.name,
    root: project.root,
    status: project.status,
    revision: project.revision,
    updatedAt: project.updatedAt,
  };
}

function normalizeIndexEntry(entry) {
  assertPlainObject(entry, 'index project');
  return {
    id: normalizeId(entry.id, 'index.id'),
    name: requiredString(entry.name, 'index.name', LIMITS.projectName),
    root: requiredString(entry.root, 'index.root', LIMITS.projectRoot),
    status: normalizeProjectStatus(entry.status),
    revision: integer(entry.revision ?? 1, 'index.revision', { min: 1 }),
    updatedAt: normalizeDate(entry.updatedAt, nowIso()),
  };
}

function candidateProject(read) {
  if (!read.value) return undefined;
  try {
    return normalizeProjectRecord(read.value);
  } catch {
    return undefined;
  }
}

function projectIsNewer(left, right) {
  if (!right) return true;
  if (left.revision !== right.revision) return left.revision > right.revision;
  return Date.parse(left.updatedAt) >= Date.parse(right.updatedAt);
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function messageRequestHash({ to, kind, body, refs, envelope }) {
  return crypto.createHash('sha256')
    .update(stableJson({ to, kind, body, refs, envelope: envelope ?? null }))
    .digest('hex');
}

function messageView(message, { detail = 'summary' } = {}) {
  const bodyChars = message.body.length;
  const bodyBytes = Buffer.byteLength(message.body, 'utf8');
  const critical = message.kind === 'blocker' || message.kind === 'decision';
  const truncated = detail === 'summary'
    && !critical
    && bodyChars > LIMITS.messagePreview;
  return {
    id: message.id,
    sequence: message.sequence,
    from: message.from,
    to: message.to,
    kind: message.kind,
    version: message.version,
    ...(message.envelope ? { envelope: clone(message.envelope) } : {}),
    body: truncated
      ? `${message.body.slice(0, LIMITS.messagePreview)}…`
      : message.body,
    bodyChars,
    bodyBytes,
    truncated,
    originalAvailable: truncated,
    ...(truncated ? { originalRef: `message:${message.id}` } : {}),
    refs: message.refs,
    requestId: message.requestId,
    createdAt: message.createdAt,
  };
}

async function readMirrorProjects(dataDir) {
  const directory = path.join(dataDir, MIRROR_DIR);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const read = await readJsonWithBackup(path.join(directory, entry.name));
    const project = candidateProject(read);
    if (project) projects.push({ project, source: read.source });
  }
  return projects;
}

async function recoverStateLocked(dataDir) {
  await fs.mkdir(path.join(dataDir, MIRROR_DIR), { recursive: true });
  const indexPath = path.join(dataDir, INDEX_FILE);
  const indexRead = await readJsonWithBackup(indexPath);
  const entries = new Map();
  if (indexRead.value && Array.isArray(indexRead.value.projects)) {
    for (const rawEntry of indexRead.value.projects) {
      const entry = normalizeIndexEntry(rawEntry);
      entries.set(entry.id, entry);
    }
  }

  for (const { project } of await readMirrorProjects(dataDir)) {
    const current = entries.get(project.id);
    if (!current || project.revision > current.revision
      || (project.revision === current.revision && Date.parse(project.updatedAt) >= Date.parse(current.updatedAt))) {
      entries.set(project.id, projectMetadata(project));
    }
  }

  const projects = new Map();
  for (const entry of [...entries.values()]) {
    const rootPath = projectFilePath(entry.root);
    const mirrorPath = mirrorFilePath(dataDir, entry.id);
    const rootRead = await readJsonWithBackup(rootPath);
    const mirrorRead = await readJsonWithBackup(mirrorPath);
    const rootProject = candidateProject(rootRead);
    const mirrorProject = candidateProject(mirrorRead);
    if (!rootProject && !mirrorProject) {
      fail(
        'RECOVERY_FAILED',
        `项目 ${entry.id} 的项目文件和数据目录镜像都无法读取`,
        { projectId: entry.id, root: entry.root },
      );
    }

    let project;
    let source;
    if (projectIsNewer(rootProject ?? { revision: -1, updatedAt: '' }, mirrorProject)) {
      project = rootProject;
      source = rootRead.source;
    } else {
      project = mirrorProject;
      source = 'mirror';
    }
    if (!project) {
      project = rootProject ?? mirrorProject;
      source = rootProject ? rootRead.source : 'mirror';
    }

    const rootUsable = (await pathState(entry.root))?.isDirectory();
    const needsRootRepair = rootUsable && (
      !rootProject
      || rootRead.source !== 'primary'
      || !sameJson(project, rootProject)
    );
    const needsMirrorRepair = !mirrorProject || !sameJson(project, mirrorProject);
    const recoveredFromFallback = source !== 'primary' && source !== 'mirror';
    const recoveredFromMirror = source === 'mirror' && Boolean(rootRead.value === undefined || rootRead.source !== 'primary');
    if (recoveredFromFallback || recoveredFromMirror || !rootUsable) {
      project.recovery = {
        lastRecoveredAt: nowIso(),
        source: !rootUsable ? 'dataDir-mirror' : (source === 'mirror' ? 'dataDir-mirror' : 'project-backup'),
      };
    }

    if (needsRootRepair) await atomicWriteJson(rootPath, project);
    if (needsMirrorRepair || (project.recovery && !sameJson(project, mirrorProject))) {
      await atomicWriteJson(mirrorPath, project);
    }
    entries.set(project.id, projectMetadata(project));
    projects.set(project.id, project);
  }

  const sortedEntries = [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  const index = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: sortedEntries.reduce(
      (latest, entry) => Date.parse(entry.updatedAt) > Date.parse(latest) ? entry.updatedAt : latest,
      '1970-01-01T00:00:00.000Z',
    ),
    projects: sortedEntries,
  };
  const normalizedOldIndex = indexRead.value && Array.isArray(indexRead.value.projects)
    ? {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: normalizeDate(indexRead.value.updatedAt, '1970-01-01T00:00:00.000Z'),
        projects: indexRead.value.projects.map(normalizeIndexEntry)
          .sort((left, right) => left.id.localeCompare(right.id)),
      }
    : null;
  if (indexRead.source !== 'primary' || !sameJson(index, normalizedOldIndex)) {
    await atomicWriteJson(indexPath, index);
  }

  return {
    dataDir,
    indexPath,
    index,
    entries,
    projects,
  };
}

function touchProject(project) {
  project.revision += 1;
  project.updatedAt = nowIso();
}

function touchWorker(worker) {
  worker.revision += 1;
  worker.updatedAt = nowIso();
}

function addEvent(project, type, { workerId = null, state = null, summary = '', details } = {}) {
  const createdAt = nowIso();
  const event = {
    id: makeId('event'),
    type,
    workerId,
    state,
    summary,
    createdAt,
  };
  if (details !== undefined) event.details = details;
  project.events.push(event);
  return event;
}

function getProject(state, projectId, { forWrite = false } = {}) {
  const id = normalizeId(projectId, 'projectId');
  const project = state.projects.get(id);
  if (!project) fail('NOT_FOUND', `项目不存在：${id}`, { projectId: id });
  if (forWrite) {
    if (project.status === 'closed') {
      fail('PROJECT_CLOSED', `项目已关闭：${id}`, { projectId: id });
    }
  }
  return clone(project);
}

function getWorker(project, workerId) {
  const id = normalizeId(workerId, 'workerId');
  const worker = project.workers.find((item) => item.id === id);
  if (!worker) fail('NOT_FOUND', `执行者不存在：${id}`, { projectId: project.id, workerId: id });
  return worker;
}

async function persistProjectLocked(state, project) {
  const rootStat = await pathState(project.root);
  if (!rootStat?.isDirectory()) {
    fail('PROJECT_ROOT_MISSING', `项目根目录不存在：${project.root}`, { root: project.root });
  }
  const rootFile = projectFilePath(project.root);
  const mirrorFile = mirrorFilePath(state.dataDir, project.id);
  await atomicWriteJson(rootFile, project);
  const rootReparsed = normalizeProjectRecord(await readJsonFile(rootFile));
  if (!sameJson(rootReparsed, project)) {
    fail('WRITE_VERIFY_FAILED', '项目主文件写入后重新解析不一致', {
      projectId: project.id,
      file: rootFile,
    });
  }
  if (pathKey(rootFile) !== pathKey(mirrorFile)) await atomicWriteJson(mirrorFile, project);
  state.projects.set(project.id, clone(project));
  state.entries.set(project.id, projectMetadata(project));

  const projects = [...state.entries.values()].sort((left, right) => left.id.localeCompare(right.id));
  state.index = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: projects.reduce(
      (latest, entry) => Date.parse(entry.updatedAt) > Date.parse(latest) ? entry.updatedAt : latest,
      '1970-01-01T00:00:00.000Z',
    ),
    projects,
  };
  await atomicWriteJson(state.indexPath, state.index);
  const indexReparsed = await readJsonFile(state.indexPath);
  if (!sameJson(indexReparsed, state.index)) {
    fail('WRITE_VERIFY_FAILED', '项目索引写入后重新解析不一致', {
      file: state.indexPath,
    });
  }
  return project;
}

function applyRuleChange(project, requirements, rules) {
  const requirementsChanged = requirements !== undefined && requirements !== project.requirements;
  const rulesChanged = rules !== undefined && rules !== project.rules;
  if (!requirementsChanged && !rulesChanged) return false;
  if (requirements !== undefined) project.requirements = requirements;
  if (rules !== undefined) project.rules = rules;
  project.requirementsVersion += 1;
  const changedAt = nowIso();
  for (const worker of project.workers) {
    if (worker.state === 'closed') continue;
    if (worker.state !== 'needs_ack') worker.stateBeforeAck = worker.state;
    worker.state = 'needs_ack';
    worker.requiredRequirementsVersion = project.requirementsVersion;
    worker.revision += 1;
    worker.updatedAt = changedAt;
  }
  return true;
}

function hasGlob(value) {
  return /[*?[\]{}]/.test(value);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globSegmentRegex(segment) {
  let pattern = '^';
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index];
    if (character === '*') {
      pattern += '[^/]*';
    } else if (character === '?') {
      pattern += '[^/]';
    } else if (character === '[') {
      const end = segment.indexOf(']', index + 1);
      if (end < 0) {
        pattern += '\\[';
      } else {
        let content = segment.slice(index + 1, end);
        if (content.startsWith('!')) content = `^${content.slice(1)}`;
        pattern += `[${content}]`;
        index = end;
      }
    } else if (character === '{') {
      const end = segment.indexOf('}', index + 1);
      if (end < 0) {
        pattern += '\\{';
      } else {
        const choices = segment.slice(index + 1, end).split(',');
        pattern += `(?:${choices.map(escapeRegex).join('|')})`;
        index = end;
      }
    } else {
      pattern += escapeRegex(character);
    }
  }
  return new RegExp(`${pattern}$`);
}

function globSegmentOverlap(left, right) {
  if (left === right) return true;
  const leftGlob = hasGlob(left);
  const rightGlob = hasGlob(right);
  if (!leftGlob && !rightGlob) return false;
  if (left === '*' || right === '*') return true;
  if (!leftGlob) return globSegmentRegex(right).test(left);
  if (!rightGlob) return globSegmentRegex(left).test(right);
  const leftPrefix = left.split(/[*?[\]{}]/, 1)[0];
  const rightPrefix = right.split(/[*?[\]{}]/, 1)[0];
  const common = Math.min(leftPrefix.length, rightPrefix.length);
  for (let index = 0; index < common; index += 1) {
    if (leftPrefix[index] !== rightPrefix[index]) return false;
  }
  return true;
}

function globPathsOverlap(leftSegments, rightSegments, leftIndex = 0, rightIndex = 0) {
  if (leftIndex >= leftSegments.length && rightIndex >= rightSegments.length) return true;
  if (leftSegments[leftIndex] === '**') {
    if (globPathsOverlap(leftSegments, rightSegments, leftIndex + 1, rightIndex)) return true;
    if (rightIndex < rightSegments.length) {
      return globPathsOverlap(leftSegments, rightSegments, leftIndex, rightIndex + 1);
    }
    return false;
  }
  if (rightSegments[rightIndex] === '**') {
    if (globPathsOverlap(leftSegments, rightSegments, leftIndex, rightIndex + 1)) return true;
    if (leftIndex < leftSegments.length) {
      return globPathsOverlap(leftSegments, rightSegments, leftIndex + 1, rightIndex);
    }
    return false;
  }
  if (leftIndex >= leftSegments.length || rightIndex >= rightSegments.length) {
    return true;
  }
  if (!globSegmentOverlap(leftSegments[leftIndex], rightSegments[rightIndex])) return false;
  return globPathsOverlap(leftSegments, rightSegments, leftIndex + 1, rightIndex + 1);
}

function pathsOverlap(left, right) {
  if (left === right) return true;
  return globPathsOverlap(left.split('/'), right.split('/'));
}

function assertFileOwnership(project, workerId, files, state) {
  if (!isActiveWorkerState(state)) return;
  for (const other of project.workers) {
    if (other.id === workerId || !isActiveWorkerState(other.state)) continue;
    for (const owned of other.files) {
      for (const requested of files) {
        if (pathsOverlap(owned, requested)) {
          fail(
            'FILE_CONFLICT',
            `文件归属冲突：${requested} 已由 ${other.id} 占用`,
            { requested, ownerWorkerId: other.id, owned },
          );
        }
      }
    }
  }
}

function assertDependencies(project, workerId, dependencies) {
  if (dependencies.includes(workerId)) {
    fail('DEPENDENCY_CYCLE', '执行者不能依赖自身', { workerId });
  }
  for (const dependency of dependencies) {
    if (!project.workers.some((worker) => worker.id === dependency) && dependency !== workerId) {
      fail('DEPENDENCY_NOT_FOUND', `依赖的执行者不存在：${dependency}`, {
        workerId,
        dependency,
      });
    }
  }
  const graph = new Map(project.workers.map((worker) => [worker.id, [...worker.dependencies]]));
  graph.set(workerId, [...dependencies]);
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      fail('DEPENDENCY_CYCLE', `执行者依赖存在环：${id}`, { workerId: id });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  visit(workerId);
}

function dependencySummaries(project, worker) {
  return worker.dependencies.map((id) => {
    const dependency = project.workers.find((item) => item.id === id);
    return dependency
      ? {
          id: dependency.id,
          name: dependency.name,
          state: dependency.state,
          revision: dependency.revision,
          summary: dependency.summary,
        }
      : { id, name: null, state: 'missing', revision: null, summary: '' };
  });
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertDependenciesComplete(project, worker, targetState) {
  if (!['ready', 'running', 'done'].includes(targetState)) return;
  const summaries = dependencySummaries(project, worker);
  const unmet = summaries.filter((dependency) => dependency.state !== 'done');
  if (unmet.length > 0) {
    fail(
      'DEPENDENCY_UNMET',
      `依赖尚未完成：${unmet.map((item) => item.id).join(', ')}`,
      { dependencies: unmet },
    );
  }
}

function unreadMessages(project, workerId, after) {
  return project.messages
    .filter((message) => message.sequence > after
      && (message.to === workerId || message.to === '*' || message.to === 'all'));
}

function participantExists(project, participant) {
  if (['orchestrator', 'user', 'host', 'all', '*'].includes(participant)) return true;
  return project.workers.some((worker) => worker.id === participant);
}

async function resolveExistingPath(project, value) {
  if (path.isAbsolute(value)) return path.resolve(value);
  return path.resolve(project.root, value);
}

async function resolveLogPath(project, cwd, logPath) {
  const candidates = path.isAbsolute(logPath)
    ? [path.resolve(logPath)]
    : [path.resolve(cwd, logPath), path.resolve(project.root, logPath)];
  for (const candidate of candidates) {
    const stat = await pathState(candidate);
    if (stat?.isFile()) return fs.realpath(candidate);
  }
  fail('EVIDENCE_LOG_MISSING', `证据日志不存在：${logPath}`, { logPath });
}

async function verifyEvidenceRecord(record) {
  try {
    const stat = await fs.stat(record.logPath);
    if (!stat.isFile() || stat.size !== record.logBytes) return false;
    return (await hashFile(record.logPath)) === record.logHash;
  } catch {
    return false;
  }
}

async function verifyRef(project, ref, evidenceById) {
  if (evidenceById.has(ref)) return verifyEvidenceRecord(evidenceById.get(ref));
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(ref)) return false;
  const candidate = await resolveExistingPath(project, ref);
  return Boolean(await pathState(candidate));
}

async function assertCompletionEvidence(project, worker) {
  const evidenceById = new Map(project.evidence.map((record) => [record.id, record]));
  const candidates = worker.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .filter((record) => record.workerId === worker.id
      && record.taskVersion === worker.taskVersion
      && record.exitCode === 0);
  let sawInvalid = false;
  for (const record of candidates) {
    if (await verifyEvidenceRecord(record)) return;
    sawInvalid = true;
  }
  for (const ref of worker.refs) {
    if (await verifyRef(project, ref, evidenceById)) return;
  }
  if (sawInvalid) {
    fail(
      'EVIDENCE_INVALID',
      '证据日志已被删除或修改，不能据此标记完成',
      { workerId: worker.id },
    );
  }
  fail(
    'EVIDENCE_REQUIRED',
    '完成态需要可核验的通过证据或现存文件引用',
    { workerId: worker.id },
  );
}

async function acquireProcessLock(dataDir) {
  const lockDir = path.join(dataDir, LOCK_DIR);
  const ownerPath = path.join(lockDir, LOCK_OWNER);
  const token = randomToken();
  const startedAt = nowIso();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      const handle = await fs.open(ownerPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, startedAt })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { lockDir, ownerPath, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const stat = await pathState(lockDir);
    const age = stat ? Date.now() - stat.mtimeMs : Infinity;
    const ownerRead = await readJsonFile(ownerPath).catch(() => undefined);
    let alive = false;
    if (Number.isInteger(ownerRead?.pid) && ownerRead.pid > 0) {
      try {
        process.kill(ownerRead.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === 'EPERM';
      }
    }
    const ownerMissingGrace = !ownerRead && age < 2_000;
    const stale = !ownerMissingGrace && (!ownerRead || !alive || age > MAX_LOCK_AGE_MS);
    if (stale) {
      const quarantine = `${lockDir}.stale-${process.pid}-${randomToken()}`;
      try {
        await fs.rename(lockDir, quarantine);
        await cleanupQuarantine(quarantine);
        continue;
      } catch (error) {
        if (!['ENOENT', 'EEXIST', 'EPERM'].includes(error.code)) throw error;
      }
    }
    await delay(20 + Math.floor(Math.random() * 50));
  }
  fail('LOCK_TIMEOUT', '等待软件工厂数据锁超时', { dataDir });
}

async function cleanupQuarantine(target) {
  const stat = await pathState(target);
  if (!stat) return;
  if (stat.isFile()) {
    await fs.unlink(target).catch(() => {});
    return;
  }
  await fs.unlink(path.join(target, LOCK_OWNER)).catch(() => {});
  await fs.rmdir(target).catch(() => {});
}

async function releaseProcessLock(lock) {
  const owner = await readJsonFile(lock.ownerPath).catch(() => undefined);
  if (owner?.token !== lock.token) return;
  await fs.unlink(lock.ownerPath).catch(() => {});
  await fs.rmdir(lock.lockDir).catch(() => {});
}

async function withProcessLock(dataDir, fn) {
  await fs.mkdir(dataDir, { recursive: true });
  const lock = await acquireProcessLock(dataDir);
  try {
    return await fn();
  } finally {
    await releaseProcessLock(lock);
  }
}

async function saveProject(args, state) {
  assertKnownKeys(
    args,
    ['id', 'name', 'root', 'requirements', 'rules', 'maxRetries', 'createRoot', 'revision'],
    'project_save',
  );
  const name = requiredString(args.name, 'name', LIMITS.projectName);
  const requestedRoot = requiredString(args.root, 'root', LIMITS.projectRoot);
  let rootStat = await pathState(requestedRoot);
  if (!rootStat) {
    if (args.createRoot !== true) {
      fail(
        'INVALID_ARGUMENT',
        `项目根目录不存在：${requestedRoot}。请先创建该目录，或显式传 createRoot=true 仅创建最后一级目录。`,
        { root: requestedRoot, canCreate: true },
      );
    }
    try {
      await fs.mkdir(requestedRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        fail(
          'INVALID_ARGUMENT',
          `项目根的父目录不存在：${requestedRoot}。请先创建父目录，再重试。`,
          { root: requestedRoot, canCreate: false },
        );
      }
      if (error?.code !== 'EEXIST') throw error;
    }
    rootStat = await pathState(requestedRoot);
  }
  if (!rootStat?.isDirectory()) {
    fail('INVALID_ARGUMENT', `项目根路径不是目录：${requestedRoot}`, {
      root: requestedRoot,
      canCreate: false,
    });
  }
  const root = await fs.realpath(requestedRoot);
  const id = args.id === undefined ? undefined : normalizeId(args.id, 'id');
  const existing = id ? state.projects.get(id) : undefined;
  const duplicateRoot = [...state.projects.values()].find(
    (project) => pathKey(project.root) === pathKey(root) && project.id !== id,
  );
  if (duplicateRoot) {
    fail('PROJECT_ROOT_IN_USE', `项目根目录已属于 ${duplicateRoot.id}`, {
      root,
      projectId: duplicateRoot.id,
    });
  }

  let project;
  if (existing) {
    requireRevision(args.revision, existing.revision, '项目');
    if (pathKey(existing.root) !== pathKey(root)) {
      fail('ROOT_CHANGE_NOT_ALLOWED', '已有项目不能更换根目录；请新建项目', {
        projectId: id,
        currentRoot: existing.root,
        requestedRoot: root,
      });
    }
    project = clone(existing);
    project.name = name;
    if (args.maxRetries !== undefined) {
      project.maxRetries = integer(args.maxRetries, 'maxRetries', { min: 0, max: 20 });
    }
    const requirements = optionalString(args.requirements, 'requirements', LIMITS.requirements);
    const rules = optionalString(args.rules, 'rules', LIMITS.rules);
    applyRuleChange(project, requirements, rules);
    addEvent(project, 'project_updated', { summary: '项目设置已更新' });
    touchProject(project);
  } else {
    if (args.revision !== undefined) {
      fail('INVALID_ARGUMENT', '新建项目不能提供 revision');
    }
    const projectId = id ?? makeId('p');
    if (state.projects.has(projectId)) {
      fail('PROJECT_EXISTS', `项目 ID 已存在：${projectId}`, { projectId });
    }
    const factoryDir = path.join(root, FACTORY_DIR);
    const factoryStat = await pathState(factoryDir);
    if (factoryStat && !factoryStat.isDirectory()) {
      fail('INVALID_ARGUMENT', `${FACTORY_DIR} 已存在但不是目录`);
    }
    const existingProjectFile = await readJsonWithBackup(projectFilePath(root));
    if (existingProjectFile.value) {
      fail('PROJECT_STORE_EXISTS', `项目根目录已有软件工厂数据：${projectFilePath(root)}`);
    }
    await fs.mkdir(factoryDir, { recursive: true });
    const createdAt = nowIso();
    project = {
      schemaVersion: SCHEMA_VERSION,
      id: projectId,
      name,
      root,
      status: 'active',
      revision: 1,
      requirements: optionalString(args.requirements, 'requirements', LIMITS.requirements) ?? '',
      requirementsVersion: 1,
      rules: optionalString(args.rules, 'rules', LIMITS.rules) ?? '',
      maxRetries: args.maxRetries === undefined
        ? 2
        : integer(args.maxRetries, 'maxRetries', { min: 0, max: 20 }),
      messageCursor: 0,
      coordinator: normalizeCoordinator(),
      workers: [],
      events: [],
      decisions: [],
      evidence: [],
      messages: [],
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
      recovery: null,
    };
    addEvent(project, 'project_created', { summary: `项目 ${name} 已创建` });
  }

  await persistProjectLocked(state, project);
  return project;
}

async function saveWorker(args, state, modelSettings) {
  assertKnownKeys(
    args,
    [
      'projectId',
      'id',
      'workerId',
      'name',
      'role',
      'roleKind',
      'scope',
      'files',
      'task',
      'acceptance',
      'dependencies',
      'sessionId',
      'model',
      'assignedModel',
      'worktree',
      'revision',
    ],
    'worker_save',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const idAlias = args.id === undefined ? undefined : normalizeId(args.id, 'id');
  const workerIdAlias = args.workerId === undefined
    ? undefined
    : normalizeId(args.workerId, 'workerId');
  if (idAlias !== undefined && workerIdAlias !== undefined && idAlias !== workerIdAlias) {
    fail('INVALID_ARGUMENT', 'id 与 workerId 指向不同执行者，请只保留一个值', {
      id: idAlias,
      workerId: workerIdAlias,
    });
  }
  const requestedId = idAlias ?? workerIdAlias;
  const existing = requestedId
    ? project.workers.find((worker) => worker.id === requestedId)
    : undefined;
  if (existing) requireRevision(args.revision, existing.revision, '执行者');
  else if (args.revision !== undefined) {
    fail('INVALID_ARGUMENT', '新建执行者不能提供 revision');
  }

  const workerId = existing?.id ?? requestedId ?? makeId('w');
  const roleKind = args.roleKind === undefined
    ? existing?.roleKind ?? 'worker'
    : requiredString(args.roleKind, 'roleKind', 30);
  if (!WORKER_ROLE_KINDS.includes(roleKind)) {
    fail('INVALID_ARGUMENT', `roleKind 必须是：${WORKER_ROLE_KINDS.join('|')}`);
  }
  if (roleKind === 'coordinator') {
    const duplicate = project.workers.find(
      (worker) => worker.id !== workerId && worker.roleKind === 'coordinator',
    );
    if (duplicate) {
      fail('COORDINATOR_EXISTS', `项目已有协调助手：${duplicate.id}`, {
        workerId: duplicate.id,
      });
    }
  }
  const createdAt = nowIso();
  const sessionId = args.sessionId === undefined
    ? existing?.sessionId ?? null
    : optionalString(args.sessionId, 'sessionId', LIMITS.sessionId);
  const worktree = args.worktree === undefined
    ? existing?.worktree ?? null
    : optionalString(args.worktree, 'worktree', LIMITS.worktree);
  const model = args.model === undefined
    ? existing?.model ?? 'auto'
    : optionalString(args.model, 'model', LIMITS.model) || 'auto';
  if (args.assignedModel !== undefined
    && (optionalString(args.assignedModel, 'assignedModel', LIMITS.model) || null)
      !== (existing?.assignedModel ?? null)) {
    fail(
      'ASSIGNED_MODEL_READ_ONLY',
      'assignedModel 只保留历史记录，不能通过 worker_save 事后补写；宿主模型回执请用 factory_task action=record。',
    );
  }
  if (model !== 'auto') {
    const unchangedUnavailable = existing?.model === model;
    if (!unchangedUnavailable) {
      const data = await modelSettings?.read?.();
      const allowed = Object.values(data?.settings?.modes || {})
        .some((mode) => mode?.enabled)
        && data.catalog?.some((item) => item.id === model && item.available);
      if (!allowed) {
        fail('MODEL_NOT_ALLOWED', `模型未启用或不可用：${model}`, { model });
      }
    }
  }
  const files = args.files === undefined
    ? existing?.files ?? []
    : ownedFileArray(args.files);
  const dependencies = args.dependencies === undefined
    ? existing?.dependencies ?? []
    : stringArray(args.dependencies, 'dependencies', {
        maxItems: LIMITS.dependencies,
        maxLength: LIMITS.id,
      }).map((dependency) => normalizeId(dependency, 'dependencies[]'));

  assertDependencies(project, workerId, dependencies);
  assertFileOwnership(project, workerId, files, existing?.state ?? 'planned');

  const worker = existing ? clone(existing) : {
    id: workerId,
    roleKind,
    state: 'planned',
    stateBeforeAck: null,
    revision: 1,
    retryCount: 0,
    summary: '',
    evidenceIds: [],
    refs: [],
    requirementsVersion: project.requirementsVersion,
    requiredRequirementsVersion: project.requirementsVersion,
    acknowledgedRequirementsVersion: project.requirementsVersion,
    taskVersion: 1,
    requiredTaskVersion: 1,
    acknowledgedTaskVersion: 1,
    sessionLive: false,
    depth: 1,
    readCursor: 0,
    lastReadAt: null,
    lastRetryAt: null,
    startedAt: null,
    completedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  worker.name = requiredString(args.name ?? existing?.name, 'name', LIMITS.workerName);
  worker.role = requiredString(args.role ?? existing?.role, 'role', LIMITS.workerRole);
  worker.roleKind = roleKind;
  worker.scope = requiredString(args.scope ?? existing?.scope, 'scope', LIMITS.workerScope);
  worker.files = files;
  worker.task = requiredString(args.task ?? existing?.task, 'task', LIMITS.workerTask);
  worker.acceptance = requiredString(
    args.acceptance ?? existing?.acceptance,
    'acceptance',
    LIMITS.workerAcceptance,
  );
  worker.dependencies = dependencies;
  worker.model = model;
  worker.assignedModel = existing?.assignedModel ?? null;
  worker.assignedModelStatus = existing?.assignedModelStatus
    ?? (worker.assignedModel ? 'legacy_unverified' : 'none');
  worker.assignedModelSource = existing?.assignedModelSource
    ?? (worker.assignedModel ? 'legacy' : null);
  worker.launch = existing?.launch ? clone(existing.launch) : null;
  worker.sessionId = sessionId || null;
  worker.sessionStatus = worker.sessionId ? 'recorded' : 'none';
  worker.sessionRecordedAt = worker.sessionId
    ? (args.sessionId === undefined ? existing?.sessionRecordedAt : nowIso())
    : null;
  if (existing && (existing.sessionId || null) !== (worker.sessionId || null)) {
    worker.assignedModel = null;
    worker.assignedModelStatus = 'none';
    worker.assignedModelSource = null;
    worker.launch = null;
  }
  worker.worktree = worktree || null;
  worker.depth = 1;
  worker.sessionLive = false;
  if (existing) {
    const taskChanged = worker.task !== existing.task
      || worker.acceptance !== existing.acceptance
      || worker.scope !== existing.scope
      || worker.role !== existing.role
      || worker.roleKind !== existing.roleKind
      || worker.model !== existing.model
      || !sameStringArray(worker.files, existing.files)
      || !sameStringArray(worker.dependencies, existing.dependencies);
    if (taskChanged && worker.state !== 'closed') {
      if (worker.state !== 'needs_ack') worker.stateBeforeAck = worker.state;
      worker.taskVersion += 1;
      worker.requiredTaskVersion = worker.taskVersion;
      worker.state = 'needs_ack';
      worker.completedAt = null;
      worker.refs = [];
      worker.launch = null;
      assertFileOwnership(project, worker.id, worker.files, worker.state);
    }
    touchWorker(worker);
    project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
    addEvent(project, 'worker_updated', {
      workerId: worker.id,
      state: worker.state,
      summary: `${worker.name} 的任务记录已更新`,
    });
  } else {
    project.workers.push(worker);
    addEvent(project, 'worker_created', {
      workerId: worker.id,
      state: worker.state,
      summary: `${worker.name} 已创建`,
    });
  }
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    projectId: project.id,
    workerId: worker.id,
    id: worker.id,
    state: worker.state,
    revision: worker.revision,
    projectRevision: project.revision,
    sessionId: worker.sessionId,
    model: worker.model,
    assignedModel: worker.assignedModel,
    assignedModelStatus: worker.assignedModelStatus,
    assignedModelSource: worker.assignedModelSource,
    launch: worker.launch,
    sessionStatus: worker.sessionStatus,
    sessionLive: worker.sessionLive,
    taskVersion: worker.taskVersion,
    requiredTaskVersion: worker.requiredTaskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    worker,
  };
}

function readWorker(args, state) {
  assertKnownKeys(args, ['projectId', 'workerId'], 'worker_get');
  const project = getProject(state, args.projectId);
  const worker = getWorker(project, args.workerId);
  const dependencies = dependencySummaries(project, worker);
  const evidenceById = new Map(project.evidence.map((record) => [record.id, record]));
  return {
    projectId: project.id,
    projectRevision: project.revision,
    workerId: worker.id,
    revision: worker.revision,
    state: worker.state,
    projectName: project.name,
    projectRoot: project.root,
    requirements: project.requirements,
    requirementsVersion: project.requirementsVersion,
    rules: project.rules,
    taskVersion: worker.taskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    sessionLive: worker.sessionLive,
    assignedModel: worker.assignedModel,
    assignedModelStatus: worker.assignedModelStatus,
    assignedModelSource: worker.assignedModelSource,
    launch: worker.launch ? clone(worker.launch) : null,
    worker: clone(worker),
    dependencies,
    blockedBy: dependencies.filter((dependency) => dependency.state !== 'done'),
    evidence: worker.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean).map(clone),
    unread: unreadMessages(project, worker.id, worker.readCursor).length,
  };
}

function readWorkerStatus(args, state) {
  assertKnownKeys(args, ['projectId', 'workerId'], 'worker_status');
  const project = getProject(state, args.projectId);
  const worker = getWorker(project, args.workerId);
  const taskChanged = worker.acknowledgedTaskVersion < worker.taskVersion;
  const requirementsChanged = worker.acknowledgedRequirementsVersion < project.requirementsVersion;
  return {
    projectId: project.id,
    projectRevision: project.revision,
    projectName: project.name,
    projectRoot: project.root,
    workerId: worker.id,
    revision: worker.revision,
    state: worker.state,
    taskVersion: worker.taskVersion,
    requiredTaskVersion: worker.requiredTaskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    requirementsVersion: project.requirementsVersion,
    requiredRequirementsVersion: worker.requiredRequirementsVersion,
    acknowledgedRequirementsVersion: worker.acknowledgedRequirementsVersion,
    taskChanged,
    requirementsChanged,
    refreshRequired: taskChanged || requirementsChanged,
    launch: worker.launch ? {
      id: worker.launch.id,
      status: worker.launch.status,
      tool: worker.launch.tool,
      model: worker.launch.model,
      effort: worker.launch.effort,
      effortField: worker.launch.effortField,
      promptChars: worker.launch.promptChars,
      attempts: worker.launch.attempts,
      hostReportedModel: worker.launch.hostReport?.model ?? null,
      hostReportStatus: worker.launch.hostReportStatus,
      sessionId: worker.launch.sessionId,
    } : null,
    assignedModel: worker.assignedModel,
    assignedModelStatus: worker.assignedModelStatus,
    requiresFullTask: taskChanged || requirementsChanged,
    sessionBound: Boolean(worker.sessionId),
    sessionLive: false,
    updatedAt: worker.updatedAt,
  };
}

function clearAssignedModel(worker) {
  worker.assignedModel = null;
  worker.assignedModelStatus = 'none';
  worker.assignedModelSource = null;
}

function dispatchPrompt(project, worker) {
  return [
    `你是软件工厂项目「${project.name}」的一层工作对话「${worker.name}」。`,
    `项目根：${project.root}`,
    `工厂标识：projectId=${project.id}，workerId=${worker.id}，taskVersion=${worker.taskVersion}，requirementsVersion=${project.requirementsVersion}。`,
    '开始前先用 factory_task action=get view=full 读取自己的完整任务、需求、规则和验收，确认版本后再执行。',
    '',
    `任务：\n${worker.task}`,
    '',
    `验收：\n${worker.acceptance}`,
    '',
    `职责范围：\n${worker.scope}`,
    '',
    '边界：只做本任务，不创建或分派下属代理/对话，不操作原问题线程，不执行 git 提交或发布。',
    '完成后回传 checks、refs、block；需要用户决定时明确说明，不擅自扩大范围。',
  ].join('\n');
}

function normalizeDispatchTarget(tool, target) {
  if (tool === 'spawn_agent') return { kind: 'current_chat' };
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    fail('DISPATCH_INCOMPLETE', 'create_thread 需要宿主 target（项目/项目外/云环境）。', {
      missing: ['target'],
    });
  }
  const type = typeof target.type === 'string' ? target.type : '';
  if (!['local', 'project', 'projectless', 'codexCloud', 'chatgptWorkCloud'].includes(type)) {
    fail('DISPATCH_INCOMPLETE', `create_thread target.type 不受支持：${type || '缺失'}`, {
      missing: ['target.type'],
    });
  }
  if (type === 'project') {
    if (typeof target.projectId !== 'string' || !target.projectId.trim()) {
      fail('DISPATCH_INCOMPLETE', 'project target 需要 projectId。', { missing: ['target.projectId'] });
    }
    const environment = target.environment;
    if (!environment || typeof environment !== 'object') {
      fail('DISPATCH_INCOMPLETE', 'project target 需要 environment。', {
        missing: ['target.environment'],
      });
    }
    if (!['local', 'worktree'].includes(environment.type)) {
      fail('DISPATCH_INCOMPLETE', 'project target.environment.type 必须是 local 或 worktree。', {
        missing: ['target.environment.type'],
      });
    }
    if (environment.type === 'worktree'
      && (!environment.startingState || typeof environment.startingState !== 'object')) {
      fail('DISPATCH_INCOMPLETE', 'worktree environment 需要 startingState。', {
        missing: ['target.environment.startingState'],
      });
    }
  }
  if (type === 'codexCloud'
    && (typeof target.environmentConfigId !== 'string' || !target.environmentConfigId.trim())) {
    fail('DISPATCH_INCOMPLETE', 'codexCloud target 需要 environmentConfigId。', {
      missing: ['target.environmentConfigId'],
    });
  }
  return clone(target);
}

async function resolveDispatchModel(worker, modelSettings) {
  let data;
  try {
    data = await modelSettings?.read?.();
  } catch (error) {
    fail('MODEL_SETTINGS_UNAVAILABLE', `无法读取模型设置：${error.message}`);
  }
  if (!data?.settings || !Array.isArray(data.catalog) || !Array.isArray(data.settings.models)) {
    fail('MODEL_SETTINGS_UNAVAILABLE', '模型设置或目录不可用，不能准备派发参数。');
  }
  const available = new Set(
    data.catalog.filter((item) => item.available !== false).map((item) => item.id),
  );
  const enabled = data.settings.models.filter((item) => item.enabled && available.has(item.id));
  if (worker.model === 'auto') {
    const first = enabled[0];
    if (!first) {
      fail('DISPATCH_INCOMPLETE', '自动选择没有可用的已启用模型，不能靠宿主默认模型补齐。', {
        missing: ['model'],
      });
    }
    return {
      model: first.id,
      source: 'auto',
      row: first,
      entry: data.catalog.find((item) => item.id === first.id),
    };
  }
  if (!available.has(worker.model)) {
    fail('MODEL_NOT_ALLOWED', `指定模型不在当前可用目录：${worker.model}`, {
      model: worker.model,
    });
  }
  const row = enabled.find((item) => item.id === worker.model);
  if (!row) {
    fail('MODEL_NOT_ALLOWED', `指定模型未启用：${worker.model}`, { model: worker.model });
  }
  return {
    model: worker.model,
    source: 'specified',
    row,
    entry: data.catalog.find((item) => item.id === worker.model),
  };
}

function resolveDispatchEffort(tool, requested, row, entry) {
  const efforts = Array.isArray(entry?.efforts) ? entry.efforts : [];
  let effort = requested === undefined ? (row?.effort || entry?.defaultEffort || null) : requested;
  if (effort !== null && typeof effort !== 'string') {
    fail('INVALID_ARGUMENT', 'effort 必须是字符串');
  }
  effort = effort?.trim() || null;
  if (effort && efforts.length > 0 && !efforts.includes(effort)) {
    fail('EFFORT_NOT_SUPPORTED', `模型 ${entry?.id || row?.id} 不支持 effort=${effort}`, {
      effort,
      allowed: efforts,
    });
  }
  if (effort && efforts.length === 0) {
    fail('EFFORT_NOT_SUPPORTED', `模型 ${entry?.id || row?.id} 未声明支持的 effort`, { effort });
  }
  if (!effort) return { effort: null, effortField: null };
  return {
    effort,
    effortField: tool === 'create_thread' ? 'thinking' : 'reasoning_effort',
  };
}

function launchReceipt(project, worker) {
  return {
    projectId: project.id,
    projectRevision: project.revision,
    workerId: worker.id,
    revision: worker.revision,
    taskVersion: worker.taskVersion,
    requirementsVersion: project.requirementsVersion,
    model: worker.model,
    assignedModel: worker.assignedModel,
    assignedModelStatus: worker.assignedModelStatus,
    assignedModelSource: worker.assignedModelSource,
    launch: worker.launch ? clone(worker.launch) : null,
  };
}

async function prepareDispatch(args, state, modelSettings) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'prompt', 'tool', 'target', 'effort', 'requestId'],
    'dispatch_prepare',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const current = getWorker(project, args.workerId);
  if (current.state === 'closed') {
    fail('WORKER_CLOSED', '已关闭执行者请使用 worker_reopen', { workerId: current.id });
  }
  if (current.state === 'done') {
    fail('WORKER_DONE', '已完成执行者请使用 worker_reopen', { workerId: current.id });
  }
  const tool = args.tool === undefined ? 'create_thread' : String(args.tool).trim();
  if (!DISPATCH_TOOLS.includes(tool)) {
    fail('INVALID_ARGUMENT', `tool 必须是：${DISPATCH_TOOLS.join('|')}`);
  }
  let prompt;
  if (args.prompt === undefined) {
    prompt = dispatchPrompt(project, current);
  } else {
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
      fail('DISPATCH_INCOMPLETE', '调用者提供了空 prompt，不能准备派发。', {
        missing: ['prompt'],
      });
    }
    prompt = requiredString(args.prompt, 'prompt', LIMITS.dispatchPrompt);
  }
  if (!prompt.trim()) {
    fail('DISPATCH_INCOMPLETE', '派发 prompt 为空，不能准备。', { missing: ['prompt'] });
  }
  const target = normalizeDispatchTarget(tool, args.target);
  const resolved = await resolveDispatchModel(current, modelSettings);
  const effort = resolveDispatchEffort(tool, args.effort, resolved.row, resolved.entry);
  const worker = clone(current);
  worker.launch = {
    id: makeId('dp'),
    status: 'prepared',
    tool,
    prompt,
    promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
    promptChars: prompt.length,
    model: resolved.model,
    modelSource: resolved.source,
    effort: effort.effort,
    effortField: effort.effortField,
    target,
    requestId: args.requestId === undefined
      ? null
      : optionalString(args.requestId, 'requestId', LIMITS.requestId),
    attempts: 0,
    lastError: null,
    sessionId: worker.sessionId,
    requestedAt: null,
    hostReport: null,
    hostReportStatus: 'none',
    modelMismatch: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, 'dispatch_prepared', {
    workerId: worker.id,
    state: worker.state,
    summary: `${worker.name} 的派发参数已准备`,
    details: {
      launchId: worker.launch.id,
      tool,
      model: resolved.model,
      effort: effort.effort,
    },
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return launchReceipt(project, worker);
}

async function recordDispatch(args, state) {
  assertKnownKeys(
    args,
    [
      'projectId',
      'workerId',
      'phase',
      'launchId',
      'sessionId',
      'hostReportedModel',
      'hostReportSource',
      'errorCode',
      'errorMessage',
      'requestId',
    ],
    'dispatch_record',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const current = getWorker(project, args.workerId);
  if (!current.launch) {
    fail('DISPATCH_NOT_PREPARED', '请先调用 factory_task action=prepare 准备派发参数。', {
      workerId: current.id,
    });
  }
  if (args.launchId !== undefined && args.launchId !== current.launch.id) {
    fail('LAUNCH_MISMATCH', '回执对应的派发参数已变化，请重新 prepare。', {
      expected: current.launch.id,
      received: args.launchId,
    });
  }
  const phase = String(args.phase || '').trim();
  const worker = clone(current);
  const launch = clone(current.launch);
  const sessionId = args.sessionId === undefined
    ? null
    : optionalString(args.sessionId, 'sessionId', LIMITS.sessionId);
  const errorCode = args.errorCode === undefined
    ? null
    : optionalString(args.errorCode, 'errorCode', LIMITS.dispatchErrorCode);
  const errorMessage = args.errorMessage === undefined
    ? ''
    : optionalString(args.errorMessage, 'errorMessage', LIMITS.dispatchErrorMessage);
  if (phase === 'requested') {
    launch.status = 'requested';
    launch.requestedAt = nowIso();
    if (args.requestId !== undefined) {
      launch.requestId = optionalString(args.requestId, 'requestId', LIMITS.requestId);
    }
    if (sessionId) {
      if (launch.sessionId && launch.sessionId !== sessionId) {
        launch.hostReport = null;
        launch.hostReportStatus = 'none';
        launch.modelMismatch = false;
      }
      launch.sessionId = sessionId;
      if (worker.sessionId && worker.sessionId !== sessionId) clearAssignedModel(worker);
      worker.sessionId = sessionId;
      worker.sessionStatus = 'recorded';
      worker.sessionRecordedAt = nowIso();
    }
  } else if (phase === 'schema_error') {
    launch.attempts += 1;
    launch.lastError = { code: errorCode || 'SCHEMA_ERROR', message: errorMessage };
    launch.status = 'prepared';
  } else if (phase === 'host_report') {
    if (typeof args.hostReportedModel !== 'string' || !args.hostReportedModel.trim()) {
      fail('DISPATCH_INCOMPLETE', 'host_report 需要 hostReportedModel。', {
        missing: ['hostReportedModel'],
      });
    }
    const reportedModel = requiredString(
      args.hostReportedModel,
      'hostReportedModel',
      LIMITS.model,
    );
    launch.hostReport = {
      model: reportedModel,
      source: args.hostReportSource === 'host_tool_result'
        ? 'host_tool_result'
        : 'caller_submission',
      tool: launch.tool,
      sessionId: sessionId || launch.sessionId,
      status: 'unverified',
      at: nowIso(),
    };
    launch.hostReportStatus = 'unverified';
    launch.modelMismatch = reportedModel !== launch.model;
    launch.status = 'host_reported';
  } else if (phase === 'blocked' || phase === 'failed' || phase === 'cancelled') {
    launch.status = phase;
    launch.lastError = { code: errorCode || phase.toUpperCase(), message: errorMessage };
  } else {
    fail('INVALID_ARGUMENT', `phase 必须是 requested|schema_error|host_report|blocked|failed|cancelled`);
  }
  launch.updatedAt = nowIso();
  worker.launch = launch;
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, `dispatch_${phase}`, {
    workerId: worker.id,
    state: worker.state,
    summary: `${worker.name} 的派发回执：${phase}`,
    details: {
      launchId: launch.id,
      model: launch.model,
      hostReportedModel: launch.hostReport?.model ?? null,
    },
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return launchReceipt(project, worker);
}

async function setWorkerState(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'state', 'summary', 'evidence', 'refs', 'revision'],
    'worker_state',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const current = getWorker(project, args.workerId);
  requireRevision(args.revision, current.revision, '执行者');
  const targetState = normalizeWorkerState(args.state);
  const worker = clone(current);
  const summary = optionalString(args.summary, 'summary', LIMITS.summary);
  if (summary !== undefined) worker.summary = summary;

  if (args.evidence !== undefined) {
    const evidenceIds = stringArray(args.evidence, 'evidence', {
      maxItems: LIMITS.evidence,
      maxLength: LIMITS.id,
    }).map((id) => normalizeId(id, 'evidence[]'));
    for (const id of evidenceIds) {
      const record = project.evidence.find((item) => item.id === id);
      if (!record) fail('EVIDENCE_NOT_FOUND', `证据不存在：${id}`, { evidenceId: id });
      if (record.workerId !== worker.id) {
        fail('EVIDENCE_OWNER_MISMATCH', `证据 ${id} 不属于执行者 ${worker.id}`);
      }
    }
    worker.evidenceIds = [...new Set([...worker.evidenceIds, ...evidenceIds])];
  }
  if (args.refs !== undefined) {
    worker.refs = [...new Set([...worker.refs, ...normalizeRefArray(args.refs)])];
  }

  if (worker.state === 'closed' && targetState !== 'closed') {
    fail('WORKER_CLOSED', '已关闭执行者请使用 worker_reopen', { workerId: worker.id });
  }
  if (worker.state === 'done' && !['done', 'needs_ack', 'closed'].includes(targetState)) {
    fail('WORKER_DONE', '已完成执行者请使用 worker_reopen', { workerId: worker.id });
  }
  const requirementsAckPending = worker.acknowledgedRequirementsVersion < project.requirementsVersion;
  const taskAckPending = worker.acknowledgedTaskVersion < worker.taskVersion;
  if (['ready', 'running', 'waiting', 'done'].includes(targetState)
    && (requirementsAckPending || taskAckPending)) {
    fail(
      'ACK_REQUIRED',
      '规则、需求或任务单已有新版本，请先 worker_ack',
      {
        workerId: worker.id,
        acknowledgedRequirementsVersion: worker.acknowledgedRequirementsVersion,
        requirementsVersion: project.requirementsVersion,
        acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
        taskVersion: worker.taskVersion,
      },
    );
  }
  if (isActiveWorkerState(targetState)) {
    assertFileOwnership(project, worker.id, worker.files, targetState);
  }
  assertDependenciesComplete(project, worker, targetState);
  if (targetState === 'done') await assertCompletionEvidence(project, worker);

  worker.state = targetState;
  if (targetState === 'running' && !worker.startedAt) worker.startedAt = nowIso();
  if (targetState === 'done') worker.completedAt = nowIso();
  if (!['done'].includes(targetState)) worker.completedAt = null;
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, 'worker_state', {
    workerId: worker.id,
    state: targetState,
    summary: worker.summary || `状态更新为 ${targetState}`,
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    projectId: project.id,
    workerId: worker.id,
    id: worker.id,
    state: worker.state,
    revision: worker.revision,
    projectRevision: project.revision,
    requirementsVersion: project.requirementsVersion,
    taskVersion: worker.taskVersion,
    requiredTaskVersion: worker.requiredTaskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    worker,
  };
}

async function saveRules(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'rules', 'requirements', 'revision'],
    'rules_save',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  requireRevision(args.revision, project.revision, '项目');
  const rules = requiredString(args.rules, 'rules', LIMITS.rules);
  const requirements = optionalString(args.requirements, 'requirements', LIMITS.requirements);
  const changed = applyRuleChange(project, requirements, rules);
  if (!changed) {
    return {
      ...projectMetadata(project),
      requirementsVersion: project.requirementsVersion,
      changed: false,
    };
  }
  addEvent(project, 'rules_changed', {
    summary: `规则或需求更新到版本 ${project.requirementsVersion}`,
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    ...projectMetadata(project),
    requirementsVersion: project.requirementsVersion,
    changed: true,
  };
}

async function sendMessage(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'from', 'to', 'kind', 'body', 'envelope', 'refs', 'requestId'],
    'message_send',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const from = requiredString(args.from, 'from', LIMITS.id);
  const to = requiredString(args.to, 'to', LIMITS.id);
  if (!participantExists(project, from)) fail('INVALID_ARGUMENT', `消息发送者不存在：${from}`);
  if (!participantExists(project, to)) fail('INVALID_ARGUMENT', `消息接收者不存在：${to}`);
  const envelope = args.envelope === undefined || args.envelope === null
    ? null
    : normalizeMessageEnvelope(args.envelope);
  if (envelope && args.kind !== undefined && args.kind !== envelope.type) {
    fail('INVALID_ARGUMENT', 'kind 与 envelope.type 必须一致', {
      kind: args.kind,
      envelopeType: envelope.type,
    });
  }
  const kind = envelope?.type ?? normalizeMessageKind(args.kind);
  if (!envelope && (args.body === undefined || args.body === null)) {
    fail('INVALID_ARGUMENT', 'message_send 需要 body 或 envelope');
  }
  const body = envelope
    ? messageBodyFromEnvelope(envelope)
    : requiredString(args.body, 'body', LIMITS.messageBody);
  const refs = normalizeRefArray(args.refs ?? []);
  const requestId = optionalString(args.requestId, 'requestId', LIMITS.requestId) || null;
  const requestHash = messageRequestHash({ to, kind, body, refs, envelope });
  if (requestId) {
    const existing = project.messages.find(
      (message) => message.requestId === requestId && message.from === from,
    );
    if (existing) {
      const existingHash = existing.requestHash
        ?? messageRequestHash({
          to: existing.to,
          kind: existing.kind,
          body: existing.body,
          refs: existing.refs,
          envelope: existing.envelope,
        });
      if (existingHash !== requestHash) {
        fail(
          'REQUEST_CONFLICT',
          `requestId ${requestId} 已用于另一条消息`,
          { requestId, messageId: existing.id, sequence: existing.sequence },
        );
      }
      return {
        ...clone(existing),
        projectRevision: project.revision,
        duplicate: true,
        notification: {
          projectId: project.id,
          workerId: existing.to,
          messageId: existing.id,
          sequence: existing.sequence,
          cursor: `m:${existing.sequence}`,
          bodyIncluded: false,
          delivery: 'pending',
        },
      };
    }
  }
  const sequence = project.messageCursor + 1;
  const message = {
    id: makeId('msg'),
    projectId: project.id,
    sequence,
    from,
    to,
    kind,
    version: envelope ? 1 : 0,
    envelope,
    body,
    refs,
    requestId,
    requestHash,
    createdAt: nowIso(),
  };
  project.messages.push(message);
  project.messageCursor = sequence;
  addEvent(project, 'message_sent', {
    workerId: to !== '*' && to !== 'all' ? to : null,
    summary: `${kind} 消息 ${sequence}`,
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    ...clone(message),
    projectRevision: project.revision,
    duplicate: false,
    notification: {
      projectId: project.id,
      workerId: to,
      messageId: message.id,
      sequence,
      cursor: `m:${sequence}`,
      bodyIncluded: false,
      delivery: 'pending',
    },
  };
}

async function readMessages(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'after', 'limit', 'maxChars', 'detail'],
    'messages_read',
  );
  const project = getProject(state, args.projectId);
  const worker = getWorker(project, args.workerId);
  const after = parseCursor(args.after) ?? worker.readCursor;
  if (after > project.messageCursor) {
    fail('CURSOR_AHEAD', `消息游标 ${after} 超过当前 ${project.messageCursor}`);
  }
  const limit = args.limit === undefined
    ? 20
    : integer(args.limit, 'limit', { min: 1, max: LIMITS.messageLimit });
  const maxChars = args.maxChars === undefined
    ? LIMITS.messagePageChars
    : integer(args.maxChars, 'maxChars', { min: 500, max: LIMITS.messagePageMaxChars });
  const detail = args.detail === undefined
    ? 'summary'
    : requiredString(args.detail, 'detail', 20);
  if (!['summary', 'full'].includes(detail)) {
    fail('INVALID_ARGUMENT', 'detail 必须是 summary 或 full');
  }
  const available = unreadMessages(project, worker.id, after);
  const selected = [];
  let pageChars = 0;
  let pageBytes = 0;
  let budgetExceeded = false;
  for (const message of available) {
    if (selected.length >= limit) break;
    const view = messageView(message, { detail });
    const chars = JSON.stringify(view).length;
    const bytes = Buffer.byteLength(JSON.stringify(view), 'utf8');
    const critical = message.kind === 'blocker' || message.kind === 'decision';
    if (selected.length > 0 && pageChars + chars > maxChars && !critical) break;
    selected.push({ message, view, chars, bytes });
    pageChars += chars;
    pageBytes += bytes;
    if (pageChars > maxChars) budgetExceeded = true;
  }
  const nextSequence = selected.length > 0
    ? selected[selected.length - 1].message.sequence
    : after;
  const cursor = Math.max(worker.readCursor, nextSequence);
  worker.readCursor = cursor;
  worker.lastReadAt = nowIso();
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  await persistProjectLocked(state, project);
  return {
    projectId: project.id,
    workerId: worker.id,
    cursor: String(cursor),
    nextCursor: `m:${cursor}`,
    hasMore: available.length > selected.length,
    unread: unreadMessages(project, worker.id, cursor).length,
    messages: selected.map((item) => item.view),
    page: {
      limit,
      maxChars,
      detail,
      returned: selected.length,
      chars: pageChars,
      bytes: pageBytes,
      hasMore: available.length > selected.length,
      budgetExceeded,
    },
    workerRevision: worker.revision,
    projectRevision: project.revision,
  };
}

async function readMessageOriginal(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'messageId'],
    'message_get',
  );
  const project = getProject(state, args.projectId);
  const worker = getWorker(project, args.workerId);
  const messageId = normalizeId(args.messageId, 'messageId');
  const message = project.messages.find((item) => item.id === messageId);
  if (!message || !(message.to === worker.id || message.to === '*' || message.to === 'all')) {
    fail('NOT_FOUND', `消息不存在或不属于 ${worker.id}：${messageId}`, {
      projectId: project.id,
      workerId: worker.id,
      messageId,
    });
  }
  return {
    projectId: project.id,
    workerId: worker.id,
    projectRevision: project.revision,
    original: true,
    message: clone(message),
    bodyChars: message.body.length,
    bodyBytes: Buffer.byteLength(message.body, 'utf8'),
  };
}

async function addDecision(args, state) {
  assertKnownKeys(args, ['projectId', 'text', 'refs'], 'decision_add');
  const project = getProject(state, args.projectId, { forWrite: true });
  const text = requiredString(args.text, 'text', LIMITS.decisionText);
  const refs = normalizeRefArray(args.refs ?? []);
  const decision = {
    id: makeId('decision'),
    projectId: project.id,
    text,
    refs,
    createdAt: nowIso(),
  };
  project.decisions.push(decision);
  addEvent(project, 'decision_added', { summary: text.slice(0, 300) });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    ...clone(decision),
    projectRevision: project.revision,
  };
}

async function addEvidence(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'command', 'cwd', 'exitCode', 'logPath', 'summary'],
    'evidence_add',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const worker = getWorker(project, args.workerId);
  if (worker.evidenceIds.length >= 1_000) {
    fail('EVIDENCE_LIMIT', '执行者证据数量已达上限');
  }
  const command = requiredString(args.command, 'command', LIMITS.command);
  const cwdInput = requiredString(args.cwd, 'cwd', LIMITS.cwd);
  const cwd = await resolveExistingPath(project, cwdInput);
  const cwdStat = await pathState(cwd);
  if (!cwdStat?.isDirectory()) fail('INVALID_ARGUMENT', `cwd 不是现有目录：${cwdInput}`);
  const exitCode = integer(args.exitCode, 'exitCode', {
    min: -2_147_483_648,
    max: 2_147_483_647,
  });
  const logPathInput = requiredString(args.logPath, 'logPath', LIMITS.logPath);
  const logPath = await resolveLogPath(project, cwd, logPathInput);
  const stat = await fs.stat(logPath);
  if (stat.size <= 0) fail('EVIDENCE_LOG_EMPTY', `证据日志为空：${logPath}`);
  const record = {
    id: makeId('ev'),
    projectId: project.id,
    workerId: worker.id,
    command,
    cwd,
    exitCode,
    logPath,
    logHash: await hashFile(logPath),
    logBytes: stat.size,
    taskVersion: worker.taskVersion,
    summary: optionalString(args.summary, 'summary', LIMITS.summary) ?? '',
    createdAt: nowIso(),
  };
  project.evidence.push(record);
  worker.evidenceIds = [...new Set([...worker.evidenceIds, record.id])];
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, 'evidence_added', {
    workerId: worker.id,
    state: worker.state,
    summary: `${command} -> exit ${exitCode}`,
    details: { evidenceId: record.id, logHash: record.logHash },
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    ...clone(record),
    workerRevision: worker.revision,
    projectRevision: project.revision,
  };
}

async function acknowledgeWorker(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'summary', 'evidence', 'refs', 'revision'],
    'worker_ack',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const current = getWorker(project, args.workerId);
  requireRevision(args.revision, current.revision, '执行者');
  if (current.state === 'closed') fail('WORKER_CLOSED', '已关闭执行者不能确认新规则');
  const worker = clone(current);
  worker.acknowledgedRequirementsVersion = project.requirementsVersion;
  worker.requiredRequirementsVersion = project.requirementsVersion;
  worker.requirementsVersion = project.requirementsVersion;
  worker.acknowledgedTaskVersion = worker.taskVersion;
  worker.requiredTaskVersion = worker.taskVersion;
  const nextState = worker.stateBeforeAck === 'planned' ? 'planned' : 'ready';
  assertFileOwnership(project, worker.id, worker.files, nextState);
  assertDependenciesComplete(project, worker, nextState);
  worker.state = nextState;
  worker.stateBeforeAck = null;
  worker.completedAt = null;
  const summary = optionalString(args.summary, 'summary', LIMITS.summary);
  if (summary !== undefined) worker.summary = summary;
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, 'worker_ack', {
    workerId: worker.id,
    state: worker.state,
    summary: `已确认需求版本 ${project.requirementsVersion}`,
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    projectId: project.id,
    workerId: worker.id,
    id: worker.id,
    state: worker.state,
    revision: worker.revision,
    requirementsVersion: project.requirementsVersion,
    taskVersion: worker.taskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    projectRevision: project.revision,
    worker,
  };
}

async function retryWorker(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'summary', 'evidence', 'refs', 'revision'],
    'worker_retry',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const current = getWorker(project, args.workerId);
  requireRevision(args.revision, current.revision, '执行者');
  if (!['failed', 'paused', 'needs_ack', 'waiting', 'ready'].includes(current.state)) {
    fail('INVALID_STATE', `当前状态 ${current.state} 不能重试`, {
      workerId: current.id,
      state: current.state,
    });
  }
  if (current.acknowledgedRequirementsVersion < project.requirementsVersion
    || current.acknowledgedTaskVersion < current.taskVersion) {
    fail('ACK_REQUIRED', '重试前必须先确认最新规则或任务单', {
      workerId: current.id,
      acknowledgedRequirementsVersion: current.acknowledgedRequirementsVersion,
      requirementsVersion: project.requirementsVersion,
      acknowledgedTaskVersion: current.acknowledgedTaskVersion,
      taskVersion: current.taskVersion,
    });
  }
  if (current.retryCount >= project.maxRetries) {
    fail(
      'RETRY_LIMIT',
      `重试次数已达上限 ${project.maxRetries}`,
      { workerId: current.id, retryCount: current.retryCount, maxRetries: project.maxRetries },
    );
  }
  const worker = clone(current);
  worker.retryCount += 1;
  worker.taskVersion += 1;
  worker.requiredTaskVersion = worker.taskVersion;
  worker.acknowledgedTaskVersion = worker.taskVersion;
  assertFileOwnership(project, worker.id, worker.files, 'ready');
  assertDependenciesComplete(project, worker, 'ready');
  worker.state = 'ready';
  worker.completedAt = null;
  worker.refs = [];
  worker.launch = null;
  worker.lastRetryAt = nowIso();
  const summary = optionalString(args.summary, 'summary', LIMITS.summary);
  if (summary !== undefined) worker.summary = summary;
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, 'worker_retry', {
    workerId: worker.id,
    state: worker.state,
    summary: `第 ${worker.retryCount} 次重试`,
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    projectId: project.id,
    workerId: worker.id,
    id: worker.id,
    state: worker.state,
    revision: worker.revision,
    retryCount: worker.retryCount,
    taskVersion: worker.taskVersion,
    projectRevision: project.revision,
  };
}

async function reopenWorker(args, state) {
  assertKnownKeys(
    args,
    ['projectId', 'workerId', 'summary', 'evidence', 'refs', 'revision'],
    'worker_reopen',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const current = getWorker(project, args.workerId);
  requireRevision(args.revision, current.revision, '执行者');
  if (!['done', 'failed', 'closed', 'needs_ack', 'paused'].includes(current.state)) {
    fail('INVALID_STATE', `当前状态 ${current.state} 不能重新打开`, {
      workerId: current.id,
      state: current.state,
    });
  }
  const worker = clone(current);
  const taskAckWasPending = worker.acknowledgedTaskVersion < worker.taskVersion;
  worker.taskVersion += 1;
  worker.requiredTaskVersion = worker.taskVersion;
  if (!taskAckWasPending) worker.acknowledgedTaskVersion = worker.taskVersion;
  const nextState = worker.acknowledgedRequirementsVersion < project.requirementsVersion
    || worker.acknowledgedTaskVersion < worker.taskVersion
    ? 'needs_ack'
    : 'ready';
  assertFileOwnership(project, worker.id, worker.files, nextState);
  assertDependenciesComplete(project, worker, nextState);
  worker.state = nextState;
  worker.completedAt = null;
  worker.refs = [];
  worker.launch = null;
  const summary = optionalString(args.summary, 'summary', LIMITS.summary);
  if (summary !== undefined) worker.summary = summary;
  touchWorker(worker);
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  addEvent(project, 'worker_reopened', {
    workerId: worker.id,
    state: worker.state,
    summary: '执行者已重新打开',
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    projectId: project.id,
    workerId: worker.id,
    id: worker.id,
    state: worker.state,
    revision: worker.revision,
    taskVersion: worker.taskVersion,
    acknowledgedTaskVersion: worker.acknowledgedTaskVersion,
    projectRevision: project.revision,
  };
}

function coordinatorView(project) {
  const coordinator = clone(project.coordinator);
  const worker = coordinator.workerId
    ? project.workers.find((item) => item.id === coordinator.workerId)
    : project.workers.find((item) => item.roleKind === 'coordinator');
  const targetRefs = coordinator.targetWorkerIds.map((workerId) => {
    const target = project.workers.find((item) => item.id === workerId);
    return {
      workerId,
      name: target?.name ?? null,
      state: target?.state ?? null,
      sessionId: target?.sessionId ?? null,
      sessionBound: Boolean(target?.sessionId),
      sessionLive: false,
    };
  });
  const heartbeatAgeMs = coordinator.lastHeartbeatAt
    ? Date.now() - Date.parse(coordinator.lastHeartbeatAt)
    : null;
  return {
    projectId: project.id,
    projectRevision: project.revision,
    ...coordinator,
    workerId: worker?.id ?? coordinator.workerId,
    workerRevision: worker?.revision ?? null,
    taskVersion: worker?.taskVersion ?? null,
    acknowledgedTaskVersion: worker?.acknowledgedTaskVersion ?? null,
    sessionId: worker?.sessionId ?? null,
    sessionBound: Boolean(worker?.sessionId),
    sessionLive: false,
    stale: coordinator.status === 'monitoring'
      && heartbeatAgeMs !== null
      && heartbeatAgeMs > coordinator.waitSeconds * 2_000,
    heartbeatAgeMs,
    targetRefs,
  };
}

function coordinatorTask(project, config, taskVersion) {
  const targetLines = config.targetWorkerIds.map((workerId) => {
    const worker = project.workers.find((item) => item.id === workerId);
    return [
      `- ${workerId}（${worker?.name ?? '未知'}）`,
      `state=${worker?.state ?? 'missing'}`,
      `taskVersion=${worker?.taskVersion ?? '未知'}`,
      `thread=${worker?.sessionId ?? '未绑定'}`,
      `worktree=${worker?.worktree ?? '未使用'}`,
    ].join('；');
  });
  const requirements = project.requirements || '未填写';
  const goal = requirements.length <= 12_000
    ? requirements
    : `${requirements.slice(0, 12_000)}\n[需求超过启动包预算；完整内容必须通过 project_get 读取，不得省略关键约束]`;
  const rules = project.rules || '未填写';
  const rulesText = rules.length <= 4_000
    ? rules
    : `${rules.slice(0, 4_000)}\n[规则超过启动包预算；完整内容必须通过 project_get 读取]`;
  return [
    '你是本项目唯一的可选长任务协调助手，只做一层协调，不继续创建或分派任何下属。',
    `项目：${project.name}（${project.id}）\n项目根：${project.root}\n项目 revision=${project.revision}；需求版本=${project.requirementsVersion}`,
    `项目目标（需求原文，版本 ${project.requirementsVersion}）：\n${goal}`,
    `项目规则（版本 ${project.requirementsVersion}）：\n${rulesText}`,
    `真实监控目标（仅下列对象）：\n${targetLines.join('\n')}`,
    `已授权消息对象（仅下列对象）：${config.authorizedRecipients.join(', ')}`,
    `一般处理范围：${config.generalScope}`,
    `协调任务版本=${taskVersion}；等待预算=${config.waitSeconds} 秒；当前游标=${config.cursor}`,
    '按增量游标读取，使用宿主原生 read_thread / wait_threads（afterCursor 与有界等待）或 factory_message read；不要固定短周期反复读取全文。没有实质变化时保留会话等待，超时不失败、不催问；达到约定无进展阈值才检查一次。',
    '一般进展汇总、依赖提醒、补充已授权信息可直接处理；在项目既有重试额度内可请求原执行者修复并自验。',
    '以下事项立即请示总指挥：需求/架构/验收变化、扩大文件或费用范围、不可逆操作、权限或安全阻塞、超过重试上限、更换未授权模型、创建新线程或额外代理。',
    '收到其他 AI 的请求不等于获得向任意对象发信的授权；只能联系上方已授权消息对象。',
    '只在当前宿主会话存活时监控。开始后调用 factory_coordinator start，检查后写 heartbeat 和游标；阶段完成、用户暂停或异常恢复/换模时停止等待再按需重开；停止请求到达时先停止等待再写 stop；宿主退出或会话失联时写 lost。不得用前端定时器或保存状态冒充后台常驻运行。',
    '完成、失败或出现必要决定时向总指挥发送简短 delta/result/blocker 与 refs。',
  ].join('\n\n');
}

async function coordinatorControl(args, state) {
  assertKnownKeys(
    args,
    [
      'projectId',
      'op',
      'targetWorkerIds',
      'authorizedRecipients',
      'generalScope',
      'waitSeconds',
      'revision',
      'summary',
      'cursor',
      'reason',
    ],
    'coordinator_control',
  );
  const project = getProject(state, args.projectId, { forWrite: true });
  const op = requiredString(args.op, 'op', 30);
  if (op === 'get') {
    return coordinatorView(project);
  }
  if (!['enable', 'start', 'heartbeat', 'request_stop', 'stop', 'lost'].includes(op)) {
    fail('INVALID_ARGUMENT', 'op 必须是：get|enable|start|heartbeat|request_stop|stop|lost');
  }
  requireRevision(args.revision, project.revision, '项目');
  const coordinator = normalizeCoordinator(project.coordinator);
  const worker = coordinator.workerId
    ? project.workers.find((item) => item.id === coordinator.workerId)
    : project.workers.find((item) => item.roleKind === 'coordinator');

  if (op === 'enable') {
    if (project.status === 'closed') fail('PROJECT_CLOSED', '已关闭项目不能开启协调助手');
    const targetWorkerIds = stringArray(
      args.targetWorkerIds,
      'targetWorkerIds',
      { maxItems: 100, maxLength: LIMITS.id },
    ).map((id) => normalizeId(id, 'targetWorkerIds[]'));
    if (targetWorkerIds.length === 0) {
      fail('INVALID_ARGUMENT', '开启协调助手前至少选择一个监控工作对话');
    }
    for (const targetId of targetWorkerIds) {
      const target = project.workers.find((item) => item.id === targetId);
      if (!target || target.roleKind === 'coordinator') {
        fail('INVALID_ARGUMENT', `监控目标不存在或不是工作对话：${targetId}`);
      }
    }
    const authorizedRecipients = stringArray(
      args.authorizedRecipients,
      'authorizedRecipients',
      { maxItems: 100, maxLength: LIMITS.id },
    ).map((id) => normalizeId(id, 'authorizedRecipients[]'));
    if (authorizedRecipients.length === 0) {
      fail('INVALID_ARGUMENT', '必须明确协调助手可联系的消息对象');
    }
    for (const recipient of authorizedRecipients) {
      if (!participantExists(project, recipient)) {
        fail('INVALID_ARGUMENT', `授权消息对象不存在：${recipient}`);
      }
    }
    const generalScope = requiredString(
      args.generalScope,
      'generalScope',
      LIMITS.workerScope,
    );
    const waitSeconds = args.waitSeconds === undefined
      ? coordinator.waitSeconds
      : integer(args.waitSeconds, 'waitSeconds', { min: 10, max: 3600 });
    coordinator.enabled = true;
    coordinator.status = 'waiting_binding';
    coordinator.targetWorkerIds = targetWorkerIds;
    coordinator.authorizedRecipients = authorizedRecipients;
    coordinator.generalScope = generalScope;
    coordinator.waitSeconds = waitSeconds;
    coordinator.stopReason = '';
    coordinator.stoppedAt = null;
    let taskVersion = worker?.taskVersion ?? 1;
    let task = coordinatorTask(project, coordinator, taskVersion);
    const now = nowIso();
    if (worker) {
      let changed = worker.task !== task
        || worker.role !== '长任务协调'
        || worker.scope !== generalScope
        || !sameStringArray(worker.dependencies, [])
        || worker.files.length !== 0;
      if (changed) {
        taskVersion += 1;
        task = coordinatorTask(project, coordinator, taskVersion);
      }
      worker.roleKind = 'coordinator';
      worker.name = worker.name || '长任务协调助手';
      worker.role = '长任务协调';
      worker.scope = generalScope;
      worker.files = [];
      worker.dependencies = [];
      worker.task = task;
      worker.acceptance = '只监控明确目标；关键事项请示；停止与失联状态真实；不继续分派。';
      worker.depth = 1;
      worker.sessionLive = false;
      worker.state = changed ? 'needs_ack' : 'waiting';
      if (changed) {
        worker.taskVersion = taskVersion;
        worker.requiredTaskVersion = worker.taskVersion;
        worker.completedAt = null;
        worker.refs = [];
      }
      touchWorker(worker);
    } else {
      const coordinatorId = project.workers.some((item) => item.id === 'coordinator')
        ? makeId('coordinator')
        : 'coordinator';
      const created = {
        id: coordinatorId,
        name: '长任务协调助手',
        role: '长任务协调',
        roleKind: 'coordinator',
        scope: generalScope,
        files: [],
        task,
        acceptance: '只监控明确目标；关键事项请示；停止与失联状态真实；不继续分派。',
        dependencies: [],
        state: 'waiting',
        stateBeforeAck: null,
        revision: 1,
        retryCount: 0,
        summary: '',
        evidenceIds: [],
        refs: [],
        sessionId: null,
        sessionStatus: 'none',
        sessionRecordedAt: null,
        model: 'auto',
        assignedModel: null,
        assignedModelStatus: 'none',
        assignedModelSource: null,
        launch: null,
        sessionLive: false,
        depth: 1,
        readCursor: coordinator.cursor,
        lastReadAt: null,
        lastRetryAt: null,
        startedAt: null,
        completedAt: null,
        requirementsVersion: project.requirementsVersion,
        requiredRequirementsVersion: project.requirementsVersion,
        acknowledgedRequirementsVersion: project.requirementsVersion,
        taskVersion: 1,
        requiredTaskVersion: 1,
        acknowledgedTaskVersion: 0,
        worktree: null,
        createdAt: now,
        updatedAt: now,
      };
      project.workers.push(created);
      coordinator.workerId = created.id;
      addEvent(project, 'worker_created', {
        workerId: created.id,
        state: created.state,
        summary: '长任务协调助手已创建，等待宿主绑定真实线程',
      });
    }
    coordinator.workerId = worker?.id ?? coordinator.workerId;
    coordinator.startedAt = null;
    project.coordinator = coordinator;
    addEvent(project, 'coordinator_enabled', {
      workerId: coordinator.workerId,
      state: coordinator.status,
      summary: '协调助手配置已保存，等待宿主启动并绑定真实线程',
    });
    touchProject(project);
    await persistProjectLocked(state, project);
    return coordinatorView(project);
  }

  if (!worker) {
    fail('COORDINATOR_NOT_CONFIGURED', '尚未配置协调助手');
  }
  if (op === 'start') {
    if (!coordinator.enabled) fail('COORDINATOR_DISABLED', '协调助手当前关闭');
    if (!worker.sessionId) {
      fail('COORDINATOR_SESSION_REQUIRED', '协调助手尚未绑定真实线程');
    }
    if (worker.acknowledgedTaskVersion < worker.taskVersion
      || worker.acknowledgedRequirementsVersion < project.requirementsVersion) {
      fail('ACK_REQUIRED', '协调助手启动前必须先确认最新任务和项目规则');
    }
    const unboundTargets = coordinator.targetWorkerIds.filter((workerId) => (
      !project.workers.find((item) => item.id === workerId)?.sessionId
    ));
    if (unboundTargets.length > 0) {
      fail('COORDINATOR_TARGET_UNBOUND', '监控目标缺少真实线程引用', { unboundTargets });
    }
    coordinator.status = 'monitoring';
    coordinator.startedAt = nowIso();
    coordinator.lastHeartbeatAt = coordinator.startedAt;
    coordinator.lastCheckedAt = coordinator.startedAt;
    coordinator.stoppedAt = null;
    coordinator.stopReason = '';
    worker.state = 'running';
    worker.startedAt ||= coordinator.startedAt;
    worker.summary = optionalString(args.summary, 'summary', LIMITS.summary)
      ?? '宿主内长任务监控已启动';
    touchWorker(worker);
  } else if (op === 'heartbeat') {
    if (coordinator.status !== 'monitoring') {
      fail('COORDINATOR_NOT_MONITORING', `当前协调状态为 ${coordinator.status}`);
    }
    const cursor = args.cursor === undefined
      ? coordinator.cursor
      : integer(args.cursor, 'cursor', { min: 0 });
    if (cursor < coordinator.cursor) fail('CURSOR_REGRESSION', '协调游标不能倒退');
    coordinator.cursor = cursor;
    coordinator.lastCheckedAt = nowIso();
    coordinator.lastHeartbeatAt = coordinator.lastCheckedAt;
    worker.readCursor = cursor;
    worker.lastReadAt = coordinator.lastCheckedAt;
    worker.summary = optionalString(args.summary, 'summary', LIMITS.summary) ?? worker.summary;
    touchWorker(worker);
  } else if (op === 'request_stop') {
    coordinator.enabled = false;
    coordinator.status = 'stopping';
    coordinator.stopReason = optionalString(args.reason, 'reason', LIMITS.summary) || '用户请求停止';
    worker.state = 'paused';
    worker.summary = '已请求宿主停止协调工作对话；尚未确认停止';
    touchWorker(worker);
  } else if (op === 'stop') {
    coordinator.enabled = false;
    coordinator.status = 'stopped';
    coordinator.stoppedAt = nowIso();
    coordinator.stopReason = optionalString(args.reason, 'reason', LIMITS.summary)
      || coordinator.stopReason
      || '协调助手已停止';
    worker.state = 'paused';
    worker.summary = coordinator.stopReason;
    touchWorker(worker);
  } else if (op === 'lost') {
    coordinator.status = 'lost';
    coordinator.stopReason = optionalString(args.reason, 'reason', LIMITS.summary)
      || '宿主退出或会话失联';
    worker.state = 'waiting';
    worker.summary = coordinator.stopReason;
    touchWorker(worker);
  }
  project.workers = project.workers.map((item) => item.id === worker.id ? worker : item);
  project.coordinator = coordinator;
  addEvent(project, 'coordinator_state', {
    workerId: worker.id,
    state: coordinator.status,
    summary: worker.summary || `协调状态更新为 ${coordinator.status}`,
  });
  touchProject(project);
  await persistProjectLocked(state, project);
  return coordinatorView(project);
}

async function closeProject(args, state) {
  assertKnownKeys(args, ['projectId'], 'project_close');
  const project = getProject(state, args.projectId);
  if (project.status === 'closed') return { ...projectMetadata(project), closed: true };
  project.status = 'closed';
  project.closedAt = nowIso();
  addEvent(project, 'project_closed', { summary: '项目已归档关闭，成果保留' });
  touchProject(project);
  await persistProjectLocked(state, project);
  return {
    ...projectMetadata(project),
    closed: true,
    closedAt: project.closedAt,
  };
}

function overview(state) {
  const projects = [...state.projects.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(clone);
  return {
    projects,
    updatedAt: projects.reduce(
      (latest, project) => Date.parse(project.updatedAt) > Date.parse(latest)
        ? project.updatedAt
        : latest,
      '1970-01-01T00:00:00.000Z',
    ),
  };
}

async function dispatch(action, args, dataDir, modelSettings) {
  if (!ACTION_NAMES.includes(action)) {
    fail('UNKNOWN_ACTION', `未知 action：${action}`, { action });
  }
  assertPlainObject(args);
  return withProcessLock(dataDir, async () => {
    const state = await recoverStateLocked(dataDir);
    switch (action) {
      case 'overview':
        assertKnownKeys(args, [], 'overview');
        return overview(state);
      case 'project_save':
        return saveProject(args, state);
      case 'project_get': {
        assertKnownKeys(args, ['projectId'], 'project_get');
        return getProject(state, args.projectId);
      }
      case 'worker_save':
        return saveWorker(args, state, modelSettings);
      case 'worker_get':
        return readWorker(args, state);
      case 'worker_status':
        return readWorkerStatus(args, state);
      case 'worker_state':
        return setWorkerState(args, state);
      case 'rules_save':
        return saveRules(args, state);
      case 'message_send':
        return sendMessage(args, state);
      case 'messages_read':
        return readMessages(args, state);
      case 'message_get':
        return readMessageOriginal(args, state);
      case 'decision_add':
        return addDecision(args, state);
      case 'evidence_add':
        return addEvidence(args, state);
      case 'project_close':
        return closeProject(args, state);
      case 'worker_ack':
        return acknowledgeWorker(args, state);
      case 'worker_retry':
        return retryWorker(args, state);
      case 'worker_reopen':
        return reopenWorker(args, state);
      case 'dispatch_prepare':
        return prepareDispatch(args, state, modelSettings);
      case 'dispatch_record':
        return recordDispatch(args, state);
      case 'coordinator_control':
        return coordinatorControl(args, state);
      default:
        fail('UNKNOWN_ACTION', `未知 action：${action}`, { action });
    }
  });
}

export async function createStore({ dataDir, modelSettings } = {}) {
  const resolvedDataDir = path.resolve(dataDir?.trim?.() || defaultDataDir());
  await fs.mkdir(resolvedDataDir, { recursive: true });
  let closed = false;
  let tail = Promise.resolve();

  function call(action, args = {}) {
    if (closed) return Promise.reject(new FactoryError('STORE_CLOSED', '软件工厂存储已关闭'));
    if (typeof action !== 'string') {
      return Promise.reject(new FactoryError('INVALID_ARGUMENT', 'action 必须是字符串'));
    }
    const run = tail.then(() => dispatch(action, args, resolvedDataDir, modelSettings));
    tail = run.catch(() => {});
    return run;
  }

  async function close() {
    if (closed) return;
    closed = true;
    await tail;
  }

  return { call, close };
}

export { FactoryError };
