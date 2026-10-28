import { t, locale, translateMessage } from './i18n.js';

export const INSIGHT_SECTIONS = [
  { id: 'breakdowns', get title() { return t('Состав трафика', 'Traffic composition'); }, get description() { return t('Распределение кликов по доступным разрезам', 'Click distribution across available dimensions'); } },
];
const BREAKDOWN_LIMIT = 8;
const CAMPAIGN_LIMIT = 10;
const DIMENSIONS = { get campaigns() { return t('Кампании', 'Campaigns'); }, get groups() { return t('Группы', 'Groups'); }, get sources() { return t('Источники', 'Sources'); }, get countries() { return t('Страны', 'Countries'); } };
const defaultScope = () => t('Все доступные кампании · независимо от статуса', 'All available campaigns · regardless of status');
const COLORS = ['#45a9d6', '#d8924b', '#8eb95c', '#aa85df', '#df7d87', '#cfb24e', '#4fb9ad', '#bf7fa8', '#627ac6', '#76854a'];
const COUNT_FIELDS = {
  clicks: { get label() { return t('Клики', 'Clicks'); }, get noun() { return t('кликов', 'clicks'); }, scope: '' },
  unique_clicks: { get label() { return t('Уникальные клики', 'Unique clicks'); }, get noun() { return t('уникальных кликов', 'unique clicks'); }, get scope() { return t('Уникальность по трекеру', 'Tracker-wide uniqueness'); } },
  unique_campaign_clicks: { get label() { return t('Уникальные клики', 'Unique clicks'); }, get noun() { return t('уникальных кликов', 'unique clicks'); }, get scope() { return t('Уникальность в кампании', 'Campaign uniqueness'); } },
};
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = value => finite(value) ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(Number(value)) : '—';
const dec = value => finite(value) ? new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(Number(value)) : '—';
const pct = value => finite(value) ? `${dec(value)} %` : '—';
const delta = (row, field) => finite(row.current?.[field]) && finite(row.previous?.[field]) ? Number(row.current[field]) - Number(row.previous[field]) : null;
const change = (row, field) => !finite(delta(row, field)) ? null : !Number(row.previous[field]) ? Number(row.current[field]) ? t('Новый трафик', 'New traffic') : t('Без изменений', 'No change') : `${delta(row, field) > 0 ? '+' : ''}${dec(delta(row, field) / Math.abs(Number(row.previous[field])) * 100)} %`;
const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const svgNode = (tag, attributes = {}) => { const element = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value)); return element; };
const safeError = error => translateMessage(String(error?.message || t('Данные этого блока недоступны. Попробуйте обновить.', 'This section is unavailable. Try refreshing.')));
const nameOf = row => typeof row.id === 'string' && row.id.startsWith('name:') && !row.id.slice(5).trim() ? t('Пустое значение', 'Empty value') : String(row.name || row.id || t('Не определено', 'Unknown'));
const colorOf = (index, remainder) => remainder ? '#8c8c8c' : `var(--campaign-${index + 1}, ${COLORS[index]})`;

/** Overview composition stays available independently of legacy section settings. */
export function createInsights(container) {
  let result = null, disposed = false, pending = true, error = null, scopeLabel = defaultScope(), dimension = 'campaigns';
  let countField = 'clicks';
  let hiddenDimensions = new Set();
  const scope = node('p', 'insight-scope'), grid = node('div', 'insights-grid');
  const warnings = node('div', 'insight-warnings'); warnings.setAttribute('role', 'status');
  const section = INSIGHT_SECTIONS[0], article = node('section', 'insight-card insight-breakdowns'), head = node('div', 'insight-card-head'), body = node('div', 'insight-content');
  article.dataset.insight = section.id; article.dataset.section = section.id;
  // The data scope is part of the panel heading.
  head.append(node('h3', '', section.title), node('p', 'insight-description', section.description), scope);
  article.append(head, body); grid.append(article); container.append(warnings, grid);
  const empty = (text, failed = false) => { body.append(node('div', failed ? 'insight-empty insight-error' : 'insight-empty', text)); };

  function diagram(rows, total, label) {
    const figure = node('figure', 'breakdown-figure'), ring = node('div', 'breakdown-ring');
    const svg = svgNode('svg', { viewBox: '0 0 220 220', 'aria-hidden': 'true' });
    svg.append(svgNode('circle', { cx: 110, cy: 110, r: 88, fill: 'none', stroke: 'var(--surface)', 'stroke-width': 24 }));
    let offset = 0;
    for (const [index, row] of rows.entries()) {
      const share = total > 0 ? Number(row.current[countField]) / total * 100 : 0;
      if (share <= 0) continue;
      const segment = svgNode('circle', { cx: 110, cy: 110, r: 88, fill: 'none', stroke: colorOf(index, row.isRemainder), 'stroke-width': 24, pathLength: 100, 'stroke-dasharray': `${share} ${100 - share}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 110 110)', class: 'breakdown-segment' });
      if (row.isRemainder) segment.dataset.remainder = 'true';
      const title = svgNode('title'); title.textContent = `${nameOf(row)}: ${num(row.current[countField])} · ${pct(share)}${countField === 'clicks' ? '' : ` · ${COUNT_FIELDS[countField].label.toLowerCase()}, ${COUNT_FIELDS[countField].scope.toLowerCase()}`}`;
      segment.append(title); svg.append(segment); offset += share;
    }
    const summary = node('div', 'breakdown-total');
    summary.append(node('strong', '', num(total)), node('span', '', t(`доступных ${COUNT_FIELDS[countField].noun}`, `available ${COUNT_FIELDS[countField].noun}`)));
    ring.append(svg, summary); figure.append(ring, node('figcaption', '', label));
    return figure;
  }

  function renderBreakdowns() {
    const tabs = node('div', 'breakdown-tabs');
    tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('Разрез трафика', 'Traffic dimension'));
    for (const [key, label] of Object.entries(DIMENSIONS)) {
      if (hiddenDimensions.has(key)) continue;
      const button = node('button', 'text-action', label); button.type = 'button'; button.setAttribute('aria-pressed', String(key === dimension));
      button.addEventListener('click', () => {
        dimension = key; body.replaceChildren(); renderBreakdowns();
        body.querySelector('.breakdown-tabs [aria-pressed=true]')?.focus({ preventScroll: true });
      }); tabs.append(button);
    }
    body.append(tabs);
    if (result?.breakdowns?.error) { empty(safeError(result.breakdowns.error), true); return; }
    const data = result?.breakdowns?.[dimension];
    if (data?.previousError) empty(t('Предыдущий период: ', 'Previous period: ') + safeError(data.previousError), true);
    if (data?.error) { empty(safeError(data.error), true); return; }
    const allRows = data?.rows || [], rows = allRows.filter(row => finite(row.current?.[countField]));
    // Entries that appear only in the complete previous report are named as such;
    // the rest without a finite count are genuinely unavailable. No zero is inferred.
    const previousOnly = allRows.filter(row => row.onlyPrevious === true && !finite(row.current?.[countField])).length;
    if (!rows.length && previousOnly && previousOnly === allRows.length) {
      empty(t(`В текущем периоде в этом разрезе нет записей. Только в предыдущем периоде: ${num(previousOnly)}.`, `No entries in this dimension for the current period. Only in the previous period: ${num(previousOnly)}.`)); return;
    }
    if (!rows.length) { empty(countField === 'clicks' ? t('В этом разрезе нет доступных данных.', 'No data is available for this dimension.') : t('Binom не вернул доступные уникальные клики для этого разреза. Проверьте соответствующую колонку у пользователя API.', 'Binom did not return unique clicks for this dimension. Check the corresponding column for the API user.')); return; }
    // This is the sum of visible values in this dimension, never a replacement
    // for a hidden report total. Unknown counts do not contribute to the chart.
    const total = rows.reduce((sum, row) => sum + Number(row.current[countField]), 0);
    const limit = dimension === 'campaigns' ? CAMPAIGN_LIMIT : BREAKDOWN_LIMIT;
    const ranked = [...rows].sort((a, b) => Number(b.current[countField]) - Number(a.current[countField])), visible = ranked.slice(0, limit), remainder = ranked.slice(limit);
    if (remainder.length) visible.push({
      isRemainder: true,
      name: `${t('Остальные', 'Others')} · ${num(remainder.length)}`,
      current: { [countField]: remainder.reduce((sum, row) => sum + Number(row.current[countField]), 0) },
      previous: { [countField]: remainder.every(row => finite(row.previous?.[countField])) ? remainder.reduce((sum, row) => sum + Number(row.previous[countField]), 0) : null },
    });
    const distribution = node('div', 'breakdown-distribution'), list = node('div', 'breakdown-list');
    list.setAttribute('role', 'list'); list.setAttribute('aria-label', `${DIMENSIONS[dimension]}: ${COUNT_FIELDS[countField].label.toLowerCase()} ${t('и доли', 'and shares')}`);
    for (const [index, row] of visible.entries()) {
      const share = total > 0 ? Number(row.current[countField]) / total * 100 : null;
      const item = node('div', 'breakdown-row'), label = node('div', 'breakdown-label'); item.setAttribute('role', 'listitem');
      if (row.isRemainder) item.dataset.remainder = 'true';
      item.style.setProperty('--breakdown-color', colorOf(index, row.isRemainder));
      label.append(node('span', 'breakdown-name', nameOf(row)), node('b', '', `${num(row.current[countField])} · ${pct(share)}`));
      const comparison = change(row, countField);
      if (comparison !== null) label.append(node('small', delta(row, countField) > 0 ? 'positive' : delta(row, countField) < 0 ? 'negative' : '', comparison));
      const bar = node('div', 'breakdown-bar'), fill = node('i'); bar.setAttribute('aria-hidden', 'true'); fill.style.width = `${Math.max(0, share || 0)}%`;
      bar.append(fill); item.append(label, bar); list.append(item);
    }
    distribution.append(diagram(visible, total, DIMENSIONS[dimension]), list); body.append(distribution);
    const note = remainder.length ? t(`Показаны ${limit} крупнейших ${dimension === 'campaigns' ? 'кампаний' : 'значений'}; ещё ${num(remainder.length)} объединены в «Остальные». `, `Showing the top ${limit} ${dimension === 'campaigns' ? 'campaigns' : 'values'}; ${num(remainder.length)} more are grouped as Others. `) : '';
    const unavailable = allRows.length - rows.length - previousOnly;
    body.append(node('p', 'insight-note', `${note}${t('Доли рассчитаны по доступным значениям разреза.', 'Shares use the available values for this dimension.')}${unavailable ? t(` Без доступного числа ${COUNT_FIELDS[countField].noun}: ${num(unavailable)}.`, ` Entries with unavailable ${COUNT_FIELDS[countField].noun}: ${num(unavailable)}.`) : ''}${previousOnly ? t(` Только в предыдущем периоде: ${num(previousOnly)}.`, ` Only in the previous period: ${num(previousOnly)}.`) : ''}${total === 0 ? t(' В выбранном периоде доступные значения равны нулю.', ' Available values are zero for the selected period.') : ''}`));
  }
  function render() {
    if (disposed) return;
    container.dataset.state = pending ? 'loading' : error ? 'error' : 'ready';
    head.querySelector('.insight-description').textContent = countField === 'clicks' ? section.description : `${t('Распределение уникальных кликов по доступным разрезам', 'Unique click distribution across available dimensions')} · ${COUNT_FIELDS[countField].scope}`;
    scope.textContent = scopeLabel;
    warnings.textContent = (result?.warnings || []).map(message => translateMessage(String(message))).join('\n'); warnings.hidden = !warnings.textContent;
    body.replaceChildren();
    if (pending) empty(t('Загрузка данных…', 'Loading data…')); else if (error) empty(safeError(error), true); else renderBreakdowns();
  }
  render();
  return {
    setCountField(field) {
      if (!Object.hasOwn(COUNT_FIELDS, field) || field === countField) return;
      countField = field; render();
    },
    setFilters({ campaignId = '', groupId = '', sourceId = '' } = {}) {
      const next = new Set(Object.entries({ campaigns: campaignId, groups: groupId, sources: sourceId }).filter(([, value]) => Boolean(value)).map(([key]) => key));
      if (next.size === hiddenDimensions.size && [...next].every(key => hiddenDimensions.has(key))) return;
      hiddenDimensions = next;
      if (hiddenDimensions.has(dimension)) dimension = Object.keys(DIMENSIONS).find(key => !hiddenDimensions.has(key));
      render();
    },
    setLoading(label) { pending = true; error = null; result = null; if (label) scopeLabel = label; render(); },
    setResult(value) { pending = false; error = null; result = value; scopeLabel = value?.scope?.label ? translateMessage(value.scope.label) : scopeLabel; render(); },
    setError(value) { pending = false; result = null; error = value; render(); },
    destroy() { disposed = true; container.replaceChildren(); },
  };
}
