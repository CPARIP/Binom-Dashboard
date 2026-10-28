import { normalizeOrigin, normalizeCampaignsPath, hostPermissionPattern, validateApiKey } from './security.js';
import { validateVaultPassword } from './vault.js';
import { t, setLanguage, getLanguage, translateMessage } from './i18n.js';
import { enhanceSelects } from './select.js';

const $ = (id) => document.getElementById(id);
// The page's selects use the styled menus shared with the popup; the
// native elements still hold the values and fire the change events.
const selects = enhanceSelects(document.querySelector('main'));
let interfaceBusy = false;
let interfaceFeedback = () => '';
// Only explicitly marked, extension-authored copy is translated. Form values and
// tracker data are never inspected or replaced by the language renderer.
const staticCopy = [...document.querySelectorAll('[data-i18n-ru]')].map(node => ({ node, ru: node.dataset.i18nRu, en: node.textContent }));
let currentConfig = null;
let currentStatus = null;
let operationPending = false;
let feedbackContent = () => '';
let preferencesRevision = 0;
let latestPreferences = null;
let connectionDraftEdited = false;
const VAULT_MESSAGES = {
  VAULT_PASSWORD: ['Пароль шифрования должен содержать от 12 до 256 символов.', 'The encryption password must contain 12–256 characters.'],
  VAULT_INVALID: ['Не удалось прочитать зашифрованный ключ. Удалите сохранённый ключ и подключитесь заново с API-ключом из Binom.', 'Could not read the encrypted key. Delete the saved key and reconnect with the API key from Binom.'],
  VAULT_UNLOCK_FAILED: ['Не удалось разблокировать ключ. Проверьте пароль. Если пароль забыт, подключитесь заново с исходным API-ключом.', 'Could not unlock the key. Check your password. If you forgot it, reconnect with the original API key.'],
  VAULT_MISSING: ['Сохранённого ключа нет. Подключите Binom заново.', 'No saved key was found. Reconnect Binom.'],
};
function uiError(ru, en) {
  const error = new Error(ru);
  error.localizedMessage = () => t(ru, en);
  return error;
}
async function message(payload) {
  let response;
  try { response = await chrome.runtime.sendMessage(payload); }
  catch { throw uiError('Не удалось связаться с расширением. Перезагрузите его.', 'Could not contact the extension. Reload it.'); }
  if (!response?.ok) {
    const error = new Error(response?.error?.message || '');
    error.code = response?.error?.code;
    error.localizedMessage = () => VAULT_MESSAGES[error.code] ? t(...VAULT_MESSAGES[error.code])
      : response?.error?.message ? translateMessage(response.error.message)
        : t('Не удалось связаться с расширением. Перезагрузите его.', 'Could not contact the extension. Reload it.');
    throw error;
  }
  return response.data;
}
function feedback(content, error = false) {
  feedbackContent = typeof content === 'function' ? content : () => translateMessage(content);
  $('feedback').textContent = feedbackContent();
  $('feedback').className = error ? 'error' : 'success';
}
function feedbackError(error, ru, en) {
  feedback(() => error.localizedMessage ? error.localizedMessage()
    : VAULT_MESSAGES[error.code] ? t(...VAULT_MESSAGES[error.code])
      : error.code && error.message ? translateMessage(error.message) : t(ru, en), true);
}
function clearSecrets() {
  for (const id of ['api-key', 'vault-password', 'vault-password-confirm', 'unlock-password']) $(id).value = '';
}
function passwordValue(id) {
  return validateVaultPassword($(id).value);
}
function setBusy(value) {
  operationPending = value;
  for (const id of ['connect', 'unlock', 'lock-key', 'forget-saved-key', 'disconnect']) $(id).disabled = value;
}
function syncStorageMode() {
  const encrypted = $('storage-mode').value === 'encrypted';
  $('vault-password-fields').hidden = !encrypted;
  $('vault-password').required = encrypted;
  $('vault-password-confirm').required = encrypted;
  $('vault-password').disabled = !encrypted;
  $('vault-password-confirm').disabled = !encrypted;
  if (!encrypted) { $('vault-password').value = ''; $('vault-password-confirm').value = ''; }
  renderStorageNote();
  selects.sync();
}
function renderStorageNote() {
  const encrypted = $('storage-mode').value === 'encrypted';
  $('storage-note').textContent = encrypted
    ? t('На устройстве сохраняется только зашифрованный ключ. Расшифрованный ключ хранится в памяти текущего сеанса.', 'Only the encrypted key is saved on this device. The decrypted key stays in memory for the current session.')
    : t('Ключ хранится только в памяти до перезапуска браузера или обновления расширения. После этого его нужно ввести снова. Зашифрованная копия при выборе этого режима не сохраняется.', 'The key stays in memory until you restart the browser or reload the extension. You must then enter it again. No encrypted copy is saved in this mode.');
}
function syncDashboardAvailability(status) {
  $('open-dashboard').hidden = !status.configured || status.preferences?.dashboardEnabled === false;
}
function renderCopy() {
  document.documentElement.lang = getLanguage();
  document.title = t('Binom Dashboard — подключение', 'Binom Dashboard — connection');
  for (const { node, ru, en } of staticCopy) node.textContent = t(ru, en);
  const status = currentStatus || {};
  const saved = Boolean(status.hasSavedKey);
  const locked = saved && (status.locked || !status.hasKey);
  $('connection-state').textContent = locked ? t('Заблокировано', 'Locked')
    : status.hasKey ? saved ? t('Ключ разблокирован', 'Key unlocked') : t('Ключ на сеанс', 'Session key')
      : status.configured ? t('Нужен ключ', 'Key required') : t('Не настроено', 'Not configured');
  $('lock-key').textContent = saved ? t('Заблокировать ключ', 'Lock key') : t('Удалить ключ сеанса', 'Remove session key');
  $('lock-key').title = t('Удаляет расшифрованный ключ из памяти и очищает открытые графики', 'Removes the decrypted key from memory and clears open charts');
  $('connection-editor-title').textContent = status.configured ? t('Изменить подключение или API-ключ', 'Change connection or API key') : t('Настроить подключение', 'Set up connection');
  $('key-storage-summary').textContent = saved
    ? locked ? t('Зашифрованный ключ сохранён на этом устройстве. Для загрузки статистики введите пароль.', 'An encrypted key is saved on this device. Enter your password to load statistics.')
      : t('Зашифрованный ключ сохранён на этом устройстве. На текущий сеанс он разблокирован.', 'An encrypted key is saved on this device and unlocked for the current session.')
    : status.hasKey ? t('Ключ доступен только в текущем сеансе браузера. На диск расширением он не сохраняется.', 'The key is available only in the current browser session. The extension does not save it to disk.')
      : t('Для загрузки статистики заново введите API-ключ.', 'Enter your API key again to load statistics.');
  $('connect-label').textContent = status.configured ? t('Обновить подключение', 'Update connection') : t('Подключить Binom', 'Connect Binom');
  $('storage-mode').setAttribute('aria-label', t('Хранение API-ключа', 'API key storage'));
  renderStorageNote();
  $('feedback').textContent = feedbackContent();
  for (const input of document.querySelectorAll('input')) {
    if (input.validity.customError) setValidationMessage(input);
  }
  renderInterface();
}
// The language, as in the popup (the design choice is gone). It
// changes preferences only: the connection form and its draft are never touched.
let interfaceFeedbackTimer = null;
function renderInterface() {
  // While a save is pending the control keeps the value the user just chose.
  if (!interfaceBusy) $('ui-language').value = getLanguage();
  $('ui-language').disabled = interfaceBusy;
  $('ui-language').setAttribute('aria-label', t('Язык', 'Language'));
  $('ui-feedback').textContent = interfaceFeedback();
  selects.sync();
}
async function saveInterface(patch) {
  if (interfaceBusy) { renderInterface(); return; }
  interfaceBusy = true;
  clearTimeout(interfaceFeedbackTimer);
  interfaceFeedback = () => t('Сохранение…', 'Saving…');
  $('ui-feedback').dataset.error = 'false';
  renderInterface();
  try {
    const { preferences } = await message({ type: 'SAVE_PREFERENCES', preferences: patch });
    preferencesRevision += 1;
    interfaceFeedback = () => t('Сохранено. Применено к открытым вкладкам Binom.', 'Saved. Applied to open Binom tabs.');
    // The confirmation is brief, so it never outlives later changes from the popup.
    interfaceFeedbackTimer = setTimeout(() => { interfaceFeedback = () => ''; renderInterface(); }, 4000);
    interfaceBusy = false;
    syncPreferences(preferences);
  } catch (error) {
    interfaceFeedback = () => error.localizedMessage ? error.localizedMessage() : t('Не удалось сохранить настройки. Повторите попытку.', 'Could not save settings. Try again.');
    $('ui-feedback').dataset.error = 'true';
  } finally { interfaceBusy = false; renderInterface(); }
}
function syncPreferences(preferences) {
  latestPreferences = preferences;
  setLanguage(preferences?.language);
  if (currentStatus) {
    currentStatus = { ...currentStatus, preferences };
    syncDashboardAvailability(currentStatus);
  }
  renderCopy();
}
async function readStatus() {
  const revision = preferencesRevision;
  const status = await message({ type: 'GET_STATUS' });
  return revision !== preferencesRevision && latestPreferences
    ? { ...status, preferences: latestPreferences } : status;
}
async function refreshStatus({ initial = false } = {}) {
  try {
    const status = await readStatus();
    currentStatus = status;
    latestPreferences = status.preferences;
    setLanguage(status.preferences?.language);
    currentConfig = status.configured ? status.config : null;
    const saved = Boolean(status.hasSavedKey);
    const locked = saved && (status.locked || !status.hasKey);
    $('connection-state').className = `badge${status.hasKey ? ' ready' : locked ? ' locked' : ''}`;
    $('connected-actions').hidden = !status.configured && !saved;
    syncDashboardAvailability(status);
    $('lock-key').hidden = !status.hasKey;
    $('forget-saved-key').hidden = !saved;
    $('unlock-panel').hidden = !locked;
    $('unlock-password').required = locked;
    $('configured-summary').hidden = !status.configured;
    const preserveDraft = initial && connectionDraftEdited;
    if (!preserveDraft) $('connection-editor').open = !status.configured || (!status.hasKey && !saved);
    if (status.configured) {
      if (!preserveDraft) $('tracker-url').value = status.config.origin + status.config.campaignsPath;
      $('configured-origin').textContent = status.config.origin;
      $('configured-timezone').textContent = status.config.timezone;
    }
    renderCopy();
  } catch { feedback(() => t('Не удалось прочитать настройки. Перезагрузите расширение.', 'Could not read settings. Reload the extension.'), true); }
}
$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (operationPending) return;
  let grantedPattern;
  let newlyGranted = false;
  let config;
  try {
    let url;
    try { url = new URL($('tracker-url').value.trim()); }
    catch { throw uiError('Укажите корректный адрес страницы кампаний Binom.', 'Enter a valid Binom Campaigns page URL.'); }
    if (url.username || url.password) throw uiError('Укажите адрес без логина и пароля в URL.', 'Enter a URL without a username or password.');
    const origin = normalizeOrigin(url.origin);
    const campaignsPath = normalizeCampaignsPath(url.pathname + url.search + url.hash, origin);
    const key = validateApiKey($('api-key').value.trim());
    const storageMode = $('storage-mode').value === 'session' ? 'session' : 'encrypted';
    config = { origin, campaignsPath, key, storageMode };
    if (storageMode === 'encrypted') {
      config.password = passwordValue('vault-password');
      if (config.password !== $('vault-password-confirm').value) throw uiError('Пароли не совпадают. Повторите пароль шифрования.', 'The passwords do not match. Repeat the encryption password.');
    }
    grantedPattern = hostPermissionPattern(origin);
    // Request during the explicit form submission; only this tracker is granted.
    const permission = { origins: [grantedPattern] };
    const previousGrant = chrome.permissions.contains(permission).catch(() => null);
    // Keep request() in the original user gesture, before any await.
    const grantRequest = chrome.permissions.request(permission);
    setBusy(true);
    const [alreadyGranted, granted] = await Promise.all([previousGrant, grantRequest]);
    if (!granted) throw uiError('Доступ к сайту не выдан. Подключение не сохранено.', 'Site access was not granted. The connection was not saved.');
    newlyGranted = granted && alreadyGranted === false;
    await message({ type: 'CONNECT', ...config });
    config.key = ''; config.password = '';
    clearSecrets();
    await refreshStatus();
    feedback(() => storageMode === 'encrypted'
      ? t('Ключ сохранён зашифрованным на этом устройстве и разблокирован на текущий сеанс. После перезапуска браузера понадобится только пароль. Откройте Dashboard в меню Binom.', 'The key is saved encrypted on this device and unlocked for the current session. After restarting the browser, you will only need your password. Open Dashboard in the Binom menu.')
      : t('Ключ сохранён только на этот сеанс браузера. Откройте Dashboard в меню Binom. После перезапуска браузера ключ нужно ввести заново.', 'The key is saved only for this browser session. Open Dashboard in the Binom menu. After restarting the browser, enter the key again.'));
  } catch (error) {
    if (newlyGranted && grantedPattern) await chrome.permissions.remove({ origins: [grantedPattern] }).catch(() => {});
    feedbackError(error, 'Не удалось сохранить подключение.', 'Could not save the connection.');
  } finally {
    if (config) { config.key = ''; config.password = ''; }
    clearSecrets();
    setBusy(false);
  }
});
$('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (operationPending) return;
  let password = '';
  try {
    password = passwordValue('unlock-password');
    if (!currentConfig) throw uiError('Подключение не настроено. Укажите адрес Binom и API-ключ.', 'The connection is not configured. Enter your Binom URL and API key.');
    const permission = { origins: [hostPermissionPattern(normalizeOrigin(currentConfig.origin))] };
    // Restoring a revoked host grant is part of this explicit unlock gesture.
    // Keep request() before the first await; only the configured tracker is requested.
    const grantRequest = chrome.permissions.request(permission);
    setBusy(true);
    if (!await grantRequest) throw uiError('Доступ к сайту не выдан. Сохранённый ключ не изменён. Разрешите доступ к вашему Binom и повторите разблокировку.', 'Site access was not granted. The saved key is unchanged. Allow access to your Binom and try unlocking again.');
    await message({ type: 'UNLOCK', password });
    password = ''; clearSecrets();
    await refreshStatus();
    feedback(() => t('Ключ разблокирован на текущий сеанс браузера. Статистика в открытом Dashboard загрузится заново.', 'The key is unlocked for the current browser session. Statistics will reload in the open Dashboard.'));
  } catch (error) { feedbackError(error, 'Не удалось разблокировать ключ.', 'Could not unlock the key.'); }
  finally { password = ''; clearSecrets(); setBusy(false); }
});
$('lock-key').addEventListener('click', async () => {
  if (operationPending) return;
  try {
    setBusy(true);
    await message({ type: 'LOCK' });
    clearSecrets(); await refreshStatus();
    feedback(() => t('Ключ удалён из памяти сеанса, открытые графики очищены. Для возобновления загрузки разблокируйте сохранённый ключ или введите API-ключ заново.', 'The key was removed from session memory and open charts were cleared. Unlock the saved key or enter your API key again to resume loading.'));
  } catch (error) { feedbackError(error, 'Не удалось заблокировать ключ.', 'Could not lock the key.'); }
  finally { clearSecrets(); setBusy(false); }
});
$('forget-saved-key').addEventListener('click', async () => {
  if (operationPending) return;
  try {
    setBusy(true);
    await message({ type: 'FORGET_SAVED_KEY' });
    clearSecrets(); await refreshStatus();
    feedback(() => t('Сохранённый ключ и ключ текущего сеанса удалены. Адрес трекера, настройки и подборки сохранены. Для подключения потребуется исходный API-ключ из Binom.', 'The saved key and current session key were deleted. The tracker URL, settings and saved selections are kept. You will need the original API key from Binom to reconnect.'));
  } catch (error) { feedbackError(error, 'Не удалось удалить сохранённый ключ.', 'Could not delete the saved key.'); }
  finally { clearSecrets(); setBusy(false); }
});
$('open-dashboard').addEventListener('click', () => {
  if (currentConfig) {
    const url = new URL(currentConfig.campaignsPath, currentConfig.origin);
    url.searchParams.set('binomDashboard', '1');
    chrome.tabs.create({ url: url.href });
  }
});
$('disconnect').addEventListener('click', async () => {
  if (operationPending) return;
  try {
    setBusy(true);
    await message({ type: 'DISCONNECT' });
    clearSecrets();
    $('tracker-url').value = '';
    $('storage-mode').value = 'encrypted'; syncStorageMode();
    await refreshStatus();
    feedback(() => t('Подключение, сохранённый ключ и ключ сеанса удалены из расширения. При необходимости отзовите ключ также в Binom.', 'The connection, saved key and session key were removed from the extension. Revoke the key in Binom as well if needed.'));
  } catch (error) { feedbackError(error, 'Не удалось удалить подключение. Перезагрузите расширение и попробуйте снова.', 'Could not remove the connection. Reload the extension and try again.'); }
  finally { clearSecrets(); setBusy(false); }
});
$('storage-mode').addEventListener('change', syncStorageMode);
$('ui-language').addEventListener('change', () => { void saveInterface({ language: $('ui-language').value }); });
for (const event of ['input', 'change']) {
  $('connect-form').addEventListener(event, () => { connectionDraftEdited = true; });
}
window.addEventListener('focus', () => {
  if (!operationPending) void readStatus().then(status => {
    syncPreferences(status.preferences);
    syncDashboardAvailability(status);
  }).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  // Language updates change copy only: never refresh status or refill a form.
  if (area === 'local' && changes.preferences) {
    preferencesRevision += 1;
    syncPreferences(changes.preferences.newValue);
  }
});
function setValidationMessage(input) {
  input.setCustomValidity('');
  if (input.validity.valueMissing) input.setCustomValidity(t('Заполните это поле.', 'Please fill out this field.'));
  else if (input.validity.typeMismatch) input.setCustomValidity(t('Укажите корректный адрес страницы кампаний Binom.', 'Enter a valid Binom Campaigns page URL.'));
}
for (const input of document.querySelectorAll('input')) {
  input.addEventListener('invalid', () => setValidationMessage(input));
  input.addEventListener('input', () => input.setCustomValidity(''));
}
syncStorageMode();
renderCopy();
void refreshStatus({ initial: true });
