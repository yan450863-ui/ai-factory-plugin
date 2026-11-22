import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MODE_KEYS = Object.freeze(['factory', 'team']);
const DEFAULT_MODES = Object.freeze({
  factory: Object.freeze({
    enabled: true,
    maxAgents: 5,
    keepInCurrentChat: false,
    disableSubagents: true,
  }),
  team: Object.freeze({
    enabled: true,
    maxAgents: 5,
    keepInCurrentChat: true,
    disableSubagents: false,
  }),
});

const DEFAULT_SETTINGS = Object.freeze({
  revision: 0,
  modes: DEFAULT_MODES,
  models: [],
});

const MODEL_LIMIT = 200;
const NATIVE_LIMIT_KEY = 'max_concurrent_threads_per_session';

export class ModelSettingsError extends Error {
  constructor(code, message, details = undefined) {
    super(`${code}: ${message}`);
    this.name = 'ModelSettingsError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new ModelSettingsError(code, message, details);
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function defaultDataDir() {
  if (process.env.CODEX_FACTORY_DATA_DIR?.trim()) {
    return path.resolve(process.env.CODEX_FACTORY_DATA_DIR.trim());
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'CodexFactory');
  }
  return path.join(os.homedir(), '.codex-factory');
}

function defaultCodexHome() {
  return path.resolve(
    process.env.CODEX_FACTORY_CODEX_HOME?.trim()
      || process.env.CODEX_HOME?.trim()
      || path.join(os.homedir(), '.codex'),
  );
}

function defaultLegacyDataDir() {
  if (Object.hasOwn(process.env, 'CODEX_FACTORY_LEGACY_DATA_DIR')) {
    const value = process.env.CODEX_FACTORY_LEGACY_DATA_DIR?.trim();
    return value ? path.resolve(value) : null;
  }
  return null;
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomUUID().replaceAll('-', '');
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readJsonOptional(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomToken()}.tmp`);
  await fs.writeFile(temporary, canonicalJson(value), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

async function atomicCopy(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomToken()}.tmp`);
  await fs.copyFile(source, temporary);
  await fs.rename(temporary, target);
}

async function atomicWriteText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomToken()}.tmp`);
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
}

async function hashFile(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('INVALID_ARGUMENT', `${name} 必须是 ${min} 到 ${max} 的整数`);
  }
  return value;
}

function normalizeSavedModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const models = [];
  for (const [index, item] of value.entries()) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      enabled: item.enabled === true,
      effort: typeof item.effort === 'string' ? item.effort : '',
      ability: Number.isInteger(item.ability) && item.ability >= 1 && item.ability <= 5
        ? item.ability
        : 3,
      order: index,
    });
  }
  return models.map(({ order: _order, ...item }) => item);
}

function normalizeMode(value, defaults, legacy) {
  const source = value && typeof value === 'object'
    ? value
    : legacy && typeof legacy === 'object' ? legacy : {};
  const migrateLegacyFactoryDefaults = Boolean(
    legacy
    && source.keepInCurrentChat === true
    && source.disableSubagents === false,
  );
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    maxAgents: Number.isInteger(source.maxAgents) && source.maxAgents >= 1 && source.maxAgents <= 16
      ? source.maxAgents
      : defaults.maxAgents,
    keepInCurrentChat: migrateLegacyFactoryDefaults
      ? defaults.keepInCurrentChat
      : typeof source.keepInCurrentChat === 'boolean'
      ? source.keepInCurrentChat
      : defaults.keepInCurrentChat,
    disableSubagents: migrateLegacyFactoryDefaults
      ? defaults.disableSubagents
      : typeof source.disableSubagents === 'boolean'
      ? source.disableSubagents
      : defaults.disableSubagents,
  };
}

function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const hasModes = source.modes && typeof source.modes === 'object';
  return {
    revision: Number.isInteger(source.revision) && source.revision >= 0
      ? source.revision
      : DEFAULT_SETTINGS.revision,
    modes: {
      factory: normalizeMode(
        hasModes ? source.modes.factory : undefined,
        DEFAULT_MODES.factory,
        hasModes ? undefined : source,
      ),
      team: normalizeMode(
        hasModes ? source.modes.team : undefined,
        DEFAULT_MODES.team,
      ),
    },
    models: normalizeSavedModels(source.models),
  };
}

function nativeConcurrency(settings) {
  const enabled = MODE_KEYS
    .map((mode) => settings.modes?.[mode])
    .filter((mode) => mode?.enabled);
  if (enabled.length === 0) return null;
  return Math.max(...enabled.map((mode) => mode.maxAgents));
}

function modelEfforts(entry) {
  const values = entry.supported_reasoning_levels
    || entry.reasoning_efforts
    || entry.supported_reasoning_efforts
    || [];
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((item) => (
    typeof item === 'string' ? item : item?.effort
  )).filter(Boolean))];
}

function normalizeCatalogEntry(entry) {
  const visibility = typeof entry?.visibility === 'string'
    ? entry.visibility.trim().toLowerCase()
    : '';
  if (
    entry?.hidden === true
    || entry?.visible === false
    || visibility === 'hide'
    || visibility === 'hidden'
  ) {
    return null;
  }
  const id = typeof entry?.slug === 'string'
    ? entry.slug.trim()
    : typeof entry?.id === 'string' ? entry.id.trim() : '';
  if (!id) return null;
  const efforts = modelEfforts(entry);
  const defaultEffort = typeof entry.default_reasoning_level === 'string'
    ? entry.default_reasoning_level
    : typeof entry.default_reasoning_effort === 'string'
      ? entry.default_reasoning_effort
      : efforts[0] || '';
  return {
    id,
    name: typeof entry.display_name === 'string' ? entry.display_name : id,
    provider: typeof entry.provider === 'string'
      ? entry.provider
      : id.includes('/') ? id.split('/')[0] : '',
    available: true,
    efforts,
    defaultEffort: efforts.includes(defaultEffort) ? defaultEffort : efforts[0] || '',
  };
}

function reconcileCatalogModels(savedModels, catalog) {
  const catalogIds = new Set(catalog.map((item) => item.id));
  const savedIds = new Set(savedModels.map((item) => item.id));
  const removed = savedModels
    .filter((item) => !catalogIds.has(item.id))
    .map((item) => item.id);
  const added = catalog
    .filter((item) => !savedIds.has(item.id))
    .map((item) => item.id);
  return {
    models: [
      ...savedModels.filter((item) => catalogIds.has(item.id)),
      ...catalog
        .filter((item) => !savedIds.has(item.id))
        .map((item) => ({
          id: item.id,
          enabled: false,
          effort: item.defaultEffort,
          ability: 3,
        })),
    ],
    removed,
    added,
  };
}

function stableModels(inputModels, currentModels, catalog) {
  if (!Array.isArray(inputModels)) fail('INVALID_ARGUMENT', 'models 必须是数组');
  if (inputModels.length > MODEL_LIMIT) fail('INVALID_ARGUMENT', `models 最多 ${MODEL_LIMIT} 项`);
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const currentById = new Map(currentModels.map((item) => [item.id, item]));
  const seen = new Set();
  const result = [];

  function append(row, source) {
    if (!row || typeof row.id !== 'string' || !row.id.trim()) {
      fail('INVALID_ARGUMENT', '每个模型必须包含非空 id');
    }
    const id = row.id.trim();
    if (seen.has(id)) fail('INVALID_ARGUMENT', `模型重复：${id}`);
    seen.add(id);
    const catalogItem = byId.get(id);
    const previous = currentById.get(id);
    const enabled = row.enabled === true;
    const ability = integer(row.ability, `models[${id}].ability`, 1, 5);
    const effort = typeof row.effort === 'string' ? row.effort : '';
    if (enabled && (!catalogItem || catalogItem.available === false)) {
      fail('MODEL_UNAVAILABLE', `模型不可用，不能启用：${id}`, { model: id });
    }
    if (catalogItem?.efforts.length && !catalogItem.efforts.includes(effort)) {
      fail('INVALID_EFFORT', `模型不支持该思考强度：${id}`, {
        model: id,
        effort,
        allowed: catalogItem.efforts,
      });
    }
    if (!catalogItem && !previous) {
      if (source === 'catalog') return;
      fail('MODEL_UNAVAILABLE', `模型不在当前目录，不能保存：${id}`, { model: id });
    }
    result.push({ id, enabled, effort, ability });
  }

  for (const row of inputModels) append(row, 'input');
  for (const item of currentModels) {
    if (!seen.has(item.id)) append(item, 'current');
  }
  for (const item of catalog) {
    if (!seen.has(item.id)) {
      append({
        id: item.id,
        enabled: false,
        effort: item.defaultEffort,
        ability: 3,
      }, 'catalog');
    }
  }
  return result;
}

async function acquireLock(lockDir) {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        createdAt: nowIso(),
      }), 'utf8');
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  fail('LOCKED', '另一窗口正在保存模型设置，请稍后重试');
}

function nativeLimitEntries(config) {
  const entries = [{ table: 'agents', present: false }];
  const agents = config.agents;
  if (agents && Object.hasOwn(agents, NATIVE_LIMIT_KEY)) {
    entries[0] = { table: 'agents', present: true, value: agents[NATIVE_LIMIT_KEY] };
  }
  const multiAgent = config.features?.multi_agent_v2;
  if (multiAgent && typeof multiAgent === 'object') {
    entries.push({
      table: 'features.multi_agent_v2',
      present: Object.hasOwn(multiAgent, NATIVE_LIMIT_KEY),
      ...(Object.hasOwn(multiAgent, NATIVE_LIMIT_KEY)
        ? { value: multiAgent[NATIVE_LIMIT_KEY] }
        : {}),
    });
  }
  return entries;
}

function patchNativeLimit(text, table, value, parseToml) {
  const title = `[${table}]`;
  const lines = text.split(/(?<=\n)/);
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== title) continue;
    start = index + 1;
    for (let cursor = start; cursor < lines.length; cursor += 1) {
      if (/^\s*\[/.test(lines[cursor])) {
        end = cursor;
        break;
      }
    }
    break;
  }
  const pattern = new RegExp(`^\\s*${NATIVE_LIMIT_KEY}\\s*=`);
  if (start >= 0) {
    const index = lines.findIndex((line, cursor) => (
      cursor >= start && cursor < end && pattern.test(line)
    ));
    if (index >= 0) {
      if (value === undefined) lines.splice(index, 1);
      else lines[index] = lines[index].replace(/(=\s*)\d+/, (_, prefix) => `${prefix}${value}`);
    } else if (value !== undefined) {
      lines.splice(start, 0, `${NATIVE_LIMIT_KEY} = ${value}\n`);
    }
    const result = lines.join('');
    parseToml(result);
    return result;
  }
  if (value === undefined) return text;
  const result = `${text}${text.endsWith('\n') ? '' : '\n'}\n${title}\n${NATIVE_LIMIT_KEY} = ${value}\n`;
  parseToml(result);
  return result;
}

export function createModelSettings({
  dataDir,
  codexHome,
  legacyDataDir,
  parseToml,
} = {}) {
  const factoryDataDir = path.resolve(dataDir?.trim?.() || defaultDataDir());
  const resolvedCodexHome = path.resolve(codexHome?.trim?.() || defaultCodexHome());
  const requestedLegacyDataDir = legacyDataDir === null
    ? null
    : legacyDataDir?.trim?.() || defaultLegacyDataDir();
  const resolvedLegacyDataDir = requestedLegacyDataDir
    ? path.resolve(requestedLegacyDataDir)
    : null;
  const modelsDir = path.join(factoryDataDir, 'models');
  const settingsFile = path.join(modelsDir, 'settings.json');
  const migrationFile = path.join(modelsDir, 'migration.json');
  const draftsDir = path.join(modelsDir, 'drafts');
  const nativeStateFile = path.join(modelsDir, 'native-limit.json');
  const lockDir = path.join(modelsDir, '.settings.lock');
  const codexConfigFile = path.join(resolvedCodexHome, 'config.toml');

  function parseConfig(text) {
    if (typeof parseToml !== 'function') {
      fail('PARSER_REQUIRED', 'createModelSettings 需要注入 TOML 解析器 parseToml');
    }
    return parseToml(text);
  }

  async function withLock(operation) {
    const release = await acquireLock(lockDir);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  async function readCatalog() {
    let config;
    try {
      config = parseConfig(await fs.readFile(codexConfigFile, 'utf8'));
    } catch (error) {
      fail(
        'CATALOG_UNAVAILABLE',
        `无法读取 Codex 配置：${error.message}`,
        { path: codexConfigFile },
      );
    }
    const declared = typeof config.model_catalog_json === 'string'
      ? config.model_catalog_json.trim()
      : '';
    const catalogFile = declared
      ? path.resolve(resolvedCodexHome, declared)
      : path.join(resolvedCodexHome, 'models_cache.json');
    let raw;
    try {
      raw = await readJson(catalogFile);
    } catch (error) {
      fail(
        'CATALOG_UNAVAILABLE',
        `无法读取模型目录：${error.message}`,
        { path: catalogFile },
      );
    }
    const entries = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.models) ? raw.models : null;
    if (!entries) {
      fail('CATALOG_INVALID', `模型目录格式无效：${catalogFile}`, { path: catalogFile });
    }
    const seen = new Set();
    const catalog = [];
    for (const entry of entries) {
      const normalized = normalizeCatalogEntry(entry);
      if (!normalized || seen.has(normalized.id)) continue;
      seen.add(normalized.id);
      catalog.push(normalized);
    }
    return catalog;
  }

  async function reconcileCatalogLocked(settings, catalog) {
    const reconciled = reconcileCatalogModels(settings.models, catalog);
    const changed = reconciled.removed.length > 0 || reconciled.added.length > 0;
    const previousRevision = settings.revision;
    const next = changed
      ? {
          ...settings,
          revision: previousRevision + 1,
          models: reconciled.models,
        }
      : settings;
    if (changed) await atomicWrite(settingsFile, next);
    return {
      settings: next,
      catalogSync: {
        removed: reconciled.removed,
        added: reconciled.added,
        previousRevision,
        revision: next.revision,
        persisted: changed,
      },
    };
  }

  async function migrateIfNeededLocked() {
    if (await pathExists(settingsFile)) {
      return readJsonOptional(migrationFile);
    }
    if (!resolvedLegacyDataDir) {
      await atomicWrite(settingsFile, DEFAULT_SETTINGS);
      return null;
    }
    const legacySettingsFile = path.join(resolvedLegacyDataDir, 'settings.json');
    const legacyNativeFile = path.join(resolvedLegacyDataDir, 'native-limit.json');
    const legacy = await readJsonOptional(legacySettingsFile);
    if (!legacy) {
      await atomicWrite(settingsFile, DEFAULT_SETTINGS);
      return null;
    }
    const migratedAt = nowIso();
    const backupRoot = path.join(modelsDir, 'migration', migratedAt.replaceAll(':', '-'));
    const settingsBackup = path.join(backupRoot, 'legacy-settings.json');
    await atomicCopy(legacySettingsFile, settingsBackup);
    let nativeLimitBackup = null;
    let nativeLimitHash = null;
    let legacyNativeState = null;
    if (await pathExists(legacyNativeFile)) {
      nativeLimitBackup = path.join(backupRoot, 'legacy-native-limit.json');
      await atomicCopy(legacyNativeFile, nativeLimitBackup);
      legacyNativeState = await readJson(nativeLimitBackup);
      nativeLimitHash = await hashFile(nativeLimitBackup);
      await atomicWrite(nativeStateFile, {
        version: 1,
        source: 'legacy-model-team',
        sourceFile: legacyNativeFile,
        entries: Array.isArray(legacyNativeState.entries) ? legacyNativeState.entries : [],
        applied: null,
      });
    }
    const settings = normalizeSettings(legacy);
    const migration = {
      version: 1,
      status: 'migrated',
      source: legacySettingsFile,
      migratedAt,
      settingsBackup,
      settingsHash: await hashFile(settingsBackup),
      legacyRevision: settings.revision,
      nativeLimitBackup,
      nativeLimitHash,
      nativeLimitSource: legacyNativeState,
      message: '已从模型团队迁移设置；旧数据与原并发记录保留。',
    };
    await atomicWrite(settingsFile, settings);
    await atomicWrite(migrationFile, migration);
    return migration;
  }

  async function readStateUnlocked() {
    const migration = await migrateIfNeededLocked();
    const stored = await readJson(settingsFile);
    const catalog = await readCatalog();
    const reconciled = await reconcileCatalogLocked(normalizeSettings(stored), catalog);
    const settings = reconciled.settings;
    const draft = await recoverableDraft(settings.revision, catalog);
    return {
      settings,
      catalog,
      catalogSync: reconciled.catalogSync,
      draft,
      migration,
    };
  }

  async function readState() {
    return withLock(readStateUnlocked);
  }

  async function preview() {
    const hasFactorySettings = await pathExists(settingsFile);
    const legacySettingsFile = resolvedLegacyDataDir
      ? path.join(resolvedLegacyDataDir, 'settings.json')
      : null;
    const legacyNativeFile = resolvedLegacyDataDir
      ? path.join(resolvedLegacyDataDir, 'native-limit.json')
      : null;
    const legacy = legacySettingsFile ? await readJsonOptional(legacySettingsFile) : undefined;
    const factory = hasFactorySettings ? await readJson(settingsFile) : undefined;
    const source = factory ? 'factory' : legacy ? 'legacy-model-team' : 'default';
    const settings = normalizeSettings(factory || legacy);
    const catalog = await readCatalog();
    const reconciled = reconcileCatalogModels(settings.models, catalog);
    return {
      source,
      settings: {
        ...settings,
        revision: settings.revision
          + (reconciled.removed.length > 0 || reconciled.added.length > 0 ? 1 : 0),
        models: reconciled.models,
      },
      catalog,
      catalogSync: {
        removed: reconciled.removed,
        added: reconciled.added,
        previousRevision: settings.revision,
        revision: settings.revision
          + (reconciled.removed.length > 0 || reconciled.added.length > 0 ? 1 : 0),
        persisted: false,
      },
      migration: await readJsonOptional(migrationFile),
      legacySettingsFile: legacySettingsFile && await pathExists(legacySettingsFile)
        ? legacySettingsFile
        : null,
      legacyNative: legacyNativeFile ? await readJsonOptional(legacyNativeFile) : null,
      currentNative: await (async () => {
        try {
          return nativeLimitEntries(parseConfig(await fs.readFile(codexConfigFile, 'utf8')));
        } catch (error) {
          if (isMissing(error)) return [];
          throw error;
        }
      })(),
      paths: {
        dataDir: factoryDataDir,
        modelsDir,
        settingsFile,
        migrationFile,
        codexConfigFile,
      },
    };
  }

  async function save(input) {
    return withLock(async () => {
      const currentData = await readStateUnlocked();
      const current = currentData.settings;
      integer(input?.revision, 'revision', 0, Number.MAX_SAFE_INTEGER);
      if (input.revision !== current.revision) {
        fail(
          'REVISION_CONFLICT',
          `设置已被其他窗口更新：期望 revision ${input.revision}，当前为 ${current.revision}`,
          { expectedRevision: input.revision, currentRevision: current.revision },
        );
      }
      const inputModes = input.modes && typeof input.modes === 'object'
        ? input.modes
        : { factory: input, team: current.modes.team };
      const modes = {};
      for (const mode of MODE_KEYS) {
        const value = inputModes[mode];
        if (!value || typeof value !== 'object') {
          fail('INVALID_ARGUMENT', `modes.${mode} 必须是对象`);
        }
        if (typeof value.enabled !== 'boolean') {
          fail('INVALID_ARGUMENT', `modes.${mode}.enabled 必须是布尔值`);
        }
        if (typeof value.keepInCurrentChat !== 'boolean') {
          fail('INVALID_ARGUMENT', `modes.${mode}.keepInCurrentChat 必须是布尔值`);
        }
        if (typeof value.disableSubagents !== 'boolean') {
          fail('INVALID_ARGUMENT', `modes.${mode}.disableSubagents 必须是布尔值`);
        }
        modes[mode] = {
          enabled: value.enabled,
          maxAgents: integer(value.maxAgents, `modes.${mode}.maxAgents`, 1, 16),
          keepInCurrentChat: value.keepInCurrentChat,
          disableSubagents: value.disableSubagents,
        };
      }
      const models = stableModels(input.models, current.models, currentData.catalog);
      if (MODE_KEYS.some((mode) => modes[mode].enabled) && !models.some((item) => (
        item.enabled && currentData.catalog.some((entry) => entry.id === item.id && entry.available)
      ))) {
        fail('MODEL_REQUIRED', '开启自动团队前请至少选择一个可用模型');
      }
      const next = {
        revision: current.revision + 1,
        modes,
        models,
      };
      try {
        await syncNativeLimit(next);
        await atomicWrite(settingsFile, next);
      } catch (error) {
        await syncNativeLimit(current).catch(() => {});
        throw error;
      }
      const catalog = currentData.catalog;
      return {
        settings: next,
        catalog,
        catalogSync: {
          removed: [],
          added: [],
          previousRevision: next.revision,
          revision: next.revision,
          persisted: false,
        },
        draft: await recoverableDraft(next.revision, catalog),
        migration: await readJsonOptional(migrationFile),
        message: MODE_KEYS.some((mode) => next.modes[mode].enabled)
          ? '模型设置已保存；仅影响后续派发。'
          : '自动团队已关闭；项目、规则和工作记录仍可管理。',
      };
    });
  }

  async function recoverableDraft(revision, catalog) {
    let names;
    try {
      names = await fs.readdir(draftsDir);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    const visibleIds = new Set(catalog.map((item) => item.id));
    const drafts = [];
    for (const name of names.filter((item) => /^[0-9a-f-]{36}\.json$/i.test(item))) {
      const value = await readJsonOptional(path.join(draftsDir, name));
      if (value?.status !== 'pending' || value?.settings?.revision !== revision) continue;
      const models = Array.isArray(value.settings.models) ? value.settings.models : [];
      if (models.some((item) => !visibleIds.has(item?.id))) continue;
      drafts.push(value);
    }
    return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null;
  }

  function draftFile(draftId) {
    if (typeof draftId !== 'string' || !/^[0-9a-f-]{36}$/i.test(draftId)) {
      fail('INVALID_ARGUMENT', 'draftId 必须是 UUID');
    }
    return path.join(draftsDir, `${draftId}.json`);
  }

  async function saveDraft(input) {
    return withLock(async () => {
      const currentData = await readStateUnlocked();
      const sequence = integer(input?.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER);
      integer(input?.revision, 'revision', 0, Number.MAX_SAFE_INTEGER);
      if (input.revision !== currentData.settings.revision) {
        fail('REVISION_CONFLICT', '正式设置已变化，草稿未覆盖；请刷新后重新核对');
      }
      const file = draftFile(input.draftId);
      const previous = await readJsonOptional(file);
      if (previous && (previous.status !== 'pending' || previous.sequence >= sequence)) {
        return { ...currentData, stored: false };
      }
      const models = stableModels(
        input.models,
        currentData.settings.models,
        currentData.catalog,
      );
      const inputModes = input.modes && typeof input.modes === 'object'
        ? input.modes
        : { factory: input, team: currentData.settings.modes.team };
      const modes = {};
      for (const mode of MODE_KEYS) {
        const value = inputModes[mode] || currentData.settings.modes[mode];
        modes[mode] = {
          enabled: value.enabled === true,
          maxAgents: integer(value.maxAgents, `modes.${mode}.maxAgents`, 1, 16),
          keepInCurrentChat: typeof value.keepInCurrentChat === 'boolean'
            ? value.keepInCurrentChat
            : currentData.settings.modes[mode].keepInCurrentChat,
          disableSubagents: typeof value.disableSubagents === 'boolean'
            ? value.disableSubagents
            : currentData.settings.modes[mode].disableSubagents,
        };
      }
      const settings = {
        revision: currentData.settings.revision,
        modes,
        models,
      };
      const draft = {
        draftId: input.draftId,
        sequence,
        settings,
        status: 'pending',
        updatedAt: nowIso(),
      };
      await atomicWrite(file, draft);
      return {
        ...currentData,
        draft,
        stored: true,
      };
    });
  }

  async function clearDraft({ draftId, sequence, reason = 'discarded' } = {}) {
    return withLock(async () => {
      const file = draftFile(draftId);
      const previous = await readJsonOptional(file);
      if (!previous) return { cleared: true };
      if (previous.sequence !== sequence) return { cleared: false };
      await atomicWrite(file, {
        ...previous,
        status: reason === 'saved' ? 'saved' : 'discarded',
        closedAt: nowIso(),
      });
      return { cleared: true };
    });
  }

  function compact(data, selectedMode = 'factory') {
    const modeName = MODE_KEYS.includes(selectedMode) ? selectedMode : 'factory';
    const settings = data.settings;
    const mode = settings.modes[modeName];
    if (!mode.enabled) return { mode: modeName, enabled: false };
    const available = new Set(data.catalog.filter((item) => item.available).map((item) => item.id));
    const models = settings.models
      .filter((item) => item.enabled && available.has(item.id))
      .map((item, index) => ({
        priority: index + 1,
        model: item.id,
        ...(item.effort ? { reasoning_effort: item.effort } : {}),
        ability: item.ability,
      }));
    return {
      mode: modeName,
      enabled: mode.enabled,
      maxAgents: mode.maxAgents,
      keepInCurrentChat: mode.keepInCurrentChat,
      disableSubagents: mode.disableSubagents,
      models,
    };
  }

  async function syncNativeLimit(settings) {
    let originalText;
    try {
      originalText = await fs.readFile(codexConfigFile, 'utf8');
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const config = parseConfig(originalText);
    let state = await readJsonOptional(nativeStateFile);
    if (!state) {
      state = {
        version: 1,
        source: 'factory',
        entries: nativeLimitEntries(config),
        applied: null,
      };
    }
    const valueFor = (currentConfig, table) => (
      table === 'agents'
        ? currentConfig.agents?.[NATIVE_LIMIT_KEY]
        : currentConfig.features?.multi_agent_v2?.[NATIVE_LIMIT_KEY]
    );
    let text = originalText;
    const appliedConcurrency = nativeConcurrency(settings);
    if (appliedConcurrency !== null) {
      if (state.applied !== null) {
        for (const entry of state.entries) {
          if (valueFor(config, entry.table) !== state.applied) {
            fail('NATIVE_LIMIT_CONFLICT', 'Codex 并发上限已被其他工具修改，未覆盖', {
              table: entry.table,
              expected: state.applied,
              current: valueFor(config, entry.table),
            });
          }
        }
      }
      for (const entry of state.entries) {
        text = patchNativeLimit(text, entry.table, appliedConcurrency, parseConfig);
      }
      await writeNativeConfig(originalText, text, config, appliedConcurrency);
      try {
        await atomicWrite(nativeStateFile, { ...state, applied: appliedConcurrency });
      } catch (error) {
        await atomicWriteText(codexConfigFile, originalText).catch(() => {});
        throw error;
      }
      return;
    }
    if (state.applied === null) return;
    for (const entry of state.entries) {
      if (valueFor(config, entry.table) !== state.applied) {
        fail('NATIVE_LIMIT_CONFLICT', 'Codex 并发上限已被其他工具修改，未恢复原值', {
          table: entry.table,
          expected: state.applied,
          current: valueFor(config, entry.table),
        });
      }
    }
    for (const entry of state.entries) {
      text = patchNativeLimit(
        text,
        entry.table,
        entry.present ? entry.value : undefined,
        parseConfig,
      );
    }
    await writeNativeConfig(originalText, text, config, undefined);
    try {
      await atomicWrite(nativeStateFile, { ...state, applied: null });
    } catch (error) {
      await atomicWriteText(codexConfigFile, originalText).catch(() => {});
      throw error;
    }
  }

  async function restoreNativeLimit() {
    return withLock(async () => {
      const data = await readStateUnlocked();
      await syncNativeLimit({
        ...data.settings,
        modes: Object.fromEntries(MODE_KEYS.map((mode) => [
          mode,
          { ...data.settings.modes[mode], enabled: false },
        ])),
      });
      return {
        restored: true,
        settingsRevision: data.settings.revision,
      };
    });
  }

  async function claimNativeLimit() {
    return withLock(async () => {
      const data = await readStateUnlocked();
      await syncNativeLimit(data.settings);
      return {
        claimed: true,
        enabled: MODE_KEYS.some((mode) => data.settings.modes[mode].enabled),
        maxAgents: nativeConcurrency(data.settings),
      };
    });
  }

  function withoutManagedLimits(config) {
    const value = structuredClone(config);
    if (value.agents && Object.hasOwn(value.agents, NATIVE_LIMIT_KEY)) {
      delete value.agents[NATIVE_LIMIT_KEY];
    }
    if (value.agents && Object.keys(value.agents).length === 0) delete value.agents;
    if (value.features?.multi_agent_v2
      && Object.hasOwn(value.features.multi_agent_v2, NATIVE_LIMIT_KEY)) {
      delete value.features.multi_agent_v2[NATIVE_LIMIT_KEY];
    }
    if (value.features?.multi_agent_v2
      && Object.keys(value.features.multi_agent_v2).length === 0) {
      delete value.features.multi_agent_v2;
    }
    if (value.features && Object.keys(value.features).length === 0) delete value.features;
    return value;
  }

  async function writeNativeConfig(originalText, nextText, originalConfig, appliedValue) {
    if (nextText === originalText) return;
    const latestText = await fs.readFile(codexConfigFile, 'utf8');
    if (latestText !== originalText) {
      fail('NATIVE_LIMIT_CONFLICT', 'Codex 配置发生并发变化，未保存并发上限');
    }
    const nextConfig = parseConfig(nextText);
    const originalOutside = stableJson(withoutManagedLimits(originalConfig));
    const nextOutside = stableJson(withoutManagedLimits(nextConfig));
    if (originalOutside !== nextOutside) {
      fail('NATIVE_LIMIT_CONFLICT', 'Codex 配置的并发上限以外字段发生变化，未保存', {
        originalOutside,
        nextOutside,
      });
    }
    const backupRoot = path.join(modelsDir, 'native-backups');
    await fs.mkdir(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, `${nowIso().replaceAll(':', '-')}-${randomToken()}.toml`);
    await atomicCopy(codexConfigFile, backup);
    await atomicWriteText(codexConfigFile, nextText);
    const written = parseConfig(await fs.readFile(codexConfigFile, 'utf8'));
    const actual = appliedValue === undefined
      ? {
          agents: written.agents?.[NATIVE_LIMIT_KEY],
          multi: written.features?.multi_agent_v2?.[NATIVE_LIMIT_KEY],
        }
      : {
          agents: written.agents?.[NATIVE_LIMIT_KEY],
          multi: written.features?.multi_agent_v2?.[NATIVE_LIMIT_KEY],
        };
    if (appliedValue !== undefined
      && Object.values(actual).some((value) => value !== undefined && value !== appliedValue)) {
      await atomicWriteText(codexConfigFile, originalText).catch(() => {});
      fail('NATIVE_LIMIT_WRITE_FAILED', 'Codex 并发上限写入后校验失败');
    }
  }

  return {
    dataDir: factoryDataDir,
    codexHome: resolvedCodexHome,
    legacyDataDir: resolvedLegacyDataDir,
    read: readState,
    preview,
    save,
    saveDraft,
    clearDraft,
    compact,
    syncNativeLimit,
    claimNativeLimit,
    restoreNativeLimit,
  };
}

export { DEFAULT_MODES, DEFAULT_SETTINGS, MODE_KEYS };
