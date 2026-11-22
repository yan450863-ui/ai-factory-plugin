import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  dependencyNodePaths,
  importDependency,
  requireDependency,
} from './dependencies.mjs';
import { createStore } from '../插件市场/plugins/codex-factory/server/store.mjs';

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(toolDir);
const pluginDir = path.join(root, '插件市场', 'plugins', 'codex-factory');
const serverDir = path.join(pluginDir, 'server');
const verifyDir = path.join(root, '验证');
const nodeModules = dependencyNodePaths(toolDir);
const { build } = requireDependency('esbuild', toolDir);
const { Window } = await importDependency('happy-dom', toolDir);
const { parse: parseToml } = await importDependency('smol-toml', toolDir);
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const recordPath = path.join(verifyDir, `ui-${stamp}.json`);

const [html, script, modelPanel, mcp] = await Promise.all([
  fs.readFile(path.join(serverDir, 'panel.html'), 'utf8'),
  fs.readFile(path.join(serverDir, 'panel-app.mjs'), 'utf8'),
  fs.readFile(path.join(serverDir, 'model-panel.mjs'), 'utf8'),
  fs.readFile(path.join(serverDir, 'mcp.mjs'), 'utf8'),
]);

assert.match(html, /\/\* APP_SCRIPT \*\//, 'panel.html 缺少构建占位');
assert.match(html, /<dialog id="projectDialog">/);
assert.match(html, /<dialog id="workerDialog">/);
assert.match(html, /<details id="historyPanel" class="soft-panel">/);
assert.doesNotMatch(html, /<details id="historyPanel"[^>]*\sopen(?:\s|>)/);
assert.match(html, /<details id="morePanel" class="soft-panel">/);
assert.doesNotMatch(html, /<details id="morePanel"[^>]*\sopen(?:\s|>)/);
assert.match(html, /<th>名称<\/th><th>负责什么<\/th><th>当前任务<\/th><th>状态<\/th>/);
assert.match(html, /id="addWorker"[^>]*>添加工作对话<\/button>/);
assert.doesNotMatch(html, />添加执行者</);
assert.match(html, /id="closeWorker"[^>]*>请求关闭<\/button>/);
assert.match(html, /id="modelSettings"[^>]*>模型设置<\/button>/);
assert.match(html, /<dialog id="modelSettingsDialog">/);
assert.match(html, /id="modelKeepInCurrentChat"[^>]*type="checkbox"/);
assert.match(html, /id="modelDisableSubagents"[^>]*type="checkbox"/);
assert.match(html, /id="workerModel"/);
assert.match(html, /id="workerNameModelHint"/);
assert.doesNotMatch(html, /min-width:700px/, '工作对话表不能强制横向滚动');
assert.match(html, /@media\(max-width:700px\)/);
assert.match(html, /@media\(max-width:640px\)/);
assert.match(html, /@media\(max-width:420px\)/);
assert.match(script, /const APP_VERSION = '0\.4\.2'/);
assert.match(html, /id="modeFactory"[^>]*>软件工厂<\/button>/);
assert.match(html, /id="modeTeam"[^>]*>团队<\/button>/);
assert.match(html, /<section id="teamView"/);
assert.match(html, /id="coordinatorToggle"[^>]*>开始跟进<\/button>/);
assert.match(html, /\[hidden\]\{display:none!important\}/);
assert.match(script, /项进行中/);
assert.match(script, /factory_ui_read/, '面板必须通过 app-only 工具读取完整数据');
assert.match(script, /factory_call/, '面板必须通过状态 API 写入');
assert.match(script, /app\.sendMessage/, '按钮必须请求当前宿主对话');
assert.match(script, /一层原生工作对话/, '按钮说明应明确原生工作对话路径');
assert.match(script, /是否仍在运行：未核实/, '面板应区分会话记录与实际运行');
assert.match(script, /停止对应原生任务后再关闭记录/, '关闭请求必须要求先停止原生任务');
assert.match(script, /worker\?\.model|worker\.worker\?\.model/, '工作对话必须读取 model');
assert.match(script, /assignedModel/, '工作对话必须区分实际 assignedModel');
assert.match(script, /请按需读取最新 factory 模式 settings、project_get、worker_get/, '派发请求必须按需读取');
assert.match(modelPanel, /factory_models_ui/);
assert.match(modelPanel, /factory_models_save/);
assert.match(modelPanel, /factory_models_draft_save/);
assert.match(modelPanel, /factory_models_draft_clear/);
assert.match(modelPanel, /keepInCurrentChat/);
assert.match(modelPanel, /disableSubagents/);
assert.doesNotMatch(script, /sessionLive=/, '面板不应向用户暴露技术字段 sessionLive');
assert.doesNotMatch(script, /updateModelContext/, '面板不应自动把全量数据写入模型上下文');
assert.doesNotMatch(modelPanel, /updateModelContext/, '模型设置不应自动写入主聊天上下文');
assert.doesNotMatch(html, /<script[^>]+src=/i, '面板不应依赖外部脚本');
assert.match(mcp, /factory_ui_read/);
assert.match(mcp, /visibility:\s*\['app'\]/, '完整读取工具必须为 app-only');

const referencedIds = [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds)].filter((id) => !new RegExp(`id=["']${id}["']`).test(html));
assert.deepEqual(missingIds, [], `panel-app 引用了不存在的 DOM id：${missingIds.join(', ')}`);
const allIds = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
const duplicateIds = [...new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))];
assert.deepEqual(duplicateIds, [], `panel.html 存在重复 DOM id：${duplicateIds.join(', ')}`);

const result = await build({
  entryPoints: [path.join(serverDir, 'panel-app.mjs')],
  bundle: true,
  write: false,
  external: ['@modelcontextprotocol/ext-apps'],
  nodePaths: nodeModules,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: false,
  logLevel: 'silent',
});
const bundled = result.outputFiles[0].text;
assert.ok(bundled.length > 10_000, '面板脚本构建结果异常小');

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

let currentStage = 'setup';
async function until(predicate, label) {
  currentStage = label;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 UI 条件超时：${label}`);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-factory-ui-'));
const projectRoot = path.join(tempRoot, 'project');
const dataDir = path.join(tempRoot, 'data');
const modelDataDir = path.join(tempRoot, 'models');
const modelCodexHome = path.join(tempRoot, 'codex-home');
await fs.mkdir(projectRoot, { recursive: true });
await fs.mkdir(modelCodexHome, { recursive: true });
const modelBundle = await build({
  entryPoints: [path.join(serverDir, 'model-settings.mjs')],
  bundle: true,
  write: false,
  nodePaths: nodeModules,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  logLevel: 'silent',
});
const modelBundlePath = path.join(tempRoot, 'model-settings.test-bundle.mjs');
await fs.writeFile(modelBundlePath, modelBundle.outputFiles[0].text, 'utf8');
const { createModelSettings } = await import(
  `${pathToFileURL(modelBundlePath).href}?v=${Date.now()}`
);

const isolatedCatalog = [
  {
    slug: 'fixture/balanced',
    display_name: 'Balanced Fixture',
    provider: 'fixture',
    supported_reasoning_levels: [],
  },
  {
    slug: 'fixture/frontier',
    display_name: 'Frontier Fixture',
    provider: 'fixture',
    supported_reasoning_levels: ['low', 'medium', 'high'],
    default_reasoning_level: 'high',
  },
  {
    slug: 'fixture/legacy',
    display_name: 'Legacy Fixture',
    provider: 'fixture',
    supported_reasoning_levels: ['low', 'high'],
    default_reasoning_level: 'high',
  },
];
await fs.writeFile(
  path.join(modelCodexHome, 'config.toml'),
  'model_catalog_json = "catalog.json"\n',
  'utf8',
);
await fs.writeFile(
  path.join(modelCodexHome, 'catalog.json'),
  `${JSON.stringify({ models: isolatedCatalog }, null, 2)}\n`,
  'utf8',
);

const actualModelSettings = createModelSettings({
  dataDir: modelDataDir,
  codexHome: modelCodexHome,
  legacyDataDir: null,
  parseToml,
});
const initialModelState = await actualModelSettings.read();
await actualModelSettings.save({
  enabled: true,
  maxAgents: 5,
  keepInCurrentChat: false,
  disableSubagents: true,
  revision: initialModelState.settings.revision,
  models: [
    { id: 'fixture/balanced', enabled: true, effort: '', ability: 3 },
    { id: 'fixture/frontier', enabled: true, effort: 'high', ability: 5 },
    { id: 'fixture/legacy', enabled: false, effort: 'high', ability: 4 },
  ],
});

async function writeCatalog(models) {
  await fs.writeFile(
    path.join(modelCodexHome, 'catalog.json'),
    `${JSON.stringify({ models }, null, 2)}\n`,
    'utf8',
  );
}

async function createModelHarness(modelSettings) {
  let last = null;
  async function sync() {
    last = await modelSettings.read();
    return last;
  }
  await sync();
  return {
    get settings() {
      const value = structuredClone(last.settings);
      return { ...value, ...structuredClone(value.modes.factory) };
    },
    get draft() {
      return structuredClone(last.draft);
    },
    read() {
      return sync();
    },
    async save(input) {
      last = await modelSettings.save(input);
      return last;
    },
    async saveDraft(input) {
      last = await modelSettings.saveDraft(input);
      return last;
    },
    async clearDraft(input) {
      const result = await modelSettings.clearDraft(input);
      await sync();
      return result;
    },
    async forceExternalUpdate() {
      const modes = structuredClone(last.settings.modes);
      modes.factory.maxAgents = 9;
      last = await modelSettings.save({
        ...last.settings,
        modes,
        revision: last.settings.revision,
      });
      return last;
    },
    async seedDraft() {
      const modes = structuredClone(last.settings.modes);
      modes.factory.maxAgents = 7;
      modes.factory.keepInCurrentChat = false;
      modes.factory.disableSubagents = true;
      last = await modelSettings.saveDraft({
        ...last.settings,
        modes,
        draftId: crypto.randomUUID(),
        sequence: 1,
      });
      return structuredClone(last.draft);
    },
  };
}

const modelFixture = await createModelHarness(actualModelSettings);
const store = await createStore({ dataDir, modelSettings: actualModelSettings });
const windows = [];
const executableSource = bundled.replace(
  /import\s*\{[\s\S]*?\}\s*from\s*['"]@modelcontextprotocol\/ext-apps['"];\s*/,
  '',
);
const execute = new (Object.getPrototypeOf(async function () {}).constructor)(
  'document',
  'window',
  'navigator',
  'crypto',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'confirm',
  'App',
  'applyDocumentTheme',
  'applyHostStyleVariables',
  executableSource,
);

async function openPage({ failRead = false, mode = 'factory' } = {}) {
  const window = new Window({
    url: `https://isolated.factory.test/?mode=${encodeURIComponent(mode)}`,
  });
  window.confirm = () => true;
  windows.push(window);
  window.document.write(html.replace(/<script[\s\S]*?<\/script>/, ''));
  const sentMessages = [];
  const toolCalls = [];
  class App {
    async connect() {}
    getHostContext() {
      return { theme: 'light' };
    }
    async callServerTool({ name, arguments: args }) {
      toolCalls.push({ name, action: args.action, arguments: args });
      try {
        if (name === 'factory_ui_read') {
          if (failRead) throw new Error('fixture read unavailable');
          return {
            _meta: { factory: await store.call(args.action, args.args) },
            structuredContent: {},
          };
        }
        if (name === 'factory_call') {
          const data = await store.call(args.action, args.args);
          return {
            content: [{ type: 'text', text: JSON.stringify(data) }],
          };
        }
        if (name === 'factory_models_ui') {
          const data = await modelFixture.read();
          return {
            _meta: { factoryModels: data },
            structuredContent: {
              enabled: data.settings.enabled,
              maxAgents: data.settings.maxAgents,
              keepInCurrentChat: data.settings.keepInCurrentChat,
              disableSubagents: data.settings.disableSubagents,
            },
          };
        }
        if (name === 'factory_models_save') {
          const data = await modelFixture.save(args);
          return {
            _meta: { factoryModels: data },
            structuredContent: {
              enabled: args.enabled,
              maxAgents: args.maxAgents,
              keepInCurrentChat: args.keepInCurrentChat,
              disableSubagents: args.disableSubagents,
            },
          };
        }
        if (name === 'factory_models_draft_save') {
          const data = await modelFixture.saveDraft(args);
          return {
            _meta: { factoryModels: data },
            structuredContent: { stored: data.stored },
          };
        }
        if (name === 'factory_models_draft_clear') {
          const result = await modelFixture.clearDraft(args);
          const data = await modelFixture.read();
          return {
            _meta: { factoryModels: data },
            structuredContent: result,
          };
        }
        throw new Error(`unexpected tool ${name}`);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error.message }],
        };
      }
    }
    async sendMessage(message) {
      sentMessages.push(message);
      return {};
    }
  }
  await execute(
    window.document,
    window,
    window.navigator,
    crypto.webcrypto,
    window.requestAnimationFrame.bind(window),
    window.cancelAnimationFrame.bind(window),
    () => true,
    App,
    () => {},
    () => {},
  );
  window.__toolCalls = toolCalls;
  return { window, document: window.document, sentMessages, toolCalls };
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

function closeDialog(document, id) {
  const dialog = document.getElementById(id);
  if (dialog.open) dialog.close();
}

function rowFor(document, workerId) {
  return document.querySelector(`tr[data-worker-id="${workerId}"]`);
}

function textOf(element) {
  return element?.textContent?.replace(/\s+/g, ' ').trim() || '';
}

async function waitIdle(document, label) {
  await until(() => (
    document.getElementById('status').textContent === '已连接'
    && document.body.getAttribute('aria-busy') === 'false'
  ), label);
}

let interactionChecks = [];
let failure;
try {
  const teamPage = await openPage({ mode: 'team' });
  const teamDocument = teamPage.document;
  await until(
    () => !teamDocument.getElementById('modelSettings').disabled,
    'team initial connect',
  );
  assert.equal(teamDocument.getElementById('teamView').hidden, false, '团队模式必须显示团队页');
  assert.equal(teamDocument.getElementById('factoryShell').hidden, true, '团队模式不得显示工厂外壳');
  assert.equal(
    teamPage.toolCalls.some((call) => (
      call.name === 'factory_ui_read'
      || call.name === 'factory_call'
      || call.action === 'overview'
      || call.action === 'project_get'
    )),
    false,
    '团队初始路径不得读取或写入工厂项目',
  );
  assert.equal(teamPage.sentMessages.length, 0, '团队初始路径不得发送工厂任务');
  interactionChecks.push('团队初始路径只读取模型设置，不读取项目、任务或规则');

  teamDocument.getElementById('modelSettings').click();
  await until(
    () => teamDocument.getElementById('modelSettingsDialog').open,
    'team model settings opens',
  );
  assert.equal(teamDocument.getElementById('modelMaxAgents').value, '5');
  assert.equal(teamDocument.getElementById('modelKeepInCurrentChat').checked, true);
  assert.equal(teamDocument.getElementById('modelDisableSubagents').checked, false);
  const teamRevision = (await modelFixture.read()).settings.revision;
  teamDocument.getElementById('modelMaxAgents').value = '4';
  teamDocument.getElementById('modelMaxAgents').dispatchEvent(
    new teamPage.window.Event('input', { bubbles: true }),
  );
  teamDocument.getElementById('modelKeepInCurrentChat').checked = false;
  teamDocument.getElementById('modelKeepInCurrentChat').dispatchEvent(
    new teamPage.window.Event('change', { bubbles: true }),
  );
  teamDocument.getElementById('modelDisableSubagents').checked = true;
  teamDocument.getElementById('modelDisableSubagents').dispatchEvent(
    new teamPage.window.Event('change', { bubbles: true }),
  );
  submit(teamPage.window, teamDocument.getElementById('modelSettingsForm'));
  await until(
    async () => (await modelFixture.read()).settings.revision === teamRevision + 1,
    'team mode independent save',
  );
  await waitIdle(teamDocument, 'team mode independent save idle');
  const teamSaved = (await modelFixture.read()).settings;
  assert.deepEqual(teamSaved.modes.team, {
    enabled: true,
    maxAgents: 4,
    keepInCurrentChat: false,
    disableSubagents: true,
  });
  assert.deepEqual(teamSaved.modes.factory, {
    enabled: true,
    maxAgents: 5,
    keepInCurrentChat: false,
    disableSubagents: true,
  });
  interactionChecks.push('团队设置独立保存，工厂模式设置保持原值');

  const teamRestoreRevision = teamSaved.revision;
  teamDocument.getElementById('modelMaxAgents').value = '5';
  teamDocument.getElementById('modelMaxAgents').dispatchEvent(
    new teamPage.window.Event('input', { bubbles: true }),
  );
  teamDocument.getElementById('modelKeepInCurrentChat').checked = true;
  teamDocument.getElementById('modelKeepInCurrentChat').dispatchEvent(
    new teamPage.window.Event('change', { bubbles: true }),
  );
  teamDocument.getElementById('modelDisableSubagents').checked = false;
  teamDocument.getElementById('modelDisableSubagents').dispatchEvent(
    new teamPage.window.Event('change', { bubbles: true }),
  );
  submit(teamPage.window, teamDocument.getElementById('modelSettingsForm'));
  await until(
    async () => (await modelFixture.read()).settings.revision === teamRestoreRevision + 1,
    'team mode baseline restore',
  );
  await waitIdle(teamDocument, 'team mode baseline restore idle');
  closeDialog(teamDocument, 'modelSettingsDialog');

  const page = await openPage();
  const { document } = page;
  await until(() => (
    !document.getElementById('newProject').disabled
    && !document.getElementById('modelSettings').disabled
  ), 'initial connect');
  assert.equal(document.getElementById('historyPanel').open, false, '历史默认折叠');
  assert.equal(document.getElementById('morePanel').open, false, '更多默认折叠');
  assert.equal(document.getElementById('workerDialog').open, false, '初始不打开详情');
  assert.equal(document.getElementById('modelSettingsDialog').open, false, '模型设置默认不打开');
  assert.equal(document.getElementById('modelSettings').textContent, '模型设置');
  document.getElementById('modelSettings').click();
  await until(() => document.getElementById('modelSettingsDialog').open, 'model settings opens');
  assert.equal(document.getElementById('modelKeepInCurrentChat').checked, false);
  assert.equal(document.getElementById('modelDisableSubagents').checked, true);
  assert.equal(document.getElementById('modelMaxAgents').value, '5');
  assert.equal(document.querySelectorAll('#modelRows tr[data-model-id]').length, 3);
  assert.match(textOf(document.getElementById('modelSettingsMessage')), /模型设置已读取/);
  interactionChecks.push('模型设置为独立二级弹窗并读取当前可见目录');

  const combinations = [
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ];
  for (const [keep, disable] of combinations) {
    const keepInput = document.getElementById('modelKeepInCurrentChat');
    const disableInput = document.getElementById('modelDisableSubagents');
    keepInput.checked = keep;
    keepInput.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    disableInput.checked = disable;
    disableInput.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    const revision = modelFixture.settings.revision;
    submit(page.window, document.getElementById('modelSettingsForm'));
    await until(() => modelFixture.settings.revision === revision + 1, `model combination ${keep}/${disable}`);
    await waitIdle(document, `model combination idle ${keep}/${disable}`);
  }
  assert.equal(modelFixture.settings.keepInCurrentChat, false);
  assert.equal(modelFixture.settings.disableSubagents, true);
  interactionChecks.push('“不开新对话/不使用子代理”四种组合与恢复默认状态均真实保存');

  const firstModelRow = document.querySelector('tr[data-model-id="fixture/balanced"]');
  document.querySelector('button[aria-label="下移 fixture/balanced"]').click();
  await until(
    () => document.querySelector('#modelRows tr:first-child')?.dataset.modelId === 'fixture/frontier',
    'model reorder',
  );
  document.getElementById('modelSearch').value = 'legacy';
  document.getElementById('modelSearch').dispatchEvent(new page.window.Event('input', { bubbles: true }));
  assert.equal(document.querySelectorAll('#modelRows tr[data-model-id]').length, 1);
  assert.equal(document.querySelector('#modelRows tr')?.dataset.modelId, 'fixture/legacy');
  document.getElementById('modelSearch').value = '';
  document.getElementById('modelSearch').dispatchEvent(new page.window.Event('input', { bubbles: true }));
  assert.ok(firstModelRow);
  interactionChecks.push('模型箭头排序和搜索筛选可操作');

  const revisionBeforeConflict = modelFixture.settings.revision;
  document.getElementById('modelMaxAgents').value = '6';
  document.getElementById('modelMaxAgents').dispatchEvent(new page.window.Event('input', { bubbles: true }));
  await modelFixture.forceExternalUpdate();
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(
    () => /设置已被其他窗口更新/.test(document.getElementById('modelSettingsMessage').textContent),
    'model revision conflict',
  );
  await waitIdle(document, 'model conflict idle');
  assert.equal(document.getElementById('modelSettingsDialog').open, true);
  assert.equal(document.getElementById('modelMaxAgents').value, '6');
  assert.ok(modelFixture.settings.revision > revisionBeforeConflict);
  interactionChecks.push('模型设置 revision 冲突保留编辑内容并明确提示刷新');

  document.getElementById('refreshModelSettings').click();
  await until(() => document.getElementById('modelMaxAgents').value === '9', 'model refresh after conflict');
  await waitIdle(document, 'model refresh idle');
  const seeded = await modelFixture.seedDraft();
  document.getElementById('refreshModelSettings').click();
  await until(() => !document.getElementById('modelDraftBanner').hidden, 'model draft banner');
  assert.match(textOf(document.getElementById('modelDraftHint')), /恢复后仍需保存/);
  document.getElementById('restoreModelDraft').click();
  await until(() => document.getElementById('modelMaxAgents').value === '7', 'model draft restore');
  assert.equal(document.getElementById('modelKeepInCurrentChat').checked, false);
  assert.equal(document.getElementById('modelDisableSubagents').checked, true);
  const restoredRevision = modelFixture.settings.revision;
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(() => modelFixture.settings.revision === restoredRevision + 1, 'restored model draft save');
  await waitIdle(document, 'restored model draft save idle');
  assert.equal(modelFixture.settings.maxAgents, 7);
  assert.ok(seeded.draftId);
  interactionChecks.push('模型草稿可恢复，恢复值需再次保存后才生效');

  document.getElementById('modelKeepInCurrentChat').checked = false;
  document.getElementById('modelKeepInCurrentChat').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  document.getElementById('modelDisableSubagents').checked = true;
  document.getElementById('modelDisableSubagents').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  document.getElementById('modelMaxAgents').value = '5';
  document.getElementById('modelMaxAgents').dispatchEvent(new page.window.Event('input', { bubbles: true }));
  const baselineRevision = modelFixture.settings.revision;
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(() => modelFixture.settings.revision === baselineRevision + 1, 'model baseline restore');
  await waitIdle(document, 'model baseline restore idle');
  closeDialog(document, 'modelSettingsDialog');

  const expandedCatalog = [
    isolatedCatalog[0],
    isolatedCatalog[1],
    {
      slug: 'fixture/new-model',
      display_name: 'New Fixture Model',
      provider: 'fixture',
      supported_reasoning_levels: ['medium'],
      default_reasoning_level: 'medium',
    },
  ];
  const revisionBeforeCatalogSync = modelFixture.settings.revision;
  await writeCatalog(expandedCatalog);
  document.getElementById('modelSettings').click();
  await until(() => (
    document.getElementById('modelSettingsDialog').open
    && document.querySelector('tr[data-model-id="fixture/new-model"]')
  ), 'model catalog open sync');
  await waitIdle(document, 'model catalog open sync idle');
  assert.ok(modelFixture.settings.revision > revisionBeforeCatalogSync);
  assert.equal(document.querySelector('tr[data-model-id="fixture/legacy"]'), null);
  assert.equal(document.querySelectorAll('#modelRows tr[data-model-id]').length, 3);
  const newModelToggle = document.querySelector('input[aria-label="启用 fixture/new-model"]');
  assert.equal(newModelToggle.checked, false);
  const preservedFrontierToggle = document.querySelector('input[aria-label="启用 fixture/frontier"]');
  assert.equal(preservedFrontierToggle.checked, true);
  interactionChecks.push('每次打开设置成功读取目录，移除缺失项并补入默认关闭新项');
  closeDialog(document, 'modelSettingsDialog');

  const revisionBeforeCatalogFailure = modelFixture.settings.revision;
  await fs.writeFile(path.join(modelCodexHome, 'catalog.json'), '{ invalid json', 'utf8');
  document.getElementById('modelSettings').click();
  await until(() => (
    document.getElementById('modelSettingsDialog').open
    && /读取失败：CATALOG_UNAVAILABLE/.test(document.getElementById('modelSettingsMessage').textContent)
  ), 'model catalog failure');
  await waitIdle(document, 'model catalog failure idle');
  assert.equal(modelFixture.settings.revision, revisionBeforeCatalogFailure);
  assert.ok(document.querySelector('tr[data-model-id="fixture/new-model"]'));
  interactionChecks.push('目录读取失败显示错误且保留原模型设置与界面行');
  closeDialog(document, 'modelSettingsDialog');

  await writeCatalog(expandedCatalog);
  document.getElementById('modelSettings').click();
  await until(() => (
    document.getElementById('modelSettingsDialog').open
    && /模型设置已读取/.test(document.getElementById('modelSettingsMessage').textContent)
  ), 'model catalog recovery');
  await waitIdle(document, 'model catalog recovery idle');
  closeDialog(document, 'modelSettingsDialog');
  interactionChecks.push('初始无项目时不自动显示工作对话详情');

  document.getElementById('newProject').click();
  document.getElementById('projectName').value = '简化界面联测';
  document.getElementById('projectRoot').value = projectRoot;
  document.getElementById('projectRequirements').value = '首页只显示项目名和一句概况，长需求进入更多。';
  document.getElementById('projectRules').value = '一层执行，不得继续分派。';
  submit(page.window, document.getElementById('projectForm'));
  await until(async () => (await store.call('overview')).projects.length === 1, 'project submit');
  await waitIdle(document, 'project form idle');
  const initialProject = (await store.call('overview')).projects[0];
  await until(() => document.getElementById('projectTitle').textContent === '简化界面联测', 'project selected');
  assert.equal(document.getElementById('workerDialog').open, false, '项目载入后不应自动选中首行');
  assert.equal(document.getElementById('historyPanel').open, false);
  assert.equal(document.querySelectorAll('#workerRows tr').length, 1, '空项目仍只显示空状态行');
  interactionChecks.push('项目表单提交真实 store，载入后保持无详情状态');

  document.getElementById('modelSettings').click();
  await until(() => document.getElementById('modelSettingsDialog').open, 'model settings reopen');
  const combinedRevision = modelFixture.settings.revision;
  document.getElementById('modelKeepInCurrentChat').checked = true;
  document.getElementById('modelKeepInCurrentChat').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  document.getElementById('modelDisableSubagents').checked = true;
  document.getElementById('modelDisableSubagents').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(() => modelFixture.settings.revision === combinedRevision + 1, 'combined model switches save');
  await waitIdle(document, 'combined model switches idle');
  closeDialog(document, 'modelSettingsDialog');
  const beforeProjectIntent = page.sentMessages.length;
  document.getElementById('requestProject').click();
  await until(() => page.sentMessages.length > beforeProjectIntent, 'project dispatch intent sent');
  await waitIdle(document, 'project dispatch intent idle');
  const projectIntentBody = page.sentMessages.at(-1).content[0].text;
  const projectAfterIntent = await store.call('project_get', { projectId: initialProject.id });
  const storedIntentBody = projectAfterIntent.messages.at(-1).body;
  assert.match(projectIntentBody, new RegExp(`project: ${initialProject.id}`));
  assert.match(projectIntentBody, /message: msg_/);
  assert.match(projectIntentBody, /cursor: m:\d+/);
  assert.match(projectIntentBody, /不在宿主通知里重复正文/);
  assert.doesNotMatch(projectIntentBody, /不创建独立工作对话，也不创建子代理/);
  assert.match(storedIntentBody, /不创建独立工作对话，也不创建子代理/);
  assert.match(storedIntentBody, /普通工作由当前对话直接执行/);
  assert.match(storedIntentBody, /按需读取最新 factory 模式 settings、project_get、worker_get/);
  assert.doesNotMatch(projectIntentBody, /一层执行，不得继续分派/);
  assert.doesNotMatch(projectIntentBody, /首页只显示项目名和一句概况/);
  assert.doesNotMatch(projectIntentBody, /fixture\/balanced|fixture\/frontier|fixture\/legacy/);
  assert.ok(projectIntentBody.length < 400, '宿主通知应只携带消息引用');
  interactionChecks.push('两个开关同开时派发文案准确，且不复制共同规则或模型目录');

  document.getElementById('modelSettings').click();
  await until(() => document.getElementById('modelSettingsDialog').open, 'model settings switch restore');
  const switchRestoreRevision = modelFixture.settings.revision;
  document.getElementById('modelKeepInCurrentChat').checked = false;
  document.getElementById('modelKeepInCurrentChat').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  document.getElementById('modelDisableSubagents').checked = true;
  document.getElementById('modelDisableSubagents').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(() => modelFixture.settings.revision === switchRestoreRevision + 1, 'model switch baseline restore');
  await waitIdle(document, 'model switch baseline idle');
  closeDialog(document, 'modelSettingsDialog');

  document.getElementById('addWorker').click();
  assert.equal(document.getElementById('workerDialogTitle').textContent, '添加工作对话');
  document.getElementById('workerName').value = '界面工作对话';
  document.getElementById('workerRole').value = '界面开发';
  document.getElementById('workerScope').value = '负责首页、列表和详情弹窗。';
  document.getElementById('editWorkerFiles').value = 'src/ui.mjs';
  document.getElementById('editWorkerTask').value = '完成四列工作对话列表。';
  document.getElementById('editWorkerAcceptance').value = '真实 DOM 与 store 联测通过。';
  document.getElementById('editWorkerSession').value = 'session-ui-test';
  document.getElementById('workerModel').value = 'fixture/frontier';
  document.getElementById('workerModel').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  assert.match(textOf(document.getElementById('workerNameModelHint')), /模型：fixture\/frontier/);
  submit(page.window, document.getElementById('workerForm'));
  await until(async () => (await store.call('project_get', { projectId: initialProject.id })).workers.length === 1, 'first worker submit');
  await waitIdle(document, 'first worker idle');
  await until(() => textOf(document.getElementById('workerRows')).includes('界面工作对话'), 'first worker rendered');
  let projectAfterFirstWorker = await store.call('project_get', { projectId: initialProject.id });
  assert.equal(projectAfterFirstWorker.workers[0].model, 'fixture/frontier');
  assert.match(textOf(document.getElementById('workerRows')), /模型：fixture\/frontier/);
  assert.equal(document.getElementById('workerDialog').open, false, '保存后回到列表，不自动打开详情');
  assert.equal(document.querySelectorAll('#workerRows tr').length, 1);
  assert.equal(document.querySelectorAll('#workerRows th').length, 0);
  interactionChecks.push('指定模型工作对话真实保存、回显并闭合详情');

  const secondSave = await store.call('worker_save', {
    projectId: initialProject.id,
    name: '旧版工作对话',
    role: '兼容维护',
    scope: '保留旧界面修复记录。',
    files: ['src/legacy.mjs'],
    task: '旧版界面维护已结束。',
    acceptance: '记录可查看。',
    dependencies: [],
    assignedModel: 'fixture/frontier',
  });
  let projectState = await store.call('project_get', { projectId: initialProject.id });
  const secondWorker = projectState.workers.find((worker) => worker.id === secondSave.workerId);
  assert.equal(secondWorker.model, 'auto');
  assert.equal(secondWorker.assignedModel, 'fixture/frontier');
  await store.call('worker_state', {
    projectId: initialProject.id,
    workerId: secondWorker.id,
    state: 'closed',
    summary: '旧版界面维护结束，记录保留。',
    revision: secondWorker.revision,
  });
  projectState = await store.call('project_get', { projectId: initialProject.id });
  const firstWorker = projectState.workers.find((worker) => worker.id !== secondWorker.id);
  await store.call('worker_state', {
    projectId: initialProject.id,
    workerId: firstWorker.id,
    state: 'running',
    summary: '正在整理四列首页。',
    revision: firstWorker.revision,
  });
  document.getElementById('refresh').click();
  await until(() => textOf(document.getElementById('historyRows')).includes('旧版工作对话'), 'closed history rendered');
  await waitIdle(document, 'refresh after fixtures idle');
  assert.equal(document.getElementById('historyPanel').open, false, 'closed 默认进入折叠历史');
  assert.equal(textOf(document.getElementById('workerRows')).includes('旧版工作对话'), false);
  assert.match(textOf(document.getElementById('historyRows')), /自动选择 · 实际 fixture\/frontier/);
  assert.match(textOf(rowFor(document, firstWorker.id)), /进行中/);
  assert.doesNotMatch(textOf(rowFor(document, firstWorker.id)), /\brunning\b/);
  assert.equal(document.getElementById('workerDialog').open, false, '刷新后仍不自动选首行');
  interactionChecks.push('closed 默认隐藏于折叠历史，运行状态显示中文');

  rowFor(document, firstWorker.id).click();
  await until(() => document.getElementById('workerDialog').open, 'worker detail opens');
  assert.equal(document.getElementById('workerDialogTitle').textContent, '工作对话详情');
  assert.equal(document.getElementById('editWorkerTask').value, '完成四列工作对话列表。');
  assert.equal(document.getElementById('workerStatus').textContent, '进行中');
  assert.equal(document.getElementById('continueWorker').hidden, false);
  assert.equal(document.getElementById('pauseWorker').hidden, false);
  assert.equal(document.getElementById('ackWorker').hidden, true);
  assert.equal(document.getElementById('retryWorker').hidden, true);
  assert.equal(document.getElementById('reopenWorker').hidden, true);
  assert.equal(document.getElementById('closeWorker').hidden, false);
  assert.ok(document.getElementById('closeWorker').closest('details'), '关闭按钮应位于高级折叠');
  assert.ok(document.getElementById('workerTechnical').closest('details'), '版本与会话信息应位于高级折叠');
  closeDialog(document, 'workerDialog');
  interactionChecks.push('点击行才加载 worker_get 并打开详情弹窗');

  document.getElementById('modelSettings').click();
  await until(() => document.getElementById('modelSettingsDialog').open, 'model dispatch guard open');
  const dispatchGuardRevision = modelFixture.settings.revision;
  document.getElementById('modelEnabled').checked = false;
  document.getElementById('modelEnabled').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  const frontierModelToggle = document.querySelector('input[aria-label="启用 fixture/frontier"]');
  frontierModelToggle.checked = false;
  frontierModelToggle.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(() => modelFixture.settings.revision === dispatchGuardRevision + 1, 'model dispatch guard save');
  await waitIdle(document, 'model dispatch guard idle');
  closeDialog(document, 'modelSettingsDialog');

  rowFor(document, firstWorker.id).click();
  await until(() => document.getElementById('workerDialog').open, 'disabled team worker detail');
  const beforeBlockedContinue = page.sentMessages.length;
  document.getElementById('continueWorker').click();
  await until(
    () => /自动团队已关闭/.test(document.getElementById('notice').textContent),
    'disabled team blocks continue',
  );
  await waitIdle(document, 'disabled team continue idle');
  assert.equal(page.sentMessages.length, beforeBlockedContinue, 'enabled=false 不得新建或继续派发');
  const beforePausedWhenDisabled = page.sentMessages.length;
  document.getElementById('pauseWorker').click();
  await until(() => page.sentMessages.length > beforePausedWhenDisabled, 'disabled team allows pause request');
  await waitIdle(document, 'disabled team pause idle');
  assert.match(page.sentMessages.at(-1).content[0].text, /message: msg_/);
  const pausedStored = (await store.call('project_get', { projectId: initialProject.id })).messages.at(-1).body;
  assert.match(pausedStored, /软件工厂模式已关闭.*不新派发/);
  assert.match(pausedStored, /暂停对应原生任务/);
  const beforeClosedWhenDisabled = page.sentMessages.length;
  document.getElementById('closeWorker').click();
  await until(() => page.sentMessages.length > beforeClosedWhenDisabled, 'disabled team allows close request');
  await waitIdle(document, 'disabled team close idle');
  assert.match(page.sentMessages.at(-1).content[0].text, /message: msg_/);
  const closedStored = (await store.call('project_get', { projectId: initialProject.id })).messages.at(-1).body;
  assert.match(closedStored, /软件工厂模式已关闭.*不新派发/);
  assert.match(closedStored, /实际停止对应原生任务/);
  closeDialog(document, 'workerDialog');
  interactionChecks.push('enabled=false 阻止 create/continue，但 pause/close 请求仍可发出');

  document.getElementById('modelSettings').click();
  await until(() => document.getElementById('modelSettingsDialog').open, 'model enabled restore');
  const enabledRestoreRevision = modelFixture.settings.revision;
  document.getElementById('modelEnabled').checked = true;
  document.getElementById('modelEnabled').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  document.getElementById('modelKeepInCurrentChat').checked = false;
  document.getElementById('modelKeepInCurrentChat').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  document.getElementById('modelDisableSubagents').checked = true;
  document.getElementById('modelDisableSubagents').dispatchEvent(new page.window.Event('change', { bubbles: true }));
  submit(page.window, document.getElementById('modelSettingsForm'));
  await until(() => modelFixture.settings.revision === enabledRestoreRevision + 1, 'model enabled restore save');
  await waitIdle(document, 'model enabled restore idle');
  closeDialog(document, 'modelSettingsDialog');

  rowFor(document, firstWorker.id).click();
  await until(() => document.getElementById('workerDialog').open, 'worker edit reopen');
  assert.equal(document.getElementById('workerModel').value, 'fixture/frontier');
  const unavailableModelOption = [...document.getElementById('workerModel').options]
    .find((option) => option.value === 'fixture/frontier');
  assert.equal(unavailableModelOption.disabled, true);
  assert.match(textOf(unavailableModelOption), /已禁用或不可用，请重新选择/);
  assert.match(textOf(document.getElementById('workerModelHint')), /当前模型已禁用或不可用/);
  assert.match(textOf(document.getElementById('workerNameModelHint')), /模型：fixture\/frontier（不可用）/);
  document.getElementById('workerScope').value = '负责首页、四列列表、历史与详情弹窗。';
  document.getElementById('editWorkerTask').value = '完成精简首页并补边界测试。';
  document.getElementById('editWorkerAcceptance').value = '默认无详情且历史默认折叠。';
  submit(page.window, document.getElementById('workerForm'));
  await until(async () => {
    const current = await store.call('project_get', { projectId: initialProject.id });
    const worker = current.workers.find((item) => item.id === firstWorker.id);
    return worker.taskVersion === 2 && worker.state === 'needs_ack';
  }, 'worker edit submit');
  await waitIdle(document, 'worker edit idle');
  projectState = await store.call('project_get', { projectId: initialProject.id });
  assert.equal(
    projectState.workers.find((worker) => worker.id === firstWorker.id).model,
    'fixture/frontier',
    '编辑其他字段时不得静默清除已禁用的历史模型选择',
  );
  await until(() => textOf(rowFor(document, firstWorker.id)).includes('待确认'), 'worker edited state rendered');
  assert.equal(document.getElementById('workerDialog').open, false);
  interactionChecks.push('已禁用历史模型保留在下拉与记录中，保存其他字段不会静默清除');

  rowFor(document, firstWorker.id).click();
  await until(() => document.getElementById('workerDialog').open, 'conflict dialog');
  assert.equal(document.getElementById('ackWorker').hidden, false);
  assert.equal(document.getElementById('retryWorker').hidden, false);
  assert.equal(document.getElementById('reopenWorker').hidden, false);
  projectState = await store.call('project_get', { projectId: initialProject.id });
  const conflictWorker = projectState.workers.find((worker) => worker.id === firstWorker.id);
  await store.call('worker_save', {
    projectId: initialProject.id,
    id: conflictWorker.id,
    task: '外部进程更新任务。',
    acceptance: '制造 revision 冲突。',
    revision: conflictWorker.revision,
  });
  document.getElementById('editWorkerTask').value = '界面使用旧 revision 提交。';
  document.getElementById('editWorkerAcceptance').value = '应显示冲突。';
  submit(page.window, document.getElementById('workerForm'));
  await until(() => /其他进程更新/.test(document.getElementById('notice').textContent), 'revision conflict notice');
  await waitIdle(document, 'revision conflict idle');
  assert.equal(document.getElementById('workerDialog').open, true, '冲突时保留编辑内容与弹窗');
  closeDialog(document, 'workerDialog');
  interactionChecks.push('外部 revision 更新后 UI 明确显示冲突并保留弹窗');

  document.getElementById('refresh').click();
  await until(async () => {
    const current = await store.call('project_get', { projectId: initialProject.id });
    return document.getElementById('projectRevision').textContent.includes(String(current.revision));
  }, 'refresh after conflict');
  await waitIdle(document, 'refresh after conflict idle');
  document.getElementById('editRules').click();
  assert.equal(document.getElementById('rulesDialog').open, true);
  document.getElementById('editRequirements').value = '需求已由简化界面更新。';
  document.getElementById('editRulesText').value = '规则已更新；执行者先确认新版本。';
  submit(page.window, document.getElementById('rulesForm'));
  await until(async () => {
    const current = await store.call('project_get', { projectId: initialProject.id });
    return current.requirementsVersion === 2;
  }, 'rules submit');
  await waitIdle(document, 'rules submit idle');
  await until(() => textOf(document.getElementById('workerRows')).includes('待确认'), 'rules ack state rendered');
  interactionChecks.push('共同规则通过弹窗保存，并显示待确认中文状态');

  rowFor(document, firstWorker.id).click();
  await until(() => document.getElementById('workerDialog').open, 'ack request dialog');
  const beforeAck = await store.call('project_get', { projectId: initialProject.id });
  const beforeAckMessages = page.sentMessages.length;
  document.getElementById('ackWorker').click();
  await until(() => page.sentMessages.length > beforeAckMessages, 'ack request sent');
  await waitIdle(document, 'ack request idle');
  const afterAckRequest = await store.call('project_get', { projectId: initialProject.id });
  const beforeAckWorker = beforeAck.workers.find((worker) => worker.id === firstWorker.id);
  const afterAckWorker = afterAckRequest.workers.find((worker) => worker.id === firstWorker.id);
  assert.equal(afterAckWorker.acknowledgedRequirementsVersion, beforeAckWorker.acknowledgedRequirementsVersion);
  assert.match(page.sentMessages.at(-1).content[0].text, /message: msg_/);
  assert.match(afterAckRequest.messages.at(-1).body, /总指挥不得代替执行者 ack/);
  interactionChecks.push('确认按钮只发送请求，不代替执行者 ack');

  const beforeCloseRequest = await store.call('project_get', { projectId: initialProject.id });
  const beforeCloseWorker = beforeCloseRequest.workers.find((worker) => worker.id === firstWorker.id);
  const beforeCloseMessages = page.sentMessages.length;
  document.getElementById('closeWorker').click();
  await until(() => page.sentMessages.length > beforeCloseMessages, 'close request sent');
  await waitIdle(document, 'close request idle');
  const afterCloseRequest = await store.call('project_get', { projectId: initialProject.id });
  const afterCloseWorker = afterCloseRequest.workers.find((worker) => worker.id === firstWorker.id);
  assert.equal(afterCloseWorker.state, beforeCloseWorker.state, '关闭按钮不能只写 closed 冒充已停止');
  assert.match(page.sentMessages.at(-1).content[0].text, /message: msg_/);
  assert.match(afterCloseRequest.messages.at(-1).body, /实际停止对应原生任务/);
  closeDialog(document, 'workerDialog');
  interactionChecks.push('关闭按钮只请求停止原生任务，不直接写 closed');

  assert.equal(document.getElementById('historyPanel').open, false);
  document.getElementById('historyPanel').querySelector('summary').click();
  await until(() => document.getElementById('historyPanel').open, 'history expand');
  rowFor(document, secondWorker.id).click();
  await until(() => document.getElementById('workerDialog').open, 'history detail opens');
  assert.equal(document.getElementById('workerStatus').textContent, '已关闭');
  assert.equal(document.getElementById('workerFields').disabled, true);
  assert.equal(document.getElementById('editWorkerTask').value, '旧版界面维护已结束。');
  assert.equal(document.getElementById('reopenWorker').hidden, false);
  assert.equal(document.getElementById('closeWorker').hidden, true);
  document.getElementById('reopenWorker').click();
  await until(async () => {
    const current = await store.call('project_get', { projectId: initialProject.id });
    return current.workers.find((worker) => worker.id === secondWorker.id).state !== 'closed';
  }, 'history worker reopened');
  await waitIdle(document, 'history worker reopen idle');
  await until(() => textOf(document.getElementById('historyRows')).includes('暂无已关闭工作对话'), 'history empty after reopen');
  closeDialog(document, 'workerDialog');
  interactionChecks.push('历史默认折叠、可展开选择并重新打开，记录保留');

  document.getElementById('morePanel').open = true;
  const beforeMessages = (await store.call('project_get', { projectId: initialProject.id })).messages.length;
  document.getElementById('messageBody').value = '验证内部消息只保存，不冒充执行。';
  submit(page.window, document.getElementById('messageForm'));
  await until(async () => {
    const current = await store.call('project_get', { projectId: initialProject.id });
    return current.messages.length > beforeMessages;
  }, 'message saved');
  await waitIdle(document, 'message save idle');
  assert.match(document.getElementById('notice').textContent, /短消息已保存/);
  assert.match(document.getElementById('notice').textContent, /宿主通知只应携带该引用/);
  interactionChecks.push('内部消息保存到 store，通知只携带引用且不冒充执行');

  const coordinatorCallsBefore = page.toolCalls.length;
  document.getElementById('coordinatorToggle').click();
  await until(
    () => document.getElementById('coordinatorDialog').open,
    'coordinator dialog opens',
  );
  const coordinatorTarget = document.querySelector('#coordinatorTargets input:checked');
  assert.ok(coordinatorTarget, '协调助手必须选择明确监控对象');
  submit(page.window, document.getElementById('coordinatorForm'));
  await until(async () => (
    (await store.call('project_get', { projectId: initialProject.id })).coordinator.enabled
  ), 'coordinator enabled in store');
  await waitIdle(document, 'coordinator enable idle');
  await until(
    () => document.getElementById('coordinatorStatus').textContent === '待启动',
    'coordinator pending binding rendered',
  );
  assert.equal(document.getElementById('coordinatorToggle').textContent, '停止跟进');
  const coordinatorCall = page.toolCalls
    .slice(coordinatorCallsBefore)
    .find((call) => (
      call.name === 'factory_call'
      && call.arguments.action === 'coordinator_control'
      && call.arguments.args?.op === 'enable'
    ));
  assert.ok(coordinatorCall, '开始跟进必须经 factory_call 写入协调状态');
  assert.match(page.sentMessages.at(-1).content[0].text, /factory-coordinator/);
  interactionChecks.push('开始跟进经真实 store 开启协调状态并发送宿主启动请求');

  const broken = await openPage({ failRead: true });
  await until(() => /fixture read unavailable/.test(broken.document.getElementById('notice').textContent), 'read failure notice');
  await waitIdle(broken.document, 'read failure idle');
  assert.equal(broken.document.getElementById('newProject').disabled, false);
  interactionChecks.push('读取失败有可见错误且连接控件仍可用');
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (failure) {
    const diagnostic = {
      ok: false,
      checkedAt: new Date().toISOString(),
      stage: currentStage,
      error: failure instanceof Error ? failure.message : String(failure),
      stack: failure instanceof Error ? failure.stack : undefined,
      pages: windows.map((window) => ({
        bodyText: window.document.body?.textContent?.slice(0, 5000),
        status: window.document.getElementById('status')?.textContent,
        workerDialogOpen: window.document.getElementById('workerDialog')?.open,
        workerRows: window.document.getElementById('workerRows')?.textContent,
        historyRows: window.document.getElementById('historyRows')?.textContent,
        notice: window.document.getElementById('notice')?.textContent,
        modelDialog: {
          refreshDisabled: window.document.getElementById('refreshModelSettings')?.disabled,
          saveDisabled: window.document.getElementById('saveModelSettings')?.disabled,
          maxAgents: window.document.getElementById('modelMaxAgents')?.value,
          message: window.document.getElementById('modelSettingsMessage')?.textContent,
          draftVisible: !window.document.getElementById('modelDraftBanner')?.hidden,
          status: window.document.getElementById('modelSettingsStatus')?.textContent,
        },
      })),
      modelState: {
        settings: modelFixture.settings,
        draft: modelFixture.draft,
      },
      toolCalls: windows.map((window) => window.__toolCalls || []),
    };
    await fs.mkdir(verifyDir, { recursive: true });
    await fs.writeFile(recordPath, `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');
  }
  for (const window of windows) await window.happyDOM.abort().catch(() => {});
  await store.close();
  assertContainedTemp(tempRoot);
  await fs.rm(tempRoot, { recursive: true, force: true });
}

const report = {
  checkedAt: new Date().toISOString(),
  node: process.version,
  files: {
    panelHtml: {
      bytes: Buffer.byteLength(html),
      sha256: crypto.createHash('sha256').update(html).digest('hex'),
    },
    panelApp: {
      bytes: Buffer.byteLength(script),
      sha256: crypto.createHash('sha256').update(script).digest('hex'),
    },
    bundled: {
      bytes: Buffer.byteLength(bundled),
      sha256: crypto.createHash('sha256').update(bundled).digest('hex'),
    },
  },
  checks: [
    '构建占位与四个弹窗存在',
    '主列表固定四列且主按钮为添加工作对话',
    '历史与更多默认折叠',
    '完整读取仅走 factory_ui_read',
    '写入仅走 factory_call',
    '按钮通过 app.sendMessage 请求当前总指挥',
    '关闭请求要求先实际停止原生任务',
    '不调用 updateModelContext 自动注入全量数据',
    '会话记录与 sessionLive 分离',
    'panel-app DOM id 与 HTML 一致',
    'browser bundle 可编译',
    ...interactionChecks,
  ],
};

await fs.mkdir(verifyDir, { recursive: true });
await fs.writeFile(recordPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true,
  record: path.relative(root, recordPath),
  checks: report.checks.length,
  bundleBytes: report.files.bundled.bytes,
}, null, 2));
