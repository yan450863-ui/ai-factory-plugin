import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from '../插件市场/plugins/codex-factory/server/store.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(toolDir);
const verifyDir = path.join(rootDir, '验证');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const recordPath = path.join(verifyDir, `store-${stamp}.json`);

async function expectCode(operation, code) {
  try {
    await operation();
    assert.fail(`预期错误 ${code}，实际成功`);
  } catch (error) {
    assert.equal(error?.code, code, error?.stack || String(error));
    return error;
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
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

async function waitForFiles(files, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(files.map(exists));
    if (states.every(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待子进程就绪超时：${files.join(', ')}`);
}

function runChild(scriptPath, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, JSON.stringify(payload)], {
      cwd: path.dirname(scriptPath),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`子进程退出 ${code}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`子进程输出不是 JSON\nstdout=${stdout}\nstderr=${stderr}`));
      }
    });
  });
}

function childSource(storeUrl) {
  return `
import fs from 'node:fs/promises';
import { createStore } from ${JSON.stringify(storeUrl)};

const payload = JSON.parse(process.argv[2]);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const store = await createStore({ dataDir: payload.dataDir });
try {
  if (payload.mode === 'revision-race') {
    const current = await store.call('project_get', { projectId: payload.projectId });
    await fs.writeFile(payload.readyPath, String(current.revision), 'utf8');
    while (true) {
      try {
        await fs.access(payload.goPath);
        break;
      } catch {
        await sleep(20);
      }
    }
    try {
      const saved = await store.call('project_save', {
        id: current.id,
        name: payload.name,
        root: current.root,
        requirements: current.requirements,
        rules: current.rules,
        maxRetries: current.maxRetries,
        revision: current.revision,
      });
      console.log(JSON.stringify({ ok: true, revision: saved.revision, name: saved.name }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
    }
  } else if (payload.mode === 'message') {
    const message = await store.call('message_send', {
      projectId: payload.projectId,
      from: 'orchestrator',
      to: payload.to,
      kind: 'delta',
      body: payload.body,
      refs: [],
      requestId: payload.requestId,
    });
    console.log(JSON.stringify({ ok: true, sequence: message.sequence, id: message.id }));
  } else {
    throw new Error('unknown child mode');
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
} finally {
  await store.close();
}
`;
}

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-factory-store-'));
  const projectRoot = path.join(base, 'project');
  const dataDir = path.join(base, 'data');
  const logDir = path.join(base, 'logs');
  const childScript = path.join(base, 'child.mjs');
  const checks = [];
  let store;
  const check = (name) => checks.push(name);

  try {
    await Promise.all([
      fs.mkdir(projectRoot, { recursive: true }),
      fs.mkdir(dataDir, { recursive: true }),
      fs.mkdir(logDir, { recursive: true }),
    ]);
    await fs.writeFile(
      childScript,
      childSource(pathToFileURL(path.join(
        rootDir,
        '插件市场',
        'plugins',
        'codex-factory',
        'server',
        'store.mjs',
      )).href),
      'utf8',
    );

    let dispatchModelEnabled = true;
    const modelSettings = {
      read: async () => ({
        settings: {
          revision: 1,
          modes: { factory: { enabled: true } },
          models: [
            { id: 'alpha', enabled: dispatchModelEnabled, effort: 'high', ability: 3 },
            { id: 'beta', enabled: false, effort: 'low', ability: 3 },
          ],
        },
        catalog: [
          { id: 'alpha', available: true, efforts: ['low', 'high'], defaultEffort: 'high' },
          { id: 'beta', available: true, efforts: ['low'], defaultEffort: 'low' },
        ],
      }),
    };
    store = await createStore({ dataDir, modelSettings });
    const project = await store.call('project_save', {
      name: '核心验证项目',
      root: projectRoot,
      requirements: '需求版本 1',
      rules: '执行者只有一层，禁止继续分派。',
      maxRetries: 1,
    });
    assert.equal(project.revision, 1);
    assert.equal(project.requirementsVersion, 1);
    assert.ok(await exists(path.join(projectRoot, '.codex-factory', 'project.json')));
    assert.ok(await exists(path.join(dataDir, 'index.json')));
    assert.ok(await exists(path.join(dataDir, 'projects', `${project.id}.json`)));
    check('项目主副本、数据目录镜像和索引均真实落盘');

    await store.close();
    store = await createStore({ dataDir, modelSettings });
    const persisted = await store.call('project_get', { projectId: project.id });
    assert.equal(persisted.id, project.id);
    assert.equal((await store.call('overview')).projects.length, 1);
    check('关闭并重建 store 后项目仍可恢复');

    const workerA = await store.call('worker_save', {
      projectId: project.id,
      name: '执行者 A',
      role: 'backend',
      scope: '服务端',
      files: ['src/a.mjs', 'src/shared/**'],
      task: '实现核心接口',
      acceptance: '接口验证通过',
      dependencies: [],
      sessionId: 'session-recorded-only',
    });
    const workerARead = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerA.workerId,
    });
    assert.equal(workerA.state, 'planned');
    assert.equal(workerARead.worker.sessionStatus, 'recorded');
    assert.equal(workerARead.worker.sessionId, 'session-recorded-only');
    assert.equal(workerARead.worker.sessionLive, false);
    assert.equal(workerARead.sessionLive, false);
    assert.equal(workerARead.worker.task, '实现核心接口');
    assert.equal(workerARead.worker.acceptance, '接口验证通过');
    assert.deepEqual(workerARead.worker.files, ['src/a.mjs', 'src/shared/**']);
    check('sessionId 只记录会话，不被解释为 running；worker_get 保留任务与验收');

    await expectCode(() => store.call('worker_save', {
      projectId: project.id,
      name: '冲突执行者',
      role: 'backend',
      scope: '冲突文件',
      files: ['src/a.mjs'],
      task: '制造冲突',
      acceptance: '不应创建',
      dependencies: [],
    }), 'FILE_CONFLICT');
    check('活动执行者的文件归属冲突被拒绝');

    const workerB = await store.call('worker_save', {
      projectId: project.id,
      name: '执行者 B',
      role: 'test',
      scope: '验证',
      files: ['src/b.mjs'],
      task: '验证服务端',
      acceptance: '测试通过',
      dependencies: [],
    });
    await expectCode(() => store.call('worker_save', {
      projectId: project.id,
      name: '依赖缺失执行者',
      role: 'review',
      scope: '审查',
      files: ['src/review.md'],
      task: '审查',
      acceptance: '报告',
      dependencies: ['w_missing'],
    }), 'DEPENDENCY_NOT_FOUND');
    const workerC = await store.call('worker_save', {
      projectId: project.id,
      name: '执行者 C',
      role: 'review',
      scope: '依赖验收',
      files: ['src/c.mjs'],
      task: '等待依赖完成',
      acceptance: '依赖通过',
      dependencies: [workerA.workerId, workerB.workerId],
    });
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerC.workerId,
      state: 'ready',
      revision: workerC.revision,
    }), 'DEPENDENCY_UNMET');
    check('依赖缺失和未完成依赖都会阻断执行');

    const aReady = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'ready',
      revision: workerARead.revision,
    });
    const aRunning = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'running',
      revision: aReady.revision,
    });
    const aRunningRead = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerA.workerId,
    });
    assert.equal(aRunningRead.state, 'running');
    assert.equal(aRunningRead.sessionLive, false);
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'done',
      evidence: [],
      refs: [],
      revision: aRunning.revision,
    }), 'EVIDENCE_REQUIRED');
    const logA = path.join(logDir, 'a-test.log');
    await fs.writeFile(logA, 'worker A tests: 8 passed\n', 'utf8');
    const evidenceA = await store.call('evidence_add', {
      projectId: project.id,
      workerId: workerA.workerId,
      command: 'npm test -- worker-a',
      cwd: projectRoot,
      exitCode: 0,
      logPath: logA,
      summary: '执行者 A 测试通过',
    });
    assert.match(evidenceA.logHash, /^[a-f0-9]{64}$/);
    const aDone = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'done',
      evidence: [evidenceA.id],
      refs: [],
      revision: evidenceA.workerRevision,
    });
    assert.equal(aDone.state, 'done');
    check('完成态必须存在真实日志和 SHA-256 证据');

    const aAfterDone = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerA.workerId,
    });
    const aTaskChanged = await store.call('worker_save', {
      projectId: project.id,
      id: workerA.workerId,
      task: '实现核心接口的新任务版本',
      acceptance: '新任务版本重新验收',
      revision: aAfterDone.revision,
    });
    assert.equal(aTaskChanged.state, 'needs_ack');
    assert.equal(aTaskChanged.taskVersion, 2);
    assert.equal(aTaskChanged.acknowledgedTaskVersion, 1);
    const aTaskGet = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerA.workerId,
    });
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'ready',
      revision: aTaskGet.revision,
    }), 'ACK_REQUIRED');
    const aTaskAck = await store.call('worker_ack', {
      projectId: project.id,
      workerId: workerA.workerId,
      revision: aTaskGet.revision,
    });
    assert.equal(aTaskAck.state, 'ready');
    assert.equal(aTaskAck.acknowledgedTaskVersion, 2);
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'done',
      evidence: [evidenceA.id],
      refs: [],
      revision: aTaskAck.revision,
    }), 'EVIDENCE_REQUIRED');
    const logA2 = path.join(logDir, 'a-test-v2.log');
    await fs.writeFile(logA2, 'worker A task v2 tests: 10 passed\n', 'utf8');
    const evidenceA2 = await store.call('evidence_add', {
      projectId: project.id,
      workerId: workerA.workerId,
      command: 'npm test -- worker-a-v2',
      cwd: projectRoot,
      exitCode: 0,
      logPath: logA2,
    });
    const aTaskDone = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'done',
      evidence: [evidenceA2.id],
      refs: [],
      revision: evidenceA2.workerRevision,
    });
    assert.equal(aTaskDone.state, 'done');
    const aReopened = await store.call('worker_reopen', {
      projectId: project.id,
      workerId: workerA.workerId,
      revision: aTaskDone.revision,
    });
    assert.equal(aReopened.state, 'ready');
    assert.equal(aReopened.taskVersion, 3);
    assert.equal(aReopened.acknowledgedTaskVersion, 3);
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerA.workerId,
      state: 'done',
      evidence: [evidenceA2.id],
      refs: [],
      revision: aReopened.revision,
    }), 'EVIDENCE_REQUIRED');
    check('任务单变更增加 taskVersion 并进入 needs_ack；旧任务证据不能复用');
    check('重新打开形成新执行轮次，旧证据和旧 refs 不能复用');

    const workerD = await store.call('worker_save', {
      projectId: project.id,
      name: '执行者 D',
      role: 'test',
      scope: '篡改验证',
      files: ['src/d.mjs'],
      task: '验证日志 hash',
      acceptance: '篡改后不得完成',
      dependencies: [],
    });
    const dReady = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerD.workerId,
      state: 'ready',
      revision: workerD.revision,
    });
    const logD = path.join(logDir, 'd-test.log');
    await fs.writeFile(logD, 'original pass\n', 'utf8');
    const evidenceD = await store.call('evidence_add', {
      projectId: project.id,
      workerId: workerD.workerId,
      command: 'node verify-d.mjs',
      cwd: projectRoot,
      exitCode: 0,
      logPath: logD,
    });
    await fs.writeFile(logD, 'tampered after evidence\n', 'utf8');
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerD.workerId,
      state: 'done',
      evidence: [evidenceD.id],
      refs: [],
      revision: evidenceD.workerRevision,
    }), 'EVIDENCE_INVALID');
    assert.equal(dReady.state, 'ready');
    check('证据日志被篡改后完成门槛失败');

    const beforeRules = await store.call('project_get', { projectId: project.id });
    const rulesResult = await store.call('rules_save', {
      projectId: project.id,
      requirements: '需求版本 2',
      rules: '规则更新：所有执行者先确认再继续。',
      revision: beforeRules.revision,
    });
    assert.equal(rulesResult.requirementsVersion, 2);
    const afterRules = await store.call('project_get', { projectId: project.id });
    assert.ok(afterRules.workers.filter((worker) => worker.state !== 'closed')
      .every((worker) => worker.state === 'needs_ack'));
    const dAfterRules = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerD.workerId,
    });
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerD.workerId,
      state: 'running',
      revision: dAfterRules.revision,
    }), 'ACK_REQUIRED');
    const dAck = await store.call('worker_ack', {
      projectId: project.id,
      workerId: workerD.workerId,
      revision: dAfterRules.revision,
    });
    assert.equal(dAck.state, 'ready');
    assert.equal(dAck.requirementsVersion, 2);
    check('规则更新增加需求版本并强制 needs_ack，确认后恢复 ready');

    const dFailed = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerD.workerId,
      state: 'failed',
      summary: '第一次失败',
      revision: dAck.revision,
    });
    const dRetry = await store.call('worker_retry', {
      projectId: project.id,
      workerId: workerD.workerId,
      revision: dFailed.revision,
    });
    assert.equal(dRetry.retryCount, 1);
    const dFailedAgain = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerD.workerId,
      state: 'failed',
      summary: '再次失败',
      revision: dRetry.revision,
    });
    await expectCode(() => store.call('worker_retry', {
      projectId: project.id,
      workerId: workerD.workerId,
      revision: dFailedAgain.revision,
    }), 'RETRY_LIMIT');
    check('重试次数受项目上限约束');

    const bAfterRules = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerB.workerId,
    });
    const bAck = await store.call('worker_ack', {
      projectId: project.id,
      workerId: workerB.workerId,
      revision: bAfterRules.revision,
    });
    const bFailed = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerB.workerId,
      state: 'failed',
      summary: '释放文件后等待其他执行者认领',
      revision: bAck.revision,
    });
    const workerE = await store.call('worker_save', {
      projectId: project.id,
      name: '执行者 E',
      role: 'backend',
      scope: '重新认领文件',
      files: ['src/b.mjs'],
      task: '认领释放文件',
      acceptance: '归属检查生效',
      dependencies: [],
    });
    await expectCode(() => store.call('worker_state', {
      projectId: project.id,
      workerId: workerB.workerId,
      state: 'ready',
      revision: bFailed.revision,
    }), 'FILE_CONFLICT');
    await expectCode(() => store.call('worker_save', {
      projectId: project.id,
      id: workerB.workerId,
      task: '尝试用任务修改绕过冲突',
      acceptance: '不应绕过',
      revision: bFailed.revision,
    }), 'FILE_CONFLICT');
    check('worker_state 和 worker_save 从非活动态恢复时都会重查文件归属');

    const cAfterRules = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerC.workerId,
    });
    const cAck = await store.call('worker_ack', {
      projectId: project.id,
      workerId: workerC.workerId,
      revision: cAfterRules.revision,
    });
    const cFailed = await store.call('worker_state', {
      projectId: project.id,
      workerId: workerC.workerId,
      state: 'failed',
      summary: '重新打开前释放文件',
      revision: cAck.revision,
    });
    const workerF = await store.call('worker_save', {
      projectId: project.id,
      name: '执行者 F',
      role: 'review',
      scope: '认领重开文件',
      files: ['src/c.mjs'],
      task: '认领已释放文件',
      acceptance: '重开冲突被拒绝',
      dependencies: [],
    });
    await expectCode(() => store.call('worker_reopen', {
      projectId: project.id,
      workerId: workerC.workerId,
      revision: cFailed.revision,
    }), 'FILE_CONFLICT');
    check('worker_reopen 也会在进入活动态时重查文件归属');

    const messageOne = await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerB.workerId,
      kind: 'delta',
      body: '第一段增量',
      refs: ['src/b.mjs'],
      requestId: 'incremental-1',
    });
    const messageDuplicate = await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerB.workerId,
      kind: 'delta',
      body: '第一段增量',
      refs: ['src/b.mjs'],
      requestId: 'incremental-1',
    });
    assert.equal(messageDuplicate.id, messageOne.id);
    assert.equal(messageDuplicate.duplicate, true);
    await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerB.workerId,
      kind: 'blocker',
      body: '第二段增量',
      refs: [],
      requestId: 'incremental-2',
    });
    const firstRead = await store.call('messages_read', {
      projectId: project.id,
      workerId: workerB.workerId,
      limit: 1,
    });
    assert.equal(firstRead.messages.length, 1);
    assert.equal(firstRead.unread, 1);
    const secondRead = await store.call('messages_read', {
      projectId: project.id,
      workerId: workerB.workerId,
      after: firstRead.cursor,
      limit: 1,
    });
    assert.equal(secondRead.messages.length, 1);
    assert.notEqual(secondRead.messages[0].id, firstRead.messages[0].id);
    assert.equal(secondRead.unread, 0);
    await expectCode(() => store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerB.workerId,
      kind: 'delta',
      body: 'x'.repeat(12_001),
      refs: [],
    }), 'INVALID_ARGUMENT');
    await store.call('decision_add', {
      projectId: project.id,
      text: '完成态以实际日志 hash 为准。',
      refs: [logA],
    });
    check('消息按游标增量读取、requestId 幂等且正文有上限');

    const workerG = await store.call('worker_save', {
      projectId: project.id,
      name: '协议执行者',
      role: 'protocol',
      scope: '状态、envelope、预算与原文',
      files: ['protocol/**'],
      task: `协议完整任务-${'T'.repeat(4000)}`,
      acceptance: `协议完整验收-${'A'.repeat(2000)}`,
      dependencies: [],
      sessionId: 'thread-protocol-store',
    });
    const statusBefore = await store.call('worker_status', {
      projectId: project.id,
      workerId: workerG.workerId,
    });
    assert.equal(statusBefore.refreshRequired, false);
    assert.equal(statusBefore.sessionBound, true);
    const fullTask = await store.call('worker_get', {
      projectId: project.id,
      workerId: workerG.workerId,
    });
    assert.equal(fullTask.worker.task, `协议完整任务-${'T'.repeat(4000)}`);
    const changedTask = await store.call('worker_save', {
      projectId: project.id,
      id: workerG.workerId,
      task: '协议任务版本 2',
      acceptance: '协议验收版本 2',
      revision: fullTask.revision,
    });
    const statusAfter = await store.call('worker_status', {
      projectId: project.id,
      workerId: workerG.workerId,
    });
    assert.equal(changedTask.taskVersion, 2);
    assert.equal(statusAfter.taskChanged, true);
    assert.equal(statusAfter.requiresFullTask, true);
    await store.call('worker_ack', {
      projectId: project.id,
      workerId: workerG.workerId,
      revision: changedTask.revision,
    });
    check('首次完整任务、后续 status 与任务版本变化重取要求');

    const oldMessage = await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerG.workerId,
      kind: 'delta',
      body: '旧格式消息仍可读',
      requestId: 'protocol-old',
    });
    assert.equal(oldMessage.notification.bodyIncluded, false);
    const largeBody = `大消息-${'L'.repeat(3000)}`;
    const largeMessage = await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerG.workerId,
      kind: 'delta',
      body: largeBody,
      requestId: 'protocol-large',
    });
    const envelopeMessage = await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerG.workerId,
      envelope: {
        v: 1,
        type: 'blocker',
        summary: '需要授权',
        block: { code: 'AUTH', message: '缺少权限', needs: '用户确认' },
      },
      refs: ['project:auth'],
      requestId: 'protocol-envelope',
    });
    assert.equal(envelopeMessage.version, 1);
    const duplicateEnvelope = await store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerG.workerId,
      envelope: {
        v: 1,
        type: 'blocker',
        summary: '需要授权',
        block: { code: 'AUTH', message: '缺少权限', needs: '用户确认' },
      },
      refs: ['project:auth'],
      requestId: 'protocol-envelope',
    });
    assert.equal(duplicateEnvelope.duplicate, true);
    await expectCode(() => store.call('message_send', {
      projectId: project.id,
      from: 'orchestrator',
      to: workerG.workerId,
      envelope: { v: 1, type: 'delta', summary: '不同内容' },
      requestId: 'protocol-envelope',
    }), 'REQUEST_CONFLICT');
    const firstPage = await store.call('messages_read', {
      projectId: project.id,
      workerId: workerG.workerId,
      limit: 1,
      maxChars: 1200,
      detail: 'summary',
    });
    assert.equal(firstPage.messages[0].body, '旧格式消息仍可读');
    assert.equal(firstPage.hasMore, true);
    const secondPage = await store.call('messages_read', {
      projectId: project.id,
      workerId: workerG.workerId,
      after: firstPage.cursor,
      limit: 1,
      maxChars: 1200,
      detail: 'summary',
    });
    assert.equal(secondPage.messages[0].truncated, true);
    assert.equal(secondPage.messages[0].originalAvailable, true);
    assert.equal(secondPage.page.budgetExceeded, true);
    const original = await store.call('message_get', {
      projectId: project.id,
      workerId: workerG.workerId,
      messageId: largeMessage.id,
    });
    assert.equal(original.message.body, largeBody);
    const thirdPage = await store.call('messages_read', {
      projectId: project.id,
      workerId: workerG.workerId,
      after: secondPage.cursor,
      limit: 1,
      maxChars: 1200,
      detail: 'summary',
    });
    assert.equal(thirdPage.messages[0].kind, 'blocker');
    assert.match(thirdPage.messages[0].body, /缺少权限/);
    check('envelope、旧 body、幂等冲突、预算分页、阻塞保留与按需原文');

    await store.close();
    store = undefined;
    await fs.unlink(path.join(projectRoot, '.codex-factory', 'project.json')).catch(() => {});
    await fs.unlink(path.join(projectRoot, '.codex-factory', 'project.json.bak')).catch(() => {});
    store = await createStore({ dataDir, modelSettings });
    const recovered = await store.call('project_get', { projectId: project.id });
    assert.equal(recovered.workers.length, 7);
    assert.equal(recovered.evidence.length, 3);
    assert.equal(recovered.messages.length, 5);
    assert.equal(recovered.recovery.source, 'dataDir-mirror');
    assert.ok(await exists(path.join(projectRoot, '.codex-factory', 'project.json')));
    check('项目主文件丢失时从数据目录镜像恢复并重建主副本');

    const readyA = path.join(base, 'race-a.ready');
    const readyB = path.join(base, 'race-b.ready');
    const go = path.join(base, 'race.go');
    const raceBase = {
      mode: 'revision-race',
      dataDir,
      projectId: project.id,
      goPath: go,
    };
    const raceA = runChild(childScript, {
      ...raceBase,
      name: '并发更新 A',
      readyPath: readyA,
    });
    const raceB = runChild(childScript, {
      ...raceBase,
      name: '并发更新 B',
      readyPath: readyB,
    });
    await waitForFiles([readyA, readyB]);
    await fs.writeFile(go, 'go', 'utf8');
    const raceResults = await Promise.all([raceA, raceB]);
    assert.equal(raceResults.filter((result) => result.ok).length, 1);
    assert.equal(raceResults.filter((result) => result.code === 'REVISION_CONFLICT').length, 1);
    const afterRace = await store.call('project_get', { projectId: project.id });
    assert.equal(afterRace.revision, recovered.revision + 1);
    check('两个进程持有同一 revision 时仅一个提交，另一个明确冲突');

    const beforeMessages = afterRace.messages.length;
    const messageChildren = await Promise.all(
      Array.from({ length: 6 }, (_, index) => runChild(childScript, {
        mode: 'message',
        dataDir,
        projectId: project.id,
        to: workerB.workerId,
        body: `跨进程消息 ${index}`,
        requestId: `cross-process-${index}`,
      })),
    );
    assert.ok(messageChildren.every((result) => result.ok));
    assert.equal(new Set(messageChildren.map((result) => result.sequence)).size, 6);
    const afterChildren = await store.call('project_get', { projectId: project.id });
    assert.equal(afterChildren.messages.length, beforeMessages + 6);
    check('跨进程并发写消息没有丢失或重复序列');

    const coordinatorRoot = path.join(base, 'coordinator-project');
    await fs.mkdir(coordinatorRoot, { recursive: true });
    const coordinatorProject = await store.call('project_save', {
      name: '协调助手验证',
      root: coordinatorRoot,
      requirements: '验证长任务协调的最小状态与线程边界。',
      rules: '协调助手只有一层，只监控授权目标。',
      maxRetries: 1,
    });
    assert.equal(coordinatorProject.coordinator.enabled, false);
    assert.equal(coordinatorProject.coordinator.status, 'off');
    const target = await store.call('worker_save', {
      projectId: coordinatorProject.id,
      name: '目标执行者',
      role: 'implementation',
      scope: '执行长任务',
      files: ['src/coordinator-target.mjs'],
      task: '完成长任务实现。',
      acceptance: '测试通过。',
      dependencies: [],
      sessionId: 'thread-target-real',
    });
    const beforeCoordinatorEnable = await store.call('project_get', {
      projectId: coordinatorProject.id,
    });
    const enabledCoordinator = await store.call('coordinator_control', {
      projectId: coordinatorProject.id,
      op: 'enable',
      revision: beforeCoordinatorEnable.revision,
      targetWorkerIds: [target.workerId],
      authorizedRecipients: [target.workerId, 'orchestrator'],
      generalScope: '汇总进展、提醒依赖并请求原执行者有限返修。',
      waitSeconds: 10,
    });
    assert.equal(enabledCoordinator.enabled, true);
    assert.equal(enabledCoordinator.status, 'waiting_binding');
    assert.equal(enabledCoordinator.sessionBound, false);
    assert.equal(enabledCoordinator.sessionLive, false);
    const coordinatorProjectState = await store.call('project_get', {
      projectId: coordinatorProject.id,
    });
    assert.equal(coordinatorProjectState.workers.filter(
      (worker) => worker.roleKind === 'coordinator',
    ).length, 1);
    await expectCode(() => store.call('worker_save', {
      projectId: coordinatorProject.id,
      name: '第二个协调',
      role: '长任务协调',
      roleKind: 'coordinator',
      scope: '不应创建',
      files: [],
      task: '不应创建第二个协调助手。',
      acceptance: '单实例限制生效。',
      dependencies: [],
    }), 'COORDINATOR_EXISTS');
    check('协调助手默认关闭、按需创建且项目内单实例');

    const coordinatorWorker = coordinatorProjectState.workers.find(
      (worker) => worker.roleKind === 'coordinator',
    );
    await expectCode(() => store.call('coordinator_control', {
      projectId: coordinatorProject.id,
      op: 'start',
      revision: coordinatorProjectState.revision,
    }), 'COORDINATOR_SESSION_REQUIRED');
    const bound = await store.call('worker_save', {
      projectId: coordinatorProject.id,
      id: coordinatorWorker.id,
      name: coordinatorWorker.name,
      role: coordinatorWorker.role,
      roleKind: 'coordinator',
      scope: coordinatorWorker.scope,
      files: [],
      task: coordinatorWorker.task,
      acceptance: coordinatorWorker.acceptance,
      dependencies: [],
      sessionId: 'thread-coordinator-real',
      revision: coordinatorWorker.revision,
    });
    const ackedCoordinator = await store.call('worker_ack', {
      projectId: coordinatorProject.id,
      workerId: bound.workerId,
      revision: bound.revision,
    });
    const projectBeforeStart = await store.call('project_get', {
      projectId: coordinatorProject.id,
    });
    const started = await store.call('coordinator_control', {
      projectId: coordinatorProject.id,
      op: 'start',
      revision: projectBeforeStart.revision,
    });
    assert.equal(started.status, 'monitoring');
    assert.equal(started.sessionLive, false);
    assert.equal(started.targetRefs[0].sessionId, 'thread-target-real');
    const primaryPath = path.join(coordinatorRoot, '.codex-factory', 'project.json');
    const mirrorPath = path.join(dataDir, 'projects', `${coordinatorProject.id}.json`);
    const primary = JSON.parse(await fs.readFile(primaryPath, 'utf8'));
    const mirror = JSON.parse(await fs.readFile(mirrorPath, 'utf8'));
    const staleAt = new Date(Date.now() - 60_000).toISOString();
    for (const record of [primary, mirror]) {
      record.coordinator.lastHeartbeatAt = staleAt;
      record.updatedAt = new Date().toISOString();
    }
    await Promise.all([
      fs.writeFile(primaryPath, `${JSON.stringify(primary, null, 2)}\n`, 'utf8'),
      fs.writeFile(mirrorPath, `${JSON.stringify(mirror, null, 2)}\n`, 'utf8'),
    ]);
    const stale = await store.call('coordinator_control', {
      projectId: coordinatorProject.id,
      op: 'get',
    });
    assert.equal(stale.status, 'monitoring');
    assert.equal(stale.sessionLive, false);
    assert.equal(stale.stale, true);
    check('协调启动必须绑定真实线程，旧心跳只显示待核实而非 live');

    const stopping = await store.call('coordinator_control', {
      projectId: coordinatorProject.id,
      op: 'request_stop',
      revision: stale.projectRevision,
      reason: '验证停止请求',
    });
    assert.equal(stopping.status, 'stopping');
    assert.equal(stopping.enabled, false);
    const stopped = await store.call('coordinator_control', {
      projectId: coordinatorProject.id,
      op: 'stop',
      revision: stopping.projectRevision,
      reason: '宿主已确认停止',
    });
    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.sessionLive, false);
    check('停止先请求宿主、确认后才进入 stopped');

    const dispatchRoot = path.join(base, 'dispatch-project');
    await fs.mkdir(dispatchRoot, { recursive: true });
    const dispatchProject = await store.call('project_save', {
      name: '派发参数验证项目',
      root: dispatchRoot,
      requirements: '只验证派发参数。',
      rules: '执行者只有一层。',
      maxRetries: 2,
    });
    const dispatchWorker = await store.call('worker_save', {
      projectId: dispatchProject.id,
      name: '派发验证工作对话',
      role: '实现',
      scope: '验证 prepare/record。',
      files: ['src/**'],
      task: '完成派发参数验证。',
      acceptance: '缺字段拒绝、重试保参、模型归因待核实。',
      dependencies: [],
    });
    const dispatchTarget = { type: 'projectless', directoryName: 'dispatch-project' };
    await expectCode(() => store.call('dispatch_prepare', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
      prompt: '',
      target: dispatchTarget,
    }), 'DISPATCH_INCOMPLETE');
    await expectCode(() => store.call('dispatch_prepare', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
    }), 'DISPATCH_INCOMPLETE');
    const prepared = await store.call('dispatch_prepare', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
      target: dispatchTarget,
    });
    assert.equal(prepared.launch.model, 'alpha');
    assert.equal(prepared.launch.modelSource, 'auto');
    assert.equal(prepared.launch.effort, 'high');
    assert.equal(prepared.launch.effortField, 'thinking');
    assert.match(prepared.launch.prompt, /完成派发参数验证/);
    assert.equal(prepared.launch.promptChars, prepared.launch.prompt.length);
    const schemaRetry = await store.call('dispatch_record', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
      phase: 'schema_error',
      launchId: prepared.launch.id,
      errorCode: 'SCHEMA',
      errorMessage: '缺少字段',
    });
    assert.equal(schemaRetry.launch.id, prepared.launch.id);
    assert.equal(schemaRetry.launch.model, 'alpha');
    assert.equal(schemaRetry.launch.effort, 'high');
    assert.equal(schemaRetry.launch.prompt, prepared.launch.prompt);
    assert.equal(schemaRetry.launch.attempts, 1);
    const reported = await store.call('dispatch_record', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
      phase: 'host_report',
      launchId: prepared.launch.id,
      hostReportedModel: 'beta',
      hostReportSource: 'host_tool_result',
    });
    assert.equal(reported.launch.hostReport.model, 'beta');
    assert.equal(reported.launch.hostReportStatus, 'unverified');
    assert.equal(reported.launch.modelMismatch, true);
    assert.equal(reported.assignedModel, null);
    assert.equal(reported.assignedModelStatus, 'none');
    await expectCode(() => store.call('worker_save', {
      projectId: dispatchProject.id,
      id: dispatchWorker.workerId,
      assignedModel: 'beta',
      revision: reported.revision,
    }), 'ASSIGNED_MODEL_READ_ONLY');
    const sessionChanged = await store.call('worker_save', {
      projectId: dispatchProject.id,
      id: dispatchWorker.workerId,
      sessionId: 'thread-dispatch-new',
      revision: reported.revision,
    });
    assert.equal(sessionChanged.launch, null);
    assert.equal(sessionChanged.assignedModel, null);
    const preparedAgain = await store.call('dispatch_prepare', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
      target: dispatchTarget,
    });
    const taskChanged = await store.call('worker_save', {
      projectId: dispatchProject.id,
      id: dispatchWorker.workerId,
      task: '完成派发参数验证（新版本）。',
      revision: preparedAgain.revision,
    });
    assert.equal(taskChanged.launch, null);
    assert.equal(taskChanged.taskVersion, 2);
    const betaWorker = await store.call('worker_save', {
      projectId: dispatchProject.id,
      name: '禁用模型工作对话',
      role: '实现',
      scope: '验证禁用模型不默认回退。',
      files: ['beta/**'],
      task: '验证禁用模型。',
      acceptance: 'prepare 拒绝。',
      dependencies: [],
      model: 'beta',
    });
    await expectCode(() => store.call('dispatch_prepare', {
      projectId: dispatchProject.id,
      workerId: betaWorker.workerId,
      target: dispatchTarget,
    }), 'MODEL_NOT_ALLOWED');
    dispatchModelEnabled = false;
    await expectCode(() => store.call('dispatch_prepare', {
      projectId: dispatchProject.id,
      workerId: dispatchWorker.workerId,
      target: dispatchTarget,
    }), 'DISPATCH_INCOMPLETE');
    dispatchModelEnabled = true;
    check('prepare 缺 prompt/model 拒绝、auto 解析、schema 重试保参、宿主报告待核实、换 session 失效');

    const globRoot = path.join(base, 'glob-project');
    await fs.mkdir(globRoot, { recursive: true });
    const globProject = await store.call('project_save', {
      name: '文件归属前缀验证',
      root: globRoot,
      requirements: '验证 glob 重叠。',
      rules: '真正重叠才拒绝。',
      maxRetries: 1,
    });
    const frontend = await store.call('worker_save', {
      projectId: globProject.id,
      name: '前端',
      role: 'frontend',
      scope: 'logs/frontend*',
      files: ['logs/frontend*'],
      task: '实现前端日志。',
      acceptance: '可创建。',
      dependencies: [],
    });
    const backend = await store.call('worker_save', {
      projectId: globProject.id,
      name: '后端',
      role: 'backend',
      scope: 'logs/backend*',
      files: ['logs/backend*'],
      task: '实现后端日志。',
      acceptance: '不同前缀不冲突。',
      dependencies: [],
    });
    assert.ok(frontend.workerId);
    assert.ok(backend.workerId);
    await expectCode(() => store.call('worker_save', {
      projectId: globProject.id,
      name: '前端日志',
      role: 'frontend',
      scope: '真正重叠',
      files: ['logs/frontend.js'],
      task: '制造真实重叠。',
      acceptance: '应拒绝。',
      dependencies: [],
    }), 'FILE_CONFLICT');
    await expectCode(() => store.call('worker_save', {
      projectId: globProject.id,
      name: '全部日志',
      role: 'ops',
      scope: '目录级重叠',
      files: ['logs/**'],
      task: '制造目录重叠。',
      acceptance: '应拒绝。',
      dependencies: [],
    }), 'FILE_CONFLICT');
    check('不同 glob 前缀不误判冲突，真正重叠仍拒绝');

    await store.call('worker_save', {
      projectId: globProject.id,
      name: '前缀通配 A',
      role: 'a',
      scope: 'a*',
      files: ['a*'],
      task: '验证通配交集。',
      acceptance: '与 *b 必须冲突。',
      dependencies: [],
    });
    await expectCode(() => store.call('worker_save', {
      projectId: globProject.id,
      name: '前缀通配 B',
      role: 'b',
      scope: '*b',
      files: ['*b'],
      task: '验证通配交集。',
      acceptance: 'a* 与 *b 在 ab 上重叠。',
      dependencies: [],
    }), 'FILE_CONFLICT');
    await store.call('worker_save', {
      projectId: globProject.id,
      name: '目录归属',
      role: 'dir',
      scope: 'src',
      files: ['src'],
      task: '验证目录归属。',
      acceptance: 'src/file 必须冲突。',
      dependencies: [],
    });
    await expectCode(() => store.call('worker_save', {
      projectId: globProject.id,
      name: '目录子文件',
      role: 'dir',
      scope: 'src/file',
      files: ['src/file'],
      task: '验证目录子文件。',
      acceptance: '必须与 src 冲突。',
      dependencies: [],
    }), 'FILE_CONFLICT');
    await store.call('worker_save', {
      projectId: globProject.id,
      name: '通配目录',
      role: 'tree',
      scope: 'tree/**',
      files: ['tree/**'],
      task: '验证通配目录。',
      acceptance: 'tree/leaf.js 必须冲突。',
      dependencies: [],
    });
    await expectCode(() => store.call('worker_save', {
      projectId: globProject.id,
      name: '通配目录子文件',
      role: 'tree',
      scope: 'tree/leaf.js',
      files: ['tree/leaf.js'],
      task: '验证通配目录子文件。',
      acceptance: '必须与 tree/** 冲突。',
      dependencies: [],
    }), 'FILE_CONFLICT');
    await store.call('worker_save', {
      projectId: globProject.id,
      name: '不同普通目录',
      role: 'other',
      scope: 'src2/file',
      files: ['src2/file'],
      task: '验证普通路径不误判。',
      acceptance: 'src 与 src2/file 不冲突。',
      dependencies: [],
    });
    check('a* 与 *b 保守冲突、plain 目录与子文件冲突、tree/** 与子文件冲突、不同普通目录放行');

    const missingRoot = path.join(base, 'missing-root');
    const missingRootError = await expectCode(() => store.call('project_save', {
      name: '缺失根目录',
      root: missingRoot,
      requirements: '默认不创建。',
      rules: '必须显式初始化。',
      maxRetries: 1,
    }), 'INVALID_ARGUMENT');
    assert.equal(missingRootError.details?.canCreate, true);
    assert.match(missingRootError.message, /createRoot=true/);
    assert.equal(await exists(missingRoot), false);
    await expectCode(() => store.call('project_save', {
      name: '缺失父目录',
      root: path.join(base, 'no-parent', 'nested-root'),
      requirements: '不递归创建。',
      rules: '父目录缺失应拒绝。',
      maxRetries: 1,
      createRoot: true,
    }), 'INVALID_ARGUMENT');
    assert.equal(await exists(path.join(base, 'no-parent')), false);
    const createdRoot = path.join(base, 'explicit-root');
    const createdProject = await store.call('project_save', {
      name: '显式根目录',
      root: createdRoot,
      requirements: '仅创建最后一级。',
      rules: 'createRoot=true 可用。',
      maxRetries: 1,
      createRoot: true,
    });
    assert.ok(createdProject.id);
    assert.equal(await exists(createdRoot), true);
    check('项目根缺失默认拒绝并可操作提示，显式 createRoot 仅创建最后一级');

    const partial = await store.call('worker_save', {
      projectId: globProject.id,
      workerId: frontend.workerId,
      sessionId: 'thread-partial-update',
      model: 'auto',
      revision: frontend.revision,
    });
    assert.equal(partial.sessionId, 'thread-partial-update');
    const partialRecord = await store.call('worker_get', {
      projectId: globProject.id,
      workerId: frontend.workerId,
    });
    const partialWorker = partialRecord.worker;
    assert.equal(partialWorker.name, '前端');
    assert.equal(partialWorker.role, 'frontend');
    assert.equal(partialWorker.task, '实现前端日志。');
    assert.deepEqual(partialWorker.files, ['logs/frontend*']);
    await expectCode(() => store.call('worker_save', {
      projectId: globProject.id,
      id: frontend.workerId,
      workerId: backend.workerId,
      revision: partial.revision,
    }), 'INVALID_ARGUMENT');
    check('worker_save 支持 workerId 别名、部分更新不清空字段、冲突别名拒绝');

    const staleLock = path.join(dataDir, '.store.lock');
    await fs.mkdir(staleLock, { recursive: true });
    await fs.writeFile(path.join(staleLock, 'owner.json'), JSON.stringify({
      pid: 999_999_999,
      token: 'stale-test',
      startedAt: new Date(0).toISOString(),
    }), 'utf8');
    await store.call('overview');
    assert.equal(await exists(staleLock), false);
    check('进程已死亡的陈旧锁可自动恢复');

    const artifact = path.join(projectRoot, 'dist', 'result.txt');
    await fs.mkdir(path.dirname(artifact), { recursive: true });
    await fs.writeFile(artifact, 'preserved output\n', 'utf8');
    const closeResult = await store.call('project_close', { projectId: project.id });
    assert.equal(closeResult.closed, true);
    const secondClose = await store.call('project_close', { projectId: project.id });
    assert.equal(secondClose.closed, true);
    assert.equal(await fs.readFile(artifact, 'utf8'), 'preserved output\n');
    const closedProject = await store.call('project_get', { projectId: project.id });
    assert.equal(closedProject.status, 'closed');
    assert.ok(await exists(path.join(projectRoot, '.codex-factory', 'project.json')));
    await expectCode(() => store.call('decision_add', {
      projectId: project.id,
      text: '关闭后不应再写入',
    }), 'PROJECT_CLOSED');
    check('项目关闭幂等、禁止后续写入且不删除成果');

    await store.close();
    const dispatchPrimary = path.join(dispatchRoot, '.codex-factory', 'project.json');
    const legacyProjectFile = JSON.parse(await fs.readFile(dispatchPrimary, 'utf8'));
    const legacyWorkerFile = legacyProjectFile.workers.find(
      (worker) => worker.id === dispatchWorker.workerId,
    );
    legacyWorkerFile.assignedModel = 'legacy-model';
    delete legacyWorkerFile.assignedModelStatus;
    delete legacyWorkerFile.assignedModelSource;
    await fs.writeFile(dispatchPrimary, `${JSON.stringify(legacyProjectFile, null, 2)}\n`, 'utf8');
    store = await createStore({ dataDir, modelSettings });
    const afterRestart = await store.call('project_get', { projectId: project.id });
    assert.equal(afterRestart.status, 'closed');
    assert.equal(afterRestart.workers.length, 7);
    const legacyProject = await store.call('project_get', { projectId: dispatchProject.id });
    const legacyWorker = legacyProject.workers.find(
      (worker) => worker.id === dispatchWorker.workerId,
    );
    assert.equal(legacyWorker.assignedModel, 'legacy-model');
    assert.equal(legacyWorker.assignedModelStatus, 'legacy_unverified');
    assert.equal(legacyWorker.assignedModelSource, 'legacy');
    const legacyCleared = await store.call('worker_save', {
      projectId: dispatchProject.id,
      id: legacyWorker.id,
      sessionId: 'thread-legacy-new',
      revision: legacyWorker.revision,
    });
    assert.equal(legacyCleared.assignedModel, null);
    assert.equal(legacyCleared.assignedModelStatus, 'none');
    await store.close();
    store = undefined;
    check('旧 assignedModel 归一化为历史未核实，换 session 后清空');
    check('关闭项目在 store 重启后仍保留完整记录');

    const report = {
      ok: true,
      checkedAt: new Date().toISOString(),
      node: process.version,
      projectId: project.id,
      dataDir,
      checks,
      summary: {
        checks: checks.length,
        workers: afterRestart.workers.length,
        evidence: afterRestart.evidence.length,
        messages: afterRestart.messages.length,
        finalRevision: afterRestart.revision,
      },
    };
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      record: path.relative(rootDir, recordPath),
      checks: checks.length,
      summary: report.summary,
    }, null, 2));
  } finally {
    if (store) await store.close().catch(() => {});
    assertContainedTemp(base);
    await fs.rm(base, { recursive: true, force: true });
  }
}

await main();
