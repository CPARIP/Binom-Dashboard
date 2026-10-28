import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError, validateQuery, resolveRanges, shiftDay, normalizeRow, aggregateRows, alignComparison,
  fetchDashboard, fetchCatalogs, validateCampaignIds, fetchCampaigns, fetchCampaignCharts, fetchCampaignOverview,
  fetchTrackerTimezone,
} from '../src/api.js';

const origin = 'https://tracker.example.com';
const key = 'test-key-not-a-secret';
const now = new Date('2026-10-21T08:30:12Z');
const query = { datePreset: 'today', timezone: 'Asia/Ho_Chi_Minh' };
const row = (date, overrides = {}) => ({ date, clicks: 10, leads: '2', costs: 10, revenue: 30, profit: 20, roi: 200, ...overrides });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function pages(batches) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      assert.ok(batches.length, 'unexpected request');
      return response(batches.shift());
    },
  };
}
function assertCode(fn, code) { assert.throws(fn, error => error instanceof ApiError && error.code === code); }

test('tracker timezone uses only the fixed read route and returns only the validated zone', async () => {
  const email = 'private-settings@example.invalid';
  for (const timezone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York', 'Etc/GMT+3']) {
    let requests = 0;
    const result = await fetchTrackerTimezone({ origin, key, path: '/public/api/v1/settings/user_keys',
      fetchImpl: async function (input, options) {
        assert.equal(this, undefined);
        requests++;
        assert.equal(input, `${origin}/public/api/v1/settings/info`);
        assert.equal(options.method, 'GET');
        assert.deepEqual(options.headers, { 'Api-Key': key, Accept: 'application/json' });
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.referrerPolicy, 'no-referrer');
        assert.ok(options.signal instanceof AbortSignal);
        assert.equal(Object.hasOwn(options, 'body'), false);
        return response({ timezone, email, arbitrarySettings: { secret: key } });
      } });
    assert.equal(requests, 1);
    assert.equal(typeof result, 'string');
    assert.equal(result, timezone);
    assert.equal(result.includes(email), false);
    assert.equal(result.includes(key), false);
  }
  assert.equal(await fetchTrackerTimezone({ origin, key, fetchImpl: async () => response({ timezone: 'UTC' }) }), 'UTC');
});

test('missing or invalid tracker timezone fails explicitly without a default or settings payload', async () => {
  const sentinel = 'private-settings@example.invalid';
  const malformed = [null, [], 'UTC', 0, true, {}, { timeZone: 'UTC' },
    ...[null, [], {}, true, 0, '', ' ', 'UTC ', ' UTC', 'UTC\n', '+07:00', 'Not/AZone', 'A'.repeat(101), sentinel]
      .map(timezone => ({ timezone, email: sentinel, secret: key }))];
  for (const payload of malformed) {
    await assert.rejects(fetchTrackerTimezone({ origin, key, fetchImpl: async () => response(payload) }), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'TIMEZONE_UNAVAILABLE');
      assert.match(error.message, /часовой пояс/);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(`${error}\n${JSON.stringify(error)}`.includes(sentinel), false);
      assert.equal(`${error}\n${JSON.stringify(error)}`.includes(key), false);
      return true;
    });
  }
});

test('tracker timezone preserves sanitized HTTP, network and response errors', async () => {
  const sentinel = 'private-settings@example.invalid';
  for (const [status, code] of [[401, 'AUTH'], [403, 'FORBIDDEN'], [429, 'RATE_LIMIT'], [400, 'API_ERROR'], [500, 'API_ERROR']]) {
    await assert.rejects(fetchTrackerTimezone({ origin, key,
      fetchImpl: async () => response({ timezone: 'UTC', email: sentinel, message: key }, status) }), error => {
      assert.equal(error.code, code);
      assert.equal(`${error}\n${JSON.stringify(error)}`.includes(sentinel), false);
      assert.equal(`${error}\n${JSON.stringify(error)}`.includes(key), false);
      return true;
    });
  }
  await assert.rejects(fetchTrackerTimezone({ origin, key, fetchImpl: async () => { throw new Error(`${sentinel} ${key}`); } }),
    error => error.code === 'NETWORK' && !`${error}\n${JSON.stringify(error)}`.includes(sentinel) && !error.message.includes(key));
  await assert.rejects(fetchTrackerTimezone({ origin, key, fetchImpl: async () => new Response(`<html>${sentinel} ${key}</html>`) }),
    error => error.code === 'API_RESPONSE' && !error.message.includes(sentinel) && !error.message.includes(key));
  await assert.rejects(fetchTrackerTimezone({ origin, key, fetchImpl: async () => ({ redirected: true }) }), { code: 'NETWORK' });
  await assert.rejects(fetchTrackerTimezone({ origin, key,
    fetchImpl: async () => new Response(JSON.stringify({ timezone: 'UTC' }), { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }) }),
  { code: 'API_RESPONSE' });
});

test('tracker timezone rejects an unsafe origin or key before any request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return response({ timezone: 'UTC' }); };
  for (const invalidOrigin of ['http://tracker.example.com', 'https://u:p@tracker.example.com', `${origin}/path`, `${origin}?secret=value`]) {
    await assert.rejects(fetchTrackerTimezone({ origin: invalidOrigin, key, fetchImpl }), { code: 'INVALID_ORIGIN' });
  }
  for (const invalidKey of ['', ' ', 'hello\r\nx: private', 'abc def']) {
    await assert.rejects(fetchTrackerTimezone({ origin, key: invalidKey, fetchImpl }), { code: 'INVALID_KEY' });
  }
  assert.equal(requests, 0);
});

test('query whitelist drops arbitrary URLs, secrets and headers', () => {
  const q = validateQuery({ ...query, apiKey: 'private', path: '/delete', headers: { evil: 1 } });
  assert.equal(q.timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(q.status, 'all');
  assert.equal(q.grouping, 'auto');
  assert.equal(q.compare, false);
  assert.equal(Object.hasOwn(q, 'path'), false);
  assert.equal(Object.hasOwn(q, 'apiKey'), false);
  assert.equal(Object.hasOwn(q, 'headers'), false);
});

test('query rejects malformed dates, oversized range, invalid zones and values', () => {
  for (const bad of [null, [], { timezone: 'Not/AZone' }, { hideBots: 'false' }, { compare: 1 },
    { datePreset: 'all_time' }, { status: 'admin' }, { grouping: 'month' }, { groupId: 'x&key=secret' },
    { sourceId: 5 }, { sourceId: '-1' }, { sourceId: 'x' },
    { datePreset: 'custom_time', dateFrom: '2026-02-30', dateTo: '2026-03-01' },
    { datePreset: 'custom_time', dateFrom: '2026-03-01', dateTo: '2026-02-01' },
    { datePreset: 'custom_time', dateFrom: '2024-01-01', dateTo: '2026-01-01' }]) {
    assertCode(() => validateQuery(bad), 'INVALID_QUERY');
  }
  assert.equal(validateQuery({ datePreset: 'custom_time', dateFrom: '2024-02-29', dateTo: '2024-02-29' }).dateFrom, '2024-02-29');
});

test('today uses selected timezone and compares the same elapsed local day', () => {
  const ranges = resolveRanges({ ...query, compare: true }, now);
  assert.deepEqual(ranges, {
    current: { dateFrom: '2026-10-21 00:00:00', dateTo: '2026-10-21 15:30:12' },
    previous: { dateFrom: '2026-10-20 00:00:00', dateTo: '2026-10-20 15:30:12' },
    grouping: 'hours',
  });
  const la = resolveRanges({ timezone: 'America/Los_Angeles' }, new Date('2026-10-21T02:30:00Z'));
  assert.equal(la.current.dateFrom, '2026-10-20 00:00:00');
  assert.equal(la.current.dateTo, '2026-10-20 19:30:00');
});

test('last N days includes today, aligned preceding N-day period ends at same clock time', () => {
  const ranges = resolveRanges({ ...query, datePreset: 'last_7_days', compare: true }, now);
  assert.deepEqual(ranges.current, { dateFrom: '2026-10-15 00:00:00', dateTo: '2026-10-21 15:30:12' });
  assert.deepEqual(ranges.previous, { dateFrom: '2026-10-08 00:00:00', dateTo: '2026-10-14 15:30:12' });
  assert.equal(ranges.grouping, 'days');
});

test('yesterday and past custom intervals include full last day and preserve calendar length', () => {
  const yesterday = resolveRanges({ ...query, datePreset: 'yesterday', compare: true }, now);
  assert.equal(yesterday.current.dateTo, '2026-10-20 23:59:59');
  assert.equal(yesterday.previous.dateTo, '2026-10-19 23:59:59');
  const custom = resolveRanges({ ...query, datePreset: 'custom_time', dateFrom: '2024-02-28', dateTo: '2024-03-01', compare: true }, now);
  assert.deepEqual(custom.previous, { dateFrom: '2024-02-25 00:00:00', dateTo: '2024-02-27 23:59:59' });
  assert.equal(shiftDay('2024-03-01', -1), '2024-02-29');
});

test('calendar comparison survives DST and rejects future date ranges', () => {
  const ranges = resolveRanges({ timezone: 'America/New_York', compare: true }, new Date('2026-03-08T16:30:00Z'));
  assert.equal(ranges.current.dateTo, '2026-03-08 12:30:00');
  assert.equal(ranges.previous.dateTo, '2026-03-07 12:30:00');
  assertCode(() => resolveRanges({ datePreset: 'custom_time', dateFrom: '2026-10-22', dateTo: '2026-10-22' }, now), 'INVALID_QUERY');
  assertCode(() => resolveRanges({ datePreset: 'last_7_days', grouping: 'hours' }, now), 'INVALID_QUERY');
});

test('normalization preserves missing and hidden metrics instead of manufacturing zeroes', () => {
  const normalized = normalizeRow({ date: '2026-10-01', clicks: '0', leads: '', costs: null, revenue: '15.25', profit: '-', roi: false });
  assert.deepEqual(normalized, { date: '2026-10-01', clicks: 0, leads: null, costs: null, revenue: 15.25, profit: null, roi: null, cr: null, epc: null, cpc: null, bots: null, unique_clicks: null, unique_campaign_clicks: null });
  assert.equal(normalizeRow(row('2026-10-01', { clicks: -1, leads: 0.1 })).clicks, null);
  assert.equal(normalizeRow(row('2026-10-01', { leads: 0.1 })).leads, null);
  assertCode(() => normalizeRow({ clicks: 1 }), 'API_RESPONSE');
});

test('totals use ratio of sums, propagate missing fields, do not reconstruct hidden profit/ROI', () => {
  const values = [normalizeRow(row('a')), normalizeRow(row('b', { costs: 90, profit: 0, roi: 0, revenue: 90 }))];
  assert.equal(aggregateRows(values).roi, 20); // Not the unweighted average 100.
  values[1].profit = null;
  assert.equal(aggregateRows(values).profit, null);
  assert.equal(aggregateRows(values).roi, null);
  values[1].profit = 0;
  values[1].roi = null;
  assert.equal(aggregateRows(values).roi, null);
  assert.equal(aggregateRows([normalizeRow(row('a', { costs: 0 }))]).roi, null);
  assert.deepEqual(aggregateRows([]), { clicks: null, leads: null, costs: null, revenue: null, profit: null, roi: null, cr: null, epc: null, cpc: null, bots: null, unique_clicks: null, unique_campaign_clicks: null });
});

test('native unique aggregates accept exact counts and never infer missing or malformed values', () => {
  for (const metric of ['unique_clicks', 'unique_campaign_clicks']) {
    for (const [value, expected] of [[0, 0], ['0', 0], [7, 7], ['7', 7], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]]) {
      assert.equal(normalizeRow(row('a', { [metric]: value }))[metric], expected);
    }
    for (const value of [undefined, null, '', '-', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, true, false, [], [5], {}]) {
      assert.equal(normalizeRow(row('a', { [metric]: value }))[metric], null, String(value));
    }
    const visible = normalizeRow(row('a', { [metric]: 4 }));
    assert.equal(aggregateRows([visible, normalizeRow(row('b'))])[metric], null);
    assert.equal(aggregateRows([visible, { ...visible, [metric]: -1 }])[metric], null);
    assert.equal(aggregateRows([visible, { ...visible, [metric]: 0.5 }])[metric], null);
    assert.equal(aggregateRows([visible, { ...visible, [metric]: Number.MAX_SAFE_INTEGER }])[metric], null);
    assert.equal(aggregateRows([{ ...visible, [metric]: 0 }, { ...visible, [metric]: 0 }])[metric], 0);
  }
  const aliases = normalizeRow(row('a', { uc: 9, unique: 9, is_campaign_unique: true, is_tracker_unique: true }));
  assert.equal(aliases.unique_clicks, null);
  assert.equal(aliases.unique_campaign_clicks, null);
});

test('unique aggregate totals do not replace clicks in CR, EPC, CPC or other financial totals', () => {
  const values = [
    normalizeRow(row('a', { clicks: 10, leads: 2, costs: 10, revenue: 30, profit: 20, roi: 200, cr: 20, epc: 3, cpc: 1, unique_clicks: 0, unique_campaign_clicks: 2 })),
    normalizeRow(row('b', { clicks: 90, leads: 3, costs: 90, revenue: 90, profit: 0, roi: 0, cr: 10 / 3, epc: 1, cpc: 1, unique_clicks: 10, unique_campaign_clicks: 20 })),
  ];
  const totals = aggregateRows(values);
  assert.equal(totals.unique_clicks, 10);
  assert.equal(totals.unique_campaign_clicks, 22);
  assert.equal(totals.clicks, 100);
  assert.equal(totals.cr, 5);
  assert.equal(totals.epc, 1.2);
  assert.equal(totals.cpc, 1);
  assert.equal(totals.roi, 20);
  values[1].unique_clicks = null;
  const hidden = aggregateRows(values);
  assert.equal(hidden.unique_clicks, null);
  assert.equal(hidden.unique_campaign_clicks, 22);
  for (const metric of ['clicks', 'cr', 'epc', 'cpc', 'roi', 'profit', 'costs', 'revenue']) assert.equal(hidden[metric], totals[metric]);
});

test('paginated Trends preserves native unique counts across periods and null calendar gaps', async () => {
  const calls = [];
  const result = await fetchDashboard({ origin, key, query: { datePreset: 'custom_time', dateFrom: '2026-10-15', dateTo: '2026-10-17', timezone: 'UTC', compare: true }, now,
    fetchImpl: async input => {
      const url = new URL(input), params = url.searchParams;
      calls.push(url);
      assert.equal(url.pathname, '/public/api/v1/trends');
      const previous = params.get('dateFrom').startsWith('2026-10-12');
      const dates = previous ? ['2026-10-12', '2026-10-13', '2026-10-14'] : ['2026-10-15', '2026-10-17'];
      const uniques = previous ? [2, 0, 3] : [5, 9], campaignUniques = previous ? [4, 0, 5] : [8, 10];
      const offset = Number(params.get('offset'));
      return response({ stats: dates.slice(offset, offset + 1).map((date, i) => row(date, {
        cr: 20, epc: 3, cpc: 1, bots: 0, unique_clicks: String(uniques[offset + i]), unique_campaign_clicks: campaignUniques[offset + i],
      })) });
    } });
  assert.deepEqual(result.rows.map(item => item.unique_clicks), [5, null, 9]);
  assert.deepEqual(result.rows.map(item => item.unique_campaign_clicks), [8, null, 10]);
  assert.deepEqual(result.previousRows.map(item => item.unique_clicks), [2, 0, 3]);
  assert.deepEqual(result.previousRows.map(item => item.unique_campaign_clicks), [4, 0, 5]);
  assert.equal(result.totals.unique_clicks, 14);
  assert.equal(result.totals.unique_campaign_clicks, 18);
  assert.equal(result.previousTotals.unique_clicks, 5);
  assert.equal(result.previousTotals.unique_campaign_clicks, 9);
  assert.equal(result.totals.cr, 20);
  assert.equal(calls.length, 6);
  for (const url of calls) assert.ok([...url.searchParams.keys()].every(name => !/unique|uniqueness|uc/i.test(name)));
  assert.ok(!result.warnings.some(message => message.includes('показатели отсутствуют')));
});

test('optional unique columns can be absent without warnings in ordinary Trends and campaign charts', async () => {
  const dates = ['2026-10-15', '2026-10-16', '2026-10-17'];
  const fetchImpl = async input => {
    const url = new URL(input);
    const rows = dates.map(date => row(date, { cr: 20, epc: 3, cpc: 1, bots: 0 }));
    return response(url.pathname.endsWith('/trends') ? { stats: rows } : { report: rows });
  };
  const args = { origin, key, query: campaignQuery, now, fetchImpl };
  const dashboard = await fetchDashboard(args);
  const overview = await fetchCampaignOverview({ ...args, campaignIds: ['1'] });
  const charts = await fetchCampaignCharts({ ...args, campaignIds: ['1', '2'] });
  for (const result of [dashboard, overview, charts]) assert.deepEqual(result.warnings, []);
  for (const data of [dashboard, overview, ...charts.campaigns]) {
    assert.equal(data.totals.unique_clicks, null);
    assert.equal(data.totals.unique_campaign_clicks, null);
    assert.ok(data.rows.every(row => row.unique_clicks === null && row.unique_campaign_clicks === null));
  }
});

test('CR, EPC and CPC use weighted complete sums while bots remain an explicit integer count', () => {
  const values=[normalizeRow(row('a',{cr:'20',epc:'3',cpc:'1',bots:'2'})),
    normalizeRow(row('b',{clicks:90,leads:3,costs:45,revenue:90,profit:45,roi:100,cr:10/3,epc:1,cpc:.5,bots:3}))];
  const totals=aggregateRows(values);
  assert.equal(totals.clicks,100);assert.equal(totals.leads,5);
  assert.equal(totals.cr,5);assert.equal(totals.epc,1.2);assert.equal(totals.cpc,.55);
  assert.equal(totals.bots,5);
  assert.equal(totals.roi,65/55*100);
  for(const bots of [-1,1.5,Number.MAX_SAFE_INTEGER+1,Infinity,NaN,'',null,false])assert.equal(normalizeRow(row('a',{bots})).bots,null);
  assert.equal(normalizeRow(row('a',{bots:0})).bots,0);
  assert.equal(aggregateRows([normalizeRow(row('a',{bots:Number.MAX_SAFE_INTEGER})),normalizeRow(row('b',{bots:1}))]).bots,null,'Unsafe integer totals are not presented as exact counts');
});

test('new rate totals never reconstruct hidden values and reject missing operands, infinity and zero denominators', () => {
  const visible=()=>normalizeRow(row('a',{cr:20,epc:3,cpc:1,bots:2}));
  for(const metric of ['cr','epc','cpc']) {
    for(const value of [undefined,null,Infinity,NaN,'Infinity','-',false,'']) {
      const hidden=normalizeRow(row('b',{cr:20,epc:3,cpc:1,[metric]:value}));
      assert.equal(hidden[metric],null);
      assert.equal(aggregateRows([visible(),hidden])[metric],null,`${metric}: hidden or invalid fields propagate through totals`);
    }
    assert.equal(aggregateRows([visible(),{...visible(),[metric]:Infinity}])[metric],null,'Direct non-finite ratio input cannot authorize derivation');
  }
  for(const [metric,operand] of [['cr','leads'],['epc','revenue'],['cpc','costs']]) {
    assert.equal(aggregateRows([visible(),{...visible(),[operand]:null}])[metric],null);
  }
  const noClicks=aggregateRows([normalizeRow(row('a',{clicks:0,leads:0,costs:0,revenue:0,profit:0,roi:0,cr:0,epc:0,cpc:0,bots:0}))]);
  for(const metric of ['cr','epc','cpc','roi'])assert.equal(noClicks[metric],null,'Zero denominators remain unavailable');
  assert.equal(noClicks.bots,0);
  const unknownClicks=aggregateRows([{...visible(),clicks:null}]);
  for(const metric of ['cr','epc','cpc'])assert.equal(unknownClicks[metric],null);
  const overflowing=aggregateRows([{...visible(),costs:1e308,revenue:1e308},{...visible(),costs:1e308,revenue:1e308}]);
  assert.equal(overflowing.epc,null);assert.equal(overflowing.cpc,null);
  const zeroNumerators=aggregateRows([normalizeRow(row('a',{leads:0,costs:0,revenue:0,cr:0,epc:0,cpc:0}))]);
  for(const metric of ['cr','epc','cpc'])assert.equal(zeroNumerators[metric],0,'Explicit zero numerators with positive clicks remain zero');
});

test('dashboard only calls fixed read-only endpoint with header authentication and no redirects/cookies/cache', async () => {
  const mock = pages([{ stats: [row('15:00 - 16:00')] }, { stats: [] }]);
  const result = await fetchDashboard({ origin, key, query, now, fetchImpl: mock.fetchImpl });
  assert.equal(result.totals.clicks, 10);
  assert.equal(result.previousRows, null);
  assert.equal(mock.calls.length, 2);
  for (const { url, options } of mock.calls) {
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/public/api/v1/trends');
    assert.equal(url.searchParams.get('datePreset'), 'custom_time');
    assert.equal(url.searchParams.get('dateTo'), '2026-10-21 15:30:12');
    assert.equal(url.searchParams.get('sortColumn'), 'date');
    assert.equal(url.searchParams.get('grouping'), 'hours');
    assert.equal(url.href.includes(key), false);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['Api-Key'], key);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer');
  }
  assert.equal(mock.calls[1].url.searchParams.get('offset'), '1');
});

test('fetch is called without a context receiver, as required by the browser native implementation', async () => {
  let calls = 0;
  const fetchImpl = function () {
    assert.equal(this, undefined);
    calls++;
    return Promise.resolve(response({ stats: [] }));
  };
  await fetchDashboard({ origin, key, query, now, fetchImpl });
  assert.equal(calls, 1);
});

test('all pages fetched even if API returns fewer rows than requested; filters use documented array names', async () => {
  const mock = pages([{ stats: [row('2026-10-01')] }, { stats: [row('2026-10-02')] }, { stats: [] }]);
  const input = { ...query, datePreset: 'last_30_days', groupId: '0AD80269-87B7-43F5-A2AF-A53090148E21', sourceId: '12', hideBots: true };
  const result = await fetchDashboard({ origin, key, query: input, now, fetchImpl: mock.fetchImpl });
  assert.equal(result.totals.clicks, 20);
  assert.deepEqual(mock.calls.map(c => c.url.searchParams.get('offset')), ['0', '1', '2']);
  const p = mock.calls[0].url.searchParams;
  assert.equal(p.get('groupUuids[]'), input.groupId.toLowerCase());
  assert.equal(p.get('trafficSourceIds[]'), '12');
  assert.equal(p.get('hideBots'), '1');
  assert.equal(p.get('includeCampaignsWithoutGroup'), '0');
  assert.equal(p.get('grouping'), 'days');
});

test('pagination rejecting repeated pages never returns partial or double-counted totals', async () => {
  await assert.rejects(fetchDashboard({ origin, key, query, now,
    fetchImpl: async () => response({ stats: [row('2026-10-01')] }) }), { code: 'REPEATED_PAGE' });
});

test('pagination hard cap rejects oversize dataset', async () => {
  const stats = Array.from({ length: 10001 }, (_, i) => row(String(i)));
  await assert.rejects(fetchDashboard({ origin, key, query, now,
    fetchImpl: async () => response({ stats }) }), { code: 'REPORT_LIMIT' });
});

test('complete seven-day Trends response succeeds in one request even if server ignores offset', async () => {
  const stats = Array.from({ length: 7 }, (_, i) => row(`2026-10-${15 + i}`));
  const offsets = [];
  const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days' }, now,
    fetchImpl: async url => { offsets.push(new URL(url).searchParams.get('offset')); return response({ stats }); } });
  assert.deepEqual(offsets, ['0']);
  assert.equal(result.rows.length, 7);
  assert.equal(result.totals.clicks, 70);
});

test('a paginated daily series stops once all requested dates are covered', async () => {
  const stats = Array.from({ length: 7 }, (_, i) => row(`2026-10-${15 + i}`));
  const mock = pages([{ stats: stats.slice(0, 2) }, { stats: stats.slice(2) }]);
  const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days' }, now, fetchImpl: mock.fetchImpl });
  assert.deepEqual(mock.calls.map(call => call.url.searchParams.get('offset')), ['0', '2']);
  assert.equal(result.totals.clicks, 70);
});

test('Sparse daily Trends response with ignored offset is accepted once, with null gaps', async () => {
  // Real Trends ignores offset; with hideBots=1 it omits days without unmarked clicks.
  const offsets = [];
  const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days', hideBots: true }, now,
    fetchImpl: async url => {
      const params = new URL(url).searchParams;
      offsets.push(params.get('offset'));
      assert.equal(params.get('hideBots'), '1');
      // A live tracker may change values between the two requests; only identities must repeat.
      const complete = { clicks: offsets.length === 1 ? 10 : 11, cr: 20, epc: 3, cpc: 1, bots: 0 };
      return response({ stats: [row('2026-10-15', complete), row('2026-10-17', complete)] });
    } });
  assert.deepEqual(offsets, ['0', '2']);
  assert.equal(result.totals.clicks, 20);
  assert.equal(result.totals.leads, 4);
  assert.deepEqual(result.rows.map(r => r.date), ['2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']);
  assert.deepEqual(result.rows.map(r => r.clicks), [10, null, 10, null, null, null, null]);
  // No gap notice outside the comparison; the chart shows empty points.
  assert.deepEqual(result.warnings, []);
});

test('Sparse hourly Trends response with ignored offset keeps its elapsed hourly axis', async () => {
  const stats = [row('03:00 - 04:00'), row('09:00 - 10:00'), row('15:00 - 16:00')];
  let calls = 0;
  const result = await fetchDashboard({ origin, key, query: { ...query, hideBots: true }, now,
    fetchImpl: async () => { calls++; return response({ stats }); } });
  assert.equal(calls, 2);
  assert.equal(result.totals.clicks, 30);
  assert.equal(result.rows.length, 16);
  assert.equal(result.rows[0].date, '00:00 - 01:00');
  assert.equal(result.rows[0].clicks, null);
  assert.deepEqual([3, 9, 15].map(hour => result.rows[hour].clicks), [10, 10, 10]);
});

test('Hourly labels on one axis share the canonical format', async () => {
  const result = await fetchDashboard({ origin, key, query: { ...query, hideBots: true }, now,
    fetchImpl: async () => response({ stats: [row('03:00'), row('09:00 - 10:00')] }) });
  assert.equal(result.rows.length, 16);
  assert.ok(result.rows.every((r, hour) => r.date === `${String(hour).padStart(2, '0')}:00 - ${String(hour + 1).padStart(2, '0')}:00`));
  assert.deepEqual([3, 9].map(hour => result.rows[hour].clicks), [10, 10]);
  assert.equal(result.rows[4].clicks, null);
});

test('A sparse current period keeps null gaps when the comparison is not shown', async () => {
  const current = [row('2026-10-15'), row('2026-10-18')];
  const previousCases = [
    async () => response({ error: 'unavailable' }, 500),
    async () => response({ stats: [row('08.10.2026')] }),
  ];
  for (const previous of previousCases) {
    const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days', compare: true, hideBots: true }, now,
      fetchImpl: async url => new URL(url).searchParams.get('dateFrom').startsWith('2026-10-15') ? response({ stats: current }) : previous() });
    assert.equal(result.previousRows, null);
    assert.equal(result.totals.clicks, 20);
    assert.deepEqual(result.rows.map(r => r.clicks), [10, null, null, 10, null, null, null]);
    assert.ok(!result.warnings.includes('Для некоторых временных интервалов Binom не вернул строки. На графике оставлены пропуски; итоги рассчитаны по полученным строкам.'));
  }
});

test('Sparse comparison periods with ignored offset both load and align', async () => {
  const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days', compare: true, hideBots: true }, now,
    fetchImpl: async url => {
      const from = new URL(url).searchParams.get('dateFrom').slice(0, 10);
      return response({ stats: from === '2026-10-15' ? [row('2026-10-16')] : [row('2026-10-08'), row('2026-10-14')] });
    } });
  assert.equal(result.totals.clicks, 10);
  assert.equal(result.previousTotals.clicks, 20);
  assert.equal(result.rows.length, 7);
  assert.equal(result.previousRows.length, 7);
  assert.equal(result.previousRows[0].clicks, 10);
  assert.equal(result.previousRows[6].clicks, 10);
});

test('An ignored offset is accepted only for an exact repeat of valid in-range buckets', async () => {
  const cases = [
    // Partial repeat: page 2 is neither empty nor the same page.
    [[row('2026-10-15'), row('2026-10-17')], [row('2026-10-17')]],
    // Same count but different labels.
    [[row('2026-10-15'), row('2026-10-17')], [row('2026-10-17'), row('2026-10-15')]],
    // Out-of-range bucket in an otherwise repeated sparse page.
    [[row('2026-10-15'), row('2026-10-22')], [row('2026-10-15'), row('2026-10-22')]],
    // Unknown label formats cannot prove which buckets were returned.
    [[row('15.10.2026')], [row('15.10.2026')]],
  ];
  for (const [first, second] of cases) {
    const mock = pages([{ stats: first }, { stats: second }]);
    await assert.rejects(fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days' }, now, fetchImpl: mock.fetchImpl }),
      error => error.code === 'REPEATED_PAGE' && !error.message.includes(key));
    assert.equal(mock.calls.length, 2);
  }
});

test('matching row count alone does not prove coverage if a returned date lies outside the range', async () => {
  const stats = Array.from({ length: 7 }, (_, i) => row(`2026-10-${16 + i}`));
  await assert.rejects(fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days' }, now,
    fetchImpl: async () => response({ stats }) }), { code: 'REPEATED_PAGE' });
});

test('malformed identities and duplicate dates within a page are response errors without raw data', async () => {
  for (const stats of [[{ clicks: 1 }], [{ date: 1, clicks: 1 }], [{ date: '', clicks: 1 }],
    [row('2026-10-15'), row('2026-10-15')]]) {
    await assert.rejects(fetchDashboard({ origin, key, query, now, fetchImpl: async () => response({ stats, secret: key }) }),
      error => error.code === 'API_RESPONSE' && !error.message.includes(key) && !error.message.includes('2026-10-15'));
  }
});

test('complete elapsed hourly series and complete past 24 hours need only one request', async () => {
  for (const [preset, count] of [['today', 16], ['yesterday', 24]]) {
    const stats = Array.from({ length: count }, (_, i) => row(`${String(i).padStart(2, '0')}:00 - ${String(i + 1).padStart(2, '0')}:00`));
    let calls = 0;
    const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: preset }, now,
      fetchImpl: async () => { calls++; return response({ stats }); } });
    assert.equal(calls, 1);
    assert.equal(result.totals.clicks, count * 10);
  }
});

test('future hourly buckets do not establish completion for an elapsed-day range', async () => {
  const stats = Array.from({ length: 24 }, (_, i) => row(`${String(i).padStart(2, '0')}:00`));
  await assert.rejects(fetchDashboard({ origin, key, query, now, fetchImpl: async () => response({ stats }) }), { code: 'REPEATED_PAGE' });
});

test('unknown date label formats remain compatible with normal empty-page completion', async () => {
  const mock = pages([{ stats: [row('15.10.2026')] }, { stats: [] }]);
  const result = await fetchDashboard({ origin, key, query: { ...query, datePreset: 'last_7_days' }, now, fetchImpl: mock.fetchImpl });
  assert.equal(mock.calls.length, 2);
  assert.equal(result.totals.clicks, 10);
});

test('network and HTTP error messages never include raw server content or API keys', async () => {
  const cases = [[401, 'AUTH'], [403, 'FORBIDDEN'], [429, 'RATE_LIMIT'], [400, 'API_ERROR'], [500, 'API_ERROR']];
  for (const [status, code] of cases) {
    await assert.rejects(fetchDashboard({ origin, key, query, now, fetchImpl: async () => response({ error: `secret ${key}` }, status) }),
      error => error.code === code && !error.message.includes(key) && !error.message.includes('secret'));
  }
  await assert.rejects(fetchDashboard({ origin, key, query, now, fetchImpl: async () => { throw new Error(`network ${key}`); } }),
    error => error.code === 'NETWORK' && !error.message.includes(key));
  await assert.rejects(fetchDashboard({ origin, key, query, now, fetchImpl: async () => new Response(`<html>${key}</html>`) }),
    error => error.code === 'API_RESPONSE' && !error.message.includes(key));
});

test('invalid origins or keys fail before any network request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return response({}); };
  for (const badOrigin of ['http://tracker.example.com', 'https://u:p@tracker.example.com', 'https://tracker.example.com/path', 'https://tracker.example.com?api_key=private', 'javascript:void(0)']) {
    await assert.rejects(fetchDashboard({ origin: badOrigin, key, query, now, fetchImpl }), { code: 'INVALID_ORIGIN' });
  }
  for (const badKey of ['', ' ', 'hello\r\nx: private', 'abc def']) {
    await assert.rejects(fetchDashboard({ origin, key: badKey, query, now, fetchImpl }), { code: 'INVALID_KEY' });
  }
  assert.equal(requests, 0);
});

test('comparison fetches matching calendar range and keeps original date labels', async () => {
  const mock = pages([{ stats: [row('10:00 - 11:00')] }, { stats: [] }, { stats: [row('10:00 - 11:00', { clicks: 6 })] }, { stats: [] }]);
  const result = await fetchDashboard({ origin, key, query: { ...query, compare: true }, now, fetchImpl: mock.fetchImpl });
  assert.equal(result.previousTotals.clicks, 6);
  assert.equal(result.previousRows[10].date, '10:00 - 11:00');
  assert.equal(result.previousRows[0].clicks, null);
  assert.equal(result.rows.length, result.previousRows.length);
  assert.equal(mock.calls[2].url.searchParams.get('dateTo'), '2026-10-20 15:30:12');
});

test('sparse comparison aligns actual calendar buckets, preserving missing data as null', () => {
  const ranges = resolveRanges({ datePreset: 'custom_time', dateFrom: '2026-10-01', dateTo: '2026-10-03', compare: true }, now);
  const aligned = alignComparison([normalizeRow(row('2026-10-01')), normalizeRow(row('2026-10-03'))],
    [normalizeRow(row('2026-09-29'))], ranges);
  assert.deepEqual(aligned.current.map(r => r.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
  assert.deepEqual(aligned.previous.map(r => r.date), ['2026-09-28', '2026-09-29', '2026-09-30']);
  assert.deepEqual(aligned.current.map(r => r.clicks), [10, null, 10]);
  assert.deepEqual(aligned.previous.map(r => r.clicks), [null, 10, null]);
  assert.equal(aligned.hasGaps, true);
  assert.equal(alignComparison([normalizeRow(row('01.10.2026'))], [], ranges), null);
});

test('failed comparison shows current report with explicit warning, never partial comparison', async () => {
  let call = 0;
  const result = await fetchDashboard({ origin, key, query: { ...query, compare: true }, now, fetchImpl: async () => {
    call++;
    if (call === 1) return response({ stats: [row('10:00 - 11:00')] });
    if (call === 2) return response({ stats: [] });
    return response({}, 500);
  } });
  assert.equal(result.totals.clicks, 10);
  assert.equal(result.previousTotals, null);
  assert.equal(result.previousRows, null);
  assert.ok(result.warnings.some(w => w.includes('предыдущий период')));
});

test('catalogs use documented group UUIDs and page traffic sources', async () => {
  const urls = [];
  const result = await fetchCatalogs({ origin, key, fetchImpl: async input => {
    const url = new URL(input); urls.push(url);
    if (url.pathname.endsWith('/groups/campaigns')) return response([{ uuid: 'c30687db-4fa8-42eb-af0e-c1da95c18209', name: 'Group' }]);
    assert.equal(url.pathname, '/public/api/v1/traffic_source/list/filtered');
    return response(url.searchParams.get('offset') === '0' ? [{ id: 5, name: 'Source' }] : []);
  } });
  assert.deepEqual(result.groups, [{ id: 'c30687db-4fa8-42eb-af0e-c1da95c18209', name: 'Group' }]);
  assert.deepEqual(result.sources, [{ id: '5', name: 'Source' }]);
  assert.deepEqual(result.warnings, []);
  assert.equal(urls.length, 3);
});

test('catalog permissions failures are explicit and do not expose error body', async () => {
  const result = await fetchCatalogs({ origin, key, fetchImpl: async () => response({ secret: key }, 403) });
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.sources, []);
  assert.equal(result.warnings.length, 2);
  assert.equal(JSON.stringify(result).includes(key), false);
});

const campaignQuery = { datePreset: 'custom_time', dateFrom: '2026-10-15', dateTo: '2026-10-17', timezone: 'UTC', grouping: 'days' };
const reportRow = (name, overrides = {}) => { const { date, ...metrics } = row(name, overrides); return { name, ...metrics }; };

test('selected Report diagnostics retain only bounded type unions for the two exact unique fields', async () => {
  const sentinel = 'private-value-never-in-diagnostic';
  const values = [undefined, null, 4, '5', false, [sentinel], { [sentinel]: key }, sentinel];
  const requests = [];
  const result = await fetchCampaignOverview({ origin, key, campaignIds: ['42'], now,
    query: { ...campaignQuery, dateFrom: '2026-10-01', dateTo: '2026-10-08' },
    fetchImpl: async input => {
      const url = new URL(input); requests.push(url);
      const index = Number(url.searchParams.get('offset'));
      const day = `2026-10-${String(index + 1).padStart(2, '0')}`;
      return response({ report: [reportRow(day, { unique_clicks: values[index], unique_campaign_clicks: '2', [sentinel]: key })],
        totals: { unique_clicks: values[index], [sentinel]: key }, [sentinel]: key });
    } });
  assert.equal(requests.length, 8);
  assert.deepEqual(result.uniqueDiagnostics, {
    unique_clicks: 'r:A+Z+N+S+B+L+O+X;t:A+Z+N+S+B+L+O+X;a:0;g:0',
    unique_campaign_clicks: 'r:S;t:A;a:1;g:0',
  });
  assert.equal(result.totals.unique_clicks, null);
  assert.equal(result.totals.unique_campaign_clicks, 16);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  for (const url of requests) {
    assert.equal(url.pathname, '/public/api/v1/report/campaign');
    assert.equal(url.searchParams.has('columns'), false);
    assert.equal(url.searchParams.has('uniqueClicks'), false);
  }
});

test('overview unique diagnostics describe the current period without previous-period types or gaps', async () => {
  const result = await fetchCampaignOverview({ origin, key, campaignIds: ['42'], now,
    query: { ...campaignQuery, compare: true }, fetchImpl: async input => {
      const params = new URL(input).searchParams;
      if (params.get('dateFrom').startsWith('2026-10-15')) {
        return response({ report: ['2026-10-15', '2026-10-16', '2026-10-17'].map(day => reportRow(day)) });
      }
      return response({ report: params.get('offset') === '0'
        ? [reportRow('2026-10-12', { unique_clicks: '3', unique_campaign_clicks: '4' })] : [],
      totals: { unique_clicks: 3, unique_campaign_clicks: 4 } });
    } });
  assert.deepEqual(result.uniqueDiagnostics, {
    unique_clicks: 'r:A;t:A;a:0;g:0', unique_campaign_clicks: 'r:A;t:A;a:0;g:0',
  });
  assert.equal(result.previousRows.length, 3);
  assert.equal(result.previousTotals.unique_campaign_clicks, 4);
  assert.ok(result.warnings.some(warning => warning.includes('пропуски')));
});

test('campaign diagnostics distinguish calendar gaps, absent row fields and an empty report without using server totals', async () => {
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1', '2', '3'], query: campaignQuery, now,
    fetchImpl: async input => {
      const params = new URL(input).searchParams, id = params.get('ids[]');
      const report = id === '3' || params.get('offset') !== '0' ? [] : id === '1'
        ? [reportRow('2026-10-15', { unique_clicks: 0, unique_campaign_clicks: '3' })]
        : ['2026-10-15', '2026-10-16', '2026-10-17'].map(day => reportRow(day));
      return response({ report, totals: { unique_clicks: 123, unique_campaign_clicks: 456 } });
    } });
  assert.deepEqual(result.campaigns.map(campaign => campaign.uniqueDiagnostics), [
    { unique_clicks: 'r:N;t:N;a:1;g:1', unique_campaign_clicks: 'r:S;t:N;a:1;g:1' },
    { unique_clicks: 'r:A;t:N;a:0;g:0', unique_campaign_clicks: 'r:A;t:N;a:0;g:0' },
    { unique_clicks: 'r:-;t:N;a:0;g:1', unique_campaign_clicks: 'r:-;t:N;a:0;g:1' },
  ]);
  assert.equal(result.campaigns[0].rows[1].unique_campaign_clicks, null);
  assert.equal(result.campaigns[0].totals.unique_campaign_clicks, 3);
  assert.equal(result.campaigns[1].totals.unique_campaign_clicks, null);
  assert.equal(result.campaigns[2].totals.unique_campaign_clicks, null);
});

test('hourly unique diagnostics separate numeric types from accepted counts and discard incomplete request diagnostics', async () => {
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1', '2'], now,
    query: { datePreset: 'custom_time', dateFrom: '2026-10-20', dateTo: '2026-10-20', timezone: 'UTC', grouping: 'hours' },
    fetchImpl: async input => {
      const params = new URL(input).searchParams;
      assert.equal(params.get('groupings[]'), 'hourOfDay');
      if (params.get('ids[]') === '2' && params.get('offset') !== '0') return response({ secret: key }, 403);
      return response({ report: params.get('offset') === '0'
        ? [reportRow('00', { unique_clicks: -1, unique_campaign_clicks: '1e999' }),
          reportRow('01', { unique_clicks: 1.5, unique_campaign_clicks: String(Number.MAX_SAFE_INTEGER + 1) })] : [] });
    } });
  assert.deepEqual(result.campaigns[0].uniqueDiagnostics, {
    unique_clicks: 'r:N;t:A;a:0;g:1', unique_campaign_clicks: 'r:S;t:A;a:0;g:1',
  });
  assert.equal(result.campaigns[1].error.code, 'FORBIDDEN');
  assert.equal(Object.hasOwn(result.campaigns[1], 'uniqueDiagnostics'), false);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('single-campaign overview uses only scoped Report requests and preserves a real previous-period comparison', async () => {
  const calls=[];
  const result=await fetchCampaignOverview({origin,key,campaignIds:['42'],now,
    query:{...campaignQuery,grouping:'auto',compare:true,status:'deleted',groupId:'0ad80269-87b7-43f5-a2af-a53090148e21',sourceId:'5',hideBots:true,path:'/delete',apiKey:key},
    fetchImpl:async(input,options)=>{
      const url=new URL(input);calls.push({url,options});
      const previous=url.searchParams.get('dateFrom').startsWith('2026-10-12');
      return response({report:Array.from({length:3},(_,index)=>reportRow(`2026-10-${(previous?12:15)+index}`,
        {clicks:previous?5:10,leads:1,costs:previous?5:10,revenue:previous?7:30,profit:previous?2:20,
          roi:previous?40:200,cr:previous?20:10,epc:previous?1.4:3,cpc:1,bots:1,
          unique_clicks:previous?'2':'4',unique_campaign_clicks:previous?3:6}))});
    }});
  assert.equal(calls.length,2,'Complete current and previous ranges each need one request');
  assert.deepEqual(calls.map(({url})=>url.searchParams.get('dateFrom')),['2026-10-15 00:00:00','2026-10-12 00:00:00']);
  for(const {url,options} of calls) {
    assert.equal(url.origin,origin);assert.equal(url.pathname,'/public/api/v1/report/campaign');
    assert.deepEqual(url.searchParams.getAll('ids[]'),['42']);
    assert.deepEqual(url.searchParams.getAll('groupings[]'),['days']);
    assert.equal(url.searchParams.get('hideBots'),'1');
    assert.equal(url.searchParams.get('sortColumn'),'name');
    assert.equal(url.searchParams.get('sortType'),'asc');
    for(const name of ['status','groupUuids[]','trafficSourceIds[]','groupId','sourceId','campaignId','path','apiKey'])assert.equal(url.searchParams.has(name),false);
    assert.equal(options.method,'GET');assert.equal(options.headers['Api-Key'],key);
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');
  }
  assert.equal(result.campaignId,'42');assert.equal(result.query.compare,true);
  assert.equal(result.query.status,'all');assert.equal(result.query.groupId,'');assert.equal(result.query.sourceId,'');
  assert.equal(result.grouping,'days');assert.equal(result.totals.clicks,30);assert.equal(result.previousTotals.clicks,15);
  assert.equal(result.totals.cr,10);assert.equal(result.previousTotals.cr,20);
  assert.equal(result.totals.epc,3);assert.equal(result.previousTotals.epc,1.4);
  assert.equal(result.totals.cpc,1);assert.equal(result.totals.bots,3);
  assert.equal(result.totals.unique_clicks,12);assert.equal(result.previousTotals.unique_clicks,6);
  assert.equal(result.totals.unique_campaign_clicks,18);assert.equal(result.previousTotals.unique_campaign_clicks,9);
  assert.ok(result.rows.every(point=>point.unique_clicks===4&&point.unique_campaign_clicks===6));
  assert.ok(result.previousRows.every(point=>point.unique_clicks===2&&point.unique_campaign_clicks===3));
  assert.deepEqual(result.rows.map(point=>point.date),['2026-10-15','2026-10-16','2026-10-17']);
  assert.deepEqual(result.previousRows.map(point=>point.date),['2026-10-12','2026-10-13','2026-10-14']);
  assert.deepEqual(result.warnings,[]);assert.equal(JSON.stringify(result).includes(key),false);
});

test('one-day campaign overview automatically uses hours and aligns sparse real previous buckets', async () => {
  const calls=[];
  const result=await fetchCampaignOverview({origin,key,campaignIds:['1'],now,query:{...query,compare:true},
    fetchImpl:async input=>{
      const url=new URL(input);calls.push(url);
      if(url.searchParams.get('offset')!=='0')return response({report:[]});
      return response({report:url.searchParams.get('dateFrom').startsWith('2026-10-21')
        ?[reportRow('2',{clicks:1,cr:10,epc:3,cpc:1,bots:0}),reportRow('00:00',{clicks:2,cr:10,epc:3,cpc:1,bots:1})]
        :[reportRow('01:00 - 02:00',{clicks:7,cr:10,epc:3,cpc:1,bots:2})]});
    }});
  assert.equal(calls.length,4,'Sparse ranges require empty page terminators');
  assert.ok(calls.every(url=>url.pathname==='/public/api/v1/report/campaign'&&url.searchParams.get('groupings[]')==='hourOfDay'));
  assert.equal(calls[0].searchParams.get('dateTo'),'2026-10-21 15:30:12');
  assert.equal(calls[2].searchParams.get('dateTo'),'2026-10-20 15:30:12');
  assert.equal(result.rows.length,16);assert.equal(result.previousRows.length,16);
  assert.deepEqual(result.rows.slice(0,3).map(point=>point.clicks),[2,null,1]);
  assert.deepEqual(result.previousRows.slice(0,3).map(point=>point.clicks),[null,7,null]);
  assert.equal(result.totals.clicks,3);assert.equal(result.previousTotals.clicks,7);
  assert.equal(result.rows[1].bots,null);assert.equal(result.rows[1].cr,null);
  assert.ok(result.warnings.some(warning=>warning.includes('пропуски')));
});

test('campaign overview refuses empty or multiple IDs before networking', async () => {
  let calls=0;
  const fetchImpl=async()=>{calls++;return response({report:[]});};
  for(const campaignIds of [[],['1','2'],undefined,null,['1','1'],['../delete'],[1]]) {
    await assert.rejects(fetchCampaignOverview({origin,key,campaignIds,query:campaignQuery,now,fetchImpl}),{code:'INVALID_QUERY'});
  }
  assert.equal(calls,0);
});

test('campaign overview retains current data when the previous report is denied or incomplete', async () => {
  for(const failure of ['denied','repeated']) {
    const result=await fetchCampaignOverview({origin,key,campaignIds:['1'],query:{...campaignQuery,compare:true},now,
      fetchImpl:async input=>{
        const url=new URL(input);
        if(url.searchParams.get('dateFrom').startsWith('2026-10-15'))return response({report:['2026-10-15','2026-10-16','2026-10-17'].map(date=>reportRow(date))});
        if(failure==='denied')return response({message:`PRIVATE ${key}`},403);
        return response({report:[reportRow('2026-10-12')]});
      }});
    assert.equal(result.totals.clicks,30);assert.equal(result.previousRows,null);assert.equal(result.previousTotals,null);
    assert.ok(result.warnings.some(warning=>warning.includes('предыдущий период')));
    assert.equal(JSON.stringify(result).includes(key),false);
  }
});

test('campaign overview rejects malformed and repeated current reports instead of partial totals', async () => {
  for(const [report,code] of [
    [[reportRow('unknown '+key)],'API_RESPONSE'],
    [[reportRow('2026-10-18')],'API_RESPONSE'],
    [[reportRow('2026-10-15'),reportRow('2026-10-15')],'API_RESPONSE'],
    [[reportRow('2026-10-15')],'REPEATED_PAGE'],
  ])await assert.rejects(fetchCampaignOverview({origin,key,campaignIds:['1'],query:campaignQuery,now,fetchImpl:async()=>response({report})}),
    error=>error.code===code&&!error.message.includes(key));
  await assert.rejects(fetchCampaignOverview({origin,key,campaignIds:['1'],query:campaignQuery,now,fetchImpl:async()=>response({message:key},403)}),
    error=>error.code==='FORBIDDEN'&&!error.message.includes(key));
  let calls=0;
  const empty=await fetchCampaignOverview({origin,key,campaignIds:['1'],query:campaignQuery,now,fetchImpl:async()=>{calls++;return response({report:[]});}});
  assert.equal(calls,1,'No previous request is sent when comparison is off');
  assert.equal(empty.previousRows,null);assert.equal(empty.previousTotals,null);
  assert.equal(empty.rows.length,3);assert.ok(empty.rows.every(point=>point.clicks===null&&point.bots===null&&point.cr===null));
  assert.ok(Object.values(empty.totals).every(value=>value===null),'An empty report cannot invent zero metrics');
});

test('selected campaign IDs are unique canonical positive integer strings and limited to eight', () => {
  const ids = ['42', '1', '9007199254740991'];
  assert.deepEqual(validateCampaignIds(ids), ids);
  assert.notEqual(validateCampaignIds(ids), ids);
  assert.deepEqual(validateCampaignIds([]), []);
  for (const invalid of [undefined, null, '42', [42], ['0'], ['01'], ['1.0'], ['1e2'], ['-1'], ['1', '1'],
    [' 42'], ['42 '], ['9007199254740992'], ['1&ids[]=2'], ['../campaign'], new Array(1),
    Array.from({ length: 9 }, (_, i) => String(i + 1))]) {
    assertCode(() => validateCampaignIds(invalid), 'INVALID_QUERY');
  }
});

test('campaign catalog requests only READ objects on its fixed endpoint and fetches every page', async () => {
  const mock = pages([[{ id: 1, name: 'One', groupUuid: null, extra: 'not returned' }], [{ id: '2', name: 'Two', groupUuid: null }], []]);
  const result = await fetchCampaigns({ origin, key, fetchImpl: mock.fetchImpl });
  assert.deepEqual(result, { campaigns: [{ id: '1', name: 'One', groupId: null, groupName: null }, { id: '2', name: 'Two', groupId: null, groupName: null }], warnings: [] });
  assert.deepEqual(mock.calls.map(call => call.url.searchParams.get('offset')), ['0', '1', '2']);
  for (const { url, options } of mock.calls) {
    assert.equal(url.pathname, '/public/api/v1/campaign/list/filtered');
    assert.equal(url.searchParams.get('accessLevel'), 'READ');
    assert.equal(url.searchParams.get('sortColumn'), 'id');
    assert.equal(url.searchParams.get('sortType'), 'asc');
    assert.equal(url.searchParams.has('status'), false);
    assert.equal(options.headers['Api-Key'], key);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
  }
});

test('all 821 campaigns retain exact group identity when the server caps each page at 100', async () => {
  const firstGroup = 'aabbccdd-0011-2233-4455-66778899aabb';
  const lastGroup = '11223344-aabb-ccdd-eeff-001122334455';
  const rows = Array.from({ length: 821 }, (_, index) => ({
    id: index + 1, name: `Campaign ${index + 1}`,
    groupUuid: (index === 820 ? lastGroup : firstGroup).toUpperCase(), groupName: 'Shared group name',
    trafficSourceId: 42, trafficSourceName: 'Source', campaign_key: 'SECRET', url: 'https://private.example',
  }));
  const offsets = [];
  const result = await fetchCampaigns({ origin, key, fetchImpl: async input => {
    const url = new URL(input);
    assert.equal(url.pathname, '/public/api/v1/campaign/list/filtered');
    assert.equal(url.searchParams.get('accessLevel'), 'READ');
    assert.equal(url.searchParams.get('limit'), '500');
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return response(rows.slice(offset, offset + 100));
  } });
  assert.deepEqual(offsets, [0, 100, 200, 300, 400, 500, 600, 700, 800, 821]);
  assert.equal(result.campaigns.length, 821);
  assert.deepEqual(result.campaigns[820], { id: '821', name: 'Campaign 821', groupId: lastGroup, groupName: 'Shared group name' });
  assert.deepEqual([...new Set(result.campaigns.map(item => item.groupId))], [firstGroup, lastGroup], 'Equal labels never merge distinct group UUIDs');
  assert.ok(result.campaigns.every(item => Object.keys(item).sort().join(',') === 'groupId,groupName,id,name'));
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(result.warnings, []);
});

test('optional group metadata distinguishes no group from unknown membership without dropping campaigns', async () => {
  const groupId = 'aabbccdd-0011-2233-4455-66778899aabb';
  const malformedIds = ['', ' ', 'not-a-uuid', 7, false, [groupId], { uuid: groupId }];
  const invalidNames = ['', ' ', 'x'.repeat(513), 'bad\nname', 7, false, ['Group'], { name: 'SECRET' }];
  const metadata = [
    { groupUuid: null, groupName: 'Ignored label without membership' },
    { groupName: 'A label cannot establish membership' },
    ...malformedIds.map(groupUuid => ({ groupUuid, groupName: 'A label cannot establish membership' })),
    { groupUuid: groupId, groupName: null }, { groupUuid: groupId },
    ...invalidNames.map(groupName => ({ groupUuid: groupId, groupName })),
  ];
  const mock = pages([metadata.map((data, index) => ({ id: index + 1, name: `Campaign ${index + 1}`, ...data })), []]);
  const result = await fetchCampaigns({ origin, key, fetchImpl: mock.fetchImpl });
  assert.equal(result.campaigns.length, metadata.length);
  assert.equal(result.campaigns[0].groupId, null);
  assert.equal(result.campaigns[0].groupName, null);
  for (const campaign of result.campaigns.slice(1, 2 + malformedIds.length)) {
    assert.equal(Object.hasOwn(campaign, 'groupId'), false, 'Unknown metadata must remain distinct from explicit null');
    assert.equal(campaign.groupName, null);
  }
  for (const campaign of result.campaigns.slice(2 + malformedIds.length)) {
    assert.equal(campaign.groupId, groupId, 'Unavailable labels cannot discard a valid membership');
    assert.equal(campaign.groupName, null);
  }
  assert.equal(result.warnings.length, 1, 'Optional metadata produces a single fixed warning');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('catalog truncation or malformed campaign IDs are errors, never partial selections', async () => {
  await assert.rejects(fetchCampaigns({ origin, key,
    fetchImpl: async () => response([{ id: 1, name: 'One' }]) }), { code: 'REPEATED_PAGE' });
  const mock = pages([[{ id: 'not-an-id', name: 'Invalid' }], []]);
  await assert.rejects(fetchCampaigns({ origin, key, fetchImpl: mock.fetchImpl }), { code: 'API_RESPONSE' });
  await assert.rejects(fetchCampaigns({ origin, key, fetchImpl: async () => response({ error: key }, 403) }),
    error => error.code === 'FORBIDDEN' && !error.message.includes(key));
});

test('campaign reports use one explicit ID, documented days grouping and no irrelevant global filters', async () => {
  const groupId = '0ad80269-87b7-43f5-a2af-a53090148e21';
  const requests = [];
  const report = ['2026-10-15', '2026-10-16', '2026-10-17'].map(day => reportRow(day));
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['42', '7'], now,
    query: { ...campaignQuery, compare: true, status: 'deleted', groupId, sourceId: '5', hideBots: true, path: '/arbitrary', apiKey: key },
    fetchImpl: async (input, options) => {
      const url = new URL(input); requests.push({ url, options });
      return response({ report });
    } });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ url }) => url.searchParams.getAll('ids[]')).sort(), [['42'], ['7']]);
  for (const { url, options } of requests) {
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/public/api/v1/report/campaign');
    assert.equal(url.searchParams.get('groupings[]'), 'days');
    assert.equal(url.searchParams.get('datePreset'), 'custom_time');
    assert.equal(url.searchParams.get('dateFrom'), '2026-10-15 00:00:00');
    assert.equal(url.searchParams.get('dateTo'), '2026-10-17 23:59:59');
    assert.equal(url.searchParams.get('timezone'), 'UTC');
    assert.equal(url.searchParams.get('sortColumn'), 'name');
    assert.equal(url.searchParams.get('hideBots'), '1');
    for (const param of ['grouping', 'status', 'groupUuids[]', 'trafficSourceIds[]', 'path', 'apiKey']) assert.equal(url.searchParams.has(param), false);
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['Api-Key'], key);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    assert.equal(url.href.includes(key), false);
  }
  assert.deepEqual(result.campaigns.map(campaign => campaign.id), ['42', '7']);
  assert.equal(result.query.compare, false);
  assert.equal(result.query.status, 'all');
  assert.equal(result.query.groupId, '');
  assert.equal(result.query.sourceId, '');
  assert.equal(result.campaigns[0].totals.clicks, 30);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('sparse campaign series share a calendar axis, use null gaps and sum only actual rows', async () => {
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1', '2'], query: campaignQuery, now,
    fetchImpl: async input => {
      const params = new URL(input).searchParams;
      if (params.get('offset') !== '0') return response({ report: [] });
      return response({ report: params.get('ids[]') === '1'
        ? [reportRow('2026-10-17', { clicks: 30, unique_clicks: '8', unique_campaign_clicks: 15 }), reportRow('2026-10-15', { clicks: 10, unique_clicks: 2, unique_campaign_clicks: '4' })]
        : [reportRow('2026-10-16', { clicks: 7, profit: null, unique_clicks: 0 })] });
    } });
  const [first, second] = result.campaigns;
  assert.deepEqual(first.rows.map(row => row.date), ['2026-10-15', '2026-10-16', '2026-10-17']);
  assert.deepEqual(second.rows.map(row => row.date), first.rows.map(row => row.date));
  assert.deepEqual(first.rows.map(row => row.clicks), [10, null, 30]);
  assert.deepEqual(second.rows.map(row => row.clicks), [null, 7, null]);
  assert.equal(first.totals.clicks, 40);
  assert.deepEqual(first.rows.map(row => row.unique_clicks), [2, null, 8]);
  assert.deepEqual(first.rows.map(row => row.unique_campaign_clicks), [4, null, 15]);
  assert.deepEqual(second.rows.map(row => row.unique_clicks), [null, 0, null]);
  assert.deepEqual(second.rows.map(row => row.unique_campaign_clicks), [null, null, null]);
  assert.equal(first.totals.unique_clicks, 10);
  assert.equal(first.totals.unique_campaign_clicks, 19);
  assert.equal(second.totals.unique_clicks, 0);
  assert.equal(second.totals.unique_campaign_clicks, null);
  assert.equal(second.totals.clicks, 7);
  assert.equal(second.totals.profit, null);
  assert.equal(second.totals.roi, null);
  assert.equal(result.warnings.some(warning => warning.includes('пропуски')), false);
});

test('hourOfDay reports accept explicit clock labels and align by hour, not response order', async () => {
  const labels = ['2:00 - 3:00', 0, '01', '03:00'];
  let request;
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], query: { ...query, grouping: 'hours' }, now,
    fetchImpl: async input => {
      request ||= new URL(input);
      return response({ report: new URL(input).searchParams.get('offset') === '0'
        ? labels.map((label, i) => reportRow(label, { clicks: i + 1 })) : [] });
    } });
  assert.equal(request.searchParams.get('groupings[]'), 'hourOfDay');
  assert.equal(request.searchParams.get('dateTo'), '2026-10-21 15:30:12');
  assert.equal(result.campaigns[0].rows.length, 16);
  assert.deepEqual(result.campaigns[0].rows.slice(0, 4).map(row => row.clicks), [2, 3, 1, 4]);
  assert.equal(result.campaigns[0].rows[4].clicks, null);
});

test('report date compatibility field can supply the same canonical daily label', async () => {
  const mock = pages([{ report: [{ date: '2026-10-15', clicks: 3 }] }, { report: [] }]);
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], query: campaignQuery, now, fetchImpl: mock.fetchImpl });
  assert.equal(result.campaigns[0].rows[0].clicks, 3);
  assert.equal(result.campaigns[0].error, undefined);
});

test('failed campaigns retain explicit safe errors while successful lines remain available', async () => {
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1', '2', '3'], query: campaignQuery, now,
    fetchImpl: async input => {
      const id = new URL(input).searchParams.get('ids[]');
      if (id === '2') return response({ error: `private ${key}` }, 403);
      if (id === '3') return response({ error: `private ${key}` }, 429);
      return response({ report: ['2026-10-15', '2026-10-16', '2026-10-17'].map(day => reportRow(day)) });
    } });
  assert.equal(result.campaigns[0].error, undefined);
  assert.equal(result.campaigns[0].totals.clicks, 30);
  assert.equal(result.campaigns[1].error.code, 'FORBIDDEN');
  assert.equal(result.campaigns[2].error.code, 'RATE_LIMIT');
  assert.deepEqual(result.campaigns[1].rows.map(row => row.clicks), [null, null, null]);
  assert.equal(result.campaigns[1].totals.clicks, null);
  assert.ok(result.campaigns[1].rows.every(row => row.unique_clicks === null && row.unique_campaign_clicks === null));
  assert.equal(result.campaigns[1].totals.unique_clicks, null);
  assert.equal(result.campaigns[1].totals.unique_campaign_clicks, null);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('unknown, duplicate or out-of-range campaign time buckets cannot produce misleading series', async () => {
  for (const report of [[reportRow('15.10.2026')], [reportRow('2026-10-18')], [reportRow('private '+key)],
    [reportRow('2026-10-15'), reportRow('2026-10-15')], [reportRow(1792022400)]]) {
    const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], query: campaignQuery, now,
      fetchImpl: async () => response({ report }) });
    assert.equal(result.campaigns[0].error.code, 'API_RESPONSE');
    assert.equal(result.campaigns[0].totals.clicks, null);
    assert.equal(JSON.stringify(result).includes(key), false);
  }
  for (const label of ['1:30', '1:00 - 3:00', '24', '16:00', 1792022400]) {
    const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], query, now,
      fetchImpl: async () => response({ report: [reportRow(label)] }) });
    assert.equal(result.campaigns[0].error.code, 'API_RESPONSE');
  }
});

test('sparse repeated campaign pages produce a per-campaign failure instead of partial totals', async () => {
  let calls = 0;
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], query: campaignQuery, now,
    fetchImpl: async () => { calls++; return response({ report: [reportRow('2026-10-15')] }); } });
  assert.equal(calls, 2);
  assert.equal(result.campaigns[0].error.code, 'REPEATED_PAGE');
  assert.equal(result.campaigns[0].totals.clicks, null);
});

test('campaign report network concurrency stays at three and selected order is retained', async () => {
  const campaignIds = ['8', '2', '7', '1', '4', '3', '6', '5'];
  let active = 0, peak = 0, calls = 0;
  const result = await fetchCampaignCharts({ origin, key, campaignIds, query: campaignQuery, now,
    fetchImpl: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return response({ report: ['2026-10-15', '2026-10-16', '2026-10-17'].map(day => reportRow(day)) });
    } });
  assert.equal(peak, 3);
  assert.equal(calls, 8);
  assert.deepEqual(result.campaigns.map(campaign => campaign.id), campaignIds);
});

test('invalid or empty selections cannot trigger unbounded report calls', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return response({ report: [] }); };
  const empty = await fetchCampaignCharts({ origin, key, campaignIds: [], query: campaignQuery, now, fetchImpl });
  assert.deepEqual(empty.campaigns, []);
  await assert.rejects(fetchCampaignCharts({ origin, key, campaignIds: ['1&ids[]=2'], query: campaignQuery, now, fetchImpl }), { code: 'INVALID_QUERY' });
  await assert.rejects(fetchCampaignCharts({ origin, key, campaignIds: Array.from({ length: 9 }, (_, i) => String(i + 1)), query: campaignQuery, now, fetchImpl }), { code: 'INVALID_QUERY' });
  assert.equal(calls, 0);
});

// A campaign without traffic gets an empty report whose totals list the
// visible columns as explicit zeros (field names as seen on a real Binom v2, where the
// spend column is `cost`). `withCosts` adds the documented fallback name too.
const realZeroTotals = (extra = {}) => ({ ...Object.fromEntries(['clicks', 'lander_clicks', 'lander_ctr', 'leads', 'cr', 'bots', 'epc', 'cpc', 'revenue', 'cost', 'profit', 'roi', 'unique_clicks', 'lander_views', 'total_count'].map(name => [name, '0'])), ...extra });
const withCosts = () => realZeroTotals({ costs: '0' });
const unknownSeries = rows => rows.every(point => Object.entries(point).every(([name, value]) => name === 'date' || value === null));

test('an empty campaign report with explicit zero totals is a zero series, not unavailable metrics', async () => {
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1', '2', '3'], query: campaignQuery, now,
    fetchImpl: async input => {
      const params = new URL(input).searchParams;
      if (params.get('ids[]') === '2') return response({ report: [], totals: withCosts() });
      if (params.get('ids[]') === '3') return response({ report: [], totals: realZeroTotals() });
      return response({ report: params.get('offset') === '0' ? ['2026-10-15', '2026-10-16', '2026-10-17'].map(day => reportRow(day, { bots: 0, cr: 20, epc: 3, cpc: 1, unique_clicks: 4, unique_campaign_clicks: 5 })) : [] });
    } });
  const empty = result.campaigns[1];
  assert.equal(empty.error, undefined);
  assert.deepEqual(empty.rows.map(point => point.date), ['2026-10-15', '2026-10-16', '2026-10-17']);
  for (const metric of ['clicks', 'leads', 'costs', 'bots', 'revenue', 'profit', 'unique_clicks']) {
    assert.deepEqual(empty.rows.map(point => point[metric]), [0, 0, 0], `${metric} is a zero in every bucket`);
    assert.equal(empty.totals[metric], 0);
  }
  for (const metric of ['cr', 'epc', 'cpc', 'roi']) {
    assert.deepEqual(empty.rows.map(point => point[metric]), [null, null, null], `${metric} is a rate and stays unknown`);
    assert.equal(empty.totals[metric], null);
  }
  assert.equal(empty.totals.unique_campaign_clicks, null, 'A column absent from totals stays unknown');
  assert.equal(empty.uniqueDiagnostics.unique_clicks.endsWith(';g:0'), true, 'A zero series has no calendar gaps');
  assert.equal(result.campaigns[0].totals.clicks, 30);
  assert.equal(result.warnings.some(warning => warning.includes('отсутствуют')), false, 'Real zero totals list every summed column, including spend as `cost`');
  const realNames = result.campaigns[2];
  assert.deepEqual(realNames.rows.map(point => point.clicks), [0, 0, 0]);
  assert.equal(realNames.totals.costs, 0, 'Binom names its spend `cost`');
  const complete = await fetchCampaignCharts({ origin, key, campaignIds: ['2'], query: campaignQuery, now,
    fetchImpl: async () => response({ report: [], totals: withCosts() }) });
  assert.deepEqual(complete.warnings, [], 'Unknown rates of a period without traffic are not reported as missing columns');
});

test('an empty campaign report stays unavailable unless its totals prove a period without traffic', async () => {
  const cases = [{}, { clicks: '0' }, { clicks: '0', total_count: '5' }, { clicks: null, total_count: '0' }, { clicks: '', total_count: '0' },
    { clicks: 'n/a', total_count: '0' }, { clicks: '1', total_count: '0' }, { unique_clicks: '0', total_count: '0' },
    { ...withCosts(), revenue: '5' }, { ...withCosts(), leads: null }, { ...withCosts(), bots: '3' },
    { ...withCosts(), cost: '7' }, { ...withCosts(), lander_views: '2' }];
  for (const totals of cases) {
    const result = await fetchCampaignCharts({ origin, key, campaignIds: ['3'], query: campaignQuery, now,
      fetchImpl: async () => response({ report: [], totals }) });
    const campaign = result.campaigns[0];
    assert.equal(campaign.error, undefined, JSON.stringify(totals));
    assert.equal(unknownSeries(campaign.rows), true, JSON.stringify(totals));
    assert.deepEqual(campaign.totals, aggregateRows([]), JSON.stringify(totals));
  }
});

test('an hourly report without traffic is a zero series on the hourly axis', async () => {
  const result = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], now,
    query: { datePreset: 'custom_time', dateFrom: '2026-10-20', dateTo: '2026-10-20', timezone: 'UTC', grouping: 'hours' },
    fetchImpl: async input => {
      assert.equal(new URL(input).searchParams.get('groupings[]'), 'hourOfDay');
      return response({ report: [], totals: withCosts() });
    } });
  const rows = result.campaigns[0].rows;
  assert.equal(rows.length, 24);
  assert.deepEqual([rows[0].date, rows[23].date], ['00:00 - 01:00', '23:00 - 00:00']);
  assert.ok(rows.every(point => point.clicks === 0 && point.cr === null));
});

test('single-campaign overview shows a period without traffic as zeros and still compares with the previous period', async () => {
  const load = (currentEmpty, previousEmpty) => fetchCampaignOverview({ origin, key, campaignIds: ['42'], now, query: { ...campaignQuery, compare: true },
    fetchImpl: async input => {
      const params = new URL(input).searchParams, current = params.get('dateFrom').startsWith('2026-10-15');
      if (current ? currentEmpty : previousEmpty) return response({ report: [], totals: withCosts() });
      const days = current ? ['2026-10-15', '2026-10-16', '2026-10-17'] : ['2026-10-12', '2026-10-13', '2026-10-14'];
      return response({ report: params.get('offset') === '0' ? days.map(day => reportRow(day, { bots: 0, cr: 20, epc: 3, cpc: 1 })) : [] });
    } });
  const quiet = await load(true, false);
  assert.deepEqual(quiet.rows.map(point => point.clicks), [0, 0, 0]);
  assert.equal(quiet.totals.clicks, 0);
  assert.equal(quiet.totals.revenue, 0);
  assert.equal(quiet.previousTotals.clicks, 30);
  assert.deepEqual(quiet.previousRows.map(point => point.clicks), [10, 10, 10]);
  assert.deepEqual(quiet.warnings, [], 'No gap or missing-column warning for a period without traffic');
  const newCampaign = await load(false, true);
  assert.deepEqual(newCampaign.rows.map(point => point.clicks), [10, 10, 10]);
  assert.deepEqual(newCampaign.previousRows.map(point => point.clicks), [0, 0, 0], 'A previous period without traffic is compared as zeros');
  assert.equal(newCampaign.previousTotals.clicks, 0);
  assert.deepEqual(newCampaign.warnings, []);
});

// A real Binom v2 names its spend column `cost` in Trends and Report rows and
// totals (the supplied OpenAPI said `costs`). Read `cost` first; `costs` stays a fallback.
test('spend is read from Binom cost, with costs only as a fallback', async () => {
  assert.equal(normalizeRow({ date: '2026-10-21', cost: '12.5' }).costs, 12.5);
  assert.equal(normalizeRow({ date: '2026-10-21', costs: 7 }).costs, 7, 'The documented schema name still works');
  assert.equal(normalizeRow({ date: '2026-10-21', cost: '3', costs: 9 }).costs, 3, 'The name the tracker actually sends wins');
  assert.equal(normalizeRow({ date: '2026-10-21', cost: null, costs: 9 }).costs, null, 'An explicit unknown cost is not replaced by another field');
  assert.equal(normalizeRow({ date: '2026-10-21' }).costs, null);
  const result = await fetchDashboard({ origin, key, now,
    query: { datePreset: 'custom_time', dateFrom: '2026-10-15', dateTo: '2026-10-15', timezone: 'UTC', grouping: 'days' },
    fetchImpl: async input => response({ stats: new URL(input).searchParams.get('offset') === '0'
      ? [{ date: '2026-10-15', clicks: '10', cost: '20.00', revenue: '30.00', profit: '10.00', roi: '50', cpc: '2', leads: '1' }] : [] }) });
  assert.equal(result.totals.costs, 20);
  assert.equal(result.totals.roi, 50, 'ROI uses the visible profit and cost totals');
  assert.equal(result.totals.cpc, 2);
});

test('campaign reports read spend from Binom cost in the comparison and the single-campaign overview', async () => {
  const days = ['2026-10-15', '2026-10-16', '2026-10-17'];
  const fetchImpl = async input => response({ report: new URL(input).searchParams.get('offset') === '0'
    ? days.map(day => ({ name: day, clicks: '10', cost: '4.50', revenue: '9', profit: '4.50', roi: '100', cpc: '0.45', leads: '1', cr: '10', epc: '0.9', bots: '0' })) : [] });
  const charts = await fetchCampaignCharts({ origin, key, campaignIds: ['1'], query: campaignQuery, now, fetchImpl });
  assert.deepEqual(charts.campaigns[0].rows.map(point => point.costs), [4.5, 4.5, 4.5]);
  assert.equal(charts.campaigns[0].totals.costs, 13.5);
  assert.equal(charts.campaigns[0].totals.roi, 100);
  const overview = await fetchCampaignOverview({ origin, key, campaignIds: ['1'], query: campaignQuery, now, fetchImpl });
  assert.equal(overview.totals.costs, 13.5);
  assert.equal(overview.totals.cpc, 0.45);
});
