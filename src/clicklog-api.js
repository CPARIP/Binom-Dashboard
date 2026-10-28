import { ApiError, resolveRanges, validateCampaignIds, validateQuery } from './api.js';
import { normalizeOrigin, validateApiKey, isPlainRecord } from './security.js';
import { CLICKLOG_PAGE_SIZES, DEFAULT_CLICKLOG_PAGE_SIZE } from './clicklog-schema.js';

const PATH = '/public/api/v1/clicklog';
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20000;
const FIELDS = Object.freeze(['id', 'click_time', 'clicked_date', 'campaign_id', 'campaign', 'ip', 'ip_v4', 'ip_v6', 'user_agent', 'os_name', 'os_version', 'device_type', 'device_name', 'device_model', 'browser_name', 'browser_version', 'traffic_source', 'country', 'language', 'is_bot']);
const MAX_DISPLAY_VALUES = 16;
// Binom's own bot mark. "1"/"true" is a bot; an absent or unknown mark is not.
const BOT_MARKS = new Set(['1', 'true']), BOT_STATES = new Set(['0', '1', 'true', 'false']);
const fail = code => { throw new ApiError(code); };
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value);
export function validateClicklogPage(input = {}) {
  if (!isPlainRecord(input) || Object.keys(input).some(key => !['limit', 'cursor', 'from', 'to', 'direction'].includes(key))) fail('INVALID_QUERY');
  const limit = input.limit === undefined ? DEFAULT_CLICKLOG_PAGE_SIZE : input.limit;
  if (!CLICKLOG_PAGE_SIZES.includes(limit)) fail('INVALID_QUERY');
  const page = { limit };
  if (input.cursor !== undefined) {
    if (!token(input.cursor) || !['next', 'prev'].includes(input.direction)) fail('INVALID_QUERY');
    page.cursor = input.cursor; page.direction = input.direction;
    for (const key of ['from', 'to']) {
      if (input[key] !== undefined && input[key] !== null) {
        if (typeof input[key] !== 'string' || !input[key] || input[key].length > 256 || /[\u0000-\u001f\u007f]/.test(input[key])) fail('INVALID_QUERY');
        page[key] = input[key];
      }
    }
  } else if (['from', 'to', 'direction'].some(key => Object.hasOwn(input, key))) fail('INVALID_QUERY');
  return page;
}
function stringValue(value, max = 512) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function scalarDisplayValue(value, max) {
  if (typeof value === 'number') return Number.isFinite(value) ? stringValue(String(value), max) : null;
  if (typeof value === 'boolean') return String(value);
  return stringValue(value, max);
}
function displayValue(value, max = 512) {
  // The official Clicklog frontend formats both scalar cells and value arrays.
  // Keep its comma-separated primitive values, but never serialize arbitrary
  // objects: a nested object could contain fields outside this allowlist.
  if (!Array.isArray(value)) return scalarDisplayValue(value, max);
  if (!value.length || value.length > MAX_DISPLAY_VALUES) return null;
  const parts = Array.from(value, part => scalarDisplayValue(part, max));
  if (parts.some(part => part === null)) return null;
  return stringValue(parts.join(', '), max);
}
function identityValue(value) {
  // Numeric IDs are accepted only when their exact integer value is preserved.
  // Array/object/boolean identities can never become pagination cursors.
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return stringValue(value, 256);
}
function validTime(value, dayOnly = false) {
  // OpenAPI declares a string without a format. Preserve unfamiliar formats;
  // validate/order only timestamps whose calendar representation is known.
  if (typeof value !== 'string' || !(dayOnly ? /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/ : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).test(value)) return null;
  const full = value.length === 10 ? value + ' 00:00:00' : value;
  const time = new Date(full.replace(' ', 'T') + 'Z');
  return Number.isFinite(time.valueOf()) && time.toISOString().slice(0, 19).replace('T', ' ') === full && full >= '1970-01-01' && full < '2201-01-01';
}
export function normalizeClicklog(payload, page = { limit: DEFAULT_CLICKLOG_PAGE_SIZE }) {
  if (!isPlainRecord(payload) || !Array.isArray(payload.rows) || payload.rows.length > page.limit) fail('API_RESPONSE');
  const ids = new Set(); let previousTime = null;
  const rows = payload.rows.map(raw => {
    if (!isPlainRecord(raw)) fail('API_RESPONSE');
    const row = Object.fromEntries(FIELDS.map(key => [key,
      key === 'id' || key === 'campaign_id' ? identityValue(raw[key])
        : key === 'click_time' || key === 'clicked_date' ? stringValue(raw[key])
          : displayValue(raw[key], key === 'user_agent' ? 2048 : 512),
    ]));
    if (row.id !== null && !token(row.id)) fail('API_RESPONSE');
    if (row.id !== null) { if (ids.has(row.id) || row.id === page.cursor) fail('REPEATED_PAGE'); ids.add(row.id); }
    for (const key of ['click_time', 'clicked_date']) if (row[key] !== null && validTime(row[key], key === 'clicked_date') === false) fail('API_RESPONSE');
    const time = validTime(row.click_time) === true ? row.click_time : validTime(row.clicked_date) === true ? row.clicked_date : null;
    if (time !== null) { if (previousTime !== null && time > previousTime) fail('API_RESPONSE'); previousTime = time; }
    return row;
  });
  // Binom serializes an empty page description as [] (an empty PHP array) when no click
  // matches the period or selection. Accept exactly that evidenced envelope; an empty
  // array next to rows would hide paging, so it stays a format error.
  const info = Array.isArray(payload.pageInfo) && payload.pageInfo.length === 0 && payload.rows.length === 0 ? null : payload.pageInfo;
  if (info !== undefined && info !== null && !isPlainRecord(info)) fail('API_RESPONSE');
  if (typeof info?.sorting === 'string' && info.sorting.toLowerCase() === 'asc') fail('API_RESPONSE');
  const pageInfo = info == null ? null : {
    from: stringValue(info.from, 256), to: stringValue(info.to, 256),
    hasNextPage: typeof info.hasNextPage === 'boolean' ? info.hasNextPage : null,
    hasPrevPage: typeof info.hasPrevPage === 'boolean' ? info.hasPrevPage : null,
    direction: ['next', 'prev'].includes(info.direction) ? info.direction : null,
    sorting: stringValue(info.sorting, 256),
    limit: Number.isInteger(info.limit) && CLICKLOG_PAGE_SIZES.includes(info.limit) ? info.limit : null,
  };
  return { rows, pageInfo };
}
async function readBody(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) fail('API_RESPONSE');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > MAX_BYTES) fail('API_RESPONSE');
    return text;
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); fail('API_RESPONSE'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
/** One fixed read endpoint, one bounded page. Credentials never leave this worker module. */
export async function fetchClicklog({ origin, key, query: input = {}, campaignIds = [], page: inputPage = {}, fetchImpl = fetch, now = new Date() }) {
  const base = normalizeOrigin(origin), apiKey = validateApiKey(key), query = validateQuery(input), ids = validateCampaignIds(campaignIds), page = validateClicklogPage(inputPage);
  const { current } = resolveRanges(query, now);
  const params = new URLSearchParams({ datePreset: 'custom_time', ...current, timezone: query.timezone, sortType: 'desc', limit: String(page.limit) });
  if (query.groupId) params.append('groupIds[]', query.groupId);
  for (const id of ids) params.append('campaignIds[]', id);
  for (const name of ['cursor', 'from', 'to', 'direction']) if (page[name] !== undefined) params.set(name, page[name]);
  const url = new URL(PATH, base); url.search = params.toString();
  const controller = new AbortController(); let timeout;
  const timer = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new ApiError('TIMEOUT')); }, TIMEOUT_MS); });
  const request = async () => {
    const response = await fetchImpl(url.href, { method: 'GET', headers: { 'Api-Key': apiKey, Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
    if (response.redirected || (response.url && new URL(response.url).origin !== base)) fail('NETWORK');
    if (response.status === 401) fail('AUTH'); if (response.status === 403) fail('FORBIDDEN'); if (response.status === 429) fail('RATE_LIMIT');
    if (!response.ok) fail('API_ERROR');
    const text = await readBody(response); let payload;
    try { payload = JSON.parse(text); } catch { fail('API_RESPONSE'); }
    const data = normalizeClicklog(payload, page);
    // Cursors come from the unfiltered page, so hiding bots never skips or repeats clicks.
    const edge = row => row ? { id: row.id, click_time: row.click_time } : null;
    const edges = { first: edge(data.rows[0]), last: edge(data.rows.at(-1)) };
    let rows = data.rows;
    if (query.hideBots) {
      // The public click log has no bot parameter, and Binom's own "is_bot = 0" filter timed out
      // on a real tracker. Hide the clicks Binom itself marked as bots instead.
      if (rows.length && !rows.some(row => BOT_STATES.has(row.is_bot))) fail('BOT_FILTER');
      rows = rows.filter(row => !BOT_MARKS.has(row.is_bot));
    }
    return { rows, pageInfo: data.pageInfo, edges, range: current, timezone: query.timezone };
  };
  try { return await Promise.race([request(), timer]); }
  catch (error) { if (error instanceof ApiError) throw error; if (controller.signal.aborted) fail('TIMEOUT'); fail('NETWORK'); }
  finally { clearTimeout(timeout); }
}
