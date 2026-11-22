import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import {
  createModelSettings,
  ModelSettingsError,
} from '../插件市场/plugins/codex-factory/server/model-settings.mjs';

const root = path.join(os.tmpdir(), `codex-factory-models-${process.pid}-${crypto.randomUUID()}`);
const dataDir = path.join(root, 'data');
const codexHome = path.join(root, 'codex-home');
const legacyDataDir = path.join(root, 'legacy');
const configFile = path.join(codexHome, 'config.toml');
const catalogFile = path.join(codexHome, 'models.json');
const checks = [];

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function check(name, operation) {
  await operation();
  checks.push(name);
}

try {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(configFile, [
    'model_catalog_json = "models.json"',
    '',
    '[agents]',
    'max_concurrent_threads_per_session = 5',
    '',
  ].join('\n'), 'utf8');
  await writeJson(catalogFile, {
    models: [
      {
        slug: 'alpha',
        display_name: 'Alpha',
        supported_reasoning_levels: [
          { effort: 'medium' },
          { effort: 'high' },
        ],
        default_reasoning_level: 'medium',
      },
      {
        slug: 'beta',
        display_name: 'Beta',
        supported_reasoning_levels: [{ effort: 'low' }],
        default_reasoning_level: 'low',
      },
    ],
  });
  const legacySettings = {
    enabled: true,
    maxAgents: 5,
    keepInCurrentChat: true,
    disableSubagents: false,
    revision: 15,
    models: [
      { id: 'beta', enabled: true, effort: 'low', ability: 4 },
      { id: 'alpha', enabled: false, effort: 'high', ability: 5 },
      { id: 'retired', enabled: false, effort: 'high', ability: 2 },
    ],
  };
  await writeJson(path.join(legacyDataDir, 'settings.json'), legacySettings);
  await writeJson(path.join(legacyDataDir, 'native-limit.json'), {
    version: 1,
    entries: [{ table: 'agents', present: false }],
    applied: 5,
  });

  const models = createModelSettings({ dataDir, codexHome, legacyDataDir, parseToml });
  let data;
  const modes = (
    factory = { enabled: true, maxAgents: 5, keepInCurrentChat: true, disableSubagents: false },
    team = { enabled: false, maxAgents: 5, keepInCurrentChat: true, disableSubagents: false },
  ) => ({ factory, team });
  await check('首次迁移并清理目录缺失项', async () => {
    const first = await models.read();
    const second = await models.read();
    assert.equal(first.migration.migratedAt, second.migration.migratedAt);
    data = first;
    assert.equal(data.migration.status, 'migrated');
    assert.deepEqual(data.settings.modes.factory, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: false,
      disableSubagents: true,
    });
    assert.deepEqual(data.settings.modes.team, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: true,
      disableSubagents: false,
    });
    assert.equal(data.settings.revision, 16);
    assert.deepEqual(data.settings.models, [
      { id: 'beta', enabled: true, effort: 'low', ability: 4 },
      { id: 'alpha', enabled: false, effort: 'high', ability: 5 },
    ]);
    assert.deepEqual(data.catalogSync.removed, ['retired']);
    assert.equal(data.catalogSync.persisted, true);
    assert.equal(data.catalog.find((item) => item.id === 'retired'), undefined);
    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, 'models', 'settings.json'), 'utf8'));
    assert.deepEqual(persisted.models.map((item) => item.id), ['beta', 'alpha']);
  });
  await check('迁移保留原始并发记录', async () => {
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'models', 'native-limit.json'), 'utf8'));
    assert.equal(state.applied, null);
    assert.deepEqual(state.entries, [{ table: 'agents', present: false }]);
    assert.equal(JSON.parse(await fs.readFile(path.join(legacyDataDir, 'native-limit.json'), 'utf8')).applied, 5);
  });
  await check('新安装使用工厂与团队各自默认派发策略', async () => {
    const fresh = createModelSettings({
      dataDir: path.join(root, 'fresh-data'),
      codexHome,
      legacyDataDir: null,
      parseToml,
    });
    const initial = await fresh.read();
    assert.deepEqual(initial.settings.modes.factory, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: false,
      disableSubagents: true,
    });
    assert.deepEqual(initial.settings.modes.team, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: true,
      disableSubagents: false,
    });
  });
  await check('旧非默认派发策略保留', async () => {
    const customLegacyDir = path.join(root, 'custom-legacy');
    await writeJson(path.join(customLegacyDir, 'settings.json'), {
      enabled: true,
      maxAgents: 4,
      keepInCurrentChat: false,
      disableSubagents: false,
      revision: 2,
      models: [{ id: 'beta', enabled: true, effort: 'low', ability: 4 }],
    });
    const custom = createModelSettings({
      dataDir: path.join(root, 'custom-data'),
      codexHome,
      legacyDataDir: customLegacyDir,
      parseToml,
    });
    const initial = await custom.read();
    assert.deepEqual(initial.settings.modes.factory, {
      enabled: true,
      maxAgents: 4,
      keepInCurrentChat: false,
      disableSubagents: false,
    });
    assert.deepEqual(initial.settings.modes.team, {
      enabled: true,
      maxAgents: 5,
      keepInCurrentChat: true,
      disableSubagents: false,
    });
  });
  await check('可用模型保留顺序与设置', async () => {
    data = await models.read();
    assert.equal(data.settings.revision, 16);
    assert.deepEqual(data.settings.models, [
      { id: 'beta', enabled: true, effort: 'low', ability: 4 },
      { id: 'alpha', enabled: false, effort: 'high', ability: 5 },
    ]);
    assert.equal(data.catalogSync.persisted, false);
    assert.deepEqual(data.catalogSync.removed, []);
  });
  await check('保存完整名单与顺序', async () => {
    data = await models.save({
      modes: modes(
        { enabled: true, maxAgents: 5, keepInCurrentChat: false, disableSubagents: true },
        { enabled: true, maxAgents: 4, keepInCurrentChat: true, disableSubagents: false },
      ),
      revision: 16,
      models: [
        { id: 'beta', enabled: true, effort: 'low', ability: 4 },
        { id: 'alpha', enabled: false, effort: 'high', ability: 5 },
      ],
    });
    assert.equal(data.settings.revision, 17);
    assert.deepEqual(data.settings.models.map((item) => item.id), ['beta', 'alpha']);
  });
  await check('精简结果包含开关', async () => {
    const compact = models.compact(data);
    assert.equal(compact.keepInCurrentChat, false);
    assert.equal(compact.disableSubagents, true);
    assert.deepEqual(compact.models, [{
      priority: 1,
      model: 'beta',
      reasoning_effort: 'low',
      ability: 4,
    }]);
    const teamCompact = models.compact(data, 'team');
    assert.equal(teamCompact.mode, 'team');
    assert.equal(teamCompact.maxAgents, 4);
    assert.equal(teamCompact.keepInCurrentChat, true);
    assert.equal(teamCompact.disableSubagents, false);
  });
  await check('冲突拒绝覆盖', async () => {
    await assert.rejects(
      models.save({
        modes: data.settings.modes,
        revision: 15,
        models: data.settings.models,
      }),
      (error) => error instanceof ModelSettingsError && error.code === 'REVISION_CONFLICT',
    );
  });
  const draftId = crypto.randomUUID();
  await check('草稿保存与恢复', async () => {
    const saved = await models.saveDraft({
      modes: modes(
        { enabled: true, maxAgents: 4, keepInCurrentChat: false, disableSubagents: true },
        data.settings.modes.team,
      ),
      revision: 17,
      draftId,
      sequence: 1,
      models: data.settings.models,
    });
    assert.equal(saved.stored, true);
    assert.equal(saved.draft.draftId, draftId);
    const recovered = await models.read();
    assert.equal(recovered.draft.sequence, 1);
    assert.equal(recovered.draft.settings.modes.factory.maxAgents, 4);
  });
  await check('草稿顺序保护', async () => {
    const stale = await models.saveDraft({
      modes: modes(
        { enabled: true, maxAgents: 3, keepInCurrentChat: true, disableSubagents: false },
        data.settings.modes.team,
      ),
      revision: 17,
      draftId,
      sequence: 1,
      models: data.settings.models,
    });
    assert.equal(stale.stored, false);
  });
  await check('草稿清除', async () => {
    assert.deepEqual(await models.clearDraft({ draftId, sequence: 1, reason: 'discarded' }), {
      cleared: true,
    });
    assert.equal((await models.read()).draft, null);
  });
  await check('重复实例不覆盖新设置', async () => {
    const again = createModelSettings({ dataDir, codexHome, legacyDataDir, parseToml });
    const current = await again.read();
    assert.equal(current.settings.revision, 17);
    assert.deepEqual(current.settings.models.map((item) => item.id), ['beta', 'alpha']);
  });
  await check('成功刷新补入新模型并排除隐藏项', async () => {
    await writeJson(catalogFile, {
      models: [
        {
          slug: 'beta',
          display_name: 'Beta',
          supported_reasoning_levels: [{ effort: 'low' }],
          default_reasoning_level: 'low',
        },
        {
          slug: 'alpha',
          display_name: 'Alpha',
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
          default_reasoning_level: 'medium',
        },
        {
          slug: 'hidden-model',
          display_name: 'Hidden',
          hidden: true,
        },
        {
          slug: 'delta',
          display_name: 'Delta',
          supported_reasoning_levels: [{ effort: 'medium' }],
          default_reasoning_level: 'medium',
        },
      ],
    });
    data = await models.read();
    assert.equal(data.settings.revision, 18);
    assert.deepEqual(data.catalogSync.added, ['delta']);
    assert.deepEqual(data.settings.models, [
      { id: 'beta', enabled: true, effort: 'low', ability: 4 },
      { id: 'alpha', enabled: false, effort: 'high', ability: 5 },
      { id: 'delta', enabled: false, effort: 'medium', ability: 3 },
    ]);
    assert.equal(data.catalog.some((item) => item.id === 'hidden-model'), false);
  });
  await check('目录读取失败不清理正式设置', async () => {
    const settingsPath = path.join(dataDir, 'models', 'settings.json');
    const before = await fs.readFile(settingsPath, 'utf8');
    await fs.writeFile(catalogFile, '{ invalid json', 'utf8');
    await assert.rejects(
      models.read(),
      (error) => error instanceof ModelSettingsError && error.code === 'CATALOG_UNAVAILABLE',
    );
    assert.equal(await fs.readFile(settingsPath, 'utf8'), before);
    await writeJson(catalogFile, {
      models: [
        {
          slug: 'beta',
          display_name: 'Beta',
          supported_reasoning_levels: [{ effort: 'low' }],
          default_reasoning_level: 'low',
        },
        {
          slug: 'alpha',
          display_name: 'Alpha',
          supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }],
          default_reasoning_level: 'medium',
        },
        { slug: 'hidden-model', display_name: 'Hidden', hidden: true },
        {
          slug: 'delta',
          display_name: 'Delta',
          supported_reasoning_levels: [{ effort: 'medium' }],
          default_reasoning_level: 'medium',
        },
      ],
    });
  });
  await check('旧草稿不复活目录缺失项', async () => {
    const staleDraftId = crypto.randomUUID();
    await writeJson(path.join(dataDir, 'models', 'drafts', `${staleDraftId}.json`), {
      draftId: staleDraftId,
      sequence: 1,
      status: 'pending',
      updatedAt: new Date().toISOString(),
      settings: {
        ...data.settings,
        models: [
          ...data.settings.models,
          { id: 'retired', enabled: false, effort: 'high', ability: 2 },
        ],
      },
    });
    const current = await models.read();
    assert.equal(current.draft, null);
    assert.equal(current.settings.models.some((item) => item.id === 'retired'), false);
  });
  await check('关闭移除 Factory 写入的并发键', async () => {
    data = await models.save({
      modes: modes(
        { enabled: false, maxAgents: 5, keepInCurrentChat: true, disableSubagents: false },
        { ...data.settings.modes.team, enabled: false },
      ),
      revision: 18,
      models: data.settings.models,
    });
    const config = await fs.readFile(configFile, 'utf8');
    assert.doesNotMatch(config, /max_concurrent_threads_per_session/);
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'models', 'native-limit.json'), 'utf8'));
    assert.equal(state.applied, null);
    assert.deepEqual(state.entries, [{ table: 'agents', present: false }]);
    assert.deepEqual(models.compact(data), { mode: 'factory', enabled: false });
  });
  await check('非法思考强度拒绝', async () => {
    await assert.rejects(
      models.save({
        modes: data.settings.modes,
        revision: 19,
        models: [
          { id: 'beta', enabled: false, effort: 'high', ability: 4 },
          ...data.settings.models.filter((item) => item.id !== 'beta'),
        ],
      }),
      (error) => error instanceof ModelSettingsError && error.code === 'INVALID_EFFORT',
    );
  });
  await check('并发外部改动拒绝覆盖', async () => {
    data = await models.save({
      modes: modes(
        { enabled: true, maxAgents: 5, keepInCurrentChat: true, disableSubagents: false },
        data.settings.modes.team,
      ),
      revision: 19,
      models: data.settings.models,
    });
    await fs.writeFile(configFile, (await fs.readFile(configFile, 'utf8'))
      .replace('max_concurrent_threads_per_session = 5', 'max_concurrent_threads_per_session = 4'), 'utf8');
    await assert.rejects(
      models.save({
        modes: modes(
          { enabled: true, maxAgents: 3, keepInCurrentChat: true, disableSubagents: false },
          data.settings.modes.team,
        ),
        revision: 20,
        models: data.settings.models,
      }),
      (error) => error instanceof ModelSettingsError && error.code === 'NATIVE_LIMIT_CONFLICT',
    );
    assert.match(await fs.readFile(configFile, 'utf8'), /max_concurrent_threads_per_session = 4/);
  });
  await check('关闭恢复原本存在的并发值', async () => {
    const restoreRoot = path.join(root, 'restore');
    const restoreHome = path.join(restoreRoot, 'home');
    const restoreData = path.join(restoreRoot, 'data');
    const restoreConfig = path.join(restoreHome, 'config.toml');
    await fs.mkdir(restoreHome, { recursive: true });
    await fs.writeFile(restoreConfig, [
      'model_catalog_json = "models.json"',
      '',
      '[agents]',
      'max_concurrent_threads_per_session = 2',
      '',
    ].join('\n'), 'utf8');
    await fs.copyFile(catalogFile, path.join(restoreHome, 'models.json'));
    const restoreModels = createModelSettings({
      dataDir: restoreData,
      codexHome: restoreHome,
      legacyDataDir: null,
      parseToml,
    });
    const initial = await restoreModels.read();
    const enabled = await restoreModels.save({
      modes: modes(
        { enabled: true, maxAgents: 5, keepInCurrentChat: true, disableSubagents: false },
        { enabled: false, maxAgents: 3, keepInCurrentChat: true, disableSubagents: false },
      ),
      revision: initial.settings.revision,
      models: [{ id: 'beta', enabled: true, effort: 'low', ability: 4 }],
    });
    assert.match(await fs.readFile(restoreConfig, 'utf8'), /max_concurrent_threads_per_session = 5/);
    await restoreModels.save({
      modes: modes(
        { enabled: false, maxAgents: 5, keepInCurrentChat: true, disableSubagents: false },
        { enabled: false, maxAgents: 3, keepInCurrentChat: true, disableSubagents: false },
      ),
      revision: enabled.settings.revision,
      models: enabled.settings.models,
    });
    assert.match(await fs.readFile(restoreConfig, 'utf8'), /max_concurrent_threads_per_session = 2/);
  });

  console.log(JSON.stringify({
    ok: true,
    passed: checks.length,
    checks,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
