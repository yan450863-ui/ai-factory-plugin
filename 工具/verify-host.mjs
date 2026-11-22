import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(toolDir);
const codex = process.env.CODEX_FACTORY_CODEX_BIN || 'codex';
const useProxy = process.argv.includes('--proxy');
const reload = process.argv.includes('--reload');
const expectedTools = [
  'factory_panel',
  'factory_panel_tab',
  'factory_ui_read',
  'factory_context',
  'factory_task',
  'factory_message',
  'factory_call',
  'factory_models',
  'factory_models_ui',
  'factory_models_save',
  'factory_models_draft_save',
  'factory_models_draft_clear',
  'factory_coordinator',
];
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const recordPath = path.join(root, '验证', `宿主加载-${stamp}.json`);
const child = spawn(codex, useProxy ? ['app-server', 'proxy'] : [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'mcp_servers.node_repl.enabled=false',
], {
  cwd: root,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let sequence = 0;
let buffer = '';
let stderr = '';
const waiting = new Map();
const finished = new Promise((resolve) => child.once('close', resolve));

function failPending(error) {
  for (const pending of waiting.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  waiting.clear();
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined || !waiting.has(message.id)) continue;
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});
child.on('error', failPending);
child.on('close', (code) => failPending(new Error(`app-server closed: ${code}`)));

function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`超时：${method}`));
    }, 60000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
}

try {
  await request('initialize', {
    clientInfo: {
      name: 'codex_factory_host_verifier',
      title: 'Codex Factory Host Verifier',
      version: '0.4.2',
    },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  if (reload) await request('config/mcpServer/reload', null);
  const result = await request('mcpServerStatus/list', { limit: 100 });
  const servers = result.data || result.servers || [];
  const matches = servers.filter((item) => {
    const name = item.name || item.serverName || '';
    return name === 'codex_factory' || name.endsWith('/codex_factory');
  });
  assert.equal(matches.length, 1, '宿主必须加载且只加载一个 codex_factory');
  const server = matches[0];
  assert.notEqual(server.status, 'failed', 'codex_factory MCP 启动失败');
  const tools = server.tools || {};
  for (const name of expectedTools) {
    assert.ok(tools[name], `宿主缺少工具 ${name}`);
  }
  assert.equal(Object.keys(tools).length, expectedTools.length, '宿主工具数量必须为 13');
  const globalEntry = tools.factory_panel?._meta?.['openai/ui']?.entrypoints
    ?.some((entry) => entry.type === 'global');
  const threadEntry = tools.factory_panel_tab?._meta?.['openai/ui']?.entrypoints
    ?.some((entry) => entry.type === 'thread');
  assert.ok(globalEntry, 'factory_panel 缺少 global 入口');
  assert.ok(threadEntry, 'factory_panel_tab 缺少 thread 入口');

  const skillSnapshots = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const skillResult = await request('skills/list', {
      cwds: [root],
      forceReload: true,
    });
    const entries = skillResult.data || [];
    const entry = entries.find((item) => path.resolve(item.cwd) === path.resolve(root))
      || entries[0];
    assert.ok(entry, 'skills/list 未返回当前工作目录');
    const skills = entry.skills || [];
    const factoryTeam = skills.filter((item) => (
      item.name === 'factory-team' || item.name === 'codex-factory:factory-team'
    ));
    const factoryCoordinator = skills.filter((item) => (
      item.name === 'factory-coordinator' || item.name === 'codex-factory:factory-coordinator'
    ));
    const legacyTeam = skills.filter((item) => (
      item.name === 'model-team-active' || item.name.endsWith(':model-team-active')
    ));
    const skillNames = skills.map((item) => item.name).join(', ');
    assert.equal(factoryTeam.length, 1, `factory-team 必须恰好存在一次；实际技能：${skillNames}`);
    assert.equal(
      factoryCoordinator.length,
      1,
      `factory-coordinator 必须恰好存在一次；实际技能：${skillNames}`,
    );
    assert.equal(legacyTeam.length, 0, '退役的 model-team-active 不得重新出现');
    assert.equal(factoryTeam[0].enabled, true, 'factory-team 必须已启用');
    assert.equal(factoryCoordinator[0].enabled, true, 'factory-coordinator 必须已启用');
    skillSnapshots.push({
      cwd: entry.cwd,
      errors: entry.errors,
      factoryTeam: factoryTeam.map((item) => ({
        name: item.name,
        enabled: item.enabled,
        path: item.path,
        pluginId: item.pluginId ?? null,
      })),
      factoryCoordinator: factoryCoordinator.map((item) => ({
        name: item.name,
        enabled: item.enabled,
        path: item.path,
        pluginId: item.pluginId ?? null,
      })),
      legacyTeamCount: legacyTeam.length,
    });
  }

  const report = {
    checkedAt: new Date().toISOString(),
    codex,
    mode: useProxy ? 'proxy' : 'isolated',
    reloaded: reload,
    matches: matches.map((item) => ({
      name: item.name || item.serverName,
      status: item.status,
      toolNames: Object.keys(item.tools || {}),
    })),
    skillSnapshots,
    allServers: servers.map((item) => ({
      name: item.name || item.serverName,
      status: item.status,
      toolCount: Object.keys(item.tools || {}).length,
    })),
    stderr: stderr
      .split('\n')
      .filter((line) => /codex.factor|error|failed/i.test(line))
      .map((line) => line.slice(0, 1000)),
  };
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    record: path.relative(root, recordPath),
    matches: report.matches,
  }, null, 2));
} finally {
  child.stdin.end();
  await Promise.race([finished, new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (child.exitCode === null) child.kill();
}
