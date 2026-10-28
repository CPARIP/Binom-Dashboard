import { t } from './i18n.js';

/** UI preference schema contains field names only, never click records. */
export const CLICKLOG_COLUMNS = Object.freeze([
  { key: 'click_time', get label() { return t('Время клика', 'Click time'); } }, { key: 'ip', label: 'IP' },
  { key: 'country', get label() { return t('Страна', 'Country'); } }, { key: 'device', get label() { return t('Устройство', 'Device'); } }, { key: 'os', get label() { return t('ОС', 'OS'); } },
  { key: 'browser', get label() { return t('Браузер', 'Browser'); } }, { key: 'campaign', get label() { return t('Кампания', 'Campaign'); } }, { key: 'user_agent', label: 'User agent' },
  { key: 'traffic_source', get label() { return t('Источник', 'Traffic source'); } }, { key: 'language', get label() { return t('Язык', 'Language'); } },
  { key: 'is_bot', get label() { return t('Бот', 'Bot'); } }, { key: 'id', get label() { return t('ID клика', 'Click ID'); } }, { key: 'campaign_id', get label() { return t('ID кампании', 'Campaign ID'); } },
]);
export const DEFAULT_CLICKLOG_COLUMNS = Object.freeze(['click_time', 'ip', 'country', 'device', 'os', 'campaign', 'traffic_source', 'is_bot', 'id']);
export const CLICKLOG_PAGE_SIZES = Object.freeze([25, 50, 100]);
export const DEFAULT_CLICKLOG_PAGE_SIZE = 50;
export function validateClicklogPreferences(input = {}) {
  const fail = () => { const error = new Error(t('Некорректные настройки журнала кликов.', 'Invalid click log preferences.')); error.code = 'INVALID_PREFERENCES'; throw error; };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['clicklogColumns', 'clicklogPageSize'].includes(key))) fail();
  const result = {};
  if (Object.hasOwn(input, 'clicklogColumns')) {
    const columns = input.clicklogColumns;
    if (!Array.isArray(columns) || !columns.length || columns.length > CLICKLOG_COLUMNS.length || new Set(columns).size !== columns.length || Array.from(columns).some(key => !CLICKLOG_COLUMNS.some(column => column.key === key))) fail();
    // Keep the saved selection, but use the same display order as the column menu.
    result.clicklogColumns = CLICKLOG_COLUMNS.filter(column => columns.includes(column.key)).map(column => column.key);
  }
  if (Object.hasOwn(input, 'clicklogPageSize')) {
    if (!CLICKLOG_PAGE_SIZES.includes(input.clicklogPageSize)) fail();
    result.clicklogPageSize = input.clicklogPageSize;
  }
  return result;
}
