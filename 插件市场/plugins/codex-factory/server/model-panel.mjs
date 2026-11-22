const TOOL_UI_READ = 'factory_models_ui';
const TOOL_SAVE = 'factory_models_save';
const TOOL_DRAFT_SAVE = 'factory_models_draft_save';
const TOOL_DRAFT_CLEAR = 'factory_models_draft_clear';

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

function textFromResult(result) {
  if (result?.isError) {
    const message = result.content?.find((item) => item.type === 'text')?.text || '模型设置操作失败';
    throw new Error(message);
  }
  if (result?._meta?.factoryModels) return result._meta.factoryModels;
  if (result?.structuredContent?.factoryModels) return result.structuredContent.factoryModels;
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeCatalogItem(item) {
  const id = String(item?.id || item?.model || item?.slug || '').trim();
  if (!id) return null;
  const efforts = stringList(
    item.efforts
      || item.reasoning_efforts
      || item.reasoningEfforts
      || item.supported_reasoning_efforts
      || item.supportedEfforts,
  );
  const status = String(item.status || '').toLowerCase();
  const available = item.available !== false
    && item.unavailable !== true
    && !['unavailable', 'missing', 'disabled', 'invalid'].includes(status);
  return {
    id,
    name: String(item.name || item.displayName || item.display_name || id),
    provider: String(item.provider || ''),
    available,
    efforts,
    defaultEffort: String(
      item.defaultEffort
        || item.default_effort
        || item.default_reasoning_effort
        || item.effort
        || '',
    ),
  };
}

function normalizeSavedModel(item) {
  const id = String(item?.id || item?.model || '').trim();
  if (!id) return null;
  return {
    id,
    enabled: item.enabled === true,
    effort: String(item.effort ?? item.reasoning_effort ?? ''),
    ability: normalizeInteger(item.ability, 3, 1, 5),
  };
}

function normalizeMode(value, defaults) {
  const source = value || {};
  return {
    enabled: normalizeBoolean(source.enabled, defaults.enabled),
    maxAgents: normalizeInteger(source.maxAgents, defaults.maxAgents, 1, 16),
    keepInCurrentChat: normalizeBoolean(source.keepInCurrentChat, defaults.keepInCurrentChat),
    disableSubagents: normalizeBoolean(source.disableSubagents, defaults.disableSubagents),
  };
}

function normalizeSettings(value) {
  const source = value || {};
  return {
    revision: normalizeInteger(source.revision, DEFAULT_SETTINGS.revision, 0, Number.MAX_SAFE_INTEGER),
    modes: Object.fromEntries(MODE_KEYS.map((mode) => [
      mode,
      normalizeMode(source.modes?.[mode], DEFAULT_MODES[mode]),
    ])),
    models: Array.isArray(source.models) ? source.models.map(normalizeSavedModel).filter(Boolean) : [],
  };
}

function normalizeDraft(value) {
  if (!value) return null;
  const settings = normalizeSettings(value.settings || value);
  return {
    draftId: String(value.draftId || value.id || ''),
    sequence: normalizeInteger(value.sequence, 0, 0, Number.MAX_SAFE_INTEGER),
    settings,
    status: String(value.status || 'pending'),
    updatedAt: value.updatedAt || value.updated_at || '',
  };
}

function moveItem(items, sourceId, targetId, after = false) {
  if (sourceId === targetId) return false;
  const source = items.findIndex((item) => item.id === sourceId);
  const target = items.findIndex((item) => item.id === targetId);
  if (source < 0 || target < 0) return false;
  let destination = target + (after ? 1 : 0);
  if (source < destination) destination -= 1;
  if (destination === source) return false;
  const [item] = items.splice(source, 1);
  items.splice(destination, 0, item);
  return true;
}

export function createModelSettingsPanel({
  app,
  $,
  setBusy,
  getMode = () => 'factory',
  onChange = () => {},
  confirmAction = (message) => window.confirm(message),
}) {
  let state = null;
  let rows = [];
  let dirty = false;
  let busy = false;
  let draftId = crypto.randomUUID();
  let draftSequence = 0;
  let draftQueue = Promise.resolve(true);
  let draftTimer = null;
  let recoveredDraft = null;
  let dragId = null;
  let dragOver = null;
  const activeMode = () => MODE_KEYS.includes(getMode()) ? getMode() : 'factory';

  const message = (text, type = '') => {
    const element = $('modelSettingsMessage');
    element.textContent = text;
    element.className = `model-dialog-message ${type}`.trim();
  };

  function statusBadge() {
    const badge = $('modelSettingsStatus');
    if (!state) {
      badge.hidden = true;
      badge.replaceChildren();
      return;
    }
    badge.hidden = false;
    const enabled = state.settings.modes[activeMode()].enabled;
    badge.textContent = `${enabled ? '已开启' : '已关闭'}${dirty ? ' · 待保存' : ''}`;
    badge.className = `badge ${enabled ? 'done' : 'closed'}`;
  }

  function setEditable(value) {
    busy = !value;
    const disabled = busy || !state;
    for (const id of [
      'modelEnabled',
      'modelKeepInCurrentChat',
      'modelDisableSubagents',
      'modelMaxAgents',
      'modelSearch',
      'refreshModelSettings',
      'saveModelSettings',
      'restoreModelDraft',
      'discardModelDraft',
    ]) {
      $(id).disabled = disabled;
    }
    for (const control of document.querySelectorAll('#modelRows input,#modelRows select,#modelRows button')) {
      if (!value) {
        control.dataset.modelBusyDisabled = String(control.disabled);
        control.disabled = true;
      } else if ('modelBusyDisabled' in control.dataset) {
        control.disabled = control.dataset.modelBusyDisabled === 'true';
        delete control.dataset.modelBusyDisabled;
      }
    }
  }

  function snapshot() {
    const mode = activeMode();
    const modes = structuredClone(state?.settings?.modes || DEFAULT_MODES);
    modes[mode] = {
      enabled: $('modelEnabled').checked,
      maxAgents: Number($('modelMaxAgents').value),
      keepInCurrentChat: $('modelKeepInCurrentChat').checked,
      disableSubagents: $('modelDisableSubagents').checked,
    };
    return {
      revision: state?.settings?.revision ?? 0,
      modes,
      models: rows.map(({ id, enabled, effort, ability }) => ({ id, enabled, effort, ability })),
    };
  }

  function availableModels() {
    return rows
      .filter((row) => row.enabled && row.available)
      .map(({ id, name }) => ({ id, name }));
  }

  function publicData() {
    return state
      ? {
        settings: snapshot(),
        catalog: state.catalog,
        availableModels: availableModels(),
      }
      : {
        settings: structuredClone(DEFAULT_SETTINGS),
        catalog: [],
        availableModels: [],
      };
  }

  function notifyChange() {
    onChange(publicData());
  }

  function buildRows(settings, catalog) {
    const catalogById = new Map(catalog.map((item) => [item.id, item]));
    const saved = settings.models;
    const order = [
      ...saved.map((item) => item.id),
      ...catalog.map((item) => item.id),
    ].filter((id, index, all) => all.indexOf(id) === index);
    return order.map((id) => {
      const catalogItem = catalogById.get(id) || {
        id,
        name: id,
        provider: '',
        available: false,
        efforts: [],
        defaultEffort: '',
      };
      const savedItem = saved.find((item) => item.id === id) || {
        id,
        enabled: false,
        effort: catalogItem.defaultEffort,
        ability: 3,
      };
      return {
        ...catalogItem,
        enabled: savedItem.enabled,
        effort: savedItem.effort || catalogItem.defaultEffort,
        ability: savedItem.ability,
      };
    });
  }

  function effortOptions(row) {
    const values = [...row.efforts];
    if (row.effort && !values.includes(row.effort)) values.unshift(row.effort);
    if (values.length === 0) values.push('');
    return values;
  }

  function cell(row) {
    const element = document.createElement('td');
    row.append(element);
    return element;
  }

  function stopDrag() {
    dragId = null;
    if (dragOver) {
      dragOver.classList.remove('drop-before', 'drop-after');
      dragOver = null;
    }
    for (const element of document.querySelectorAll('.drag-source')) {
      element.classList.remove('drag-source');
    }
  }

  function changed() {
    dirty = true;
    statusBadge();
    message('有未保存的修改，正在暂存草稿…');
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      queueDraft().catch(() => {});
    }, 250);
    notifyChange();
  }

  function render() {
    const body = $('modelRows');
    body.replaceChildren();
    const query = $('modelSearch').value.trim().toLowerCase();
    rows.forEach((row, index) => {
      if (query && !`${row.name} ${row.id} ${row.provider}`.toLowerCase().includes(query)) return;
      const tr = document.createElement('tr');
      tr.dataset.modelId = row.id;

      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = row.enabled;
      enabled.disabled = !row.available;
      enabled.setAttribute('aria-label', `启用 ${row.id}`);
      enabled.onchange = () => {
        row.enabled = enabled.checked;
        changed();
      };
      cell(tr).append(enabled);

      const order = document.createElement('div');
      order.className = 'model-order';
      const number = document.createElement('span');
      number.textContent = String(index + 1).padStart(2, '0');
      order.append(number);
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'drag-handle';
      handle.draggable = true;
      handle.textContent = '⠿';
      handle.title = '按住拖动排序，也可用 Alt + ↑ / ↓ 微调';
      handle.setAttribute('aria-label', `拖动排序 ${row.id}`);
      handle.ondragstart = (event) => {
        if (busy) {
          event.preventDefault();
          return;
        }
        dragId = row.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', row.id);
        requestAnimationFrame(() => {
          if (dragId === row.id) tr.classList.add('drag-source');
        });
      };
      handle.ondragend = stopDrag;
      handle.onkeydown = (event) => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || busy) return;
        event.preventDefault();
        const delta = event.key === 'ArrowUp' ? -1 : 1;
        if (!rows[index + delta]) return;
        [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]];
        changed();
        render();
        [...document.querySelectorAll('.drag-handle')]
          .find((button) => button.getAttribute('aria-label') === `拖动排序 ${row.id}`)
          ?.focus();
      };
      order.append(handle);
      tr.ondragover = (event) => {
        if (!dragId || busy) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (dragOver && dragOver !== tr) {
          dragOver.classList.remove('drop-before', 'drop-after');
        }
        if (dragId === row.id) return;
        const rect = tr.getBoundingClientRect();
        tr.classList.remove('drop-before', 'drop-after');
        tr.classList.add(event.clientY > rect.top + rect.height / 2 ? 'drop-after' : 'drop-before');
        dragOver = tr;
      };
      tr.ondragleave = (event) => {
        if (!tr.contains(event.relatedTarget) && dragOver === tr) {
          tr.classList.remove('drop-before', 'drop-after');
          dragOver = null;
        }
      };
      tr.ondrop = (event) => {
        if (!dragId || busy) return;
        event.preventDefault();
        const source = dragId;
        const rect = tr.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        stopDrag();
        if (moveItem(rows, source, row.id, after)) {
          changed();
          render();
        }
      };
      for (const [symbol, delta] of [['↑', -1], ['↓', 1]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'arrow';
        button.textContent = symbol;
        button.setAttribute('aria-label', `${delta < 0 ? '上移' : '下移'} ${row.id}`);
        button.disabled = index + delta < 0 || index + delta >= rows.length;
        button.onclick = () => {
          [rows[index], rows[index + delta]] = [rows[index + delta], rows[index]];
          changed();
          render();
        };
        order.append(button);
      }
      cell(tr).append(order);

      const name = document.createElement('div');
      name.className = 'model-name';
      name.textContent = row.name;
      name.title = row.name;
      const id = document.createElement('div');
      id.className = `model-id${row.available ? '' : ' unavailable'}`;
      id.textContent = row.available ? row.id : `${row.id}（不可用，保留原设置）`;
      cell(tr).append(name, id);

      const effort = document.createElement('select');
      effort.setAttribute('aria-label', `思考强度 ${row.id}`);
      for (const value of effortOptions(row)) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value || '模型默认';
        effort.append(option);
      }
      effort.value = row.effort;
      effort.onchange = () => {
        row.effort = effort.value;
        changed();
      };
      cell(tr).append(effort);

      const ability = document.createElement('select');
      ability.setAttribute('aria-label', `能力等级 ${row.id}`);
      for (let value = 1; value <= 5; value += 1) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = `${value} 级`;
        ability.append(option);
      }
      ability.value = String(row.ability);
      ability.onchange = () => {
        row.ability = Number(ability.value);
        changed();
      };
      cell(tr).append(ability);
      body.append(tr);
    });

    if (!body.children.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state?.catalog?.length ? '没有匹配的模型' : '模型目录为空';
      td.append(empty);
      tr.append(td);
      body.append(tr);
    }
    $('modelSelected').textContent = `${rows.filter((row) => row.enabled).length} 个`;
    const teamMode = activeMode() === 'team';
    const modeLabel = teamMode ? '团队' : '软件工厂';
    $('modelEnabledLabel').textContent = `${modeLabel}启用`;
    $('modelKeepLabel').textContent = teamMode ? '在当前聊天工作' : '不开新对话';
    $('modelKeepHint').textContent = teamMode
      ? '团队默认由主对话直接完成，不额外创建独立工作对话。'
      : '在当前聊天内工作，不额外创建独立工作对话。';
    $('modelDisableLabel').textContent = teamMode ? '不使用一层助手' : '不使用子代理';
    $('modelDisableHint').textContent = teamMode
      ? '关闭后由主对话完成核心工作和一般辅助。'
      : '可创建或继续一层独立工作对话，但不创建子代理。';
    $('modelMaxAgentsLabel').textContent = teamMode ? '同时助手上限' : '并行工作上限';
    $('modelMaxAgentsHint').textContent = teamMode
      ? '只限制团队模式后续创建的一层助手。'
      : '只限制软件工厂模式后续并行工作对话；不表示会开满。';
    $('modelEnabledHint').textContent = $('modelEnabled').checked
      ? `${modeLabel}模式已开启；只影响后续派发，正在运行的会话继续。`
      : `${modeLabel}模式当前关闭；保存后不再新派发，现有记录与运行会话继续。`;
    statusBadge();
    setEditable(!busy);
  }

  function populate(settings) {
    const mode = settings.modes[activeMode()];
    $('modelEnabled').checked = mode.enabled;
    $('modelMaxAgents').value = String(mode.maxAgents);
    $('modelKeepInCurrentChat').checked = mode.keepInCurrentChat;
    $('modelDisableSubagents').checked = mode.disableSubagents;
    rows = buildRows(settings, state.catalog);
  }

  function apply(data) {
    if (!data || !data.settings || !Array.isArray(data.catalog)) {
      throw new Error('未收到完整的模型设置与目录，请刷新重试');
    }
    state = {
      settings: normalizeSettings(data.settings),
      catalog: data.catalog.map(normalizeCatalogItem).filter(Boolean),
      migration: data.migration || null,
    };
    populate(state.settings);
    dirty = false;
    recoveredDraft = normalizeDraft(data.draft);
    $('modelDraftBanner').hidden = !recoveredDraft;
    if (recoveredDraft) {
      const at = recoveredDraft.updatedAt ? new Date(recoveredDraft.updatedAt).toLocaleString() : '未知时间';
      $('modelDraftHint').textContent = `暂存于 ${at}；恢复后仍需保存才会生效。`;
    }
    render();
    const removed = Array.isArray(data.catalogSync?.removed) ? data.catalogSync.removed : [];
    const added = Array.isArray(data.catalogSync?.added) ? data.catalogSync.added : [];
    const syncParts = [];
    if (removed.length) syncParts.push(`移除 ${removed.length} 个目录中已不存在的模型`);
    if (added.length) syncParts.push(`补入 ${added.length} 个新模型并默认关闭`);
    message(
      syncParts.length
        ? `已跟随 Codex 模型目录同步：${syncParts.join('；')}。`
        : data.migration?.message
          || (state.settings.modes[activeMode()].enabled
            ? '模型设置已读取。'
            : `${activeMode() === 'team' ? '团队' : '软件工厂'}模式已关闭；已有记录仍可使用。`),
      'ok',
    );
    notifyChange();
  }

  async function callTool(name, args = {}) {
    return textFromResult(await app.callServerTool({ name, arguments: args }));
  }

  async function read() {
    setEditable(false);
    try {
      apply(await callTool(TOOL_UI_READ, {}));
      return true;
    } catch (error) {
      message(`读取失败：${error.message}`, 'error');
      return false;
    } finally {
      setEditable(true);
    }
  }

  async function queueDraft() {
    if (!dirty || !state) return true;
    const input = snapshot();
    const maxAgents = input.modes[activeMode()].maxAgents;
    if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > 16) {
      message('并发上限应为 1–16；当前修改尚未暂存。', 'error');
      return false;
    }
    const activeDraftId = draftId;
    const sequence = ++draftSequence;
    draftQueue = draftQueue
      .catch(() => false)
      .then(async () => {
        try {
          const result = await callTool(TOOL_DRAFT_SAVE, {
            ...input,
            draftId: activeDraftId,
            sequence,
          });
          if (result?.stored === false) {
            throw new Error('草稿版本冲突，请刷新后重新编辑');
          }
          if (dirty && activeDraftId === draftId && sequence === draftSequence) {
            message('草稿已暂存，点击“保存设置”后正式生效。', 'ok');
          }
          return true;
        } catch (error) {
          if (dirty && activeDraftId === draftId && sequence === draftSequence) {
            message(`草稿暂存失败：${error.message}；请勿关闭页面。`, 'error');
          }
          return false;
        }
      });
    return draftQueue;
  }

  async function save() {
    if (busy || !state) return false;
    clearTimeout(draftTimer);
    setBusy(true);
    setEditable(false);
    try {
      await draftQueue;
      const data = await callTool(TOOL_SAVE, snapshot());
      apply(data);
      const previousDraftId = draftId;
      const previousSequence = draftSequence;
      draftId = crypto.randomUUID();
      draftSequence = 0;
      if (previousSequence > 0) {
        try {
          await callTool(TOOL_DRAFT_CLEAR, {
            draftId: previousDraftId,
            sequence: previousSequence,
            reason: 'saved',
          });
        } catch {
          // The new revision makes the old draft non-restorable.
        }
      }
      message(data.message || '模型设置已保存；仅影响后续分派。', 'ok');
      return true;
    } catch (error) {
      message(
        /REVISION_CONFLICT|revision|其他窗口|版本冲突/i.test(error.message)
          ? `设置已被其他窗口更新：${error.message}。当前编辑已保留，请刷新核对后再保存。`
          : `保存失败：${error.message}`,
        'error',
      );
      return false;
    } finally {
      setEditable(true);
      setBusy(false);
    }
  }

  async function discardDraft(identity = recoveredDraft) {
    if (!identity?.draftId) return false;
    try {
      const result = await callTool(TOOL_DRAFT_CLEAR, {
        draftId: identity.draftId,
        sequence: identity.sequence,
        reason: 'discarded',
      });
      if (result?.cleared === false) {
        message('草稿已在其他窗口变化；请重新读取后再处理。', 'error');
        return false;
      }
      recoveredDraft = null;
      $('modelDraftBanner').hidden = true;
      return true;
    } catch (error) {
      message(`无法处理草稿：${error.message}`, 'error');
      return false;
    }
  }

  async function refresh() {
    if (dirty && !confirmAction('放弃尚未保存的修改并重新读取模型设置？')) return false;
    clearTimeout(draftTimer);
    setBusy(true);
    setEditable(false);
    try {
      await draftQueue;
      if (dirty && draftSequence > 0) {
        const cleared = await discardDraft({ draftId, sequence: draftSequence });
        if (!cleared) return false;
      }
      draftId = crypto.randomUUID();
      draftSequence = 0;
      dirty = false;
      return await read();
    } catch (error) {
      message(`刷新失败：${error.message}`, 'error');
      return false;
    } finally {
      setEditable(true);
      setBusy(false);
    }
  }

  async function restoreDraft() {
    if (!recoveredDraft || busy) return false;
    if (dirty && !confirmAction('用暂存草稿替换当前未保存的修改？')) return false;
    const original = recoveredDraft;
    populate(original.settings);
    recoveredDraft = null;
    $('modelDraftBanner').hidden = true;
    dirty = true;
    draftId = crypto.randomUUID();
    draftSequence = 0;
    render();
    message('草稿已恢复到表单；保存后才会生效。', 'ok');
    if (await queueDraft()) await discardDraft(original);
    return true;
  }

  $('modelSettingsForm').onsubmit = (event) => {
    event.preventDefault();
    save();
  };
  $('modelEnabled').onchange = () => {
    render();
    changed();
  };
  $('modelKeepInCurrentChat').onchange = changed;
  $('modelDisableSubagents').onchange = changed;
  $('modelMaxAgents').oninput = changed;
  $('modelSearch').oninput = render;
  $('refreshModelSettings').onclick = refresh;
  $('restoreModelDraft').onclick = restoreDraft;
  $('discardModelDraft').onclick = async () => {
    setEditable(false);
    try {
      if (await discardDraft()) message('已丢弃这份草稿，正式设置未改变。', 'ok');
    } finally {
      setEditable(true);
    }
  };
  document.addEventListener('dragover', (event) => {
    if (dragId) event.preventDefault();
  });
  document.addEventListener('drop', stopDrag);
  document.addEventListener('dragend', stopDrag);

  return {
    async open() {
      if (busy || $('modelSettingsDialog').open) return;
      if (!state || !dirty) await read();
      if (!busy && !$('modelSettingsDialog').open) $('modelSettingsDialog').showModal();
    },
    refresh,
    save,
    accept(data) {
      apply(data);
    },
    get data() {
      return publicData();
    },
    availableModels,
    statusBadge,
    setEditable,
  };
}
