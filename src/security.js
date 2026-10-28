/** Pure validation shared by the extension worker and options page. */
import { DEFAULT_CLICKLOG_COLUMNS, DEFAULT_CLICKLOG_PAGE_SIZE, validateClicklogPreferences } from './clicklog-schema.js';
const METRIC_KEYS = ['clicks', 'leads', 'costs', 'revenue', 'profit', 'roi', 'cr', 'epc', 'cpc', 'bots'];
export const DEFAULT_PREFERENCES = Object.freeze({
  metrics: Object.freeze(['clicks', 'leads', 'costs', 'revenue']),
  visibleMetrics: Object.freeze(METRIC_KEYS.slice(0, 6)),
  overviewCampaignId: '',
  clicklogColumns: DEFAULT_CLICKLOG_COLUMNS,
  clicklogPageSize: DEFAULT_CLICKLOG_PAGE_SIZE,
  theme: 'auto',
  collapsed: false,
  autoRefresh: 0,
  mode: 'overview',
  campaignIds: Object.freeze([]),
  campaignMetric: 'clicks',
  language: 'en',
  dashboardEnabled: true,
  insightsSections: Object.freeze(['breakdowns', 'top']),
  alertThresholds: Object.freeze({ dropPercent: 50, spikePercent: 100, botIncreasePoints: 10, minClicks: 20 }),
  savedSelections: Object.freeze([]),
});

export const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_ORIGIN: 'Укажите HTTPS-адрес вашего Binom без пути, параметров и данных входа.',
  INVALID_PATH: 'Укажите путь страницы кампаний внутри выбранного Binom.',
  INVALID_TIMEZONE: 'Некорректный часовой пояс Binom.',
  TIMEZONE_UNAVAILABLE: 'Binom не вернул корректный часовой пояс. Проверьте настройку часового пояса в Binom и доступ API-пользователя к ней.',
  INVALID_KEY: 'Введите корректный API-ключ без пробелов и переносов строк.',
  INVALID_MESSAGE: 'Некорректный запрос расширения.',
  INVALID_PREFERENCES: 'Некорректные настройки панели.',
  INVALID_QUERY: 'Проверьте период и фильтры отчёта.',
  ACCESS_DENIED: 'Эта страница не может выполнить запрос расширения.',
  PERMISSION_REQUIRED: 'Разрешите расширению доступ к выбранному сайту Binom.',
  NOT_CONNECTED: 'Подключите Binom в настройках расширения.',
  KEY_REQUIRED: 'Разблокируйте сохранённый ключ или введите API-ключ в настройках расширения.',
  VAULT_PASSWORD: 'Пароль должен содержать от 12 до 256 символов.',
  VAULT_INVALID: 'Сохранённый ключ повреждён или относится к другому подключению. Подключите Binom заново.',
  VAULT_UNLOCK_FAILED: 'Не удалось разблокировать ключ. Проверьте пароль; если он забыт, подключите Binom заново с API-ключом.',
  VAULT_MISSING: 'Нет сохранённого ключа. Подключите Binom и выберите сохранение с паролем.',
  SETTINGS_CHANGED: 'Подключение изменилось. Обновите панель.',
  DASHBOARD_DISABLED: 'Дашборд отключён. Включите его в меню расширения.',
  NETWORK: 'Не удалось подключиться к Binom. Проверьте адрес и доступность сервера.',
  TIMEOUT: 'Binom не ответил вовремя. Повторите запрос.',
  AUTH: 'Binom отклонил API-ключ. Проверьте ключ в настройках.',
  FORBIDDEN: 'У пользователя API недостаточно прав для запрошенных данных.',
  RATE_LIMIT: 'Binom ограничил частоту запросов. Попробуйте позже.',
  API_RESPONSE: 'Ответ Binom не соответствует ожидаемому формату.',
  API_ERROR: 'Binom не смог сформировать отчёт.',
  INCOMPLETE_DATA: 'Binom вернул неполные данные отчёта.',
  BOT_FILTER: 'Binom не прислал отметку «Бот» для кликов, поэтому «Без ботов» не применить к журналу. Включите колонку «Бот» в настройках таблицы журнала кликов у API-пользователя Binom или выключите фильтр.',
  REPEATED_PAGE: 'Binom повторил страницу отчёта. Не удалось подтвердить полноту данных за выбранный период.',
  REPORT_LIMIT: 'Отчёт превысил предел загрузки. Сократите период или фильтры.',
  INTERNAL: 'Не удалось выполнить действие. Повторите попытку.',
});

export class SecurityError extends Error {
  constructor(code) {
    super(SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES.INTERNAL);
    this.name = 'SecurityError';
    this.code = Object.hasOwn(SAFE_ERROR_MESSAGES, code) ? code : 'INTERNAL';
  }
}

export function publicError(error) {
  // Never expose a browser error, request URL, API response, or credential.
  const code = typeof error?.code === 'string' && Object.hasOwn(SAFE_ERROR_MESSAGES, error.code)
    ? error.code : 'INTERNAL';
  return { code, message: SAFE_ERROR_MESSAGES[code] };
}

export function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => 'value' in entry);
}

function assertRecord(value, code = 'INVALID_MESSAGE') {
  if (!isPlainRecord(value)) throw new SecurityError(code);
}

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new SecurityError('INVALID_ORIGIN');
  const input = value.trim();
  // In particular reject backslashes, userinfo, paths and invisible characters.
  if (!/^https:\/\/[^\s\\/?#]+\/?$/i.test(input)) throw new SecurityError('INVALID_ORIGIN');
  let url;
  try { url = new URL(input); } catch { throw new SecurityError('INVALID_ORIGIN'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || url.hostname.includes('*')) {
    throw new SecurityError('INVALID_ORIGIN');
  }
  return url.origin;
}

export function hostPermissionPattern(origin) {
  const url = new URL(normalizeOrigin(origin));
  // Host grants are broader than an origin; sender and API checks enforce port.
  return `https://${url.hostname}/*`;
}

export function normalizeCampaignsPath(value, origin) {
  const validOrigin = normalizeOrigin(origin);
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
      || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new SecurityError('INVALID_PATH');
  }
  let url;
  try { url = new URL(value, validOrigin); } catch { throw new SecurityError('INVALID_PATH'); }
  if (url.origin !== validOrigin || url.username || url.password) throw new SecurityError('INVALID_PATH');
  // Binom can append a temporary web-login token. Never persist or reopen it.
  for (const name of [...url.searchParams.keys()]) {
    if (name.toLowerCase() === 'auth' || name === 'binomDashboard') url.searchParams.delete(name);
  }
  // A saved navigation path must not become an accidental credential store.
  const secretName = /^(?:api[-_]?key|access[-_]?token|token|password|authorization|auth|secret)$/i;
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, '').replace(/^[^?]*\?/, ''));
  for (const name of [...url.searchParams.keys(), ...hashParams.keys()]) {
    if (secretName.test(name)) throw new SecurityError('INVALID_PATH');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function validateTimezone(value) {
  if (typeof value !== 'string' || !value || value.length > 80) throw new SecurityError('INVALID_TIMEZONE');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { throw new SecurityError('INVALID_TIMEZONE'); }
  return value;
}

export function validateApiKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new SecurityError('INVALID_KEY');
  }
  return value;
}

export function validateConnection(input) {
  assertRecord(input);
  const allowed = ['origin', 'campaignsPath', 'key'];
  if (Object.keys(input).some((name) => !allowed.includes(name))
      || !Object.hasOwn(input, 'origin') || !Object.hasOwn(input, 'key')) {
    throw new SecurityError('INVALID_MESSAGE');
  }
  const origin = normalizeOrigin(input.origin);
  return {
    config: {
      origin,
      campaignsPath: normalizeCampaignsPath(Object.hasOwn(input, 'campaignsPath') ? input.campaignsPath : '/', origin),
    },
    key: validateApiKey(input.key),
  };
}

export function validateSavedConfig(input) {
  assertRecord(input);
  if (!['origin', 'campaignsPath', 'timezone'].every((name) => Object.hasOwn(input, name))
      || Object.keys(input).some((name) => !['origin', 'campaignsPath', 'timezone'].includes(name))) {
    throw new SecurityError('INVALID_MESSAGE');
  }
  const origin = normalizeOrigin(input.origin);
  return { origin, campaignsPath: normalizeCampaignsPath(input.campaignsPath, origin), timezone: validateTimezone(input.timezone) };
}

const DASHBOARD_PRESETS = ['today', 'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'custom_time'];
function storedDay(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Period, filters and checkboxes of the overview, kept between page loads.
 * Only these exact fields and value forms; dates are checked again before any request.
 * An unfinished custom range (empty or reversed dates) may be stored as typed. */
function validateDashboardQuery(input) {
  assertRecord(input, 'INVALID_PREFERENCES');
  const fields = ['datePreset', 'dateFrom', 'dateTo', 'groupId', 'sourceId', 'compare', 'hideBots', 'uniqueClicks'];
  if (Object.keys(input).some(name => !fields.includes(name)) || !DASHBOARD_PRESETS.includes(input.datePreset)
      || typeof input.groupId !== 'string' || (input.groupId !== '' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.groupId))
      || typeof input.sourceId !== 'string' || (input.sourceId !== '' && !/^[1-9]\d{0,14}$/.test(input.sourceId))
      || ['compare', 'hideBots', 'uniqueClicks'].some(name => typeof input[name] !== 'boolean')) throw new SecurityError('INVALID_PREFERENCES');
  const custom = input.datePreset === 'custom_time';
  if (custom ? !storedDay(input.dateFrom) || !storedDay(input.dateTo) : Object.hasOwn(input, 'dateFrom') || Object.hasOwn(input, 'dateTo')) throw new SecurityError('INVALID_PREFERENCES');
  return { datePreset: input.datePreset, ...(custom ? { dateFrom: input.dateFrom, dateTo: input.dateTo } : {}),
    groupId: input.groupId, sourceId: input.sourceId, compare: input.compare, hideBots: input.hideBots, uniqueClicks: input.uniqueClicks };
}

export function validatePreferences(input) {
  assertRecord(input, 'INVALID_PREFERENCES');
  const allowed = ['dashboardQuery', 'metrics', 'visibleMetrics', 'overviewCampaignId', 'clicklogColumns', 'clicklogPageSize', 'theme', 'collapsed', 'autoRefresh', 'mode', 'campaignIds', 'campaignMetric', 'trackerTheme', 'design', 'language', 'dashboardEnabled', 'insightsSections', 'alertThresholds', 'savedSelections'];
  if (Object.keys(input).some((name) => !allowed.includes(name))) throw new SecurityError('INVALID_PREFERENCES');
  const result = {};
  if (Object.hasOwn(input, 'language')) {
    if (!['en', 'ru'].includes(input.language)) throw new SecurityError('INVALID_PREFERENCES');
    result.language = input.language;
  }
  for (const name of ['metrics', 'visibleMetrics']) if (Object.hasOwn(input, name)) {
    const metrics = input[name];
    const allowedMetrics = METRIC_KEYS;
    if (!Array.isArray(metrics) || metrics.length > allowedMetrics.length
        || (name === 'visibleMetrics' && !metrics.length)
        || Array.from(metrics).some((metric) => typeof metric !== 'string' || !allowedMetrics.includes(metric))
        || new Set(metrics).size !== metrics.length) throw new SecurityError('INVALID_PREFERENCES');
    result[name] = [...metrics];
  }
  if (Object.hasOwn(input, 'dashboardQuery')) result.dashboardQuery = validateDashboardQuery(input.dashboardQuery);
  if (Object.hasOwn(input, 'overviewCampaignId')) {
    const id = input.overviewCampaignId;
    if (typeof id !== 'string' || (id !== '' && (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))))) throw new SecurityError('INVALID_PREFERENCES');
    result.overviewCampaignId = id;
  }
  try { Object.assign(result, validateClicklogPreferences(Object.fromEntries(['clicklogColumns', 'clicklogPageSize'].filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])))); }
  catch { throw new SecurityError('INVALID_PREFERENCES'); }
  if (Object.hasOwn(input, 'theme')) {
    if (!['auto', 'dark', 'light'].includes(input.theme)) throw new SecurityError('INVALID_PREFERENCES');
    result.theme = input.theme;
  }
  if (Object.hasOwn(input, 'collapsed')) {
    if (typeof input.collapsed !== 'boolean') throw new SecurityError('INVALID_PREFERENCES');
    result.collapsed = input.collapsed;
  }
  if (Object.hasOwn(input, 'autoRefresh')) {
    if (![0, 60, 300].includes(input.autoRefresh)) throw new SecurityError('INVALID_PREFERENCES');
    result.autoRefresh = input.autoRefresh;
  }
  if (Object.hasOwn(input, 'mode')) {
    if (!['overview', 'campaigns'].includes(input.mode)) throw new SecurityError('INVALID_PREFERENCES');
    result.mode = input.mode;
  }
  if (Object.hasOwn(input, 'campaignIds')) {
    const ids = input.campaignIds;
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length
        || Array.from(ids).some(id => typeof id !== 'string' || !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new SecurityError('INVALID_PREFERENCES');
    result.campaignIds = [...ids];
  }
  if (Object.hasOwn(input, 'campaignMetric')) {
    if (!METRIC_KEYS.includes(input.campaignMetric)) throw new SecurityError('INVALID_PREFERENCES');
    result.campaignMetric = input.campaignMetric;
  }
  // Only one design remains. Earlier installs stored a design name and
  // `trackerTheme`; any such former value is accepted (each on its own, since
  // both are dropped) so the other preferences survive, and it is never stored again.
  if (Object.hasOwn(input, 'trackerTheme') && typeof input.trackerTheme !== 'boolean') throw new SecurityError('INVALID_PREFERENCES');
  if (Object.hasOwn(input, 'design') && !(typeof input.design === 'string' && /^[a-z]{1,16}$/.test(input.design))) throw new SecurityError('INVALID_PREFERENCES');
  if (Object.hasOwn(input, 'dashboardEnabled')) {
    if (typeof input.dashboardEnabled !== 'boolean') throw new SecurityError('INVALID_PREFERENCES');
    result.dashboardEnabled = input.dashboardEnabled;
  }
  if (Object.hasOwn(input, 'insightsSections')) {
    const sections = input.insightsSections;
    if (!Array.isArray(sections) || sections.length > 7 || new Set(sections).size !== sections.length
        || Array.from(sections).some(section => !['leaders', 'top', 'attention', 'pace', 'heatmap', 'breakdowns', 'efficiency'].includes(section))) throw new SecurityError('INVALID_PREFERENCES');
    result.insightsSections = [...sections];
  }
  if (Object.hasOwn(input, 'alertThresholds')) {
    const thresholds = input.alertThresholds;
    assertRecord(thresholds, 'INVALID_PREFERENCES');
    const bounds = { dropPercent: [1, 100], spikePercent: [1, 10000], botIncreasePoints: [1, 100], minClicks: [1, 10000000] };
    if (Object.keys(thresholds).length !== 4 || Object.keys(thresholds).some(name => !Object.hasOwn(bounds, name))) throw new SecurityError('INVALID_PREFERENCES');
    for (const [name, [min, max]] of Object.entries(bounds)) {
      if (!Number.isInteger(thresholds[name]) || thresholds[name] < min || thresholds[name] > max) throw new SecurityError('INVALID_PREFERENCES');
    }
    result.alertThresholds = { ...thresholds };
  }
  if (Object.hasOwn(input, 'savedSelections')) {
    if (!Array.isArray(input.savedSelections) || input.savedSelections.length > 20) throw new SecurityError('INVALID_PREFERENCES');
    const seen = new Set();
    result.savedSelections = Array.from(input.savedSelections, selection => {
      assertRecord(selection, 'INVALID_PREFERENCES');
      const fields = ['id', 'name', 'campaignIds', 'campaignMetric', 'datePreset', 'dateFrom', 'dateTo', 'grouping', 'hideBots'];
      if (Object.keys(selection).some(name => !fields.includes(name)) || typeof selection.id !== 'string'
          || !/^[A-Za-z0-9_-]{1,64}$/.test(selection.id) || seen.has(selection.id)
          || typeof selection.name !== 'string' || !selection.name.trim() || selection.name.trim().length > 60
          || /[\u0000-\u001f\u007f]/.test(selection.name)) throw new SecurityError('INVALID_PREFERENCES');
      seen.add(selection.id);
      const checked = validatePreferences({ campaignIds: selection.campaignIds, campaignMetric: selection.campaignMetric });
      if (!checked.campaignIds.length || !['today', 'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'custom_time'].includes(selection.datePreset)
          || !['auto', 'days', 'hours'].includes(selection.grouping) || typeof selection.hideBots !== 'boolean') throw new SecurityError('INVALID_PREFERENCES');
      let dateFrom = '', dateTo = '';
      if (selection.datePreset === 'custom_time') {
        const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          && value >= '1970-01-01' && value <= '2200-12-31' && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
          && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
        if (!validDay(selection.dateFrom) || !validDay(selection.dateTo) || selection.dateFrom > selection.dateTo
            || Date.parse(selection.dateTo) - Date.parse(selection.dateFrom) > 365 * 86400000) throw new SecurityError('INVALID_PREFERENCES');
        dateFrom = selection.dateFrom; dateTo = selection.dateTo;
      }
      const oneDay = ['today', 'yesterday'].includes(selection.datePreset) || (dateFrom && dateFrom === dateTo);
      if (selection.grouping === 'hours' && !oneDay) throw new SecurityError('INVALID_PREFERENCES');
      return { id: selection.id, name: selection.name.trim(), ...checked, datePreset: selection.datePreset,
        dateFrom, dateTo, grouping: selection.grouping, hideBots: selection.hideBots };
    });
  }
  return result;
}

export function isOptionsSender(sender, extensionId, optionsUrl) {
  return isPlainRecord(sender) && Object.hasOwn(sender, 'id') && Object.hasOwn(sender, 'url')
    && sender.id === extensionId && sender.url === optionsUrl
    && (!Object.hasOwn(sender, 'frameId') || sender.frameId === 0);
}

export function isContentSender(sender, extensionId, origin) {
  if (!origin || !isPlainRecord(sender) || !isPlainRecord(sender.tab)
      || !['id', 'url', 'tab', 'frameId'].every((name) => Object.hasOwn(sender, name))
      || !['id', 'url'].every((name) => Object.hasOwn(sender.tab, name))
      || sender.id !== extensionId || sender.frameId !== 0
      || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0) return false;
  try {
    const documentUrl = new URL(sender.url);
    const tabUrl = new URL(sender.tab.url);
    return documentUrl.protocol === 'https:' && documentUrl.origin === origin
      && tabUrl.origin === origin && !documentUrl.username && !documentUrl.password
      && !tabUrl.username && !tabUrl.password
      && (!sender.origin || sender.origin === origin);
  } catch { return false; }
}
