// Read-only Binom v2 adapter. There is intentionally no general-purpose request API.
const PATHS = Object.freeze({
  trends: '/public/api/v1/trends',
  groups: '/public/api/v1/groups/campaigns',
  sources: '/public/api/v1/traffic_source/list/filtered',
  campaigns: '/public/api/v1/campaign/list/filtered',
  campaignReport: '/public/api/v1/report/campaign',
  trackerSettings: '/public/api/v1/settings/info',
});
const ALLOWED_PATHS = new Set(Object.values(PATHS));
const PAGE_SIZE = 500;
const MAX_ROWS = 10000;
const MAX_PAGES = 100;
const TIMEOUT_MS = 20000;
const MAX_CAMPAIGNS = 8;
const CAMPAIGN_CONCURRENCY = 3;
const BASE_METRICS = ['clicks', 'leads', 'costs', 'revenue', 'profit', 'roi', 'cr', 'epc', 'cpc', 'bots'];
// These native aggregate columns are optional: availability depends on Binom's
// column settings. Their absence must not warn when ordinary metrics are shown.
const UNIQUE_METRICS = ['unique_clicks', 'unique_campaign_clicks'];
const METRICS = [...BASE_METRICS, ...UNIQUE_METRICS];
const COUNT_METRICS = new Set(['clicks', 'leads', 'bots', ...UNIQUE_METRICS]);
const RATIOS = Object.freeze({ roi: ['profit', 'costs', 100], cr: ['leads', 'clicks', 100], epc: ['revenue', 'clicks', 1], cpc: ['costs', 'clicks', 1] });
const MESSAGES = Object.freeze({
  INVALID_QUERY: 'Некорректные параметры отчёта. Проверьте период, часовой пояс и фильтры.',
  INVALID_ORIGIN: 'Укажите HTTPS-адрес трекера без пути, параметров и данных входа.',
  INVALID_KEY: 'Введите корректный API-ключ.',
  NETWORK: 'Не удалось связаться с Binom. Проверьте адрес, HTTPS и разрешение расширения.',
  TIMEOUT: 'Binom не ответил вовремя. Попробуйте меньший период.',
  AUTH: 'Binom не принял API-ключ. Проверьте ключ в настройках расширения.',
  FORBIDDEN: 'У пользователя Binom нет доступа к этим данным.',
  RATE_LIMIT: 'Binom ограничил частоту запросов. Подождите перед обновлением.',
  API_RESPONSE: 'Binom вернул неожиданный формат данных. Возможно, требуется обновление адаптера.',
  API_ERROR: 'Binom не смог выполнить запрос. Проверьте доступность Public API и выбранные фильтры.',
  INCOMPLETE_DATA: 'Не удалось получить полный отчёт. Итоги не показаны. Сократите период или фильтры.',
  BOT_FILTER: 'Binom не прислал отметку «Бот» для кликов, поэтому «Без ботов» не применить к журналу. Включите колонку «Бот» в настройках таблицы журнала кликов у API-пользователя Binom или выключите фильтр.',
  REPEATED_PAGE: 'Binom повторил уже полученные строки. Полнота отчёта не подтверждена; итоги не показаны.',
  REPORT_LIMIT: 'Отчёт превысил безопасный предел загрузки. Сократите период или фильтры.',
  TIMEZONE_UNAVAILABLE: 'Binom не вернул корректный часовой пояс. Проверьте настройку часового пояса в Binom и доступ API-пользователя к ней.',
});

const REPORT_DIAGNOSTICS = new Set(['report-shape', 'report-empty', 'report-total', 'report-zero', 'row-identity', 'category-shape', 'category-name-null', 'category-name', 'category-level', 'category-id', 'campaign-id', 'category-label-conflict']);

export class ApiError extends Error {
  constructor(code, diagnostic) {
    super(MESSAGES[code] || MESSAGES.API_ERROR);
    this.name = 'ApiError';
    this.code = Object.hasOwn(MESSAGES, code) ? code : 'API_ERROR';
    if (REPORT_DIAGNOSTICS.has(diagnostic)) this.diagnostic = diagnostic;
  }
}

function fail(code, diagnostic) { throw new ApiError(code, diagnostic); }
function pick(value, allowed, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) fail('INVALID_QUERY');
  return value;
}
function boolean(value) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail('INVALID_QUERY');
  return value;
}
function validTimezone(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
  catch { return false; }
}
function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value &&
    value >= '1970-01-01' && value <= '2200-12-31';
}
function daysBetween(start, end) {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000);
}
export function shiftDay(day, count) {
  if (!validDay(day) || !Number.isInteger(count) || Math.abs(count) > 1000) fail('INVALID_QUERY');
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}

/** Ignore unknown properties: a content script can never supply a URL, headers or API path. */
export function validateQuery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_QUERY');
  const datePreset = pick(input.datePreset,
    ['today', 'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'custom_time'], 'today');
  const timezone = input.timezone === undefined ? 'UTC' : input.timezone;
  if (!validTimezone(timezone)) fail('INVALID_QUERY');
  const groupId = input.groupId === undefined ? '' : input.groupId;
  const sourceId = input.sourceId === undefined ? '' : input.sourceId;
  if (typeof groupId !== 'string' || (groupId !== '' && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(groupId))) fail('INVALID_QUERY');
  if (typeof sourceId !== 'string' || (sourceId !== '' && !/^[1-9]\d{0,14}$/.test(sourceId))) fail('INVALID_QUERY');
  let dateFrom = '', dateTo = '';
  if (datePreset === 'custom_time') {
    dateFrom = input.dateFrom;
    dateTo = input.dateTo;
    if (!validDay(dateFrom) || !validDay(dateTo) || dateFrom > dateTo || daysBetween(dateFrom, dateTo) > 365) fail('INVALID_QUERY');
  }
  return {
    datePreset, dateFrom, dateTo, timezone,
    status: pick(input.status, ['all', 'active', 'with_traffic', 'deleted'], 'all'),
    groupId: groupId.toLowerCase(), sourceId,
    grouping: pick(input.grouping, ['auto', 'days', 'hours'], 'auto'),
    hideBots: boolean(input.hideBots), compare: boolean(input.compare),
  };
}

function isCampaignId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
}

/** Selected IDs cannot become arbitrary report paths or unbounded batches. */
export function validateCampaignIds(input) {
  if (!Array.isArray(input) || input.length > MAX_CAMPAIGNS ||
      Array.from(input).some(id => !isCampaignId(id)) || new Set(input).size !== input.length) fail('INVALID_QUERY');
  return [...input];
}

function zonedClock(now, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(part => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}:${values.second}` };
}

/** Calendar ranges use the selected zone, independent of the browser or server zone.
 * Last N days includes today. An unfinished last day is compared at the same local
 * clock time in the previous calendar period, including across DST transitions. */
export function resolveRanges(input, now = new Date()) {
  const query = validateQuery(input);
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) fail('INVALID_QUERY');
  const clock = zonedClock(now, query.timezone);
  let from, to;
  if (query.datePreset === 'custom_time') { from = query.dateFrom; to = query.dateTo; }
  else if (query.datePreset === 'yesterday') { from = to = shiftDay(clock.day, -1); }
  else {
    const length = { today: 1, last_7_days: 7, last_14_days: 14, last_30_days: 30 }[query.datePreset];
    from = shiftDay(clock.day, 1 - length); to = clock.day;
  }
  if (to > clock.day) fail('INVALID_QUERY');
  const length = daysBetween(from, to) + 1;
  // The native Hours mode can aggregate recurring clock hours across days.
  // Do not represent that as a chronological multi-day series.
  if (query.grouping === 'hours' && length !== 1) fail('INVALID_QUERY');
  const endTime = to === clock.day ? clock.time : '23:59:59';
  const current = { dateFrom: `${from} 00:00:00`, dateTo: `${to} ${endTime}` };
  const previous = query.compare ? {
    dateFrom: `${shiftDay(from, -length)} 00:00:00`,
    dateTo: `${shiftDay(to, -length)} ${endTime}`,
  } : null;
  return { current, previous, grouping: query.grouping === 'auto' ? (length === 1 ? 'hours' : 'days') : query.grouping };
}

/** Binom field that carries a metric. A real Binom v2 names spend `cost` in Trends and
 * Report rows and totals (its own frontend reads `cost`); the supplied OpenAPI said
 * `costs`, kept as a fallback only when `cost` is absent. */
function metricField(record, metric) {
  return metric === 'costs' && record && Object.hasOwn(record, 'cost') ? 'cost' : metric;
}

function numberOrNull(value) {
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function normalizeRow(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.date !== 'string' || !raw.date || raw.date.length > 100) fail('API_RESPONSE');
  const row = { date: raw.date };
  for (const name of METRICS) row[name] = numberOrNull(raw[metricField(raw, name)]);
  for (const name of COUNT_METRICS) {
    if (row[name] !== null && (!Number.isSafeInteger(row[name]) || row[name] < 0)) row[name] = null;
  }
  // Never reconstruct missing/hidden profit or ROI from other fields.
  return row;
}

/** Every missing value propagates to its total. Visible ratios use complete sums,
 * never an average; a hidden ratio cannot be recovered from its operands. */
export function aggregateRows(rows) {
  const total = Object.fromEntries(METRICS.map(name => [name, null]));
  if (!rows.length) return total;
  for (const name of METRICS.filter(name => !Object.hasOwn(RATIOS, name))) {
    if (rows.every(row => typeof row[name] === 'number' && Number.isFinite(row[name]) &&
        (!COUNT_METRICS.has(name) || Number.isSafeInteger(row[name]) && row[name] >= 0))) {
      const sum = rows.reduce((result, row) => result + row[name], 0);
      total[name] = Number.isFinite(sum) && (!COUNT_METRICS.has(name) || Number.isSafeInteger(sum)) ? sum : null;
    }
  }
  for (const [name, [numerator, denominator, scale]] of Object.entries(RATIOS)) {
    if (rows.every(row => typeof row[name] === 'number' && Number.isFinite(row[name])) &&
        total[numerator] !== null && total[denominator] !== null && total[denominator] > 0) {
      const ratio = total[numerator] / total[denominator] * scale;
      total[name] = Number.isFinite(ratio) ? ratio : null;
    }
  }
  return total;
}

/** Number of calendar buckets in a requested range; 0 for an unsupported grouping. */
function timeGridSize(range, grouping) {
  const from = range.dateFrom.slice(0, 10), to = range.dateTo.slice(0, 10);
  if (grouping === 'days') return daysBetween(from, to) + 1;
  if (grouping === 'hours' && from === to) return Number(range.dateTo.slice(11, 13)) - Number(range.dateFrom.slice(11, 13)) + 1;
  return 0;
}

/** Calendar position of a Trends label inside the requested range, or null for
 * unknown, malformed or out-of-range labels. */
function timePosition(label, range, grouping) {
  const size = timeGridSize(range, grouping);
  let position;
  if (grouping === 'days') {
    if (!validDay(label)) return null;
    position = daysBetween(range.dateFrom.slice(0, 10), label);
  } else if (grouping === 'hours') {
    const match = /^(\d{2}):00(?:\s*[-–]\s*(\d{2}):00)?$/.exec(label.trim());
    if (!match || Number(match[1]) > 23) return null;
    const hour = Number(match[1]);
    if (match[2] !== undefined && Number(match[2]) !== (hour + 1) % 24 && !(hour === 23 && match[2] === '24')) return null;
    position = hour - Number(range.dateFrom.slice(11, 13));
  } else return null;
  return position >= 0 && position < size ? position : null;
}

/** Place rows on the requested calendar grid; missing buckets become null rows,
 * never zeros. Unknown, duplicate or out-of-range labels return null rather than a guess.
 * Every row gets the canonical label, so one axis never mixes "HH:00" and "HH:00 - HH:00". */
export function padTimeSeries(rows, range, grouping) {
  const size = timeGridSize(range, grouping);
  if (!size) return null;
  const index = new Map();
  for (const row of rows) {
    const position = timePosition(row.date, range, grouping);
    if (position === null || index.has(position)) return null;
    index.set(position, row);
  }
  const from = range.dateFrom.slice(0, 10), startHour = Number(range.dateFrom.slice(11, 13));
  return Array.from({ length: size }, (_, position) => {
    const date = grouping === 'hours' ? hourLabel(startHour + position) : shiftDay(from, position);
    const row = index.get(position);
    return row ? { ...row, date } : emptyMetricRow(date);
  });
}

/** Align by calendar position, never by the index of potentially sparse API rows.
 * Unknown labels return null so callers can decline a misleading comparison. */
export function alignComparison(currentRows, previousRows, ranges) {
  if (!ranges.previous) return null;
  const current = padTimeSeries(currentRows, ranges.current, ranges.grouping);
  const previous = padTimeSeries(previousRows, ranges.previous, ranges.grouping);
  if (!current || !previous || current.length !== previous.length) return null;
  return { current, previous, hasGaps: current.length !== currentRows.length || previous.length !== previousRows.length };
}

function connection(origin, key) {
  let url;
  try { url = new URL(origin); } catch { fail('INVALID_ORIGIN'); }
  if (typeof origin !== 'string' || url.protocol !== 'https:' || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') fail('INVALID_ORIGIN');
  if (typeof key !== 'string' || !key.trim() || key.length > 2048 || /[^\x21-\x7E]/.test(key)) fail('INVALID_KEY');
  return { origin: url.origin, key };
}

async function readJSON(context, path, params) {
  if (!ALLOWED_PATHS.has(path)) fail('API_ERROR');
  const url = new URL(path, context.origin);
  url.search = params.toString();
  const controller = new AbortController();
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new ApiError('TIMEOUT')); }, TIMEOUT_MS);
  });
  const request = async () => {
    // Native browser fetch rejects arbitrary receiver objects (Illegal invocation).
    // Keep the call detached rather than invoking it as a context method.
    const fetchImpl = context.fetchImpl;
    const response = await fetchImpl(url.href, {
      method: 'GET', headers: { 'Api-Key': context.key, Accept: 'application/json' },
      redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    if (response.redirected) fail('NETWORK');
    if (response.status === 401) fail('AUTH');
    if (response.status === 403) fail('FORBIDDEN');
    if (response.status === 429) fail('RATE_LIMIT');
    if (!response.ok) fail('API_ERROR');
    const declaredSize = Number(response.headers?.get('content-length'));
    if (declaredSize > 8 * 1024 * 1024) fail('API_RESPONSE');
    const body = await response.text();
    if (body.length > 8 * 1024 * 1024) fail('API_RESPONSE');
    try { return JSON.parse(body); } catch { fail('API_RESPONSE'); }
  };
  try { return await Promise.race([request(), timer]); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    if (controller.signal.aborted) fail('TIMEOUT');
    fail('NETWORK');
  } finally { clearTimeout(timeout); }
}

/** Read the tracker zone only; never forward email or other settings fields. */
export async function fetchTrackerTimezone({ origin, key, fetchImpl = fetch }) {
  const context = { ...connection(origin, key), fetchImpl };
  const payload = await readJSON(context, PATHS.trackerSettings, new URLSearchParams());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !validTimezone(payload.timezone)) {
    fail('TIMEZONE_UNAVAILABLE');
  }
  return payload.timezone;
}

/** A complete bounded time domain proves a Trends response needs no next page.
 * Unknown formats, sparse domains and out-of-range labels cannot prove completion. */
function coversTimeRange(rows, range, grouping) {
  const count = timeGridSize(range, grouping);
  return count > 0 && rows.length === count && withinTimeRange(rows, range, grouping);
}

/** Every label is a distinct canonical bucket of the requested range; buckets may be missing. */
function withinTimeRange(rows, range, grouping) {
  const positions = new Set();
  for (const row of rows) {
    const position = timePosition(row.date, range, grouping);
    if (position === null || positions.has(position)) return false;
    positions.add(position);
  }
  return positions.size > 0;
}

function samePageIdentities(previous, next, identity) {
  return next.length === previous.length && next.every((row, index) => identity(row) === identity(previous[index]));
}

/** Continue until an empty page or a caller-proven complete bounded report.
 * A short page alone does not prove completion: servers can cap page sizes.
 * Real Trends ignores offset and resends its whole response. isWholeResponse lets
 * a caller accept that only when the second request repeats the short first page
 * identity for identity, no count is declared, and the caller validates the rows. */
async function readAll(context, path, initialParams, extractRows, identity, isComplete = () => false, totalCount = () => null, isWholeResponse = () => false) {
  const rows = [], seen = new Set();
  let expectedTotal = null, firstPageShort = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams(initialParams);
    const limit = Math.min(PAGE_SIZE, MAX_ROWS - rows.length + 1);
    params.set('limit', String(limit));
    params.set('offset', String(rows.length));
    const payload = await readJSON(context, path, params);
    const declaredTotal = totalCount(payload);
    if (declaredTotal !== null) {
      if (expectedTotal !== null && expectedTotal !== declaredTotal) fail('INCOMPLETE_DATA');
      if (declaredTotal > MAX_ROWS) fail('REPORT_LIMIT');
      expectedTotal = declaredTotal;
    }
    const next = extractRows(payload, rows.length);
    if (!Array.isArray(next)) fail('API_RESPONSE');
    if (expectedTotal !== null && rows.length + next.length > expectedTotal) fail('API_RESPONSE', 'report-total');
    if (!next.length) {
      if (expectedTotal !== null && rows.length !== expectedTotal) fail('INCOMPLETE_DATA');
      return rows;
    }
    if (page === 1 && expectedTotal === null && firstPageShort &&
        samePageIdentities(rows, next, identity) && isWholeResponse(rows)) return rows;
    if (next.length + rows.length > MAX_ROWS) fail('REPORT_LIMIT');
    if (page === 0) firstPageShort = next.length < limit;
    const pageIds = new Set();
    for (const row of next) {
      const id = identity(row);
      if (typeof id !== 'string' || !id || pageIds.has(id)) fail('API_RESPONSE', 'row-identity');
      if (seen.has(id)) fail('REPEATED_PAGE');
      pageIds.add(id);
      seen.add(id);
      rows.push(row);
    }
    if (expectedTotal !== null && rows.length === expectedTotal) return rows;
    if (isComplete(rows)) {
      if (expectedTotal !== null && rows.length !== expectedTotal) fail('INCOMPLETE_DATA');
      return rows;
    }
  }
  fail('REPORT_LIMIT');
}

/** Native Report pagination uses totals.total_count, including numeric strings.
 * Only exact nonnegative safe integers establish completeness. */
function reportTotalCount(payload) {
  const value = payload?.totals?.total_count;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value))) fail('API_RESPONSE', 'report-total');
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total < 0) fail('API_RESPONSE', 'report-total');
  return total;
}

/** The public Report frontend accepts a null/omitted report as empty and reads
 * totals.total_count. Require an explicit validated zero before accepting that
 * envelope, so an unrelated success object cannot erase a failed report. */
function reportRows(payload, offset) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('API_RESPONSE', 'report-shape');
  const totalIsZero = payload.totals && typeof payload.totals === 'object' &&
    !Array.isArray(payload.totals) && reportTotalCount(payload) === 0;
  if (totalIsZero && (offset > 0 || Array.isArray(payload.report) && payload.report.length)) fail('API_RESPONSE', 'report-zero');
  if (Array.isArray(payload.report)) return payload.report;
  if (payload.report == null && totalIsZero) return [];
  fail('API_RESPONSE', 'report-empty');
}

function reportParams(query, range, grouping) {
  const params = new URLSearchParams({
    datePreset: 'custom_time', dateFrom: range.dateFrom, dateTo: range.dateTo,
    timezone: query.timezone, status: query.status, grouping,
    sortColumn: 'date', sortType: 'asc', hideBots: query.hideBots ? '1' : '0',
  });
  if (query.groupId) {
    params.append('groupUuids[]', query.groupId);
    params.set('includeCampaignsWithoutGroup', '0');
  }
  if (query.sourceId) {
    params.append('trafficSourceIds[]', query.sourceId);
    params.set('includeCampaignsWithDeletedTrafficSource', '0');
  }
  return params;
}

export async function fetchDashboard({ origin, key, query: input, fetchImpl = fetch, now = new Date() }) {
  const context = { ...connection(origin, key), fetchImpl };
  const query = validateQuery(input);
  const ranges = resolveRanges(query, now);
  const getRows = async range => {
    const raw = await readAll(context, PATHS.trends, reportParams(query, range, ranges.grouping),
      payload => payload?.stats, row => typeof row?.date === 'string' ? row.date : '',
      rows => coversTimeRange(rows, range, ranges.grouping), undefined,
      rows => withinTimeRange(rows, range, ranges.grouping));
    return raw.map(normalizeRow);
  };
  let rows = await getRows(ranges.current);
  const totals = aggregateRows(rows);
  const warnings = [];
  if (rows.length && BASE_METRICS.some(name => rows.some(row => row[name] === null))) {
    warnings.push('Некоторые показатели отсутствуют в ответе Binom или скрыты правами/настройками колонок. Они показаны как «—».');
  }
  let previousRows = null, previousTotals = null, aligned = null;
  if (ranges.previous) {
    try {
      previousRows = await getRows(ranges.previous);
      previousTotals = aggregateRows(previousRows);
      aligned = alignComparison(rows, previousRows, ranges);
      if (aligned) {
        rows = aligned.current;
        previousRows = aligned.previous;
      } else {
        previousRows = null;
        previousTotals = null;
        warnings.push('Формат временных меток Binom не позволяет надёжно совместить периоды. Сравнение не показано.');
      }
    } catch {
      warnings.push('Не удалось полностью загрузить предыдущий период. Сравнение не показано.');
    }
  }
  if (!aligned && rows.length) {
    // Trends omits empty buckets (e.g. with hideBots); keep the time axis honest with null gaps.
    rows = padTimeSeries(rows, ranges.current, ranges.grouping) || rows;
  }
  // No extra gap notice outside the comparison; the empty points speak for themselves.
  if (aligned?.hasGaps) warnings.push('Для некоторых временных интервалов Binom не вернул строки. На графике оставлены пропуски; итоги рассчитаны по полученным строкам.');
  return {
    rows, totals, previousRows, previousTotals, query,
    fetchedAt: new Date().toISOString(), warnings,
    range: ranges.current, previousRange: ranges.previous, grouping: ranges.grouping,
  };
}

function normalizeCatalog(rows, isGroup) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('API_RESPONSE');
  const seen = new Set();
  return rows.map(row => {
    const id = isGroup ? row?.uuid : String(row?.id ?? '');
    const validId = isGroup ? typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) : /^[1-9]\d{0,14}$/.test(id);
    if (!validId || seen.has(id) || typeof row?.name !== 'string' || row.name.length > 512) fail('API_RESPONSE');
    seen.add(id);
    return { id, name: row.name };
  });
}

export async function fetchCatalogs({ origin, key, fetchImpl = fetch }) {
  const context = { ...connection(origin, key), fetchImpl };
  const results = await Promise.allSettled([
    readJSON(context, PATHS.groups, new URLSearchParams()).then(rows => normalizeCatalog(rows, true)),
    readAll(context, PATHS.sources, new URLSearchParams({ status: 'all' }), payload => payload,
      row => String(row?.id ?? '')).then(rows => normalizeCatalog(rows, false)),
  ]);
  const warnings = [];
  if (results[0].status === 'rejected') warnings.push('Список групп недоступен. Фильтр по группам не загружен.');
  if (results[1].status === 'rejected') warnings.push('Список источников недоступен. Фильтр по источникам не загружен.');
  return {
    groups: results[0].status === 'fulfilled' ? results[0].value : [],
    sources: results[1].status === 'fulfilled' ? results[1].value : [], warnings,
  };
}

/** Read every catalog page; never silently return a partial campaign selector. */
export async function fetchCampaigns({ origin, key, fetchImpl = fetch }) {
  const context = { ...connection(origin, key), fetchImpl };
  const rows = await readAll(context, PATHS.campaigns,
    new URLSearchParams({ accessLevel: 'READ', sortColumn: 'id', sortType: 'asc' }),
    payload => payload, row => String(row?.id ?? ''));
  let incompleteGroups = false;
  const campaigns = rows.map(row => {
    const id = String(row?.id ?? '');
    if (!isCampaignId(id) || typeof row?.name !== 'string' || row.name.length > 512) fail('API_RESPONSE');
    const campaign = { id, name: row.name, groupName: null };
    // Only an explicit null means no group. Missing/malformed optional metadata
    // must not hide a readable campaign or invent membership from its label.
    if (row.groupUuid === null) campaign.groupId = null;
    else if (typeof row.groupUuid === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.groupUuid)) {
      campaign.groupId = row.groupUuid.toLowerCase();
      if (row.groupName != null) {
        if (typeof row.groupName === 'string' && row.groupName.trim() && row.groupName.length <= 512 && !/[\u0000-\u001f\u007f]/.test(row.groupName)) campaign.groupName = row.groupName;
        else incompleteGroups = true;
      }
    } else incompleteGroups = true;
    return campaign;
  });
  return { campaigns, warnings: incompleteGroups ? ['У некоторых кампаний недоступны данные группы. Все кампании остаются в списке выбора.'] : [] };
}

function campaignReportParams(query, range, grouping, id) {
  const params = new URLSearchParams({
    datePreset: 'custom_time', dateFrom: range.dateFrom, dateTo: range.dateTo,
    timezone: query.timezone, sortColumn: 'name', sortType: 'asc', hideBots: query.hideBots ? '1' : '0',
  });
  params.append('ids[]', id);
  params.append('groupings[]', grouping === 'hours' ? 'hourOfDay' : 'days');
  return params;
}

function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00 - ${String((hour + 1) % 24).padStart(2, '0')}:00`;
}

function calendarAxis(range, grouping) {
  if (grouping === 'hours') {
    return Array.from({ length: Number(range.dateTo.slice(11, 13)) + 1 }, (_, hour) => hourLabel(hour));
  }
  const from = range.dateFrom.slice(0, 10), to = range.dateTo.slice(0, 10);
  return Array.from({ length: daysBetween(from, to) + 1 }, (_, index) => shiftDay(from, index));
}

function emptyMetricRow(date) {
  return { date, ...Object.fromEntries(METRICS.map(metric => [metric, null])) };
}

// Report totals that are rates, not sums: they cannot prove the absence of traffic.
const TOTAL_RATE_FIELDS = new Set([...Object.keys(RATIOS), 'lander_ctr', 'total_count']);

/** Binom omits buckets without traffic, so a campaign without traffic gets an empty
 * report. Its `totals` still lists the visible columns. Only an explicit zero row count,
 * explicit zero clicks and an explicit zero in every other summed field of `totals`
 * (including fields the extension does not show, such as `lander_views`) prove a period
 * without traffic. Then each bucket is a zero for the summed metrics present in `totals`;
 * rates and absent columns stay null. Anything else keeps the unavailable state. */
function noTrafficRows(axis, payload) {
  const totals = payload?.totals;
  if (!totals || typeof totals !== 'object' || Array.isArray(totals) || reportTotalCount(payload) !== 0 ||
      numberOrNull(totals.clicks) !== 0) return null;
  for (const [field, value] of Object.entries(totals)) {
    if (!TOTAL_RATE_FIELDS.has(field) && numberOrNull(value) !== 0) return null;
  }
  const values = Object.fromEntries(METRICS.filter(name => !Object.hasOwn(RATIOS, name))
    .map(metric => [metric, Object.hasOwn(totals, metricField(totals, metric)) ? 0 : null]));
  return axis.map(date => ({ ...emptyMetricRow(date), ...values }));
}

/** A visible summed column is missing from a row: the UI shows «—» and explains why. */
function hasMissingSum(rows) {
  return rows.some(row => BASE_METRICS.some(metric => row[metric] === null && !Object.hasOwn(RATIOS, metric)));
}

// Diagnostic alphabet is fixed and contains no server values or field names:
// absent, null, number, numeric string, boolean, array, object, other.
const UNIQUE_DIAGNOSTIC_STATES = 'AZNSBLOX';
function uniqueMetricState(record, field) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, field)) return 'A';
  const value = record[field];
  if (value === null) return 'Z';
  if (typeof value === 'number') return 'N';
  if (typeof value === 'string' && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return 'S';
  if (typeof value === 'boolean') return 'B';
  if (Array.isArray(value)) return 'L';
  if (typeof value === 'object') return 'O';
  return 'X';
}

/** Observe only two known columns on successful current-period Report pages.
 * Sets retain types, never values; server totals are diagnostic evidence only. */
function uniqueReportDiagnostics() {
  const rows = Object.fromEntries(UNIQUE_METRICS.map(field => [field, new Set()]));
  const totals = Object.fromEntries(UNIQUE_METRICS.map(field => [field, new Set()]));
  const code = states => [...UNIQUE_DIAGNOSTIC_STATES].filter(state => states.has(state)).join('+') || '-';
  return {
    observe(rawRows, payload) {
      for (const field of UNIQUE_METRICS) {
        for (const row of rawRows) rows[field].add(uniqueMetricState(row, field));
        totals[field].add(uniqueMetricState(payload.totals, field));
      }
    },
    finish(normalizedTotals, hasGaps) {
      return Object.fromEntries(UNIQUE_METRICS.map(field => [field,
        `r:${code(rows[field])};t:${code(totals[field])};a:${Number(Number.isSafeInteger(normalizedTotals[field]) && normalizedTotals[field] >= 0)};g:${Number(hasGaps)}`]));
    },
  };
}

/** Reports label their grouping in `name`, not Trends' `date` field. Only
 * recognizable time buckets can be mapped to the shared calendar axis. */
function normalizeCampaignRow(raw, range, grouping) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('API_RESPONSE');
  const label = raw.date ?? raw.name;
  let date;
  if (grouping === 'days') {
    if (!validDay(label) || label < range.dateFrom.slice(0, 10) || label > range.dateTo.slice(0, 10)) fail('API_RESPONSE');
    date = label;
  } else {
    let hour;
    if (typeof label === 'number' && Number.isInteger(label)) hour = label;
    else if (typeof label === 'string' && /^\d{1,2}$/.test(label.trim())) hour = Number(label.trim());
    else if (typeof label === 'string') {
      const match = /^(\d{1,2}):00(?:\s*[-–]\s*(\d{1,2}):00)?$/.exec(label.trim());
      if (!match) fail('API_RESPONSE');
      hour = Number(match[1]);
      if (match[2] !== undefined && Number(match[2]) !== (hour + 1) % 24 && !(hour === 23 && Number(match[2]) === 24)) fail('API_RESPONSE');
    } else fail('API_RESPONSE');
    if (hour < 0 || hour > 23 || hour > Number(range.dateTo.slice(11, 13))) fail('API_RESPONSE');
    date = hourLabel(hour);
  }
  return normalizeRow({ ...raw, date });
}

/** A single selected campaign uses the fixed Report route, including the real
 * previous period. Trends has no documented campaign-ID filter. */
export async function fetchCampaignOverview({ origin, key, query: input, campaignIds, fetchImpl = fetch, now = new Date() }) {
  const context = { ...connection(origin, key), fetchImpl };
  const ids = validateCampaignIds(campaignIds);
  if (ids.length !== 1) fail('INVALID_QUERY');
  const query = { ...validateQuery(input), status: 'all', groupId: '', sourceId: '' };
  const ranges = resolveRanges(query, now);
  const getRows = async (range, diagnostics) => {
    let firstPayload;
    const rows = await readAll(context, PATHS.campaignReport,
      campaignReportParams(query, range, ranges.grouping, ids[0]),
      (payload, offset) => {
        const rawRows = reportRows(payload, offset);
        if (offset === 0) firstPayload = payload;
        const rows = rawRows.map(row => normalizeCampaignRow(row, range, ranges.grouping));
        diagnostics?.observe(rawRows, payload);
        return rows;
      },
      row => row.date, rows => coversTimeRange(rows, range, ranges.grouping));
    return { rows, zeros: rows.length ? null : noTrafficRows(calendarAxis(range, ranges.grouping), firstPayload) };
  };
  const diagnostics = uniqueReportDiagnostics();
  const current = await getRows(ranges.current, diagnostics);
  const actualRows = current.zeros || current.rows;
  const totals = aggregateRows(actualRows);
  const axis = calendarAxis(ranges.current, ranges.grouping);
  const byDate = new Map(actualRows.map(row => [row.date, row]));
  let rows = axis.map(date => byDate.get(date) || emptyMetricRow(date));
  const currentHasGaps = actualRows.length < axis.length;
  let hasGaps = currentHasGaps;
  const warnings = [];
  if (current.rows.some(row => BASE_METRICS.some(metric => row[metric] === null)) || (current.zeros && hasMissingSum(current.zeros))) {
    warnings.push('Некоторые показатели отсутствуют в ответе Binom или скрыты правами/настройками колонок. Они показаны как «—».');
  }
  let previousRows = null, previousTotals = null;
  if (ranges.previous) {
    try {
      const before = await getRows(ranges.previous);
      const previous = before.zeros || before.rows;
      const aligned = alignComparison(actualRows, previous, ranges);
      if (!aligned) fail('API_RESPONSE');
      rows = aligned.current;
      previousRows = aligned.previous;
      previousTotals = aggregateRows(previous);
      hasGaps ||= aligned.hasGaps;
    } catch {
      warnings.push('Не удалось полностью загрузить предыдущий период. Сравнение не показано.');
    }
  }
  if (hasGaps) warnings.push('Для некоторых временных интервалов Binom не вернул строки. На графике оставлены пропуски; итоги рассчитаны по полученным строкам.');
  return { rows, totals, previousRows, previousTotals, query, campaignId: ids[0],
    uniqueDiagnostics: diagnostics.finish(totals, currentHasGaps),
    fetchedAt: new Date().toISOString(), warnings,
    range: ranges.current, previousRange: ranges.previous, grouping: ranges.grouping };
}

/** One documented report per campaign avoids assuming an undocumented nested
 * multi-group response. Workers bound simultaneous API requests to three. */
export async function fetchCampaignCharts({ origin, key, query: input, campaignIds, fetchImpl = fetch, now = new Date() }) {
  const context = { ...connection(origin, key), fetchImpl };
  const ids = validateCampaignIds(campaignIds);
  const query = { ...validateQuery(input), compare: false, status: 'all', groupId: '', sourceId: '' };
  const ranges = resolveRanges(query, now);
  const axis = calendarAxis(ranges.current, ranges.grouping);
  const campaigns = new Array(ids.length);
  let cursor = 0;
  let hasMissingMetrics = false, hasFailures = false;
  const worker = async () => {
    while (cursor < ids.length) {
      const index = cursor++;
      const id = ids[index];
      try {
        const diagnostics = uniqueReportDiagnostics();
        let firstPayload;
        const rows = await readAll(context, PATHS.campaignReport,
          campaignReportParams(query, ranges.current, ranges.grouping, id),
          (payload, offset) => {
            const rawRows = reportRows(payload, offset);
            if (offset === 0) firstPayload = payload;
            const normalized = rawRows.map(row => normalizeCampaignRow(row, ranges.current, ranges.grouping));
            diagnostics.observe(rawRows, payload);
            return normalized;
          },
          row => row.date, rows => coversTimeRange(rows, ranges.current, ranges.grouping));
        const zeros = rows.length ? null : noTrafficRows(axis, firstPayload);
        const byDate = new Map(rows.map(row => [row.date, row]));
        hasMissingMetrics ||= rows.some(row => BASE_METRICS.some(metric => row[metric] === null)) || Boolean(zeros && hasMissingSum(zeros));
        const totals = aggregateRows(zeros || rows);
        campaigns[index] = { id, rows: zeros || axis.map(date => byDate.get(date) || emptyMetricRow(date)), totals,
          uniqueDiagnostics: diagnostics.finish(totals, !zeros && rows.length < axis.length) };
      } catch (error) {
        hasFailures = true;
        // Recreate fixed local messages; never forward request/server error strings.
        const safe = new ApiError(error instanceof ApiError ? error.code : 'API_ERROR');
        campaigns[index] = {
          id, rows: axis.map(emptyMetricRow), totals: aggregateRows([]),
          error: { code: safe.code, message: safe.message },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CAMPAIGN_CONCURRENCY, ids.length) }, () => worker()));
  const warnings = [];
  if (hasMissingMetrics) warnings.push('Некоторые показатели отсутствуют в ответе Binom или скрыты правами/настройками колонок. Они показаны как «—».');
  if (hasFailures) warnings.push('Часть кампаний не удалось загрузить. Ошибки показаны отдельно; доступные кампании остаются на графике.');
  return { campaigns, range: ranges.current, grouping: ranges.grouping, query, fetchedAt: new Date().toISOString(), warnings };
}

const INSIGHT_SECTIONS = ['campaigns', 'pace', 'heatmap', 'breakdowns'];
const MAX_INSIGHT_REQUESTS = 120;
const MAX_INSIGHT_BATCH_IDS = 500;
const MAX_INSIGHT_URL_LENGTH = 7000;

/** Insights are independently selectable; arbitrary report paths/groupings never cross this boundary. */
export function validateInsightSections(input = INSIGHT_SECTIONS) {
  if (!Array.isArray(input) || input.length > INSIGHT_SECTIONS.length ||
      Array.from(input).some(section => !INSIGHT_SECTIONS.includes(section)) || new Set(input).size !== input.length) fail('INVALID_QUERY');
  return [...input];
}

function insightError(error) {
  const safe = new ApiError(error instanceof ApiError ? error.code : 'API_ERROR', error instanceof ApiError ? error.diagnostic : undefined);
  // A fixed parser stage helps diagnose a private response without exposing
  // field values, report rows, credentials or a response dump.
  return { code: safe.code, message: safe.message + (safe.diagnostic ? ` Код: ${safe.diagnostic}.` : '') };
}

function insightMetrics(raw = {}) {
  const { date, ...metrics } = normalizeRow({ ...raw, date: 'metrics' });
  metrics.cpa = metrics.costs !== null && metrics.leads > 0 ? metrics.costs / metrics.leads : null;
  return metrics;
}

/** The OpenAPI example calls the entity identifier `id`, but the official v2
 * Report frontend consumes `entity_id` and assigns its own UI-only `id` to each
 * row. Non-entity groupings use `name` as their value. Accept these two evidenced
 * flat formats, never infer a campaign from its display name or flatten levels. */
function normalizeInsightCategory(raw, grouping, batchIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('API_RESPONSE', 'category-shape');
  if (raw.name === null) fail('API_RESPONSE', 'category-name-null');
  if (typeof raw.name !== 'string' || raw.name.length > 512) fail('API_RESPONSE', 'category-name');
  if (Object.hasOwn(raw, 'level') && raw.level !== 1 && raw.level !== '1') fail('API_RESPONSE', 'category-level');
  const value = Object.hasOwn(raw, 'entity_id') ? raw.entity_id : raw.id;
  const absent = value === undefined || value === null || value === '';
  if (!absent && (typeof value !== 'string' && typeof value !== 'number' ||
      typeof value === 'number' && !Number.isSafeInteger(value) ||
      String(value).length > 512 || !String(value).trim())) fail('API_RESPONSE', 'category-id');
  if (grouping === 'campaign') {
    const id = absent ? '' : String(value);
    if (!raw.name.trim() || !isCampaignId(id) || !batchIds.has(id)) fail('API_RESPONSE', 'campaign-id');
    return { id, name: raw.name, ...insightMetrics(raw) };
  }
  const id = absent ? `name:${raw.name}` : `id:${value}`;
  // Binom explicitly displays blank category labels as "Empty value". Preserve
  // their exact raw identity; the display label must not merge them with a real
  // category named "Пустое значение", nor merge distinct whitespace values.
  return { id, name: raw.name.trim() ? raw.name : 'Пустое значение', ...insightMetrics(raw) };
}

function insightTotals(rows) {
  const total = aggregateRows(rows);
  total.cpa = total.costs !== null && total.leads > 0 ? total.costs / total.leads : null;
  for (const name of ['bots', 'cr', 'epc', 'cpc', 'cpa']) if (!Number.isFinite(total[name])) total[name] = null;
  return total;
}

/** Queue complete report operations, so request timeouts do not include queue wait. */
function insightQueue() {
  const pending = [];
  let active = 0;
  const pump = () => {
    while (active < CAMPAIGN_CONCURRENCY && pending.length) {
      const { run, resolve, reject } = pending.shift();
      active++;
      Promise.resolve().then(run).then(resolve, reject).finally(() => { active--; pump(); });
    }
  };
  return run => new Promise((resolve, reject) => { pending.push({ run, resolve, reject }); pump(); });
}

/** Keep explicit READ-scoped IDs in each request without exceeding common proxy
 * request-line limits. Pagination parameters are reserved before splitting. */
function insightIdBatches(ids, params, origin) {
  const baseLength = origin.length + PATHS.campaignReport.length + 1 + params.toString().length + 80;
  const batches = [];
  let batch = [], length = baseLength;
  for (const id of ids) {
    const addition = new URLSearchParams([['ids[]', id]]).toString().length + 1;
    if (batch.length && (batch.length >= MAX_INSIGHT_BATCH_IDS || length + addition > MAX_INSIGHT_URL_LENGTH)) {
      batches.push(batch); batch = []; length = baseLength;
    }
    if (length + addition > MAX_INSIGHT_URL_LENGTH) fail('REPORT_LIMIT');
    batch.push(id); length += addition;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Merge complete, disjoint campaign partitions. Keep only one accumulator per
 * category/time bucket; a hidden field in any contributing row remains hidden. */
function insightAccumulator() {
  const sums = ['clicks', 'leads', 'costs', 'revenue', 'profit', 'bots', ...UNIQUE_METRICS];
  const ratios = ['roi', 'cr', 'epc', 'cpc'];
  const entries = new Map();
  return {
    add(rows, temporal) {
      for (const row of rows) {
        const identity = temporal ? row.date : row.id;
        let entry = entries.get(identity);
        if (!entry) {
          if (entries.size >= MAX_ROWS) fail('REPORT_LIMIT');
          entry = { identity: temporal ? { date: row.date } : { id: row.id, name: row.name }, count: 0,
            values: Object.fromEntries(sums.map(metric => [metric, 0])),
            known: Object.fromEntries([...sums, ...ratios].map(metric => [metric, true])) };
          entries.set(identity, entry);
        } else if (!temporal && entry.identity.name !== row.name) fail('API_RESPONSE', 'category-label-conflict');
        entry.count++;
        for (const metric of [...sums, ...ratios]) {
          const known = typeof row[metric] === 'number' && Number.isFinite(row[metric]);
          entry.known[metric] &&= known;
          if (known && sums.includes(metric)) entry.values[metric] += row[metric];
        }
      }
    },
    finish(batchCount, temporal) {
      return [...entries.values()].map(entry => {
        // A missing hourly/daily row is an unknown interval, not zero traffic in
        // that partition. Never draw a partial total as the complete scope.
        if (temporal && entry.count !== batchCount) return { ...entry.identity, ...insightMetrics() };
        const raw = Object.fromEntries(sums.map(metric => [metric, entry.known[metric] ? entry.values[metric] : null]));
        for (const metric of ratios) raw[metric] = entry.known[metric] ? 0 : null;
        return { ...entry.identity, ...insightTotals([raw]) };
      });
    },
  };
}

/** Optional, bounded insights. All insight requests use fixed report and catalog GET routes.
 * Report has no documented campaign-status filter. Insights explicitly use their own
 * all-accessible / selected-ID scope, retaining date, zone, group, source and bot filters.
 * A failed or omitted bucket is unknown, never an invented zero. */
export async function fetchInsights({ origin, key, query: input, campaignIds = [], sections: requested = INSIGHT_SECTIONS, fetchImpl = fetch, now = new Date() }) {
  const ids = validateCampaignIds(campaignIds);
  const sections = validateInsightSections(requested);
  const original = validateQuery(input);
  const query = { ...original, status: 'all', compare: true,
    ...(ids.length ? { groupId: '', sourceId: '' } : {}) };
  const ranges = resolveRanges(query, now);
  const scope = {
    mode: ids.length ? 'selected' : 'all',
    label: ids.length ? 'Выбранные кампании' : 'Все доступные кампании · независимо от статуса',
    statusIgnored: original.status !== 'all', query,
  };
  let requests = 0, requestBudget = MAX_INSIGHT_REQUESTS;
  const context = { ...connection(origin, key), fetchImpl: (...args) => {
    if (++requests > requestBudget) fail('REPORT_LIMIT');
    return fetchImpl(...args);
  } };
  const result = { query, scope, range: ranges.current, previousRange: ranges.previous,
    fetchedAt: now.toISOString(), warnings: [] };
  if (!sections.length) return result;
  const queue = insightQueue();
  const memo = new Map();
  let catalog;
  try {
    const params = new URLSearchParams({ accessLevel: 'READ', sortColumn: 'id', sortType: 'asc' });
    if (query.groupId) params.set('groupUuid', query.groupId);
    if (query.sourceId) params.set('trafficSourceId', query.sourceId);
    // Read the complete catalog under the same 10k-row/100-page bounds as the
    // campaign picker. The former 500-campaign cutoff rejected every block before
    // any report could load on otherwise ordinary multi-campaign installations.
    catalog = await readAll(context, PATHS.campaigns, params, payload => payload, row => String(row?.id ?? ''));
    catalog = catalog.map(row => {
      const id = String(row?.id ?? '');
      if (!isCampaignId(id) || typeof row?.name !== 'string' || row.name.length > 512) fail('API_RESPONSE');
      // Verify the documented filtered catalog; do not silently widen a requested scope.
      if (query.groupId && (typeof row.groupUuid !== 'string' || row.groupUuid.toLowerCase() !== query.groupId)) fail('API_RESPONSE');
      if (query.sourceId && String(row.trafficSourceId) !== query.sourceId) fail('API_RESPONSE');
      return { id, name: row.name };
    });
    if (ids.length) {
      const byId = new Map(catalog.map(row => [row.id, row]));
      if (ids.some(id => !byId.has(id))) fail('FORBIDDEN');
      catalog = ids.map(id => byId.get(id));
    }
  } catch (error) {
    for (const section of sections) result[section] = { error: insightError(error) };
    return result;
  }
  const scopeIds = catalog.map(row => row.id);
  result.scope.campaignIds = scopeIds;
  result.scope.campaignCount = scopeIds.length;
  if (!scopeIds.length) result.warnings.push('В выбранной области нет доступных кампаний. Отсутствующие показатели показаны как «—».');

  const reportParams = (range, grouping) => {
    const params = new URLSearchParams({ datePreset: 'custom_time', dateFrom: range.dateFrom, dateTo: range.dateTo,
      timezone: query.timezone, sortColumn: 'name', sortType: 'asc', hideBots: query.hideBots ? '1' : '0' });
    params.append('groupings[]', grouping);
    return params;
  };
  const scopeBatchCount = insightIdBatches(scopeIds, reportParams(ranges.current, 'campaignsGroup'), context.origin).length;
  // Budget scales with the work introduced by partitioning instead of letting a
  // shared 120-request ceiling starve later blocks. Catalog/row/page limits and
  // at most three simultaneous HTTP requests still bound every load.
  requestBudget += Math.max(0, scopeBatchCount - 1) * 40;
  result.scope.reportBatches = scopeBatchCount;

  const report = (range, grouping, selectedIds = scopeIds) => {
    if (!selectedIds.length) return Promise.resolve([]);
    const params = reportParams(range, grouping);
    const token = JSON.stringify([params.toString(), selectedIds]);
    if (!memo.has(token)) memo.set(token, (async () => {
      const batches = insightIdBatches(selectedIds, params, context.origin);
      const temporal = grouping === 'days' || grouping === 'hourOfDay';
      const axisGrouping = grouping === 'hourOfDay' ? 'hours' : 'days';
      const accumulator = insightAccumulator(), campaignRows = [];
      for (const batch of batches) {
        const batchIds = new Set(batch);
        const batchParams = new URLSearchParams(params);
        batch.forEach(id => batchParams.append('ids[]', id));
        const rows = await queue(() => readAll(context, PATHS.campaignReport, batchParams, (payload, offset) =>
          reportRows(payload, offset).map(raw => {
            if (temporal) {
              const normalized = normalizeCampaignRow(raw, range, axisGrouping);
              return { ...normalized, ...insightMetrics(raw) };
            }
            return normalizeInsightCategory(raw, grouping, batchIds);
          }), row => temporal ? row.date : (row.id || `name:${row.name}`),
        temporal ? rows => coversTimeRange(rows, range, axisGrouping) :
          grouping === 'campaign' ? rows => rows.length === batch.length : undefined,
        temporal ? undefined : reportTotalCount));
        if (batches.length === 1) return rows;
        if (grouping === 'campaign') campaignRows.push(...rows);
        else accumulator.add(rows, temporal);
      }
      return grouping === 'campaign' ? campaignRows : accumulator.finish(batches.length, temporal);
    })());
    return memo.get(token);
  };

  const paired = async grouping => {
    const [current, previous] = await Promise.allSettled([
      report(ranges.current, grouping), report(ranges.previous, grouping),
    ]);
    if (current.status !== 'fulfilled') return { error: insightError(current.reason) };
    const currentById = new Map(current.value.map(row => [row.id, row]));
    const previousRows = previous.status === 'fulfilled' ? previous.value : [];
    const previousById = new Map(previousRows.map(row => [row.id, row]));
    const keys = new Set([...currentById.keys(), ...previousById.keys()]);
    const rows = [...keys].map(id => {
      const present = currentById.get(id), before = previousById.get(id);
      // An entry known only from the complete previous report keeps unknown current
      // metrics, but is marked so the UI can say "only in the previous period" instead
      // of "unavailable". Its absence now is not turned into a zero.
      return { id, name: (present || before).name, current: present ? insightMetrics(present) : insightMetrics(),
        previous: before ? insightMetrics(before) : null, ...(present ? {} : { onlyPrevious: true }) };
    });
    return { rows, totals: insightTotals(current.value), previousTotals: previous.status === 'fulfilled' ? insightTotals(previousRows) : null,
      ...(previous.status === 'rejected' ? { previousError: insightError(previous.reason) } : {}),
      range: ranges.current, previousRange: ranges.previous };
  };

  const jobs = sections.map(async section => {
    try {
      if (section === 'campaigns') {
        const campaigns = await paired('campaign');
        result.campaigns = campaigns;
        if (campaigns.error) return;
        const named = new Map(catalog.map(row => [row.id, row.name]));
        for (const row of campaigns.rows) { row.name = named.get(row.id) || row.name; row.sparkline = []; }
        const knownClicks = campaigns.rows.filter(row => row.current.clicks !== null);
        const ranked = [...knownClicks].sort((a, b) => b.current.clicks - a.current.clicks);
        const changes = knownClicks.filter(row => row.previous?.clicks !== null && row.previous?.clicks !== undefined)
          .sort((a, b) => (b.current.clicks - b.previous.clicks) - (a.current.clicks - a.previous.clicks));
        const miniIds = new Set([...ranked.slice(0, 10), ...changes.slice(0, 3), ...changes.slice(-3)].map(row => row.id));
        const axis = calendarAxis(ranges.current, ranges.grouping);
        await Promise.all(campaigns.rows.filter(row => miniIds.has(row.id)).map(async campaign => {
          try {
            const raw = await report(ranges.current, ranges.grouping === 'hours' ? 'hourOfDay' : 'days', [campaign.id]);
            const byDate = new Map(raw.map(row => [row.date, row]));
            campaign.sparkline = axis.map(date => ({ date, clicks: byDate.get(date)?.clicks ?? null }));
          } catch (error) { campaign.sparklineError = insightError(error); }
        }));
        campaigns.sparklineLimit = 16;
      } else if (section === 'pace') {
        const clock = zonedClock(now, query.timezone);
        const descriptors = [ ['today', 'Сегодня', 0], ['yesterday', 'Вчера', -1] ];
        const series = await Promise.all(descriptors.map(async ([id, name, offset]) => {
          const day = shiftDay(clock.day, offset);
          const range = { dateFrom: `${day} 00:00:00`, dateTo: `${day} ${clock.time}` };
          try {
            const raw = await report(range, 'hourOfDay');
            const byDate = new Map(raw.map(row => [row.date, row]));
            let cumulative = 0, complete = true;
            const rows = calendarAxis(range, 'hours').map(date => {
              const clicks = byDate.get(date)?.clicks ?? null;
              if (clicks === null) complete = false;
              else cumulative += clicks;
              return { date, clicks, cumulativeClicks: complete ? cumulative : null };
            });
            return { id, name, day, rows, range };
          } catch (error) { return { id, name, day, rows: [], range, error: insightError(error) }; }
        }));
        result.pace = { series, throughTime: clock.time, timezone: query.timezone,
          range: { dateFrom: `${clock.day} 00:00:00`, dateTo: `${clock.day} ${clock.time}` } };
      } else if (section === 'heatmap') {
        const clock = zonedClock(now, query.timezone);
        const first = shiftDay(clock.day, -7), last = shiftDay(clock.day, -1);
        const errors = [];
        const batches = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
          const day = shiftDay(first, index), weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
          const range = { dateFrom: `${day} 00:00:00`, dateTo: `${day} 23:59:59` };
          let raw = [];
          try { raw = await report(range, 'hourOfDay'); }
          catch (error) { errors.push({ day, ...insightError(error) }); }
          const byDate = new Map(raw.map(row => [row.date, row]));
          return Array.from({ length: 24 }, (_, hour) => {
            const clicks = byDate.get(hourLabel(hour))?.clicks ?? null;
            return { weekday, hour, day, clicks, samples: clicks === null ? 0 : 1 };
          });
        }));
        result.heatmap = { cells: batches.flat(), range: { dateFrom: `${first} 00:00:00`, dateTo: `${last} 23:59:59` },
          days: 7, timezone: query.timezone, errors };
      } else if (section === 'breakdowns') {
        // A fixed scope makes its own composition dimension redundant. Keep
        // these reports out of the request queue as well as out of the UI.
        const dimensions = {
          ...(ids.length === 1 ? {} : { campaigns: 'campaign' }),
          ...(query.groupId ? {} : { groups: 'campaignsGroup' }),
          ...(query.sourceId ? {} : { sources: 'trafficSource' }),
          countries: 'geoCountry',
        };
        const entries = await Promise.all(Object.entries(dimensions).map(async ([name, grouping]) => [name, await paired(grouping)]));
        result.breakdowns = Object.fromEntries(entries);
      }
    } catch (error) { result[section] = { error: insightError(error) }; }
  });
  await Promise.all(jobs);
  return result;
}
