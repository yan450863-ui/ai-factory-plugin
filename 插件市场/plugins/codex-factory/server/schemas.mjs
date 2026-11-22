import path from 'node:path';

export const SCHEMA_VERSION = 2;

export const ACTION_NAMES = Object.freeze([
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
  'dispatch_prepare',
  'dispatch_record',
  'coordinator_control',
]);

export const WORKER_ROLE_KINDS = Object.freeze([
  'worker',
  'coordinator',
]);

export const COORDINATOR_STATUSES = Object.freeze([
  'off',
  'waiting_binding',
  'monitoring',
  'stopping',
  'stopped',
  'lost',
]);

export const WORKER_STATES = Object.freeze([
  'planned',
  'ready',
  'running',
  'waiting',
  'paused',
  'needs_ack',
  'done',
  'failed',
  'closed',
]);

export const ACTIVE_WORKER_STATES = Object.freeze([
  'planned',
  'ready',
  'running',
  'waiting',
  'paused',
  'needs_ack',
]);

export const MESSAGE_KINDS = Object.freeze([
  'delta',
  'blocker',
  'result',
  'decision',
  'ack',
  'error',
]);

export const LIMITS = Object.freeze({
  id: 200,
  projectName: 300,
  projectRoot: 4000,
  requirements: 200_000,
  rules: 100_000,
  workerName: 300,
  workerRole: 100,
  workerScope: 4_000,
  workerTask: 20_000,
  workerAcceptance: 10_000,
  filePath: 1_000,
  files: 200,
  dependencies: 100,
  summary: 10_000,
  evidence: 100,
  refs: 100,
  ref: 3_000,
  messageBody: 12_000,
  messageLimit: 50,
  messageSummary: 1_600,
  messagePreview: 1_600,
  messageChanges: 12,
  messageChecks: 12,
  messageChange: 500,
  messageCheck: 800,
  messageBlock: 1_000,
  messageDecision: 1_600,
  messageEnvelopeBytes: 8_192,
  messagePageChars: 6_000,
  messagePageMaxChars: 50_000,
  sessionId: 500,
  model: 200,
  worktree: 2_000,
  decisionText: 20_000,
  command: 10_000,
  cwd: 4_000,
  logPath: 4_000,
  requestId: 300,
  cursor: 500,
  dispatchPrompt: 100_000,
  dispatchTool: 40,
  dispatchEffort: 40,
  dispatchErrorCode: 80,
  dispatchErrorMessage: 2_000,
});

export function messageBodyFromEnvelope(envelope) {
  const lines = [`[${envelope.type}] ${envelope.summary}`];
  if (envelope.changes?.length) {
    lines.push('changes:', ...envelope.changes.map((item) => `- ${item}`));
  }
  if (envelope.checks?.length) {
    lines.push('checks:', ...envelope.checks.map((item) => `- ${item}`));
  }
  if (envelope.block) {
    lines.push(`block: ${envelope.block.code ? `${envelope.block.code}: ` : ''}${envelope.block.message}`);
    if (envelope.block.needs) lines.push(`needs: ${envelope.block.needs}`);
  }
  if (envelope.decision) lines.push(`decision: ${envelope.decision}`);
  return lines.join('\n');
}

export function normalizeMessageEnvelope(value) {
  assertPlainObject(value, 'envelope');
  assertKnownKeys(
    value,
    ['v', 'type', 'summary', 'changes', 'checks', 'block', 'decision'],
    'message_envelope',
  );
  const v = integer(value.v, 'envelope.v', { min: 1, max: 1 });
  const type = normalizeMessageKind(value.type);
  const summary = requiredString(value.summary, 'envelope.summary', LIMITS.messageSummary);
  const changes = stringArray(value.changes ?? [], 'envelope.changes', {
    maxItems: LIMITS.messageChanges,
    maxLength: LIMITS.messageChange,
  });
  const checks = stringArray(value.checks ?? [], 'envelope.checks', {
    maxItems: LIMITS.messageChecks,
    maxLength: LIMITS.messageCheck,
  });
  let block = null;
  if (value.block !== undefined && value.block !== null && value.block !== '') {
    if (typeof value.block === 'string') {
      block = { code: null, message: requiredString(value.block, 'envelope.block', LIMITS.messageBlock), needs: null };
    } else {
      assertPlainObject(value.block, 'envelope.block');
      assertKnownKeys(value.block, ['code', 'message', 'needs'], 'message_envelope.block');
      block = {
        code: optionalString(value.block.code, 'envelope.block.code', 80) || null,
        message: requiredString(value.block.message, 'envelope.block.message', LIMITS.messageBlock),
        needs: optionalString(value.block.needs, 'envelope.block.needs', 500) || null,
      };
    }
  }
  const decision = optionalString(value.decision, 'envelope.decision', LIMITS.messageDecision) || null;
  const envelope = {
    v,
    type,
    summary,
    ...(changes.length ? { changes } : {}),
    ...(checks.length ? { checks } : {}),
    ...(block ? { block } : {}),
    ...(decision ? { decision } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (bytes > LIMITS.messageEnvelopeBytes) {
    fail(
      'MESSAGE_BUDGET',
      `消息 envelope 为 ${bytes} 字节，超过 ${LIMITS.messageEnvelopeBytes} 字节上限`,
      { bytes, maxBytes: LIMITS.messageEnvelopeBytes },
    );
  }
  return envelope;
}

export class FactoryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FactoryError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = undefined) {
  throw new FactoryError(code, message, details);
}

export function assertPlainObject(value, name = 'args') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ARGUMENT', `${name} 必须是对象`);
  }
  return value;
}

export function assertKnownKeys(args, allowed, action) {
  assertPlainObject(args);
  const accepted = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => args[key] !== undefined && !accepted.has(key));
  if (unknown.length > 0) {
    fail('INVALID_ARGUMENT', `${action} 不接受字段：${unknown.join(', ')}`, { unknown });
  }
}

export function requiredString(value, name, maxLength) {
  if (typeof value !== 'string') {
    fail('INVALID_ARGUMENT', `${name} 必须是字符串`);
  }
  const normalized = value.trim();
  if (!normalized) {
    fail('INVALID_ARGUMENT', `${name} 不能为空`);
  }
  if (normalized.length > maxLength) {
    fail('INVALID_ARGUMENT', `${name} 超过 ${maxLength} 字符上限`);
  }
  return normalized;
}

export function optionalString(value, name, maxLength) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    fail('INVALID_ARGUMENT', `${name} 必须是字符串`);
  }
  if (value.length > maxLength) {
    fail('INVALID_ARGUMENT', `${name} 超过 ${maxLength} 字符上限`);
  }
  return value.trim();
}

export function stringArray(value, name, { maxItems, maxLength, defaultValue = [] } = {}) {
  if (value === undefined) return [...defaultValue];
  if (!Array.isArray(value)) {
    fail('INVALID_ARGUMENT', `${name} 必须是字符串数组`);
  }
  if (maxItems !== undefined && value.length > maxItems) {
    fail('INVALID_ARGUMENT', `${name} 最多 ${maxItems} 项`);
  }
  const result = value.map((item, index) => requiredString(item, `${name}[${index}]`, maxLength));
  return [...new Set(result)];
}

export function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_ARGUMENT', `${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

export function optionalRevision(value, name = 'revision') {
  if (value === undefined) return undefined;
  return integer(value, name, { min: 0 });
}

export function requireRevision(value, current, label = '对象') {
  const revision = optionalRevision(value);
  if (revision === undefined) {
    fail(
      'REVISION_REQUIRED',
      `更新已有${label}时必须提供 revision，当前 revision 为 ${current}`,
      { currentRevision: current },
    );
  }
  if (revision !== current) {
    fail(
      'REVISION_CONFLICT',
      `${label}已被其他进程更新：期望 revision ${revision}，当前为 ${current}`,
      { expectedRevision: revision, currentRevision: current },
    );
  }
  return revision;
}

export function normalizeId(value, name = 'id') {
  const id = requiredString(value, name, LIMITS.id);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    fail('INVALID_ARGUMENT', `${name} 只能包含字母、数字、下划线和连字符`);
  }
  return id;
}

export function normalizeWorkerState(value, name = 'state') {
  const state = requiredString(value, name, 30);
  if (!WORKER_STATES.includes(state)) {
    fail('INVALID_ARGUMENT', `${name} 必须是：${WORKER_STATES.join('|')}`);
  }
  return state;
}

export function normalizeMessageKind(value) {
  const kind = requiredString(value, 'kind', 30);
  if (!MESSAGE_KINDS.includes(kind)) {
    fail('INVALID_ARGUMENT', `kind 必须是：${MESSAGE_KINDS.join('|')}`);
  }
  return kind;
}

export function normalizeOwnedFile(value, index = 0) {
  const raw = requiredString(value, `files[${index}]`, LIMITS.filePath).replaceAll('\\', '/');
  if (raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.startsWith('~/')) {
    fail('INVALID_ARGUMENT', `files[${index}] 必须是项目根目录内的相对路径`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, '');
  if (normalized === '..' || normalized.startsWith('../')) {
    fail('INVALID_ARGUMENT', `files[${index}] 不能越过项目根目录`);
  }
  return normalized;
}

export function ownedFileArray(value, name = 'files') {
  const files = stringArray(value, name, {
    maxItems: LIMITS.files,
    maxLength: LIMITS.filePath,
  }).map((item, index) => normalizeOwnedFile(item, index));
  return [...new Set(files)];
}

export function normalizeRefArray(value, name = 'refs') {
  return stringArray(value, name, {
    maxItems: LIMITS.refs,
    maxLength: LIMITS.ref,
  });
}

export function parseCursor(value, name = 'after') {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    return integer(value, name, { min: 0 });
  }
  if (typeof value !== 'string' || value.length > LIMITS.cursor) {
    fail('INVALID_ARGUMENT', `${name} 必须是消息游标`);
  }
  const match = value.trim().match(/^(?:m:)?(\d+)$/);
  if (!match) {
    fail('INVALID_ARGUMENT', `${name} 必须是消息游标`);
  }
  return integer(Number(match[1]), name, { min: 0 });
}

export function isActiveWorkerState(state) {
  return ACTIVE_WORKER_STATES.includes(state);
}

export function clone(value) {
  return structuredClone(value);
}
