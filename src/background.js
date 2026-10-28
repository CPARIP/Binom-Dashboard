import { fetchCatalogs, fetchDashboard, fetchCampaigns, fetchCampaignCharts, fetchCampaignOverview, fetchInsights, fetchTrackerTimezone, validateInsightSections, validateCampaignIds, validateQuery } from './api.js';
import { fetchClicklog } from './clicklog-api.js';
import {
  DEFAULT_PREFERENCES, SecurityError, hostPermissionPattern, isContentSender,
  isOptionsSender, isPlainRecord, publicError, validateConnection,
  validatePreferences, validateSavedConfig, validateApiKey,
} from './security.js';
import { encryptApiKey, decryptApiKey, validateVault } from './vault.js';
import { injectsIntoOpenTabs } from './updates.js';

const SCRIPT_ID = 'binom-dashboard';
const OPTIONS_URL = chrome.runtime.getURL('options.html');
const POPUP_URL = chrome.runtime.getURL('popup.html');
let connectionGeneration = 0;
let connectionChanging = false;
let mutationTail = Promise.resolve();
const CONNECTION_KEYS = ['config', 'preferences', 'keyVault', 'credentialId'];
let messageSequence = 0;
// Only browser document identities and request counters live here, never keys,
// URLs, report contents or connection settings. Different report kinds may overlap.
const contentDocuments = new Map();

// Only ciphertext persists locally. Neither storage area is exposed to content scripts.
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);

function serializeMutation(operation) {
  const pending = mutationTail.then(operation, operation);
  mutationTail = pending.catch(() => {});
  return pending;
}

async function readState() {
  await ready;
  const [local, session] = await Promise.all([
    chrome.storage.local.get(CONNECTION_KEYS),
    chrome.storage.session.get('apiKey'),
  ]);
  let config = null;
  let preferences = { ...DEFAULT_PREFERENCES, metrics: [...DEFAULT_PREFERENCES.metrics] };
  try { if (local.config) config = validateSavedConfig(local.config); } catch { /* Invalid stored state is disconnected. */ }
  try { if (local.preferences) preferences = { ...preferences, ...validatePreferences(local.preferences) }; }
  catch {
    // An unreadable stored filter must not reset the language and metrics too.
    try {
      const { dashboardQuery: _unreadable, ...rest } = local.preferences;
      preferences = { ...preferences, ...validatePreferences(rest) };
    } catch { /* Use safe defaults. */ }
  }
  let vault = null;
  const hasSavedKey = Boolean(local.keyVault);
  try {
    if (config && hasSavedKey) {
      vault = validateVault(local.keyVault, config.origin);
      if (vault.credentialId !== local.credentialId) vault = null;
    }
  } catch { /* A corrupt vault must never be decrypted or silently overwritten. */ }
  // Bind both origin and credential generation, including same-site replacements.
  // Older session-only installs have neither id; accept them until explicit reconnect.
  const credentialMatches = Object.hasOwn(local, 'credentialId')
    ? typeof local.credentialId === 'string' && session.apiKey?.credentialId === local.credentialId
    : !Object.hasOwn(session.apiKey || {}, 'credentialId');
  let key = null;
  if (config && isPlainRecord(session.apiKey) && session.apiKey.origin === config.origin && credentialMatches) {
    try { key = validateApiKey(session.apiKey.key); } catch { /* Invalid session key stays locked. */ }
  }
  return { config, preferences, key, vault, hasSavedKey, credentialId: local.credentialId };
}

function statusOf(state) {
  return {
    configured: Boolean(state.config),
    hasKey: Boolean(state.key),
    hasSavedKey: state.hasSavedKey,
    keyStorage: state.hasSavedKey ? 'encrypted' : 'session',
    locked: Boolean(state.config && state.hasSavedKey && !state.key),
    config: state.config,
    preferences: state.preferences,
  };
}

function requireOptions(sender) {
  if (!isOptionsSender(sender, chrome.runtime.id, OPTIONS_URL)) throw new SecurityError('ACCESS_DENIED');
}

function isControlSender(sender) {
  return isOptionsSender(sender, chrome.runtime.id, OPTIONS_URL)
    || isOptionsSender(sender, chrome.runtime.id, POPUP_URL);
}

function requireContent(sender, config) {
  if (!config) throw new SecurityError('NOT_CONNECTED');
  if (!isContentSender(sender, chrome.runtime.id, config.origin)) throw new SecurityError('ACCESS_DENIED');
}

// Call only after requireContent: an unrelated page must not cancel valid reads.
function observeContentDocument(sender, sequence) {
  const tabId = sender.tab.id;
  const documentId = typeof sender.documentId === 'string' ? sender.documentId : null;
  let document = contentDocuments.get(tabId);
  if (!document || document.id !== documentId) {
    // Storage/permission awaits may resolve in a different order from messages.
    if (document && sequence < document.sequence) throw new SecurityError('SETTINGS_CHANGED');
    document = { id: documentId, sequence, latest: new Map(), active: new Map() };
    contentDocuments.set(tabId, document);
  }
  return document;
}

function beginContentRead(sender, type, sequence, generation) {
  const tabId = sender.tab.id;
  const document = observeContentDocument(sender, sequence);
  if (sequence < (document.latest.get(type) ?? 0)) throw new SecurityError('SETTINGS_CHANGED');
  const token = {};
  document.latest.set(type, sequence);
  document.active.set(type, token);
  return {
    assertCurrent() {
      if (connectionChanging || generation !== connectionGeneration ||
          contentDocuments.get(tabId) !== document || document.active.get(type) !== token) {
        throw new SecurityError('SETTINGS_CHANGED');
      }
    },
    finish() {
      // An old completion must never remove its replacement's token.
      if (document.active.get(type) === token) document.active.delete(type);
    },
  };
}

async function hasHostPermission(origin) {
  return chrome.permissions.contains({ origins: [hostPermissionPattern(origin)] });
}

async function unregisterPanel() {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
}

async function registerPanel(origin) {
  await unregisterPanel();
  await chrome.scripting.registerContentScripts([{
    id: SCRIPT_ID,
    matches: [hostPermissionPattern(origin)],
    js: ['content.js'],
    allFrames: false,
    runAt: 'document_idle',
    persistAcrossSessions: true,
    world: 'ISOLATED',
  }]);
}

async function matchingTabs(origin) {
  if (!origin) return [];
  const tabs = await chrome.tabs.query({ url: hostPermissionPattern(origin) });
  return tabs.filter((tab) => {
    try { return Number.isInteger(tab.id) && new URL(tab.url).origin === origin; }
    catch { return false; }
  });
}

async function notifyTabs(origin, configured) {
  const tabs = await matchingTabs(origin);
  await Promise.allSettled(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, {
    type: 'BINOM_CONFIG_CHANGED', configured,
  }, { frameId: 0 })));
}

async function notifyPreferences(origin) {
  const tabs = await matchingTabs(origin);
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, {
    type: 'BINOM_PREFERENCES_CHANGED',
  }, { frameId: 0 })));
}

async function injectExistingTabs(origin) {
  const tabs = await matchingTabs(origin);
  // The content entrypoint has an idempotency guard; frames receive no secret.
  await Promise.allSettled(tabs.map((tab) => chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    files: ['content.js'],
    world: 'ISOLATED',
  })));
}

async function removeUnusedHostPermissions(keepOrigin = null) {
  const permissions = await chrome.permissions.getAll();
  const keep = keepOrigin ? hostPermissionPattern(keepOrigin) : null;
  const remove = (permissions.origins || []).filter((pattern) => pattern.startsWith('https://') && pattern !== keep);
  if (remove.length) await chrome.permissions.remove({ origins: remove });
}

async function connect(payload, sender) {
  requireOptions(sender);
  const connection = {};
  for (const field of ['origin', 'campaignsPath', 'key']) {
    if (Object.hasOwn(payload, field)) connection[field] = payload[field];
  }
  const { config, key } = validateConnection(connection);
  const mode = payload.storageMode ?? 'session';
  if (!['session', 'encrypted'].includes(mode)) throw new SecurityError('INVALID_MESSAGE');
  if (!await hasHostPermission(config.origin)) throw new SecurityError('PERMISSION_REQUIRED');
  const previous = await readState();
  const credentialId = crypto.randomUUID();
  // Derive/encrypt before changing any working connection. Password is never stored.
  const vault = mode === 'encrypted'
    ? await encryptApiKey({ key, origin: config.origin, password: payload.password, credentialId }) : null;
  // Resolve Binom's setting before replacing any working configuration or key.
  // The options page cannot supply a timezone or a fallback value.
  config.timezone = await fetchTrackerTimezone({ origin: config.origin, key });
  if (!await hasHostPermission(config.origin)) throw new SecurityError('PERMISSION_REQUIRED');
  const snapshot = await chrome.storage.local.get(CONNECTION_KEYS);
  connectionGeneration += 1;
  connectionChanging = true;
  try {
    await chrome.storage.session.remove('apiKey');
    let preferences = previous.config?.origin === config.origin
      ? previous.preferences : { ...DEFAULT_PREFERENCES, metrics: [...DEFAULT_PREFERENCES.metrics], language: previous.preferences.language };
    // A locked previous key cannot prove the same API user's permissions.
    if (previous.config && previous.key !== key) {
      // Another key can see other groups and sources: drop the stored filters too.
      const { dashboardQuery: _previousFilters, ...rest } = preferences;
      preferences = { ...rest, campaignIds: [], savedSelections: [], mode: 'overview' };
    }
    await chrome.storage.local.set({ config, preferences, credentialId, keyVault: vault });
    if (!vault) await chrome.storage.local.remove('keyVault');
    await chrome.storage.session.set({ apiKey: { origin: config.origin, key, credentialId } });
    await registerPanel(config.origin);
  } catch {
    // Restore the previous encrypted connection on failed replacement. If rollback
    // itself fails, stay locked; never retain a new key with old settings.
    await chrome.storage.session.remove('apiKey').catch(() => {});
    try {
      await chrome.storage.local.set(snapshot);
      const absent = CONNECTION_KEYS.filter(name => !Object.hasOwn(snapshot, name));
      if (absent.length) await chrome.storage.local.remove(absent);
      if (previous.config && await hasHostPermission(previous.config.origin)) await registerPanel(previous.config.origin);
      else await unregisterPanel();
      if (previous.key) await chrome.storage.session.set({ apiKey: {
        origin: previous.config.origin, key: previous.key,
        ...(previous.credentialId ? { credentialId: previous.credentialId } : {}),
      } });
    } catch { await chrome.storage.session.remove('apiKey').catch(() => {}); }
    connectionGeneration += 1;
    connectionChanging = false;
    if (previous.config) await notifyTabs(previous.config.origin, true).catch(() => {});
    throw new SecurityError('INTERNAL');
  }
  connectionGeneration += 1;
  connectionChanging = false;
  if (previous.config && previous.config.origin !== config.origin) {
    await notifyTabs(previous.config.origin, false).catch(() => {});
  }
  await removeUnusedHostPermissions(config.origin).catch(() => {});
  await injectExistingTabs(config.origin).catch(() => {});
  await notifyTabs(config.origin, true).catch(() => {});
  return statusOf(await readState());
}

async function unlock(password, sender) {
  requireOptions(sender);
  const state = await readState();
  if (!state.config) throw new SecurityError('NOT_CONNECTED');
  if (!state.hasSavedKey) throw new SecurityError('VAULT_MISSING');
  if (!state.vault) throw new SecurityError('VAULT_INVALID');
  if (!await hasHostPermission(state.config.origin)) throw new SecurityError('PERMISSION_REQUIRED');
  const key = await decryptApiKey({ vault: state.vault, origin: state.config.origin, password });
  const timezone = await fetchTrackerTimezone({ origin: state.config.origin, key });
  if (!await hasHostPermission(state.config.origin)) throw new SecurityError('PERMISSION_REQUIRED');
  connectionGeneration += 1;
  connectionChanging = true;
  try {
    await chrome.storage.session.remove('apiKey');
    await chrome.storage.local.set({ config: { ...state.config, timezone } });
    await chrome.storage.session.set({ apiKey: { origin: state.config.origin, key, credentialId: state.credentialId } });
  } catch {
    await chrome.storage.session.remove('apiKey').catch(() => {});
    try {
      await chrome.storage.local.set({ config: state.config });
      if (state.key) await chrome.storage.session.set({ apiKey: {
        origin: state.config.origin, key: state.key, credentialId: state.credentialId,
      } });
    } catch { await chrome.storage.session.remove('apiKey').catch(() => {}); }
    throw new SecurityError('INTERNAL');
  } finally {
    connectionGeneration += 1;
    connectionChanging = false;
    await notifyTabs(state.config.origin, true).catch(() => {});
  }
  return statusOf(await readState());
}

async function lock(sender, forget = false) {
  requireOptions(sender);
  const state = await readState();
  if (!state.config) throw new SecurityError('NOT_CONNECTED');
  connectionGeneration += 1;
  await chrome.storage.session.remove('apiKey');
  try {
    if (forget) await chrome.storage.local.remove('keyVault');
  } finally {
    await notifyTabs(state.config.origin, true).catch(() => {});
  }
  return statusOf(await readState());
}

async function disconnect(sender) {
  requireOptions(sender);
  const previous = await readState();
  connectionGeneration += 1;
  await chrome.storage.session.remove('apiKey');
  await chrome.storage.local.remove(CONNECTION_KEYS);
  await chrome.storage.local.set({ preferences: { language: previous.preferences.language } });
  await unregisterPanel();
  // Notify before removing host permissions, while tab URLs remain accessible.
  if (previous.config) await notifyTabs(previous.config.origin, false).catch(() => {});
  await removeUnusedHostPermissions();
  return statusOf(await readState());
}

async function readApiData(type, queryInput, sender, campaignIds = [], sectionsInput, request, page) {
  const generation = connectionGeneration;
  const state = await readState();
  requireContent(sender, state.config);
  if (!state.preferences.dashboardEnabled) throw new SecurityError('DASHBOARD_DISABLED');
  const read = beginContentRead(sender, type, request.sequence, generation);
  request.read = read;
  read.assertCurrent();
  if (!state.key) throw new SecurityError('KEY_REQUIRED');
  if (!await hasHostPermission(state.config.origin)) throw new SecurityError('PERMISSION_REQUIRED');
  read.assertCurrent();
  const options = { origin: state.config.origin, key: state.key, fetchImpl: (...args) => {
    // A report can paginate or queue further requests after the first response.
    // Reloads, newer filters and key changes all stop the obsolete pipeline.
    read.assertCurrent();
    return fetch(...args);
  } };
  let result;
  if (type === 'GET_DASHBOARD') result = await fetchDashboard({ ...options, query: validateQuery(queryInput) });
  else if (type === 'GET_CAMPAIGN_OVERVIEW') result = await fetchCampaignOverview({ ...options, query: validateQuery(queryInput), campaignIds: validateCampaignIds(campaignIds) });
  else if (type === 'GET_CLICKLOG') result = await fetchClicklog({ ...options, query: validateQuery(queryInput), campaignIds: validateCampaignIds(campaignIds), page });
  else if (type === 'GET_CATALOGS') result = await fetchCatalogs(options);
  else if (type === 'GET_CAMPAIGNS') result = await fetchCampaigns(options);
  else if (type === 'GET_CAMPAIGN_CHARTS') result = await fetchCampaignCharts({ ...options, query: validateQuery(queryInput), campaignIds: validateCampaignIds(campaignIds) });
  else if (type === 'GET_INSIGHTS') result = await fetchInsights({ ...options, query: validateQuery(queryInput), campaignIds: validateCampaignIds(campaignIds), sections: validateInsightSections(sectionsInput) });
  else throw new SecurityError('INVALID_MESSAGE');
  read.assertCurrent();
  return result;
}

async function handleMessage(message, sender, request) {
  await ready;
  if (!isPlainRecord(message) || !Object.hasOwn(message, 'type') || typeof message.type !== 'string') {
    throw new SecurityError('INVALID_MESSAGE');
  }
  if (message.type === 'CONNECT') {
    requireOptions(sender);
    const payload = {};
    for (const field of ['origin', 'campaignsPath', 'key', 'storageMode', 'password']) {
      if (Object.hasOwn(message, field)) payload[field] = message[field];
    }
    return serializeMutation(() => connect(payload, sender));
  }
  if (['UNLOCK', 'LOCK', 'FORGET_SAVED_KEY'].includes(message.type)) {
    requireOptions(sender);
    return serializeMutation(() => message.type === 'UNLOCK'
      ? unlock(message.password, sender) : lock(sender, message.type === 'FORGET_SAVED_KEY'));
  }
  if (message.type === 'DISCONNECT') {
    requireOptions(sender);
    return serializeMutation(() => disconnect(sender));
  }
  if (['GET_DASHBOARD', 'GET_CAMPAIGN_OVERVIEW', 'GET_CLICKLOG', 'GET_CATALOGS', 'GET_CAMPAIGNS', 'GET_CAMPAIGN_CHARTS', 'GET_INSIGHTS'].includes(message.type)) {
    return readApiData(message.type, Object.hasOwn(message, 'query') ? message.query : {}, sender,
      Object.hasOwn(message, 'campaignIds') ? message.campaignIds : [],
      Object.hasOwn(message, 'sections') ? message.sections : undefined, request, Object.hasOwn(message, 'page') ? message.page : undefined);
  }
  const state = await readState();
  if (message.type === 'GET_STATUS') {
    if (!isControlSender(sender)) {
      requireContent(sender, state.config);
      observeContentDocument(sender, request.sequence);
    }
    return statusOf(state);
  }
  if (message.type === 'SAVE_PREFERENCES') {
    const fromControl = isControlSender(sender);
    if (!fromControl) requireContent(sender, state.config);
    const patch = validatePreferences(message.preferences);
    const languageOnly = fromControl && Object.keys(patch).length === 1 && Object.hasOwn(patch, 'language');
    if (!state.config && !languageOnly) throw new SecurityError('NOT_CONNECTED');
    return serializeMutation(async () => {
      const fresh = await readState();
      if (!fromControl) requireContent(sender, fresh.config);
      if (!fresh.config && !languageOnly) throw new SecurityError('NOT_CONNECTED');
      const preferences = { ...fresh.preferences, ...patch };
      await chrome.storage.local.set({ preferences });
      // Stop pagination and delivery from already-running panels when disabled.
      if (fresh.preferences.dashboardEnabled && !preferences.dashboardEnabled) {
        connectionGeneration += 1;
        contentDocuments.clear();
      }
      if (fresh.config) await notifyPreferences(fresh.config.origin).catch(() => {});
      return { preferences };
    });
  }
  if (message.type === 'OPEN_SETTINGS') {
    if (!isControlSender(sender)) requireContent(sender, state.config);
    await chrome.runtime.openOptionsPage();
    return {};
  }
  requireContent(sender, state.config);
  throw new SecurityError('INVALID_MESSAGE');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Establish ordering before the first await; unauthorised senders still never
  // create or mutate a document record.
  const request = { sequence: ++messageSequence, read: null };
  const complete = (data, error) => {
    let response;
    try {
      request.read?.assertCurrent();
      if (error) throw error;
      response = { ok: true, data };
    } catch (failure) {
      response = { ok: false, error: publicError(failure) };
    } finally { request.read?.finish(); }
    // A reloaded document may have already closed its message port.
    try { sendResponse(response); } catch { /* Nothing remains to deliver. */ }
  };
  handleMessage(message, sender, request).then(data => complete(data), error => complete(undefined, error));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => { contentDocuments.delete(tabId); });

// Dynamic registration survives restarts; repair it after updates without
// restoring the session-only secret. Failure never grants new permissions.
ready.then(() => serializeMutation(async () => {
  const state = await readState();
  // Persist the normalized path, removing old temporary auth query parameters.
  if (state.config) await chrome.storage.local.set({ config: state.config });
  if (state.config && await hasHostPermission(state.config.origin)) await registerPanel(state.config.origin);
  else await unregisterPanel();
})).catch(() => {});

// The registration above only reaches documents loaded later. An update or reload
// orphans the content script of every open tracker tab, so inject a fresh copy once the
// registration is repaired; it retires the orphan itself (content.js). Copies up to 0.6.12
// cannot step aside and ask for a page reload instead (updates.js).
chrome.runtime.onInstalled.addListener((details) => {
  if (!injectsIntoOpenTabs(details)) return;
  ready.then(() => serializeMutation(async () => {
    const state = await readState();
    if (state.config && await hasHostPermission(state.config.origin)) await injectExistingTabs(state.config.origin);
  })).catch(() => {});
});
