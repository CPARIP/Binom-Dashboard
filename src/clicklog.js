import { t, locale, translateMessage } from './i18n.js';
import { CLICKLOG_COLUMNS, DEFAULT_CLICKLOG_COLUMNS, CLICKLOG_PAGE_SIZES, DEFAULT_CLICKLOG_PAGE_SIZE, validateClicklogPreferences } from './clicklog-schema.js';
import { publicError } from './security.js';
import { describeClicklogIcon } from './clicklog-icons.js';

let tooltipSequence = 0;

const node = (tag, className, text) => { const element = document.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; return element; };
const present = value => typeof value === 'string' && value.length ? value : null;
const orderedTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value : null;
const join = (...values) => values.map(present).filter(Boolean).join(' ') || '—';
function valueOf(row, key) {
  if (key === 'ip') return present(row.ip) || present(row.ip_v4) || present(row.ip_v6) || '—';
  if (key === 'os') return join(row.os_name, row.os_version);
  if (key === 'browser') return join(row.browser_name, row.browser_version);
  if (key === 'device') return join(row.device_type, row.device_name, row.device_model);
  if (key === 'is_bot') return ['1', 'true'].includes(row.is_bot) ? t('Да', 'Yes') : ['0', 'false'].includes(row.is_bot) ? t('Нет', 'No') : '—';
  if (key === 'click_time') return present(row.click_time) || present(row.clicked_date) || '—';
  return present(row[key]) || '—';
}
/** Cursor edges of the unfiltered page: hidden bot clicks still bound the page. */
function pageEdges(data) {
  const rows = data?.rows || [];
  return data?.edges || { first: rows[0] || null, last: rows.at(-1) || null };
}
function scopeKey(query, ids) {
  return JSON.stringify({ datePreset: query.datePreset, dateFrom: query.dateFrom, dateTo: query.dateTo, timezone: query.timezone, groupId: query.groupId, hideBots: query.hideBots === true, campaignIds: ids });
}

/** Transient click records never enter preferences or local/session storage. */
export function createClicklog(container, { loadPage = async () => { throw new Error(); }, preferences = {}, onPreferencesChange = () => {} } = {}) {
  let columns = [...DEFAULT_CLICKLOG_COLUMNS], limit = DEFAULT_CLICKLOG_PAGE_SIZE;
  try {
    const patch = validateClicklogPreferences({ ...(preferences.clicklogColumns ? { clicklogColumns: preferences.clicklogColumns } : {}), ...(preferences.clicklogPageSize !== undefined ? { clicklogPageSize: preferences.clicklogPageSize } : {}) });
    columns = patch.clicklogColumns || columns; limit = patch.clicklogPageSize || limit;
  } catch { /* Invalid stored display settings use bounded defaults. */ }
  let query = {}, campaignIds = [], signature = null, request = 0, disposed = false, pending = false, data = null, error = null, page = { limit }, pageNumber = 1, scopeLabel = '';
  container.classList.add('clicklog-root');
  const article = node('section', 'clicklog-panel'), head = node('div', 'clicklog-head'), heading = node('div');
  heading.append(node('h3', '', t('Последние клики', 'Recent clicks')), node('p', 'clicklog-order', t('Сначала новые', 'Newest first')));
  const controls = node('div', 'clicklog-controls'), settings = node('details', 'clicklog-columns');
  settings.append(node('summary', '', t('Колонки', 'Columns')));
  const choices = node('div', 'clicklog-column-options');
  for (const column of CLICKLOG_COLUMNS) {
    const label = node('label', 'check'), input = node('input'); input.type = 'checkbox'; input.dataset.column = column.key; input.checked = columns.includes(column.key);
    input.addEventListener('change', () => {
      const next = input.checked ? [...columns, column.key] : columns.filter(key => key !== column.key);
      if (!next.length) { input.checked = true; return; }
      columns = CLICKLOG_COLUMNS.filter(column => next.includes(column.key)).map(column => column.key);
      preferences.clicklogColumns = [...columns]; save({ clicklogColumns: [...columns] }); renderTable();
    }); label.append(input, document.createTextNode(column.label)); choices.append(label);
  }
  settings.append(choices);
  const refreshButton = node('button', 'setting-action', t('Обновить', 'Refresh')); refreshButton.type = 'button'; refreshButton.dataset.clicklogAction = 'refresh'; refreshButton.addEventListener('click', () => { void refresh(); });
  controls.append(settings, refreshButton); head.append(heading, controls);
  const scope = node('p', 'clicklog-scope'), feedback = node('p', 'clicklog-feedback'); feedback.setAttribute('role', 'status');
  const content = node('div', 'clicklog-content'), footer = node('div', 'clicklog-footer'), limitLabel = node('label', '', t('Строк на странице', 'Rows per page'));
  const select = node('select'); select.dataset.clicklogLimit = ''; select.setAttribute('aria-label', t('Строк кликов на странице', 'Clicks per page'));
  for (const size of CLICKLOG_PAGE_SIZES) { const option = node('option', '', String(size)); option.value = String(size); select.append(option); }
  select.value = String(limit); limitLabel.append(select);
  select.addEventListener('change', () => { limit = Number(select.value); preferences.clicklogPageSize = limit; save({ clicklogPageSize: limit }); void refresh(); });
  const pagination = node('div', 'clicklog-pagination'), prev = node('button', 'setting-action', t('Назад', 'Previous')), next = node('button', 'setting-action', t('Далее', 'Next')), position = node('span', 'clicklog-position');
  prev.type = next.type = 'button'; prev.dataset.clicklogAction = 'prev'; next.dataset.clicklogAction = 'next';
  prev.addEventListener('click', () => { void navigate('prev'); }); next.addEventListener('click', () => { void navigate('next'); });
  pagination.append(prev, position, next); footer.append(limitLabel, pagination);
  const tooltip = node('div', 'clicklog-tooltip'); tooltip.id = `clicklog-tooltip-${++tooltipSequence}`; tooltip.setAttribute('role', 'tooltip'); tooltip.setAttribute('popover', 'manual'); tooltip.hidden = true;
  let tooltipTarget = null;
  article.append(head, scope, feedback, content, footer); container.append(article, tooltip);
  function hideTooltip() {
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
    tooltip.hidden = true; tooltipTarget?.removeAttribute('aria-describedby'); tooltipTarget = null;
  }
  function showTooltip(target, label) {
    hideTooltip(); tooltipTarget = target; tooltip.textContent = label; tooltip.hidden = false;
    target.setAttribute('aria-describedby', tooltip.id);
    if (typeof tooltip.showPopover === 'function') tooltip.showPopover();
    const rect = target.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left + (rect.width - box.width) / 2, window.innerWidth - box.width - 8))}px`;
    tooltip.style.top = `${Math.max(8, rect.bottom + box.height + 8 <= window.innerHeight ? rect.bottom + 8 : rect.top - box.height - 8)}px`;
  }
  function onTooltipKey(event) { if (event.key === 'Escape') hideTooltip(); }
  container.addEventListener('scroll', hideTooltip, true); window.addEventListener('scroll', hideTooltip, true); window.addEventListener('resize', hideTooltip); window.addEventListener('keydown', onTooltipKey);
  function renderIcon(row, key, value) {
    const description = describeClicklogIcon(key, key === 'device' ? row.device_type : key === 'os' ? row.os_name : value === '—' ? null : value);
    const label = value === '—' ? description.label : value;
    const icon = node('span', 'clicklog-value-icon'); icon.tabIndex = 0; icon.setAttribute('role', 'img'); icon.setAttribute('aria-label', label); icon.dataset.icon = description.icon;
    if (description.emoji) icon.textContent = description.emoji;
    // The helper returns fixed local artwork, never markup from API values.
    else icon.innerHTML = description.svg;
    icon.addEventListener('pointerenter', () => showTooltip(icon, label));
    icon.addEventListener('focus', () => showTooltip(icon, label));
    icon.addEventListener('pointerleave', hideTooltip); icon.addEventListener('blur', hideTooltip);
    return icon;
  }
  async function save(patch) {
    try { await onPreferencesChange(patch); if (!disposed) feedback.textContent = ''; }
    catch { if (!disposed) feedback.textContent = t('Не удалось сохранить вид таблицы. Повторите выбор.', 'Could not save the table layout. Try again.'); }
  }
  function renderTable() {
    if (disposed) return;
    hideTooltip();
    content.replaceChildren(); container.dataset.state = pending ? 'loading' : error ? 'error' : 'ready';
    refreshButton.disabled = pending || signature === null;
    const rows = data?.rows || [], info = data?.pageInfo, edges = pageEdges(data);
    prev.disabled = pending || Boolean(error) || info?.hasPrevPage !== true || !edges.first?.id;
    next.disabled = pending || Boolean(error) || info?.hasNextPage !== true || !edges.last?.id;
    position.textContent = data && !pending && !error ? t(`Страница ${new Intl.NumberFormat(locale()).format(pageNumber)} · ${new Intl.NumberFormat(locale()).format(rows.length)} строк`, `Page ${new Intl.NumberFormat(locale()).format(pageNumber)} · ${new Intl.NumberFormat(locale()).format(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`) : '';
    if (pending || error || !rows.length) {
      content.append(node('p', error ? 'clicklog-state clicklog-error' : 'clicklog-state', pending ? t('Загрузка кликов…', 'Loading clicks…') : error ? translateMessage(error.message)
        : edges.first?.id ? t('На этой странице только клики, которые Binom отметил как ботов.', 'This page only has clicks Binom marked as bots.')
          : t('За выбранный период кликов нет или они недоступны.', 'There are no clicks for this period, or they are unavailable.'))); return;
    }
    const wrap = node('div', 'clicklog-table-wrap'), table = node('table', 'clicklog-table'), thead = node('thead'), tr = node('tr'), tbody = node('tbody');
    table.setAttribute('aria-label', t('Последние клики', 'Recent clicks'));
    for (const key of columns) { const th = node('th', '', CLICKLOG_COLUMNS.find(column => column.key === key).label); th.scope = 'col'; th.dataset.column = key; tr.append(th); }
    thead.append(tr);
    for (const row of rows) {
      const tr = node('tr'); if (row.id != null) tr.dataset.clickId = row.id;
      for (const key of columns) {
        const value = valueOf(row, key), td = node('td'); td.dataset.column = key;
        if (['country', 'device', 'os'].includes(key)) td.append(renderIcon(row, key, value)); else td.textContent = value;
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(thead, tbody); wrap.append(table); content.append(wrap);
  }
  async function load(nextPage, nextNumber, boundary = null) {
    if (disposed || signature === null) return;
    const id = ++request; pending = true; error = null; data = null; renderTable();
    try {
      const result = await loadPage({ ...query }, [...campaignIds], { ...nextPage });
      if (disposed || id !== request) return;
      // Never re-sort cursor pages: a contradictory boundary means pagination is unreliable.
      const first = result?.rows?.[0], last = result?.rows?.at(-1);
      if (boundary && orderedTime(boundary.click_time) && ((nextPage.direction === 'next' && orderedTime(first?.click_time) && first.click_time > boundary.click_time) || (nextPage.direction === 'prev' && orderedTime(last?.click_time) && last.click_time < boundary.click_time))) {
        const failed = new Error(); failed.code = 'API_RESPONSE'; throw failed;
      }
      data = result; page = nextPage; pageNumber = nextNumber;
    } catch (caught) { if (disposed || id !== request) return; error = publicError(caught); }
    finally { if (!disposed && id === request) { pending = false; renderTable(); } }
  }
  async function navigate(direction) {
    if (pending || error || !data) return;
    const info = data.pageInfo, edges = pageEdges(data), boundary = direction === 'next' ? edges.last : edges.first;
    if (!boundary?.id || (direction === 'next' ? info?.hasNextPage : info?.hasPrevPage) !== true) return;
    const nextPage = { limit, cursor: boundary.id, direction };
    for (const key of ['from', 'to']) if (typeof info?.[key] === 'string' && info[key]) nextPage[key] = info[key];
    await load(nextPage, Math.max(1, pageNumber + (direction === 'next' ? 1 : -1)), boundary);
  }
  function refresh() { return load({ limit }, 1); }
  renderTable();
  return {
    update({ query: nextQuery = {}, campaignIds: nextIds = [], scopeLabel: label = '' } = {}) {
      if (disposed) return;
      query = { ...nextQuery }; campaignIds = [...nextIds]; scopeLabel = label;
      scope.textContent = `${scopeLabel || (campaignIds.length ? t('Выбранные кампании', 'Selected campaigns') : t('Все доступные кампании', 'All available campaigns'))} · ${t('период и группа как в фильтрах.', 'period and group match the filters.')}`;
      article.querySelector('.clicklog-order').textContent = `${t('Сначала новые', 'Newest first')}${query.timezone ? ' · ' + query.timezone : ''}`;
      const nextSignature = scopeKey(query, campaignIds);
      if (signature !== nextSignature) { signature = nextSignature; void refresh(); return true; }
      return false;
    },
    refresh,
    destroy() { disposed = true; request++; data = null; hideTooltip(); container.removeEventListener('scroll', hideTooltip, true); window.removeEventListener('scroll', hideTooltip, true); window.removeEventListener('resize', hideTooltip); window.removeEventListener('keydown', onTooltipKey); container.replaceChildren(); },
  };
}
