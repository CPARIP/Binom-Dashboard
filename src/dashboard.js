import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import styles from './dashboard.css';
import { createInsights, INSIGHT_SECTIONS } from './insights.js';
import insightStyles from './insights.css';
import { createClicklog } from './clicklog.js';
import clicklogStyles from './clicklog.css';
import { enhanceSelects } from './select.js';
import { renderCampaignTree } from './campaign-tree.js';
import selectStyles from './select.css';
import binomStyles from './binom.css';
import { t, setLanguage, getLanguage, locale, translateMessage } from './i18n.js';

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

const METRICS = [
  { key: 'clicks', get label() { return t('Клики', 'Clicks'); }, color: '#6c9dff', type: 'count' },
  { key: 'leads', get label() { return t('Конверсии', 'Conversions'); }, color: '#b18aff', type: 'count' },
  { key: 'costs', get label() { return t('Расход', 'Cost'); }, color: '#f07886', type: 'money' },
  { key: 'revenue', get label() { return t('Доход', 'Revenue'); }, color: '#e6c45f', type: 'money' },
  { key: 'profit', get label() { return t('Прибыль', 'Profit'); }, color: '#8bcda2', type: 'money' },
  { key: 'roi', label: 'ROI', color: '#efa468', type: 'percent' },
  { key: 'cr', label: 'CR', color: '#5bc4b5', type: 'percent' },
  { key: 'epc', label: 'EPC', color: '#c797eb', type: 'money', fractionDigits: 4 },
  { key: 'cpc', label: 'CPC', color: '#dfae72', type: 'money', fractionDigits: 4 },
  { key: 'bots', get label() { return t('Боты', 'Bots'); }, color: '#b6a77b', type: 'count' },
];
const CAMPAIGN_COLORS = ['#6c9dff', '#efa468', '#8bcda2', '#b18aff', '#f07886', '#e6c45f', '#5ac6d0', '#d78bbc'];
const MAX_CAMPAIGNS = 8;
const ICONS = {
  resetFilters: '<path d="M3 4h18l-7 8v7l-4 2v-9Z"/><path d="m17 16 5 5m0-5-5 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.1 3M4.8 15A8 8 0 0 0 18 18"/>',
  settings: '<path d="M9.321 5.533 10.747 3.088 13.253 3.088 14.679 5.533 17.416 4.812 19.188 6.584 18.467 9.321 20.912 10.747 20.912 13.253 18.467 14.679 19.188 17.416 17.416 19.188 14.679 18.467 13.253 20.912 10.747 20.912 9.321 18.467 6.584 19.188 4.812 17.416 5.533 14.679 3.088 13.253 3.088 10.747 5.533 9.321 4.812 6.584 6.584 4.812Z"/><circle cx="12" cy="12" r="3"/>',
  dropdown: '<path d="m6 9 6 6 6-6"/>',
  theme: '<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
};
const svg = name => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;


function dayAtZone(timezone) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
}
function addDays(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function applyPreset(query) {
  query = { ...query, grouping: 'auto', status: 'with_traffic', uniqueClicks: query.uniqueClicks === true };
  if (query.groupId) query.campaignId = '';
  if (query.datePreset === 'custom_time') return query;
  const today = dayAtZone(query.timezone);
  const length = { today: 1, yesterday: 1, last_7_days: 7, last_14_days: 14, last_30_days: 30 }[query.datePreset] || 7;
  const end = query.datePreset === 'yesterday' ? addDays(today, -1) : today;
  return { ...query, dateFrom: addDays(end, 1 - length), dateTo: end };
}

/** Stored period and filters (validated again by the worker); unknown forms are ignored. */
function restoredQuery(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const query = {};
  if (['today', 'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'custom_time'].includes(stored.datePreset)) query.datePreset = stored.datePreset;
  if (query.datePreset === 'custom_time') for (const key of ['dateFrom', 'dateTo']) query[key] = typeof stored[key] === 'string' ? stored[key] : '';
  for (const key of ['groupId', 'sourceId']) if (typeof stored[key] === 'string') query[key] = stored[key];
  for (const key of ['compare', 'hideBots', 'uniqueClicks']) if (typeof stored[key] === 'boolean') query[key] = stored[key];
  return query;
}

/** Render a Binom overview without accessing any extension or page credentials. */
export function createDashboard(container, {
  loadDashboard, loadCampaignOverview = async () => { throw new Error(t("Отчёт кампании недоступен.", "Campaign report unavailable.")); },
  loadClicklog = async () => { throw new Error(t("Журнал кликов недоступен.", "Click log unavailable.")); }, loadCatalogs = async () => ({ groups: [], sources: [], warnings: [] }),
  loadCampaigns = async () => ({ campaigns: [], warnings: [] }),
  loadCampaignCharts = async () => { throw new Error(t("Сравнение кампаний пока недоступно.", "Campaign comparison is currently unavailable.")); },
  loadInsights = async () => ({ sections: {} }),
  onSettings = () => {}, initialQuery = {}, preferences = {}, onPreferencesChange = () => {}, demo = false,
} = {}) {
  setLanguage(preferences.language);
  const number = new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const perClickDecimal = new Intl.NumberFormat(locale(), { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const format = (value, type, fractionDigits = 2) => !finite(value) ? '—' : type === 'money' ? `${(fractionDigits === 4 ? perClickDecimal : decimal).format(value)} $` : type === 'percent' ? `${decimal.format(value)} %` : number.format(value);
  const root = container.shadowRoot || container.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${styles}\n${insightStyles}\n${selectStyles}\n${binomStyles}\n${clicklogStyles}</style><section class="bd binom" data-design="binom" lang="${getLanguage()}" aria-label="${t("График статистики Binom", "Binom statistics chart")}">
    <header class="head"><div class="heading"><span class="heading-dot"></span><h2>${t("Обзор кампаний", "Campaign overview")}</h2>${demo ? `<span class="badge">${t('ДЕМО · ПРИМЕР ДАННЫХ', 'DEMO · SAMPLE DATA')}</span>` : ''}</div><div class="actions">
      <button class="refresh" data-action="refresh" title="${t("Обновить статистику", "Refresh statistics")}">${svg('refresh')}<span>${t("Обновить", "Refresh")}</span></button>
      <button class="icon-btn" data-action="settings" aria-label="${t("Настройки подключения", "Connection settings")}" title="${t("Настройки подключения", "Connection settings")}">${svg('settings')}</button>
    </div></header>
    <div class="body"><div class="filter-area"><div class="mode-toolbar"><div class="mode-switch" role="group" aria-label="${t("Режим графика", "Chart mode")}"><button data-mode="overview" aria-pressed="true">${t("Обзор", "Overview")}</button><button data-mode="campaigns" aria-pressed="false">${t("Сравнить кампании", "Compare campaigns")}</button></div><span class="mode-description">${t("Общая статистика по выбранным фильтрам", "Summary for the selected filters")}</span></div><div class="toolbar">
      <select data-query="datePreset" aria-label="${t("Период", "Period")}"><option value="today">${t("Сегодня", "Today")}</option><option value="yesterday">${t("Вчера", "Yesterday")}</option><option value="last_7_days">${t("Последние 7 дней", "Last 7 days")}</option><option value="last_14_days">${t("Последние 14 дней", "Last 14 days")}</option><option value="last_30_days">${t("Последние 30 дней", "Last 30 days")}</option><option value="custom_time">${t("Свой период", "Custom period")}</option></select>
      <div class="range" hidden><input type="date" data-query="dateFrom" aria-label="${t("Начало периода", "Start date")}"><span>—</span><input type="date" data-query="dateTo" aria-label="${t("Конец периода", "End date")}"></div>
      <div class="campaign-controls" hidden><div class="campaign-picker"><button class="setting-action" data-action="pick-campaigns" aria-haspopup="dialog" aria-expanded="false" aria-controls="campaign-picker-panel">${t("Выбрать кампании", "Select campaigns")}</button><div class="campaign-popover" id="campaign-picker-panel" role="dialog" aria-label="${t("Выбор кампаний", "Campaign selection")}" hidden><div class="picker-heading"><strong>${t("Кампании", "Campaigns")}</strong><button class="picker-close" data-action="close-picker" aria-label="${t("Закрыть выбор кампаний", "Close campaign selection")}">×</button></div><input class="campaign-search" type="search" placeholder="${t("Кампания, ID или группа", "Campaign, ID or group")}" aria-label="${t("Найти кампанию", "Find a campaign")}"><div class="campaign-list" role="group" aria-label="${t("Доступные кампании", "Available campaigns")}"></div><div class="picker-status" role="status"></div><div class="picker-footer"><span class="picker-count"></span><button class="refresh" data-action="apply-campaigns">${t("Применить", "Apply")}</button></div></div></div><label class="campaign-metric-label">${t("Показатель", "Metric")}<select data-preference="campaignMetric" aria-label="${t("Показатель для сравнения кампаний", "Campaign comparison metric")}">${METRICS.map(metric => `<option value="${metric.key}">${metric.label}</option>`).join('')}</select></label></div>
      <select data-query="groupId" data-overview-control aria-label="${t("Группа кампаний", "Campaign group")}"><option value="">${t("Все группы", "All groups")}</option></select>
      <div class="campaign-picker overview-campaign-picker" data-overview-control><select data-query="campaignId" class="select-native" tabindex="-1" aria-hidden="true" aria-label="${t("Кампания", "Campaign")}"><option value="">${t("Все кампании", "All campaigns")}</option></select><button type="button" class="select-trigger" data-action="pick-overview-campaign" aria-label="${t("Кампания", "Campaign")}" aria-haspopup="dialog" aria-expanded="false" aria-controls="overview-campaign-picker-panel"><span class="select-value">${t("Все кампании", "All campaigns")}</span><span class="select-chevron">${svg('dropdown')}</span></button><div class="campaign-popover overview-campaign-popover" id="overview-campaign-picker-panel" role="dialog" aria-label="${t("Выбор кампании", "Campaign selection")}" hidden><div class="picker-heading"><strong>${t("Кампания", "Campaign")}</strong><button type="button" class="picker-close" data-action="close-overview-picker" aria-label="${t("Закрыть выбор кампании", "Close campaign selection")}">×</button></div><input class="campaign-search overview-campaign-search" type="search" placeholder="${t("Кампания, ID или группа", "Campaign, ID or group")}" aria-label="${t("Найти кампанию или группу", "Find a campaign or group")}"><button type="button" class="campaign-option all-campaigns-option" data-action="all-overview-campaigns">${t("Все кампании", "All campaigns")}</button><div class="campaign-list overview-campaign-list" aria-label="${t("Группы и кампании", "Groups and campaigns")}"></div><div class="picker-status overview-picker-status" role="status"></div></div></div>
      <select data-query="sourceId" data-overview-control aria-label="${t("Источник трафика", "Traffic source")}"><option value="">${t("Все источники", "All sources")}</option></select>
      <button class="reset-filters" data-action="reset-filters" type="button" aria-label="${t("Сбросить фильтры", "Reset filters")}" title="${t("Сбросить фильтры", "Reset filters")}">${svg('resetFilters')}</button>
      <span class="timezone">${svg('clock')}<span></span></span>
    </div><div class="toolbar secondary">
      <label class="check" data-overview-control><input type="checkbox" data-query="compare">${t("Сравнить с предыдущим периодом", "Compare with previous period")}</label>
      <label class="check unique-clicks-control"><input type="checkbox" data-query="uniqueClicks">${t("Уникальные клики", "Unique clicks")}</label>
      <label class="check"><input type="checkbox" data-query="hideBots">${t("Без ботов", "Exclude bots")}</label>
      <details class="metric-settings" data-overview-control><summary>${t("Показатели", "Metrics")}</summary><div class="metric-options" role="group" aria-label="${t("Видимые показатели", "Visible metrics")}"></div></details>
    </div><p class="insight-note unique-clicks-note" hidden></p><p class="preference-feedback" role="status"></p></div><div class="cards"></div>
    <div class="chart-panel"><div class="chart-head"><div><span class="chart-title">${t("Динамика показателей", "Metric trends")}</span><span class="chart-period"></span></div><div class="legend-note"><span><i class="legend-line"></i>${t("Текущий период", "Current period")}</span><span class="previous-note" hidden><i class="legend-line previous"></i>${t("Предыдущий", "Previous")}</span></div></div><div class="campaign-legend" aria-label="${t("Кампании на графике", "Campaigns on the chart")}" hidden></div>
    <div class="chart-wrap"><div class="chart" role="img" aria-label="${t("График выбранных показателей", "Chart of selected metrics")}"></div><div class="state" aria-live="polite"><div class="loading-line"></div><div class="state-title">${t("Загрузка статистики", "Loading statistics")}</div><div class="state-detail"></div><button class="setting-action" hidden>${t("Настроить подключение", "Set up connection")}</button></div></div>
    <div class="notice" hidden role="status"></div></div>
    <div class="insights-root"></div><div class="clicklog-root"></div>
    <footer class="footer"><div class="footer-left"><span class="updated">${t("Ещё не обновлено", "Not updated yet")}</span><label>${t("Автообновление", "Auto refresh")}<select data-preference="autoRefresh" aria-label="${t("Автообновление", "Auto refresh")}"><option value="0">${t("Выключено", "Off")}</option><option value="60">${t("Каждую минуту", "Every minute")}</option><option value="300">${t("Каждые 5 минут", "Every 5 minutes")}</option></select></label><span>${t("Фильтры графика не меняют таблицу Binom", "Chart filters do not change the Binom table")}</span></div><span class="privacy">${svg('shield')}${demo ? t('Демонстрационные данные', 'Demo data') : t('Данные напрямую из вашего Binom', 'Data directly from your Binom')}</span></footer>
    </div></section>`;
  const $ = selector => root.querySelector(selector);
  const $$ = selector => [...root.querySelectorAll(selector)];
  let dropdowns;
  const validMetrics = (preferences.metrics || ['clicks', 'leads', 'revenue', 'profit']).filter(key => METRICS.some(metric => metric.key === key));
  let prefs = { theme: 'dark', autoRefresh: 0, mode: 'overview', campaignIds: [], campaignMetric: 'clicks', ...preferences, language: getLanguage(), metrics: validMetrics.length ? validMetrics : ['clicks'] };
  prefs.mode = prefs.mode === 'campaigns' ? 'campaigns' : 'overview';
  prefs.campaignIds = [...new Set((Array.isArray(prefs.campaignIds) ? prefs.campaignIds : []).map(String))].slice(0, MAX_CAMPAIGNS);
  if (!METRICS.some(metric => metric.key === prefs.campaignMetric)) prefs.campaignMetric = 'clicks';
  prefs.insightsSections = INSIGHT_SECTIONS.map(section => section.id);
  prefs.visibleMetrics = [...new Set(preferences.visibleMetrics || METRICS.slice(0, 6).map(m => m.key))].filter(key => METRICS.some(m => m.key === key));
  if (!prefs.visibleMetrics.length) prefs.visibleMetrics = ['clicks'];
  prefs.metrics = prefs.metrics.filter(key => prefs.visibleMetrics.includes(key));
  prefs.alertThresholds = { dropPercent: 50, spikePercent: 100, botIncreasePoints: 10, minClicks: 20, ...preferences.alertThresholds };
  prefs.savedSelections = Array.isArray(preferences.savedSelections) ? preferences.savedSelections : [];
  let query = applyPreset({ datePreset: 'last_30_days', timezone: 'UTC', status: 'with_traffic', groupId: '', sourceId: '', campaignId: prefs.overviewCampaignId || '', grouping: 'auto', hideBots: false, uniqueClicks: false, compare: false, ...restoredQuery(preferences.dashboardQuery), ...initialQuery });
  let disposed = false;
  let requestId = 0;
  let pending = false;
  let refreshQueued = false;
  let timer = null;
  // Custom dates load after the input settles: changing both dates, or typing a date
  // segment by segment, is one load instead of one per change.
  const DATE_SETTLE_MS = 700;
  let dateTimer = null;
  let chart = null;
  let result = null;
  let catalogWarnings = [];
  let resizeObserver = null;
  let error = null;
  let campaignCatalog = null;
  let campaignCatalogPromise = null;
  let campaignCatalogError = null;
  let campaignCatalogWarnings = [];
  let draftCampaignIds = new Set(prefs.campaignIds);
  const expandedCampaignGroups = new Set(), expandedOverviewGroups = new Set();
  const campaignNames = new Map();
  const campaignColors = new Map();
  const hiddenCampaigns = new Set();

  let insightRequestId = 0;
  let insightPending = false;
  let insightQueued = false;
  const insights = createInsights($('.insights-root'));
  const clicklog = createClicklog($('.clicklog-root'), {
    loadPage: loadClicklog, preferences: prefs,
    async onPreferencesChange(patch) { Object.assign(prefs, patch); if (!await savePrefs()) throw new Error(); },
  });
  dropdowns = enhanceSelects(root);
  function selectedIds() { return prefs.mode === 'campaigns' ? [...prefs.campaignIds] : query.campaignId ? [query.campaignId] : []; }
  // Unique clicks select an already returned metric, never a request filter.
  function requestQuery() { const { uniqueClicks, ...value } = query; return value; }
  function scopedQuery() { return selectedIds().length ? { ...requestQuery(), groupId: '', sourceId: '' } : requestQuery(); }
  function clickCountField() { return query.uniqueClicks ? 'unique_clicks' : 'clicks'; }
  function metricValue(values, key) { return values?.[key === 'clicks' ? clickCountField() : key]; }
  function metricLabel(metric) { return metric.key === 'clicks' && query.uniqueClicks ? t("Уникальные клики", "Unique clicks") : metric.label; }
  function uniqueScopeLabel() { return prefs.mode === 'campaigns' || query.campaignId ? t("Уникальные клики по трекеру в выбранных кампаниях", "Tracker unique clicks in selected campaigns") : t("Уникальные клики по трекеру", "Tracker unique clicks"); }
  function uniqueDiagnosticCodes() {
    if (!query.uniqueClicks || !result) return [];
    const outcomes = prefs.mode === 'campaigns' ? result.campaigns || [] : [result];
    // Only fixed type/presence flags may cross into this compact diagnostic.
    // Never display arbitrary response text, campaign identifiers or values.
    return [...new Set(outcomes.slice(0, MAX_CAMPAIGNS)
      .filter(outcome => !outcome.error && !finite(metricValue(outcome.totals, 'clicks')))
      .map(outcome => outcome.uniqueDiagnostics?.[clickCountField()])
      .filter(code => typeof code === 'string' && /^r:(?:-|[AZNSBLOX](?:\+[AZNSBLOX]){0,7});t:(?:-|[AZNSBLOX](?:\+[AZNSBLOX]){0,7});a:[01];g:[01]$/.test(code)))];
  }
  function missingUniqueHint() {
    const campaignScope = prefs.mode === 'campaigns' || query.campaignId;
    const codes = uniqueDiagnosticCodes();
    return t(
      `Уникальные клики недоступны в полученных данных.${codes.length ? ` Код: ${codes.join(' / ')}.` : ''} Для проверки: колонка «Unique Clicks» ${campaignScope ? 'в отчёте Report' : 'в Trends'} под пользователем API; затем обновите дашборд.`,
      `Unique clicks are unavailable in the returned data.${codes.length ? ` Code: ${codes.join(' / ')}.` : ''} Check the Unique Clicks column in ${campaignScope ? 'Report' : 'Trends'} for the API user, then refresh the dashboard.`);
  }
  function metricTooltip(value, metric) { return format(value, metric.type, metric.fractionDigits); }
  function renderUniqueNote() {
    const missing = query.uniqueClicks && result && (prefs.mode === 'campaigns'
      ? (result.campaigns || []).some(campaign => !campaign.error && !finite(metricValue(campaign.totals, 'clicks')))
      : !finite(metricValue(result.totals, 'clicks')));
    $('.unique-clicks-note').hidden = !missing;
    $('.unique-clicks-note').textContent = missing ? missingUniqueHint() : '';
  }
  async function refreshInsights() {
    const id = ++insightRequestId;
    // Invalidate in-flight overview data without requesting reports in comparison.
    if (prefs.mode === 'campaigns') { insightQueued = false; return; }
    const scopeLabel = query.campaignId ? campaignNames.get(query.campaignId) || `${t('Кампания', 'Campaign')} #${query.campaignId}` : t("Все доступные кампании · независимо от статуса", "All available campaigns · regardless of status");
    insights.setLoading(scopeLabel);
    if (insightPending) { insightQueued = true; return; }
    const sections = INSIGHT_SECTIONS.map(section => section.id);
    if (!sections.length) { insights.setResult({ scope: { label: scopeLabel } }); return; }
    insightPending = true;
    try {
      const next = await loadInsights({ ...scopedQuery(), status: 'all', compare: false }, selectedIds(), sections);
      if (!disposed && id === insightRequestId) insights.setResult(next);
    } catch (caught) { if (!disposed && id === insightRequestId) insights.setError(caught); }
    finally { insightPending = false; if (!disposed && insightQueued) { insightQueued = false; void refreshInsights(); } }
  }
  function isLight() { return prefs.theme === 'light' || (prefs.theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: light)').matches); }
  function paletteColor(name, fallback) { return getComputedStyle($('.bd')).getPropertyValue(name).trim() || fallback; }
  function metricColor(metric) { return paletteColor(`--metric-${metric.key}`, metric.color); }
  function campaignColor(id) {
    const fallback = campaignColors.get(id);
    return paletteColor(`--campaign-${CAMPAIGN_COLORS.indexOf(fallback) + 1}`, fallback);
  }
  /** Period, filters and checkboxes survive Dashboard → Campaigns → Dashboard.
   * Built from this panel's current query on every save: after a language switch the
   * stored filters match what is shown, and with two open tabs any save stores the
   * filters of the tab where it happened. An impossible typed date is stored as empty. */
  function storedQuery() {
    const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
    return { datePreset: query.datePreset, ...(query.datePreset === 'custom_time' ? { dateFrom: day(query.dateFrom), dateTo: day(query.dateTo) } : {}),
      groupId: query.groupId || '', sourceId: query.sourceId || '', compare: query.compare === true, hideBots: query.hideBots === true, uniqueClicks: query.uniqueClicks === true };
  }
  async function savePrefs() {
    if (disposed) return false;
    try {
      prefs.dashboardQuery = storedQuery();
      await onPreferencesChange({ ...prefs, metrics: [...prefs.metrics], campaignIds: [...prefs.campaignIds] });
      if (!disposed) $('.preference-feedback').textContent = '';
      return true;
    }
    catch { if (!disposed) $('.preference-feedback').textContent = t("Не удалось сохранить настройки в браузере. Повторите попытку.", "Could not save settings in the browser. Please try again."); return false; }
  }
  function showState(title, detail = '', { loading = false, settings = false } = {}) {
    $('.state').hidden = false;
    $('.state-title').textContent = title;
    $('.state-detail').textContent = translateMessage(detail);
    $('.loading-line').hidden = !loading;
    $('.state .setting-action').hidden = !settings;
  }
  function syncControls() {
    for (const control of $$('[data-query]')) {
      const value = query[control.dataset.query];
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = value ?? '';
    }
    $('.range').hidden = query.datePreset !== 'custom_time';
    for (const key of ['groupId', 'sourceId']) $(`[data-query=${key}]`).disabled = Boolean(query.campaignId);
    $('[data-query=campaignId]').disabled = Boolean(query.groupId);
    $('[data-action=pick-overview-campaign]').disabled = Boolean(query.groupId);
    if (query.groupId && !$('.overview-campaign-popover').hidden) closePicker();
    $('.timezone span').textContent = query.timezone;
    $('.bd').classList.toggle('light', isLight());
    $('[data-preference=autoRefresh]').value = String(prefs.autoRefresh || 0);
    const campaignsMode = prefs.mode === 'campaigns';
    $('.head h2').textContent = campaignsMode ? t("Сравнение кампаний", "Campaign comparison") : query.campaignId ? t("Обзор кампании", "Campaign overview") : t("Обзор кампаний", "Campaign overview");
    for (const control of $$('[data-overview-control]')) control.hidden = campaignsMode;
    $('.cards').hidden = campaignsMode;
    $('.insights-root').hidden = campaignsMode;
    insights.setFilters({ campaignId: query.campaignId, groupId: query.groupId, sourceId: query.sourceId });
    insights.setCountField(clickCountField());
    renderUniqueNote();
    $('.unique-clicks-control').title = `${uniqueScopeLabel()}. ${t('Меняется только показатель кликов; остальные показатели и журнал кликов не фильтруются.', 'Only the click metric changes; other metrics and the click log are not filtered.')}`;
    $('.campaign-controls').hidden = !campaignsMode;
    $('.campaign-legend').hidden = !campaignsMode;
    $('.legend-note').hidden = campaignsMode;
    $('.mode-description').textContent = campaignsMode ? t("Сравнение выбранных кампаний за один период", "Compare selected campaigns over the same period") : query.campaignId ? campaignNames.get(query.campaignId) || `${t('Кампания', 'Campaign')} #${query.campaignId}` : t("Общая статистика по выбранным фильтрам", "Summary for the selected filters");
    for (const button of $$('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === prefs.mode));
    $('[data-preference=campaignMetric] option[value=clicks]').textContent = metricLabel(METRICS[0]);
    $('[data-preference=campaignMetric]').value = prefs.campaignMetric;
    $('[data-action=pick-campaigns]').textContent = prefs.campaignIds.length ? `${t('Кампании', 'Campaigns')} · ${prefs.campaignIds.length}` : t("Выбрать кампании", "Select campaigns");
    const overviewLabel = query.campaignId ? campaignName(query.campaignId) : t("Все кампании", "All campaigns");
    $('[data-action=pick-overview-campaign] .select-value').textContent = overviewLabel;
    $('[data-action=pick-overview-campaign]').title = overviewLabel;
    $('.chart-title').textContent = campaignsMode ? `${metricLabel(METRICS.find(metric => metric.key === prefs.campaignMetric))} ${t('по кампаниям', 'by campaign')}` : t("Динамика показателей", "Metric trends");
    dropdowns.sync();
  }
  function renderMetricSettings() {
    const options = $('.metric-options'); options.replaceChildren();
    for (const metric of METRICS) {
      const label = document.createElement('label'); label.className = 'check';
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.visibleMetric = metric.key;
      input.checked = prefs.visibleMetrics.includes(metric.key);
      input.disabled = input.checked && prefs.visibleMetrics.length === 1;
      input.addEventListener('change', () => {
        const next = input.checked ? [...prefs.visibleMetrics, metric.key] : prefs.visibleMetrics.filter(key => key !== metric.key);
        if (!next.length) { input.checked = true; return; }
        prefs.visibleMetrics = METRICS.filter(m => next.includes(m.key)).map(m => m.key);
        prefs.metrics = prefs.metrics.filter(key => prefs.visibleMetrics.includes(key));
        savePrefs(); renderMetricSettings(); renderCards(); renderChart({ preserveViewport: true });
      });
      label.append(input, document.createTextNode(metricLabel(metric))); options.append(label);
    }
  }
  function renderCards() {
    renderUniqueNote();
    $('.cards').replaceChildren();
    if (prefs.mode === 'campaigns') {
      renderCampaignLegend();
      return;
    }
    $('.cards').style.setProperty('--metric-columns', String(Math.min(6, prefs.visibleMetrics.length)));
    for (const metric of METRICS.filter(metric => prefs.visibleMetrics.includes(metric.key))) {
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.metric = metric.key;
      card.style.setProperty('--accent', `var(--metric-${metric.key}, ${metric.color})`);
      card.setAttribute('aria-pressed', String(prefs.metrics.includes(metric.key)));
      card.title = metric.key === 'roi' ? t("Показать или скрыть ROI на шкале «Количество или %»", "Show or hide ROI on the Count or % scale") : `${t('Показать или скрыть', 'Show or hide')}: ${metric.key === 'clicks' && query.uniqueClicks ? uniqueScopeLabel() : metric.label}`;
      const label = document.createElement('span'); label.className = 'card-label'; label.textContent = metricLabel(metric);
      const dot = document.createElement('i'); dot.className = 'metric-dot'; label.append(dot);
      const value = document.createElement('span'); value.className = 'card-value'; value.textContent = format(metricValue(result?.totals, metric.key), metric.type, metric.fractionDigits);
      const change = document.createElement('span'); change.className = 'card-change';
      const now = metricValue(result?.totals, metric.key);
      const previous = metricValue(result?.previousTotals, metric.key);
      if (query.compare && finite(now) && finite(previous)) {
        const delta = metric.key === 'roi' ? Number(now) - Number(previous) : Number(previous) === 0 ? null : (Number(now) - Number(previous)) / Math.abs(Number(previous)) * 100;
        // A zero previous value has no percentage change; show it in the metric's own format.
        if (delta === null) { change.textContent = `${t("В прошлом периоде", "Previous period")}: ${format(previous, metric.type, metric.fractionDigits)}`; }
        else { change.textContent = `${delta > 0 ? '+' : ''}${decimal.format(delta)} ${metric.key === 'roi' ? t("п. п.", "pp") : '%'} ${t('к прошлому периоду', 'vs previous period')}`; change.classList.add(delta === 0 ? 'neutral' : ((delta > 0) !== (['costs', 'cpc', 'bots'].includes(metric.key))) ? 'positive' : 'negative'); }
      } else change.textContent = query.compare ? t("Нет данных для сравнения", "No comparison data") : prefs.metrics.includes(metric.key) ? t("На графике", "Shown on chart") : t("Нажмите, чтобы показать", "Click to show");
      card.append(label, value, change);
      card.addEventListener('click', () => {
        prefs.metrics = prefs.metrics.includes(metric.key) ? prefs.metrics.filter(key => key !== metric.key) : [...prefs.metrics, metric.key];
        if (!prefs.metrics.length) prefs.metrics = [metric.key];
        savePrefs(); renderCards(); renderChart();
      });
      $('.cards').append(card);
    }
  }

  function campaignName(id) { return campaignNames.get(String(id)) || `${t('Кампания', 'Campaign')} #${id}`; }
  function updateCampaignColors() {
    const used = new Set();
    for (const id of prefs.campaignIds) {
      const previous = campaignColors.get(id);
      const color = previous && !used.has(previous) ? previous : CAMPAIGN_COLORS.find(candidate => !used.has(candidate));
      campaignColors.set(id, color); used.add(color);
    }
  }
  function renderCampaignLegend() {
    $('.campaign-legend').replaceChildren();
    updateCampaignColors();
    const metric = METRICS.find(item => item.key === prefs.campaignMetric);
    for (const id of prefs.campaignIds) {
      const campaign = result?.campaigns?.find(item => String(item.id) === id);
      const chip = document.createElement('div'); chip.className = 'campaign-chip'; chip.dataset.campaignId = id;
      chip.classList.toggle('campaign-error', Boolean(campaign?.error));
      chip.classList.toggle('campaign-hidden', hiddenCampaigns.has(id));
      chip.style.setProperty('--campaign-color', `var(--campaign-${CAMPAIGN_COLORS.indexOf(campaignColors.get(id)) + 1}, ${campaignColors.get(id)})`);
      const toggle = document.createElement('button'); toggle.className = 'campaign-toggle'; toggle.setAttribute('aria-pressed', String(!hiddenCampaigns.has(id)));
      toggle.title = campaign?.error ? translateMessage(campaign.error.message || t("Данные кампании недоступны", "Campaign data unavailable")) : t("Показать или скрыть линию", "Show or hide this line");
      const dot = document.createElement('i'); dot.className = 'campaign-dot';
      const name = document.createElement('span'); name.className = 'campaign-name'; name.textContent = campaignName(id);
      const label = document.createElement('span'); label.className = 'campaign-id'; label.textContent = `#${id}`;
      const total = document.createElement('strong'); total.className = 'campaign-total'; total.textContent = campaign?.error ? t("Ошибка", "Error") : format(metricValue(campaign?.totals, metric.key), metric.type, metric.fractionDigits);
      total.title = metric.key === 'clicks' && query.uniqueClicks ? uniqueScopeLabel() : metric.label;
      toggle.append(dot, name, label, total);
      toggle.addEventListener('click', () => { if (hiddenCampaigns.has(id)) hiddenCampaigns.delete(id); else hiddenCampaigns.add(id); renderCampaignLegend(); renderChart(); });
      const remove = document.createElement('button'); remove.className = 'campaign-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', `${t('Убрать кампанию', 'Remove campaign')} ${campaignName(id)}`);
      remove.addEventListener('click', () => {
        prefs.campaignIds = prefs.campaignIds.filter(item => item !== id); hiddenCampaigns.delete(id);
        savePrefs(); syncControls(); closePicker(); refresh();
      });
      chip.append(toggle, remove); $('.campaign-legend').append(chip);
    }
  }
  function renderCampaignPicker() {
    if (disposed) return;
    const count = renderCampaignTree($('.campaign-list'), { campaigns: campaignCatalog || [], term: $('.campaign-search').value,
      expanded: expandedCampaignGroups, selectedIds: draftCampaignIds, multiple: true, maxSelected: MAX_CAMPAIGNS,
      onLayout: () => positionPicker($('.campaign-popover'), $('[data-action=pick-campaigns]')),
      onSelect(id, checked) {
        if (checked && draftCampaignIds.size < MAX_CAMPAIGNS) draftCampaignIds.add(id); else draftCampaignIds.delete(id);
        $('.picker-count').textContent = t(`Выбрано ${draftCampaignIds.size} из ${MAX_CAMPAIGNS}`, `${draftCampaignIds.size} of ${MAX_CAMPAIGNS} selected`);
      },
    });
    $('.picker-count').textContent = t(`Выбрано ${draftCampaignIds.size} из ${MAX_CAMPAIGNS}`, `${draftCampaignIds.size} of ${MAX_CAMPAIGNS} selected`);
    $('.picker-status').textContent = pickerStatus(count);
    positionPicker($('.campaign-popover'), $('[data-action=pick-campaigns]'));
  }
  function pickerStatus(count) {
    return campaignCatalogPromise ? t("Загружаем кампании…", "Loading campaigns…") : campaignCatalogError ? translateMessage(campaignCatalogError.message || t("Не удалось загрузить кампании", "Could not load campaigns")) : !count ? t("Кампании не найдены", "No campaigns found") : `${number.format(count)} ${t('кампаний', 'campaigns')}`;
  }
  function selectOverviewCampaign(id) {
    const control = $('[data-query=campaignId]');
    if (control.disabled) return;
    control.value = id;
    closePicker();
    control.dispatchEvent(new Event('change', { bubbles: true }));
    $('[data-action=pick-overview-campaign]').focus({ preventScroll: true });
  }
  function renderOverviewPicker() {
    if (disposed) return;
    const count = renderCampaignTree($('.overview-campaign-list'), { campaigns: campaignCatalog || [], term: $('.overview-campaign-search').value,
      expanded: expandedOverviewGroups, selectedIds: new Set(query.campaignId ? [query.campaignId] : []), onSelect: selectOverviewCampaign,
      onLayout: () => positionPicker($('.overview-campaign-popover'), $('[data-action=pick-overview-campaign]')) });
    $('[data-action=all-overview-campaigns]').setAttribute('aria-pressed', String(!query.campaignId));
    $('.overview-picker-status').textContent = pickerStatus(count);
    positionPicker($('.overview-campaign-popover'), $('[data-action=pick-overview-campaign]'));
  }
  async function ensureCampaignCatalog() {
    if (disposed || campaignCatalog) return;
    if (campaignCatalogPromise) return campaignCatalogPromise;
    campaignCatalogError = null;
    campaignCatalogPromise = (async () => {
      try {
        const catalog = await loadCampaigns({ ...query, status: 'all', groupId: '', sourceId: '', compare: false });
        if (disposed) return;
        campaignCatalog = (catalog.campaigns || []).filter(item => item?.id != null).map(item => ({ id: String(item.id), name: String(item.name || `${t('Кампания', 'Campaign')} #${item.id}`),
          ...(item.groupId === null || typeof item.groupId === 'string' && item.groupId ? { groupId: item.groupId } : {}),
          groupName: typeof item.groupName === 'string' && item.groupName.trim() ? item.groupName : null }));
        for (const campaign of campaignCatalog) campaignNames.set(campaign.id, campaign.name);
        const control = $('[data-query=campaignId]');
        control.replaceChildren(new Option(t("Все кампании", "All campaigns"), ''));
        for (const campaign of campaignCatalog) control.append(new Option(campaign.name, campaign.id));
        if (query.campaignId && !campaignNames.has(query.campaignId)) control.append(new Option(`${t('Кампания', 'Campaign')} #${query.campaignId}`, query.campaignId));
        syncControls();
        campaignCatalogWarnings = catalog.warnings || [];
      } catch (caught) { if (!disposed) campaignCatalogError = caught; }
      finally {
        campaignCatalogPromise = null;
        if (!disposed) { renderCampaignPicker(); renderOverviewPicker(); renderCampaignLegend(); renderWarnings(); if (prefs.mode === 'campaigns') renderChart(); }
      }
    })();
    renderCampaignPicker(); renderOverviewPicker();
    return campaignCatalogPromise;
  }
  function closePicker() {
    for (const popup of $$('.campaign-popover')) {
      if (popup.matches(':popover-open')) popup.hidePopover();
      popup.hidden = true;
    }
    for (const trigger of $$('[data-action=pick-campaigns], [data-action=pick-overview-campaign]')) trigger.setAttribute('aria-expanded', 'false');
  }
  function positionPicker(popup, trigger) {
    if (popup.hidden) return;
    const margin = 10, gap = 6, rect = trigger.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - margin * 2);
    popup.style.width = `${width}px`; popup.style.maxHeight = `${Math.max(0, window.innerHeight - margin * 2)}px`;
    const desiredHeight = popup.getBoundingClientRect().height;
    const below = window.innerHeight - margin - rect.bottom - gap, above = rect.top - margin - gap;
    const flipped = below < desiredHeight && above > below;
    popup.style.maxHeight = `${Math.max(0, Math.min(window.innerHeight - margin * 2, flipped ? above : below))}px`;
    const height = popup.getBoundingClientRect().height;
    popup.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin))}px`;
    popup.style.top = `${Math.max(margin, Math.min(flipped ? rect.top - gap - height : rect.bottom + gap, window.innerHeight - height - margin))}px`;
  }
  function showPicker(popup, trigger) {
    popup.hidden = false;
    if (typeof popup.showPopover === 'function') { popup.setAttribute('popover', 'manual'); popup.showPopover(); }
    trigger.setAttribute('aria-expanded', 'true');
    positionPicker(popup, trigger);
  }
  function openPicker() {
    closePicker(); expandedCampaignGroups.clear();
    draftCampaignIds = new Set(prefs.campaignIds);
    $('.campaign-search').value = '';
    showPicker($('.campaign-popover'), $('[data-action=pick-campaigns]'));
    renderCampaignPicker(); void ensureCampaignCatalog(); $('.campaign-search').focus();
  }
  function openOverviewPicker() {
    if (query.groupId) return;
    closePicker(); expandedOverviewGroups.clear();
    $('.overview-campaign-search').value = '';
    showPicker($('.overview-campaign-popover'), $('[data-action=pick-overview-campaign]'));
    renderOverviewPicker(); void ensureCampaignCatalog(); $('.overview-campaign-search').focus();
  }

  function axisLabel(value, type, preciseMoney = false) {
    if (type === 'money' && preciseMoney && Math.abs(value) < 1) return perClickDecimal.format(value);
    const compact = new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    return type === 'percent' ? `${compact}%` : compact;
  }
  function dateLabel(value) {
    const raw = String(value ?? '');
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const date = new Date(`${raw.slice(0, 10)}T12:00:00Z`);
      if (!Number.isFinite(date.getTime())) return raw;
      const day = new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', month: '2-digit', day: '2-digit' }).format(date);
      const match = raw.match(/[T ](\d{2}:\d{2})/);
      return match ? `${day} ${match[1]}` : day;
    }
    return raw;
  }
  function renderChart({ preserveViewport = false } = {}) {
    if (disposed || !result || error) return;
    const campaignsMode = prefs.mode === 'campaigns';
    const campaignMetric = METRICS.find(metric => metric.key === prefs.campaignMetric);
    const successfulCampaigns = (result.campaigns || []).filter(campaign => !campaign.error);
    const campaigns = successfulCampaigns.filter(campaign => !hiddenCampaigns.has(String(campaign.id)));
    const rows = campaignsMode ? campaigns.find(campaign => campaign.rows?.length)?.rows || [] : Array.isArray(result.rows) ? result.rows : [];
    $('.chart-period').textContent = `${dateLabel(query.dateFrom)} — ${dateLabel(query.dateTo)}`;
    $('.previous-note').hidden = campaignsMode || !query.compare || !result.previousRows;
    if (campaignsMode && (result.campaigns || []).length && !successfulCampaigns.length) { showState(t("Не удалось загрузить выбранные кампании", "Could not load the selected campaigns"), t("Проверьте доступ к кампаниям и повторите обновление.", "Check campaign access and refresh again.")); chart?.clear(); return; }
    if (campaignsMode && successfulCampaigns.length && !campaigns.length) { showState(t("Все линии скрыты", "All lines are hidden"), t("Нажмите на название кампании в легенде, чтобы вернуть её на график.", "Click a campaign name in the legend to show its line again.")); chart?.clear(); return; }
    if (!rows.length) { showState(t("За этот период данных нет", "No data for this period"), t("Выберите другой период или измените фильтры.", "Choose another period or change the filters.")); chart?.clear(); return; }
    const selected = campaignsMode ? [campaignMetric] : METRICS.filter(metric => prefs.metrics.includes(metric.key));
    const hasValues = campaignsMode ? campaigns.some(campaign => (campaign.rows || []).some(row => finite(metricValue(row, campaignMetric.key)))) : selected.some(metric => rows.some(row => finite(metricValue(row, metric.key))));
    if (!hasValues) { showState(t("Показатели недоступны", "Metrics unavailable"), query.uniqueClicks && selected.some(metric => metric.key === 'clicks') ? `${missingUniqueHint()} ${t('Можно выключить «Уникальные клики».', 'You can turn off Unique clicks.')}` : campaignsMode ? t("API не вернул значения выбранного показателя. Выберите другой показатель.", "The API did not return the selected metric. Choose another metric.") : t("API не вернул значения выбранных показателей. Выберите другую карточку.", "The API did not return the selected metrics. Choose another card.")); chart?.clear(); return; }
    $('.state').hidden = true;
    if (!chart) chart = echarts.init($('.chart'), null, { renderer: 'canvas' });
    const light = isLight();
    const textColor = paletteColor('--muted', light ? '#6b778c' : '#9ca6b6');
    const gridColor = paletteColor('--chart-grid', paletteColor('--line', light ? '#e7ebf1' : '#343b47'));
    const zoom = preserveViewport ? chart.getOption()?.dataZoom?.[0] : null;
    // Counts and percentages share the left scale;
    // monetary metrics always use the right scale, including money-only views.
    const axisTypes = campaignsMode ? [campaignMetric.type] : ['quantity', 'money'];
    const axisIndex = type => campaignsMode || type !== 'money' ? 0 : 1;
    const series = [];
    if (campaignsMode) {
      updateCampaignColors();
      for (const campaign of campaigns) {
        const id = String(campaign.id);
        const byDate = new Map((campaign.rows || []).map(row => [String(row.date), row]));
        series.push({ type: 'line', id: `campaign-${id}`, name: `${campaignName(id)} · #${id}`, yAxisIndex: 0, smooth: false, symbol: 'circle', symbolSize: 5, showSymbol: rows.length <= 32, connectNulls: false, emphasis: { focus: 'series' }, itemStyle: { color: campaignColor(id) }, lineStyle: { width: 2.2 }, animationDuration: 250, tooltip: { valueFormatter: value => metricTooltip(value, campaignMetric) }, data: rows.map(row => { const value = metricValue(byDate.get(String(row.date)), campaignMetric.key); return finite(value) ? Number(value) : null; }) });
      }
    } else for (const metric of selected) {
      const shared = { type: 'line', yAxisIndex: axisIndex(metric.type), smooth: false, symbol: 'circle', symbolSize: 5, showSymbol: rows.length <= 32, connectNulls: false, emphasis: { focus: 'series' }, itemStyle: { color: metricColor(metric) }, animationDuration: 250, tooltip: { valueFormatter: value => metricTooltip(value, metric) } };
      series.push({ ...shared, id: metric.key, name: metricLabel(metric), data: rows.map(row => finite(metricValue(row, metric.key)) ? Number(metricValue(row, metric.key)) : null), lineStyle: { width: 2.2 }, areaStyle: selected.length <= 2 ? { opacity: .055 } : undefined });
      if (query.compare && result.previousRows) {
        series.push({ ...shared, id: `${metric.key}-previous`, name: `${metricLabel(metric)} · ${t('предыдущий', 'previous')}`, data: rows.map((_, index) => finite(metricValue(result.previousRows[index], metric.key)) ? Number(metricValue(result.previousRows[index], metric.key)) : null), lineStyle: { type: 'dashed', width: 1.5, opacity: .6 }, showSymbol: false, itemStyle: { color: metricColor(metric), opacity: .6 } });
      }
    }
    // Lines show markers on hover only. Every point keeps a
    // transparent marker (never thinned out by ECharts); a point without drawn
    // neighbours keeps a visible one so it never disappears. Previous-period
    // dashes keep the pure series color (translucency turned them brown).
    for (const item of series) {
      const dashed = item.lineStyle?.type === 'dashed', visible = dashed ? .9 : 1, data = item.data;
      if (dashed) item.lineStyle = { ...item.lineStyle, width: 1.25, opacity: .9 };
      Object.assign(item, { showSymbol: true, showAllSymbol: true, itemStyle: { ...item.itemStyle, opacity: 0 }, emphasis: { ...item.emphasis, itemStyle: { opacity: visible } } });
      item.data = data.map((value, index) => value !== null && data[index - 1] == null && data[index + 1] == null ? { value, itemStyle: { opacity: visible } } : value);
    }
    const preciseMoney = selected.some(metric => metric.type === 'money' && metric.fractionDigits === 4);
    const axis = (type, name) => ({ type: 'value', name, nameTextStyle: { color: textColor, fontSize: 10, ...(campaignsMode ? { align: 'left' } : {}) }, nameGap: 13, axisLabel: { color: textColor, fontSize: 10, formatter: value => axisLabel(value, type, preciseMoney) }, splitLine: { show: true, lineStyle: { color: gridColor, type: 'dashed', opacity: .7 } }, axisLine: { show: false }, min: value => Math.min(0, value.min) });
    chart.setOption({
      animation: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      textStyle: { fontFamily: getComputedStyle($('.bd')).fontFamily },
      grid: { left: 8, right: 10, top: 33, bottom: 24, containLabel: true },
      tooltip: { trigger: 'axis', renderMode: 'richText', confine: true, backgroundColor: paletteColor('--bg', light ? '#ffffff' : '#2c3340'), borderColor: gridColor, borderWidth: 1, borderRadius: 4, textStyle: { color: paletteColor('--text', light ? '#263247' : '#eff2f8'), fontSize: 11 }, axisPointer: { type: 'line', lineStyle: { color: textColor, type: 'dashed' } } },
      xAxis: { type: 'category', boundaryGap: false, data: rows.map(row => dateLabel(row.date)), axisLine: { lineStyle: { color: gridColor } }, axisTick: { show: false }, axisLabel: { color: textColor, fontSize: 10, hideOverlap: true, margin: 13, showMaxLabel: true } },
      yAxis: axisTypes.map((type, index) => ({ ...axis(type, campaignsMode ? (type === 'money' ? `${campaignMetric.label}, USD` : type === 'percent' ? `${campaignMetric.label}, %` : metricLabel(campaignMetric)) : ({ quantity: t("Количество или %", "Count or %"), money: 'USD' })[type]), position: index === 0 ? 'left' : 'right', offset: 0, ...(campaignsMode ? {} : { nameTextStyle: { color: textColor, fontSize: 10, align: index === 0 ? 'left' : 'right' } }), splitLine: { show: index === 0, lineStyle: { color: gridColor, type: 'dashed', opacity: .7 } } })),
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none', zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, preventDefaultMouseMove: false, ...(zoom ? { start: zoom.start, end: zoom.end } : {}) }],
      series,
    }, { notMerge: true });
    chart.resize();
  }
  function renderWarnings() {
    const campaignFailures = prefs.mode === 'campaigns' ? (result?.campaigns || []).filter(campaign => campaign.error).map(campaign => `${campaignName(campaign.id)} (#${campaign.id}): ${translateMessage(campaign.error.message || t("данные недоступны", "data unavailable"))}`) : [];
    const warnings = [...(prefs.mode === 'campaigns' ? campaignCatalogWarnings : catalogWarnings), ...(result?.warnings || [])].filter(Boolean).map(String)
      .filter(warning => warning !== 'Некоторые показатели отсутствуют в ответе Binom или скрыты правами/настройками колонок. Они показаны как «—».')
      .map(translateMessage).concat(campaignFailures);
    $('.notice').hidden = !warnings.length;
    $('.notice').textContent = [...new Set(warnings)].join('\n');
  }
  function setTimer() {
    clearInterval(timer);
    timer = null;
    if ([60, 300].includes(Number(prefs.autoRefresh))) timer = setInterval(() => {
      if (!disposed && !document.hidden && !pending) refresh(true);
    }, Number(prefs.autoRefresh) * 1000);
  }
  async function refresh(refreshClicks = false) {
    // A load that pre-empts the date wait still keeps those dates.
    if (dateTimer) { clearTimeout(dateTimer); dateTimer = null; void savePrefs(); }
    if (disposed) return;
    result = null;
    insightRequestId += 1;
    if (prefs.mode === 'campaigns') insightQueued = false;
    else insights.setLoading(query.campaignId ? campaignNames.get(query.campaignId) || `${t('Кампания', 'Campaign')} #${query.campaignId}` : t("Все доступные кампании · независимо от статуса", "All available campaigns · regardless of status"));
    renderCards();
    if (pending) { refreshQueued = true; requestId += 1; return; }
    query = applyPreset(query);
    if (!query.dateFrom || !query.dateTo || query.dateFrom > query.dateTo) {
      error = new Error(t("Проверьте даты: начало периода должно быть раньше его конца.", "Check the dates: the start date must not be after the end date."));
      showState(t("Проверьте период", "Check the period"), error.message); insights.setError(error); return;
    }
    const changed = clicklog.update({ query: scopedQuery(), campaignIds: selectedIds(), scopeLabel: selectedIds().length ? t("Выбранные кампании", "Selected campaigns") : t("Все доступные кампании", "All available campaigns") });
    if (refreshClicks && !changed) void clicklog.refresh();
    if (prefs.mode === 'campaigns' && !prefs.campaignIds.length) {
      error = null; chart?.clear();
      showState(t("Выберите кампании для сравнения", "Select campaigns to compare"), t("Добавьте до 8 кампаний. Каждая будет показана своей линией на общем графике.", "Add up to 8 campaigns. Each campaign will have its own line on the chart."));
      $('.updated').textContent = t("Кампании не выбраны", "No campaigns selected");
      renderWarnings(); void refreshInsights(); return;
    }
    void refreshInsights();
    pending = true; error = null;
    const id = ++requestId;
    $('[data-action=refresh]').disabled = true;
    $('.updated').textContent = t("Обновляем…", "Refreshing…");
    showState(t("Загрузка статистики", "Loading statistics"), prefs.mode === 'campaigns' ? t("Получаем отчёты выбранных кампаний из Binom", "Fetching selected campaign reports from Binom") : t("Получаем отчёт из Binom", "Fetching the report from Binom"), { loading: true });
    try {
      const next = prefs.mode === 'campaigns'
        ? await loadCampaignCharts({ ...requestQuery(), status: 'all', groupId: '', sourceId: '', compare: false }, [...prefs.campaignIds])
        : query.campaignId ? await loadCampaignOverview(scopedQuery(), [query.campaignId]) : await loadDashboard(requestQuery());
      if (disposed || id !== requestId) return;
      result = next;
      const timestamp = next.fetchedAt ? new Date(next.fetchedAt) : new Date();
      $('.updated').textContent = `${t('Обновлено в', 'Updated at')} ${timestamp.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      renderCards(); renderChart(); renderWarnings();
    } catch (caught) {
      if (disposed || id !== requestId) return;
      error = caught;
      result = null;
      renderCards(); chart?.clear();
      const code = String(caught?.code || '');
      const needsSettings = /KEY|AUTH|CONNECT|CONFIG|PERMISSION|401|403/.test(code);
      showState(needsSettings ? t("Подключите ваш Binom", "Connect your Binom") : t("Не удалось загрузить статистику", "Could not load statistics"), String(caught?.message || t("Повторите попытку или проверьте настройки подключения.", "Try again or check connection settings.")), { settings: true });
      $('.updated').textContent = t("Обновление не удалось", "Refresh failed");
    } finally {
      if (!disposed) {
        pending = false;
        $('[data-action=refresh]').disabled = false;
        if (refreshQueued) { refreshQueued = false; refresh(); }
      }
    }
  }
  async function populateCatalogs() {
    try {
      const catalogs = await loadCatalogs();
      if (disposed) return;
      let droppedFilter = false;
      for (const [key, items] of [['groupId', catalogs.groups], ['sourceId', catalogs.sources]]) {
        const control = $(`[data-query=${key}]`);
        const list = Array.isArray(items) ? items : [];
        for (const item of list) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = String(item.name); control.append(option); }
        // A stored filter must stay visible: use the catalog's exact identity, drop
        // one the loaded catalog no longer has, and label it when the list is unavailable.
        const stored = query[key] || '';
        const match = stored && list.find(item => String(item.id).toLowerCase() === stored.toLowerCase());
        if (match) query[key] = String(match.id);
        else if (stored && list.length) { query[key] = ''; droppedFilter = true; }
        else if (stored) { const option = document.createElement('option'); option.value = stored; option.textContent = key === 'groupId' ? t('Сохранённая группа (нет в списке)', 'Saved group (not listed)') : t('Сохранённый источник (нет в списке)', 'Saved source (not listed)'); control.append(option); }
        control.value = query[key] || '';
      }
      if (droppedFilter) { syncControls(); void savePrefs(); refresh(); }
      catalogWarnings = catalogs.warnings || [];
      dropdowns.sync();
      renderWarnings();
    } catch { if (!disposed) { catalogWarnings = [t("Списки групп и источников пока недоступны.", "Group and source lists are currently unavailable.")]; renderWarnings(); } }
  }

  $('[data-action=refresh]').addEventListener('click', () => refresh(true));
  $('[data-action=reset-filters]').addEventListener('click', () => {
    prefs.overviewCampaignId = '';
    prefs.campaignIds = [];
    prefs.campaignMetric = 'clicks';
    draftCampaignIds.clear();
    hiddenCampaigns.clear();
    query = applyPreset({ ...query, datePreset: 'last_30_days', campaignId: '', groupId: '', sourceId: '', compare: false, hideBots: false, uniqueClicks: false });
    closePicker(); void savePrefs(); syncControls(); renderMetricSettings(); refresh();
  });
  $('[data-action=settings]').addEventListener('click', () => onSettings());
  $('.state .setting-action').addEventListener('click', () => onSettings());
  for (const button of $$('[data-mode]')) button.addEventListener('click', () => {
    if (prefs.mode === button.dataset.mode) return;
    prefs.mode = button.dataset.mode;
    closePicker(); savePrefs(); syncControls();
    if (prefs.mode === 'campaigns') void ensureCampaignCatalog();
    refresh();
  });
  $('[data-action=pick-campaigns]').addEventListener('click', () => { if ($('.campaign-popover').hidden) openPicker(); else closePicker(); });
  $('[data-action=close-picker]').addEventListener('click', () => { closePicker(); $('[data-action=pick-campaigns]').focus(); });
  $('.campaign-search').addEventListener('input', () => { expandedCampaignGroups.clear(); renderCampaignPicker(); });
  $('[data-action=pick-overview-campaign]').addEventListener('click', () => { if ($('.overview-campaign-popover').hidden) openOverviewPicker(); else closePicker(); });
  $('[data-action=close-overview-picker]').addEventListener('click', () => { closePicker(); $('[data-action=pick-overview-campaign]').focus(); });
  $('[data-action=all-overview-campaigns]').addEventListener('click', () => selectOverviewCampaign(''));
  $('.overview-campaign-search').addEventListener('input', () => { expandedOverviewGroups.clear(); renderOverviewPicker(); });
  $('[data-action=apply-campaigns]').addEventListener('click', () => {
    const next = [...draftCampaignIds].slice(0, MAX_CAMPAIGNS);
    const changed = JSON.stringify(next) !== JSON.stringify(prefs.campaignIds);
    prefs.campaignIds = next;
    for (const id of hiddenCampaigns) if (!next.includes(id)) hiddenCampaigns.delete(id);
    closePicker(); savePrefs(); syncControls();
    if (changed) refresh(); else renderCampaignLegend();
  });
  $('[data-preference=campaignMetric]').addEventListener('change', event => {
    prefs.campaignMetric = event.target.value; savePrefs(); syncControls(); renderCards(); renderChart();
  });
  // The metric list is a popover over the cards, so it closes on an
  // outside click or Escape like the campaign pickers.
  const metricPopoverOpen = () => $('.metric-settings').open;
  const onOutsidePointer = event => {
    if (!$$('.campaign-picker').some(picker => event.composedPath().includes(picker))) closePicker();
    if (metricPopoverOpen() && !event.composedPath().includes($('.metric-settings'))) $('.metric-settings').open = false;
  };
  const onEscape = event => {
    if (event.key !== 'Escape') return;
    const trigger = !$('.overview-campaign-popover').hidden ? $('[data-action=pick-overview-campaign]') : !$('.campaign-popover').hidden ? $('[data-action=pick-campaigns]') : null;
    if (trigger) { event.preventDefault(); closePicker(); trigger.focus({ preventScroll: true }); }
    else if (metricPopoverOpen()) { event.preventDefault(); $('.metric-settings').open = false; $('.metric-settings summary').focus({ preventScroll: true }); }
  };
  const onPickerViewportChange = () => {
    positionPicker($('.campaign-popover'), $('[data-action=pick-campaigns]'));
    positionPicker($('.overview-campaign-popover'), $('[data-action=pick-overview-campaign]'));
  };
  // ECharts' shared dataZoom controller prevents every wheel event before it
  // checks the Ctrl modifier. Keep ordinary wheel events out of that controller
  // without cancelling the browser's native page/scroll-container scrolling.
  const onChartWheel = event => { if (!event.ctrlKey) event.stopPropagation(); };
  $('.chart').addEventListener('wheel', onChartWheel, { capture: true, passive: true });
  document.addEventListener('pointerdown', onOutsidePointer);
  window.addEventListener('resize', onPickerViewportChange);
  document.addEventListener('scroll', onPickerViewportChange, true);
  root.addEventListener('keydown', onEscape);
  for (const control of $$('[data-query]')) control.addEventListener('change', () => {
    if (control.disabled) { syncControls(); return; }
    const key = control.dataset.query;
    query[key] = control.type === 'checkbox' ? control.checked : control.value;
    if (key === 'uniqueClicks') { void savePrefs(); syncControls(); renderMetricSettings(); renderCards(); renderChart({ preserveViewport: true }); return; }
    if (key === 'campaignId') {
      prefs.overviewCampaignId = query.campaignId;
      if (query.campaignId) { query.groupId = ''; query.sourceId = ''; }
    }
    query = applyPreset(query);
    // Dates are saved when they settle, not on every typed segment.
    if (key !== 'dateFrom' && key !== 'dateTo') void savePrefs();
    syncControls();
    // Choosing "Свой период" keeps the dates of the current period, so the loaded data
    // stay valid; only a later date change loads.
    if (key === 'datePreset' && query.datePreset === 'custom_time' && result && !error && !pending) return;
    if (key === 'dateFrom' || key === 'dateTo') {
      clearTimeout(dateTimer);
      dateTimer = setTimeout(() => { dateTimer = null; void savePrefs(); refresh(); }, DATE_SETTLE_MS);
      return;
    }
    refresh();
  });
  $('[data-preference=autoRefresh]').addEventListener('change', event => { prefs.autoRefresh = Number(event.target.value); savePrefs(); setTimer(); });
  const onResize = () => { if (!disposed) chart?.resize(); };
  if (typeof ResizeObserver !== 'undefined') { resizeObserver = new ResizeObserver(onResize); resizeObserver.observe(container); }
  else window.addEventListener('resize', onResize);
  renderMetricSettings(); syncControls(); renderCards(); setTimer(); populateCatalogs(); void ensureCampaignCatalog();
  if (prefs.mode === 'campaigns') void ensureCampaignCatalog();
  refresh();
  return {
    refresh,
    getQuery: () => ({ ...query }),
    updateQuery(patch) {
      if (disposed) return;
      query = applyPreset({ ...query, ...patch });
      prefs.overviewCampaignId = query.campaignId || '';
      void savePrefs();
      syncControls(); renderMetricSettings(); refresh();
    },
    updateAppearance(patch) {
      if (disposed) return;
      const wasLight = $('.bd').classList.contains('light');
      // Only light/dark remains (the Binom design is the only design).
      if (['auto', 'light', 'dark'].includes(patch?.theme)) prefs.theme = patch.theme;
      // Status polling and unrelated DOM changes repeat this call. Preserve the
      // user's zoom unless the actual palette changed (including auto mode).
      if (wasLight !== isLight()) { syncControls(); renderChart({ preserveViewport: true }); }
    },
    // Leaving right after typing a date (Dashboard → Campaigns) still keeps it.
    destroy() { if (dateTimer) { clearTimeout(dateTimer); dateTimer = null; void savePrefs(); } closePicker(); disposed = true; requestId += 1; clearInterval(timer); resizeObserver?.disconnect(); window.removeEventListener('resize', onResize); window.removeEventListener('resize', onPickerViewportChange); document.removeEventListener('scroll', onPickerViewportChange, true); document.removeEventListener('pointerdown', onOutsidePointer); root.removeEventListener('keydown', onEscape); $('.chart').removeEventListener('wheel', onChartWheel, true); dropdowns.destroy(); insights.destroy(); clicklog.destroy(); insightRequestId += 1; chart?.dispose(); root.replaceChildren(); },
  };
}
