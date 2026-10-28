import { enhanceSelects } from './select.js';
import { t, setLanguage, getLanguage, translateMessage } from './i18n.js';

const $ = id => document.getElementById(id);
const selects = enhanceSelects(document.querySelector('main'));
let status = null;
let busy = false;
let refreshSequence = 0;
let feedbackContent = () => '';

async function message(payload) {
  let response;
  try { response = await chrome.runtime.sendMessage(payload); }
  catch {
    const error = new Error();
    error.localizedMessage = () => t('Не удалось связаться с расширением. Откройте меню ещё раз.', 'Could not contact the extension. Open the menu again.');
    throw error;
  }
  if (!response?.ok) {
    const error = new Error(response?.error?.message || '');
    error.localizedMessage = () => response?.error?.message
      ? translateMessage(response.error.message)
      : t('Не удалось сохранить настройки. Повторите попытку.', 'Could not save settings. Try again.');
    throw error;
  }
  return response.data;
}
function feedback(content, error = false) {
  feedbackContent = typeof content === 'function' ? content : () => translateMessage(content);
  $('feedback').textContent = feedbackContent();
  $('feedback').dataset.error = String(error);
}
function render() {
  const configured = Boolean(status?.configured);
  const enabled = status?.preferences?.dashboardEnabled !== false;
  document.documentElement.lang = getLanguage();
  // While a save is pending the control keeps the value the user just chose.
  if (!busy) $('language').value = getLanguage();
  $('language').disabled = busy;
  $('language-label').textContent = t('Язык', 'Language');
  $('language').setAttribute('aria-label', t('Язык', 'Language'));
  $('theme-hint').textContent = t('Светлая и тёмная темы — через переключатель в Binom.', 'Switch between light and dark themes in Binom.');
  $('dashboard-control').setAttribute('aria-label', t('Управление дашбордом', 'Dashboard controls'));
  $('dashboard-label').textContent = t('Дашборд', 'Dashboard');
  $('connection-hint').textContent = t('Подключение и настройки сохраняются.', 'Your connection and settings are kept.');
  $('settings-label').textContent = t('Настройки подключения', 'Connection settings');
  $('connection-state').textContent = !configured ? t('Подключите трекер в настройках', 'Connect your tracker in settings')
    : !status.hasKey ? t('Для статистики разблокируйте или введите ключ', 'Unlock or enter your key to load statistics') : t('Трекер подключён', 'Tracker connected');
  // The same state as a colored mark (none / locked / ready).
  $('connection-state').dataset.state = !configured ? 'none' : !status.hasKey ? 'locked' : 'ready';
  $('dashboard-state').textContent = !configured ? t('Не подключён', 'Not connected') : enabled ? t('Включён', 'Enabled') : t('Отключён', 'Disabled');
  // A switch named "Dashboard"; its title says what a click does.
  $('toggle-dashboard').disabled = busy || !configured;
  $('toggle-dashboard').dataset.enabled = String(enabled);
  $('toggle-dashboard').setAttribute('aria-checked', String(configured && enabled));
  $('toggle-dashboard').title = !configured ? '' : enabled ? t('Отключить дашборд', 'Disable dashboard') : t('Включить дашборд', 'Enable dashboard');
  $('feedback').textContent = feedbackContent();
  selects.sync();
}
async function refresh() {
  const sequence = ++refreshSequence;
  try {
    const latest = await message({ type: 'GET_STATUS' });
    if (sequence !== refreshSequence) return;
    status = latest;
    setLanguage(status.preferences?.language);
    render();
  } catch (error) {
    if (sequence !== refreshSequence) return;
    status = null; render(); feedback(error.localizedMessage || error.message, true);
  }
}
async function save(patch) {
  const languageOnly = Object.keys(patch).length === 1 && Object.hasOwn(patch, 'language');
  if (busy || (!status?.configured && !languageOnly)) return;
  busy = true;
  ++refreshSequence;
  render();
  feedback(() => t('Сохранение…', 'Saving…'));
  try {
    const { preferences } = await message({ type: 'SAVE_PREFERENCES', preferences: patch });
    status = { ...status, preferences };
    setLanguage(preferences.language);
    feedback(() => t('Сохранено. Применено к открытым вкладкам Binom.', 'Saved. Applied to open Binom tabs.'));
  } catch (error) { feedback(error.localizedMessage || error.message, true); }
  finally { busy = false; await refresh(); }
}
$('language').addEventListener('change', () => { void save({ language: $('language').value }); });
$('toggle-dashboard').addEventListener('click', () => { void save({ dashboardEnabled: status?.preferences?.dashboardEnabled === false }); });
// The "Dashboard" label is a larger target for the same switch.
$('dashboard-label').addEventListener('click', () => { if (!$('toggle-dashboard').disabled) $('toggle-dashboard').click(); });
$('open-settings').addEventListener('click', async () => {
  try { await message({ type: 'OPEN_SETTINGS' }); window.close(); }
  catch (error) { feedback(error.localizedMessage || error.message, true); }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.preferences || changes.config) && !busy) void refresh();
});
render();
void refresh();
