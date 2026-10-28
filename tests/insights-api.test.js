import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, fetchInsights, validateInsightSections } from '../src/api.js';

const origin = 'https://tracker.example.com', key = 'test-insights-key';
const now = new Date('2026-10-21T08:30:12Z');
const query = { datePreset: 'last_7_days', timezone: 'UTC', status: 'active' };
const metrics = (overrides = {}) => ({ clicks: 10, leads: 2, costs: 8, revenue: 20, profit: 12, roi: 150, bots: 1, cr: 20, epc: 2, cpc: 0.8, ...overrides });
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });
function fixture({ catalog = [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }], handler, delay = false } = {}) {
  const calls = [];
  let active = 0, maximum = 0;
  const fetchImpl = async (href, options) => {
    const url = new URL(href), params = url.searchParams;
    calls.push({ url, options });
    active++; maximum = Math.max(maximum, active);
    try {
      if (delay) await new Promise(resolve => setTimeout(resolve, 2));
      const custom = await handler?.(url, options);
      if (custom !== undefined) return custom instanceof Response ? custom : respond(custom);
      const offset = Number(params.get('offset') || 0);
      if (url.pathname.endsWith('/campaign/list/filtered')) return respond(catalog.slice(offset, offset + Number(params.get('limit') || 500)));
      assert.equal(url.pathname, '/public/api/v1/report/campaign');
      if (offset) return respond({ report: [] });
      const grouping = params.get('groupings[]');
      const ids = params.getAll('ids[]');
      assert.ok(ids.length, 'never request an unscoped report');
      // The public v2 Report frontend uses entity_id, assigning a separate UI
      // UUID to id; country groupings can be label-only. Do not let the
      // simplified OpenAPI {id,name} example hide these production variants.
      if (grouping === 'campaign') return respond({ report: ids.map(id => ({ entity_id: id, level: 1, name: `Campaign ${id}`, ...metrics({ clicks: 10 * Number(id) }) })) });
      if (grouping === 'days') {
        const first = Date.parse(params.get('dateFrom').slice(0, 10)), last = Date.parse(params.get('dateTo').slice(0, 10));
        return respond({ report: Array.from({ length: (last - first) / 86400000 + 1 }, (_, i) => ({ name: new Date(first + i * 86400000).toISOString().slice(0, 10), ...metrics() })) });
      }
      if (grouping === 'hourOfDay') return respond({ report: Array.from({ length: Number(params.get('dateTo').slice(11, 13)) + 1 }, (_, i) => ({ name: i, ...metrics() })) });
      const category = grouping === 'trafficSource' ? { entity_id: 1 } : grouping === 'campaignsGroup' ? { entity_id: null } : {};
      return respond({ report: [{ ...category, level: 1, name: grouping, ...metrics() }] });
    } finally { active--; }
  };
  return { calls, fetchImpl, get maximum() { return maximum; } };
}
const load = (mock, args = {}) => fetchInsights({ origin, key, query, now, fetchImpl: mock.fetchImpl, ...args });

test('insight sections reject arbitrary identifiers, sparse arrays, duplicate values and invalid IDs', async () => {
  assert.deepEqual(validateInsightSections(), ['campaigns', 'pace', 'heatmap', 'breakdowns']);
  for (const invalid of [null, 'campaigns', ['delete'], ['pace', 'pace'], new Array(1)]) {
    assert.throws(() => validateInsightSections(invalid), error => error instanceof ApiError && error.code === 'INVALID_QUERY');
  }
  await assert.rejects(load(fixture(), { campaignIds: ['1&ids[]=2'] }), { code: 'INVALID_QUERY' });
  const mock = fixture();
  await load(mock, { sections: [] });
  assert.equal(mock.calls.length, 0);
});

test('all insights are fixed GET reads, bounded to three parallel requests, and explicitly ignore status', async () => {
  const mock = fixture({ delay: true });
  const result = await load(mock);
  assert.ok(mock.maximum <= 3);
  assert.equal(mock.maximum, 3);
  assert.equal(result.scope.mode, 'all');
  assert.equal(result.scope.statusIgnored, true);
  assert.match(result.scope.label, /независимо от статуса/);
  assert.equal(result.scope.query.status, 'all');
  assert.equal(result.campaigns.rows.length, 2);
  assert.equal(result.campaigns.rows[0].name, 'One');
  assert.equal(result.campaigns.totals.clicks, 30);
  assert.equal(result.campaigns.rows[0].sparkline.length, 7);
  assert.equal(result.heatmap.cells.length, 168);
  assert.equal(result.pace.series.length, 2);
  assert.deepEqual(Object.keys(result.breakdowns).sort(), ['campaigns', 'countries', 'groups', 'sources']);
  for (const { url, options } of mock.calls) {
    assert.equal(url.origin, origin);
    assert.ok(['/public/api/v1/report/campaign', '/public/api/v1/campaign/list/filtered'].includes(url.pathname));
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.headers['Api-Key'], key);
    assert.ok(!url.href.includes(key));
    if (url.pathname.endsWith('/report/campaign')) assert.equal(url.searchParams.getAll('groupings[]').length, 1);
    assert.equal(url.searchParams.getAll('groupings[]').includes('deviceType'), false);
  }
});

test('overview scope uses documented filtered catalog and rejects mismatching metadata', async () => {
  const groupId = '66067d5f-e6ea-4652-8cb6-83976342d383', sourceId = '4';
  const mock = fixture({ catalog: [{ id: 2, name: 'Scoped', groupUuid: groupId, trafficSourceId: 4 }] });
  const result = await load(mock, { query: { ...query, groupId, sourceId, hideBots: true }, sections: ['campaigns'] });
  assert.equal(result.campaigns.rows.length, 1);
  assert.equal(mock.calls[0].url.searchParams.get('groupUuid'), groupId);
  assert.equal(mock.calls[0].url.searchParams.get('trafficSourceId'), '4');
  for (const { url } of mock.calls.filter(call => call.url.pathname.endsWith('/report/campaign'))) {
    assert.deepEqual(url.searchParams.getAll('ids[]'), ['2']);
    assert.equal(url.searchParams.get('hideBots'), '1');
  }
  const bad = await load(fixture(), { query: { ...query, groupId }, sections: ['campaigns'] });
  assert.equal(bad.campaigns.error.code, 'API_RESPONSE');
  assert.equal(bad.campaigns.rows, undefined);
});

test('categorical reports accept evidenced entity_id and label-only rows without requiring a UI row id', async () => {
  const groupId = '66067d5f-e6ea-4652-8cb6-83976342d383';
  const mock = fixture({ handler: url => {
    const grouping = url.searchParams.get('groupings[]');
    if (!grouping || ['days', 'hourOfDay'].includes(grouping)) return;
    if (url.searchParams.get('offset') !== '0') return { report: [] };
    const rows = {
      campaign: [
        { entity_id: '1', id: 'ui-only-row-uuid', name: 'One', level: '1', ...metrics({ costs: null, profit: null, roi: null }) },
        { entity_id: 2, name: 'Two', level: 1, ...metrics() },
      ],
      trafficSource: [{ entity_id: 0, name: 'No traffic source', level: 1, ...metrics() }],
      campaignsGroup: [{ entity_id: groupId, name: 'Group', level: 1, ...metrics() }, { entity_id: null, name: 'No group', level: 1, ...metrics() }],
      geoCountry: [{ name: 'United States', level: 1, ...metrics() }],
    };
    return { report: rows[grouping] };
  } });
  const result = await load(mock, { sections: ['campaigns', 'breakdowns'] });
  assert.equal(result.campaigns.error, undefined);
  assert.deepEqual(result.campaigns.rows.map(row => row.id), ['1', '2']);
  for (const metric of ['costs', 'profit', 'roi']) assert.equal(result.campaigns.totals[metric], null);
  assert.equal(result.breakdowns.sources.rows[0].name, 'No traffic source');
  assert.equal(result.breakdowns.groups.rows.length, 2);
  assert.equal(result.breakdowns.countries.rows[0].name, 'United States');
  for (const dimension of Object.values(result.breakdowns)) {
    assert.equal(dimension.error, undefined);
    assert.ok(dimension.rows.every(row => row.previous?.clicks === 10));
  }
});

test('the documented legacy id/name report remains compatible', async () => {
  const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'campaign'
    ? { report: url.searchParams.getAll('ids[]').map(id => ({ id, name: `Campaign ${id}`, ...metrics() })) } : undefined });
  const result = await load(mock, { sections: ['campaigns'] });
  assert.equal(result.campaigns.error, undefined);
  assert.deepEqual(result.campaigns.rows.map(row => row.id), ['1', '2']);
});

test('campaign identity never falls back to names or an unrelated id when entity_id is present', async () => {
  for (const row of [
    { name: '1' }, { entity_id: 1, name: '' }, { entity_id: 1, name: ' ' }, { entity_id: null, id: '1', name: 'One' },
    { entity_id: '', id: '1', name: 'One' }, { entity_id: 0, name: 'One' },
    { entity_id: '3', id: '1', name: 'One' }, { entity_id: { id: '1' }, name: 'One' },
    { entity_id: 1, name: 'One', level: 2 }, { entity_id: 1, name: 'One', level: null },
  ]) {
    const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'campaign'
      ? { report: [{ ...row, ...metrics() }] } : undefined });
    const result = await load(mock, { sections: ['campaigns'] });
    assert.equal(result.campaigns.error?.code, 'API_RESPONSE', JSON.stringify(row));
    assert.equal(result.campaigns.rows, undefined);
  }
});

test('label-only categories retain identity across pages and reject malformed or duplicate rows', async () => {
  const mock = fixture({ handler: url => {
    if (url.searchParams.get('groupings[]') !== 'geoCountry') return;
    const offset = Number(url.searchParams.get('offset'));
    return { report: offset < 2 ? [{ name: ['United States', 'France'][offset], level: 1, ...metrics() }] : [] };
  } });
  const result = await load(mock, { sections: ['breakdowns'] });
  assert.equal(result.breakdowns.countries.rows.length, 2);
  assert.equal(result.breakdowns.countries.totals.clicks, 20);
  for (const rows of [
    [{}], [{ name: null }], [{ name: 0 }], [{ name: 'A'.repeat(513) }], [{ name: ['United States'] }],
    [{ name: 'United States', entity_id: {} }], [{ name: 'United States', level: 2 }],
    [{ name: 'United States' }, { name: 'United States' }],
  ]) {
    const malformed = fixture({ handler: url => url.searchParams.get('groupings[]') === 'geoCountry'
      ? { report: rows.map(row => ({ ...row, ...metrics() })) } : undefined });
    const rejected = await load(malformed, { sections: ['breakdowns'] });
    assert.equal(rejected.breakdowns.countries.error?.code, 'API_RESPONSE', JSON.stringify(rows));
    assert.equal(rejected.breakdowns.countries.totals, undefined);
  }
});

test('entity and country categories use distinct IDs rather than display labels', async () => {
  for (const [grouping, dimension] of [['campaign', 'campaigns'], ['campaignsGroup', 'groups'], ['trafficSource', 'sources'], ['geoCountry', 'countries']]) {
    for (const distinctIds of [false, true]) {
      const mock = fixture({ handler: url => {
        const params = url.searchParams;
        if (params.get('groupings[]') !== grouping) return;
        return { report: [1, 2].map(index => ({ entity_id: distinctIds ? index : 1,
          name: distinctIds ? 'Same display name' : `Different name ${index}`, level: 1, ...metrics() })),
        totals: { total_count: 2 } };
      } });
      const data = (await load(mock, { sections: ['breakdowns'] })).breakdowns[dimension];
      if (distinctIds) {
        assert.equal(data.error, undefined, grouping);
        assert.equal(data.rows.length, 2, grouping);
        assert.equal(data.totals.clicks, 20, grouping);
      } else {
        assert.equal(data.error?.code, 'API_RESPONSE', grouping);
        assert.equal(data.totals, undefined, grouping);
      }
    }
  }
});

test('category shape, name, level and ID validation remain strict', async () => {
  for (const row of [null, [], { name: null }, { name: ['Germany'] }, { name: 'Germany', level: 2 },
    { name: 'Germany', entity_id: {} }, { name: 'Germany', id: false }]) {
    const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'geoCountry'
      ? { report: [row], totals: { total_count: 1 } } : undefined });
    const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
    assert.equal(countries.error?.code, 'API_RESPONSE', JSON.stringify(row));
    assert.equal(countries.rows, undefined);
    assert.equal(countries.totals, undefined);
  }
});

test('blank country categories retain exact identities across pages and periods without display-label collisions', async () => {
  const names = ['', ' ', 'Пустое значение', 'Germany'];
  const mock = fixture({ handler: url => {
    const params = url.searchParams;
    if (params.get('groupings[]') !== 'geoCountry') return;
    const offset = Number(params.get('offset'));
    const previous = params.get('dateFrom').startsWith('2026-10-08');
    return { report: names.slice(offset, offset + 2).map((name, index) => ({
      name, entity_id: null, level: 1, ...metrics({ clicks: (offset + index + 1) * (previous ? 5 : 10) }),
    })) };
  } });
  const result = await load(mock, { sections: ['breakdowns'] });
  const countries = result.breakdowns.countries;
  assert.equal(countries.error, undefined);
  assert.equal(countries.previousError, undefined);
  assert.deepEqual(countries.rows.map(row => row.id), names.map(name => `name:${name}`));
  assert.deepEqual(countries.rows.map(row => row.name), ['Пустое значение', 'Пустое значение', 'Пустое значение', 'Germany']);
  assert.deepEqual(countries.rows.map(row => row.current.clicks), [10, 20, 30, 40]);
  assert.deepEqual(countries.rows.map(row => row.previous.clicks), [5, 10, 15, 20]);
  assert.equal(countries.totals.clicks, 100);
  assert.equal(countries.previousTotals.clicks, 50);
  assert.equal(mock.calls.filter(({ url }) => url.searchParams.get('groupings[]') === 'geoCountry').length, 6);

  const duplicate = fixture({ handler: url => url.searchParams.get('groupings[]') === 'geoCountry'
    ? { report: [{ name: '', ...metrics() }, { name: '', ...metrics() }] } : undefined });
  assert.equal((await load(duplicate, { sections: ['breakdowns'] })).breakdowns.countries.error.code, 'API_RESPONSE');
});

test('a previous-only blank country category preserves current rows and unknown unmatched values', async () => {
  const mock = fixture({ handler: url => {
    const params = url.searchParams;
    if (params.get('groupings[]') !== 'geoCountry') return;
    if (params.get('offset') !== '0') return { report: [] };
    const names = params.get('dateFrom').startsWith('2026-10-08') ? [''] : ['France', 'Unknown', 'Germany'];
    return { report: names.map(name => ({ name, level: 1, ...metrics() })) };
  } });
  const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
  assert.equal(countries.previousError, undefined);
  assert.equal(countries.totals.clicks, 30);
  assert.equal(countries.previousTotals.clicks, 10);
  assert.deepEqual(countries.rows.slice(0, 3).map(row => row.name), ['France', 'Unknown', 'Germany']);
  assert.ok(countries.rows.slice(0, 3).every(row => row.previous === null));
  assert.equal(countries.rows[3].name, 'Пустое значение');
  assert.equal(countries.rows[3].current.clicks, null);
  assert.equal(countries.rows[3].previous.clicks, 10);
  // Mark an entry known only from the previous report, so the UI can say "only in
  // the previous period" instead of "unavailable", without inventing a current zero.
  assert.equal(countries.rows[3].onlyPrevious, true);
  assert.ok(countries.rows.slice(0, 3).every(row => !Object.hasOwn(row, 'onlyPrevious')));
});

test('explicit zero-count empty Report envelopes do not invent previous traffic or comparisons', async () => {
  for (const total_count of [0, '0']) for (const envelope of [{ totals: { total_count } }, { report: null, totals: { total_count } }, { report: [], totals: { total_count } }]) {
    const mock = fixture({ handler: url => {
      const params = url.searchParams;
      if (params.get('groupings[]') !== 'geoCountry' || !params.get('dateFrom').startsWith('2026-10-08')) return;
      return envelope;
    } });
    const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
    assert.equal(countries.error, undefined);
    assert.equal(countries.previousError, undefined);
    assert.equal(countries.totals.clicks, 10);
    assert.ok(Object.values(countries.previousTotals).every(value => value === null));
    assert.equal(countries.rows[0].previous, null);
    assert.equal(mock.calls.filter(({ url }) => url.searchParams.get('groupings[]') === 'geoCountry' && url.searchParams.get('dateFrom').startsWith('2026-10-08')).length, 1);
  }
});

test('unknown or contradictory Report envelopes remain errors and preserve the complete current period', async () => {
  for (const envelope of [
    {}, null, [], { report: null }, { report: null, totals: [] },
    ...[undefined, null, false, '', '00', 1, -1, {}, []].map(total_count => ({ report: null, totals: { total_count } })),
    { report: {}, totals: { total_count: 0 } }, { report: false, totals: { total_count: 0 } },
    { report: [{ name: 'Germany', ...metrics() }], totals: { total_count: 0 } },
  ]) {
    const mock = fixture({ handler: url => {
      const params = url.searchParams;
      if (params.get('groupings[]') === 'geoCountry' && params.get('dateFrom').startsWith('2026-10-08')) return respond(envelope);
    } });
    const result = await load(mock, { sections: ['breakdowns'] });
    const countries = result.breakdowns.countries;
    assert.equal(countries.previousError?.code, 'API_RESPONSE', JSON.stringify(envelope));
    assert.equal(countries.previousTotals, null);
    assert.equal(countries.totals.clicks, 10);
    assert.equal(countries.rows[0].previous, null);
    assert.equal(result.breakdowns.sources.previousError, undefined);
  }
});

test('a zero total after a nonempty Report page is rejected instead of accepting incomplete totals', async () => {
  for (const report of [null, []]) {
    const mock = fixture({ handler: url => {
      const params = url.searchParams;
      if (params.get('groupings[]') !== 'geoCountry' || !params.get('dateFrom').startsWith('2026-10-08')) return;
      return params.get('offset') === '0' ? { report: [{ name: 'Germany', ...metrics() }] } : { report, totals: { total_count: 0 } };
    } });
    const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
    assert.equal(countries.previousError?.code, 'API_RESPONSE');
    assert.equal(countries.previousTotals, null);
    assert.equal(countries.rows[0].previous, null);
    assert.equal(countries.totals.clicks, 10);
  }
});

test('a complete categorical report uses numeric or numeric-string totals without requesting an extra empty page', async () => {
  for (const total_count of [3, '3']) {
    const mock = fixture({ handler: url => {
      const params = url.searchParams;
      if (params.get('groupings[]') !== 'geoCountry') return;
      // Native Report can return null after the final page. A known complete
      // count must avoid that unnecessary request, not discard valid rows.
      return { report: params.get('offset') === '0'
        ? ['France', 'Germany', 'Unknown'].map(name => ({ name, ...metrics() })) : null,
      totals: { total_count } };
    } });
    const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
    assert.equal(countries.error, undefined);
    assert.equal(countries.previousError, undefined);
    assert.equal(countries.rows.length, 3);
    assert.equal(countries.totals.clicks, 30);
    assert.equal(countries.previousTotals.clicks, 30);
    assert.deepEqual(mock.calls.filter(({ url }) => url.searchParams.get('groupings[]') === 'geoCountry')
      .map(({ url }) => url.searchParams.get('offset')), ['0', '0']);
  }
});

test('a reported total continues capped short pages until every category has arrived', async () => {
  for (const total_count of [3, '3']) {
    const mock = fixture({ handler: url => {
      const params = url.searchParams;
      if (params.get('groupings[]') !== 'geoCountry') return;
      const offset = Number(params.get('offset'));
      return { report: ['France', 'Germany', 'Unknown'].slice(offset, offset + 2).map(name => ({ name, ...metrics() })),
        totals: { total_count } };
    } });
    const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
    assert.equal(countries.error, undefined);
    assert.equal(countries.previousError, undefined);
    assert.deepEqual(countries.rows.map(row => row.name), ['France', 'Germany', 'Unknown']);
    assert.equal(countries.totals.clicks, 30);
    for (const dateFrom of ['2026-10-15', '2026-10-08']) assert.deepEqual(mock.calls.filter(({ url }) =>
      url.searchParams.get('groupings[]') === 'geoCountry' && url.searchParams.get('dateFrom').startsWith(dateFrom))
      .map(({ url }) => url.searchParams.get('offset')), ['0', '2']);
  }
});

test('reports without a total retain empty-page termination and never truncate a short page', async () => {
  const mock = fixture({ handler: url => {
    const params = url.searchParams;
    if (params.get('groupings[]') !== 'geoCountry') return;
    const offset = Number(params.get('offset'));
    return { report: ['France', 'Germany', 'Unknown'].slice(offset, offset + 2).map(name => ({ name, ...metrics() })) };
  } });
  const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
  assert.equal(countries.error, undefined);
  assert.equal(countries.rows.length, 3);
  assert.equal(countries.totals.clicks, 30);
  for (const dateFrom of ['2026-10-15', '2026-10-08']) assert.deepEqual(mock.calls.filter(({ url }) =>
    url.searchParams.get('groupings[]') === 'geoCountry' && url.searchParams.get('dateFrom').startsWith(dateFrom))
    .map(({ url }) => url.searchParams.get('offset')), ['0', '2', '3']);
});

test('inconsistent counts and duplicate categories never expose partial breakdown totals', async () => {
  const row = name => ({ name, ...metrics() });
  for (const { name, pages, code } of [
    { name: 'changed total', pages: [
      { report: [row('France'), row('Germany')], totals: { total_count: 3 } },
      { report: [row('Unknown')], totals: { total_count: 4 } },
    ], code: 'INCOMPLETE_DATA' },
    { name: 'empty before total', pages: [
      { report: [row('France')], totals: { total_count: 3 } },
      { report: [], totals: { total_count: 3 } },
    ], code: 'INCOMPLETE_DATA' },
    { name: 'count omitted after first page', pages: [
      { report: [row('France')], totals: { total_count: 3 } },
      { report: [] },
    ], code: 'INCOMPLETE_DATA' },
    { name: 'too many rows', pages: [{ report: [row('France'), row('Germany')], totals: { total_count: 1 } }], code: 'API_RESPONSE' },
    { name: 'duplicate in page', pages: [{ report: [row('France'), row('France')], totals: { total_count: 2 } }], code: 'API_RESPONSE' },
    { name: 'repeated next page', pages: [
      { report: [row('France')], totals: { total_count: 2 } },
      { report: [row('France')], totals: { total_count: 2 } },
    ], code: 'REPEATED_PAGE' },
  ]) {
    const mock = fixture({ handler: url => {
      const params = url.searchParams;
      if (params.get('groupings[]') !== 'geoCountry') return;
      return pages[params.get('offset') === '0' ? 0 : 1];
    } });
    const result = await load(mock, { sections: ['breakdowns'] });
    assert.equal(result.breakdowns.countries.error?.code, code, name);
    assert.equal(result.breakdowns.countries.rows, undefined, name);
    assert.equal(result.breakdowns.countries.totals, undefined, name);
    assert.equal(result.breakdowns.sources.error, undefined, name);
  }
});

test('invalid or excessive report totals fail without accepting their valid-looking rows', async () => {
  for (const total_count of [-1, 1.5, true, '', ' 1', '+1', '01', '1.0', '1e0', {}, [], 9007199254740992, '9007199254740992', 10001, '10001']) {
    const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'geoCountry'
      ? { report: [{ name: 'Germany', ...metrics() }], totals: { total_count } } : undefined });
    const countries = (await load(mock, { sections: ['breakdowns'] })).breakdowns.countries;
    assert.equal(countries.error?.code, total_count === 10001 || total_count === '10001' ? 'REPORT_LIMIT' : 'API_RESPONSE', JSON.stringify(total_count));
    assert.equal(countries.rows, undefined);
    assert.equal(countries.totals, undefined);
  }
});

test('report diagnostics identify fixed parser stages without exposing malformed values', async () => {
  const sentinel = 'synthetic-private-value-not-for-display';
  for (const { name, stage } of [
    { name: null, stage: 'category-name-null' },
    { name: { value: sentinel }, stage: 'category-name' },
    { name: sentinel.repeat(20), stage: 'category-name' },
  ]) {
    const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'geoCountry'
      ? { report: [{ name, ...metrics() }] } : undefined });
    const result = await load(mock, { sections: ['breakdowns'] });
    const error = result.breakdowns.countries.error;
    assert.equal(error.code, 'API_RESPONSE');
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message']);
    assert.ok(error.message.endsWith(`Код: ${stage}.`));
    assert.ok(!JSON.stringify(result).includes(sentinel));
    assert.ok(!JSON.stringify(result).includes(key));
  }
  const error = new ApiError('API_RESPONSE', sentinel);
  assert.equal(Object.hasOwn(error, 'diagnostic'), false);
  assert.ok(!error.message.includes(sentinel));
  const mock = fixture({ handler: url => {
    if (url.searchParams.get('groupings[]') === 'geoCountry') throw error;
  } });
  const result = await load(mock, { sections: ['breakdowns'] });
  assert.ok(!JSON.stringify(result).includes(sentinel));
  assert.ok(!result.breakdowns.countries.error.message.includes('Код:'));
});

test('the known campaign ID domain cannot override a contradictory report total', async () => {
  const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'campaign'
    ? { report: [1, 2].map(entity_id => ({ entity_id, name: `Campaign ${entity_id}`, ...metrics() })), totals: { total_count: 3 } } : undefined });
  const campaigns = (await load(mock, { sections: ['breakdowns'] })).breakdowns.campaigns;
  assert.equal(campaigns.error?.code, 'INCOMPLETE_DATA');
  assert.equal(campaigns.rows, undefined);
  assert.equal(campaigns.totals, undefined);
});

test('breakdowns omit dimensions fixed by the selected scope and never request sparklines', async () => {
  const groupId = '66067d5f-e6ea-4652-8cb6-83976342d383', sourceId = '4';
  for (const filters of [{}, { groupId }, { sourceId }, { groupId, sourceId }]) {
    const mock = fixture({ catalog: [1, 2].map(id => ({ id, name: `Campaign ${id}`, groupUuid: groupId, trafficSourceId: 4 })) });
    const result = await load(mock, { query: { ...query, ...filters }, sections: ['breakdowns'] });
    const requested = new Set(mock.calls.map(({ url }) => url.searchParams.get('groupings[]')).filter(Boolean));
    assert.equal(requested.has('campaign'), true);
    assert.equal(requested.has('campaignsGroup'), !filters.groupId);
    assert.equal(requested.has('trafficSource'), !filters.sourceId);
    assert.equal(requested.has('geoCountry'), true);
    assert.equal(requested.has('deviceType'), false);
    assert.equal(Object.hasOwn(result.breakdowns, 'devices'), false);
    assert.equal(requested.has('days'), false);
    assert.equal(requested.has('hourOfDay'), false);
    assert.equal(Object.hasOwn(result.breakdowns, 'groups'), !filters.groupId);
    assert.equal(Object.hasOwn(result.breakdowns, 'sources'), !filters.sourceId);
    assert.equal(result.breakdowns.campaigns.rows.length, 2);
    assert.ok(result.breakdowns.campaigns.rows.every(row => !Object.hasOwn(row, 'sparkline')));
  }
  const mock = fixture();
  const result = await load(mock, { query: { ...query, groupId, sourceId }, campaignIds: ['2'], sections: ['breakdowns'] });
  assert.equal(Object.hasOwn(result.breakdowns, 'campaigns'), false);
  assert.deepEqual(new Set(mock.calls.map(({ url }) => url.searchParams.get('groupings[]')).filter(Boolean)),
    new Set(['campaignsGroup', 'trafficSource', 'geoCountry']));
});

test('selected scope ignores hidden overview group/source filters and never widens unknown IDs', async () => {
  const mock = fixture();
  const result = await load(mock, { query: { ...query, groupId: '66067d5f-e6ea-4652-8cb6-83976342d383', sourceId: '4' }, campaignIds: ['2'], sections: ['campaigns'] });
  assert.equal(result.scope.mode, 'selected');
  assert.equal(mock.calls[0].url.searchParams.has('groupUuid'), false);
  assert.equal(mock.calls[0].url.searchParams.has('trafficSourceId'), false);
  assert.deepEqual(result.scope.campaignIds, ['2']);
  for (const { url } of mock.calls.filter(call => call.url.pathname.endsWith('/report/campaign'))) assert.deepEqual(url.searchParams.getAll('ids[]'), ['2']);
  const unknown = await load(fixture(), { campaignIds: ['3'], sections: ['pace'] });
  assert.equal(unknown.pace.error.code, 'FORBIDDEN');
});

test('pace compares identical local clocks across DST and propagates missing cumulative buckets', async () => {
  const mock = fixture({ handler: url => {
    if (url.searchParams.get('groupings[]') === 'hourOfDay' && url.searchParams.get('dateFrom').startsWith('2026-03-08')) {
      return { report: url.searchParams.get('offset') === '0' ? [{ name: '0', ...metrics() }, { name: '2', ...metrics() }] : [] };
    }
  } });
  const result = await load(mock, { query: { ...query, timezone: 'America/New_York' }, now: new Date('2026-03-08T16:30:00Z'), sections: ['pace'] });
  assert.equal(result.pace.throughTime, '12:30:00');
  assert.deepEqual(result.pace.series.map(series => series.day), ['2026-03-08', '2026-03-07']);
  assert.deepEqual(result.pace.series.map(series => series.id), ['today', 'yesterday']);
  for (const series of result.pace.series) {
    assert.equal(series.range.dateTo.slice(11), '12:30:00');
    assert.equal(series.rows.length, 13);
  }
  assert.equal(result.pace.series[0].rows[0].cumulativeClicks, 10);
  assert.equal(result.pace.series[0].rows[1].clicks, null);
  assert.equal(result.pace.series[0].rows[2].clicks, 10);
  assert.equal(result.pace.series[0].rows[2].cumulativeClicks, null);
});

test('heatmap is exactly seven completed local days, reports per-day errors and preserves zero versus unknown', async () => {
  const mock = fixture({ handler: url => {
    if (url.pathname.endsWith('/report/campaign') && url.searchParams.get('dateFrom').startsWith('2026-10-15')) return respond({ message: 'private-server-error' }, 403);
    if (url.pathname.endsWith('/report/campaign') && url.searchParams.get('dateFrom').startsWith('2026-10-14')) return { report: url.searchParams.get('offset') === '0' ? [{ name: '0', ...metrics({ clicks: 0 }) }] : [] };
  } });
  const result = await load(mock, { sections: ['heatmap'] });
  assert.equal(result.heatmap.range.dateFrom, '2026-10-14 00:00:00');
  assert.equal(result.heatmap.range.dateTo, '2026-10-20 23:59:59');
  assert.equal(result.heatmap.errors.length, 1);
  assert.equal(result.heatmap.errors[0].code, 'FORBIDDEN');
  const cells = result.heatmap.cells.filter(cell => cell.day === '2026-10-14');
  assert.equal(cells[0].weekday, 2);
  assert.equal(cells[0].clicks, 0); assert.equal(cells[0].samples, 1);
  assert.equal(cells[1].clicks, null); assert.equal(cells[1].samples, 0);
  assert.ok(!JSON.stringify(result).includes('private-server-error'));
});

test('missing financial columns remain unknown and totals use weighted visible ratios', async () => {
  const mock = fixture({ handler: url => {
    if (url.searchParams.get('groupings[]') !== 'campaign') return;
    return { report: url.searchParams.get('offset') === '0' ? [
      { id: '1', name: 'One', ...metrics({ clicks: 10, leads: 2, costs: 10, revenue: 30, profit: null, roi: null, cr: null, epc: null, cpc: null, bots: null }) },
      { id: '2', name: 'Two', ...metrics({ clicks: 90, leads: 3, costs: 90, revenue: 90, profit: 0, roi: 0 }) },
    ] : [] };
  } });
  const result = await load(mock, { sections: ['campaigns'] });
  const totals = result.campaigns.totals;
  assert.equal(totals.clicks, 100); assert.equal(totals.costs, 100); assert.equal(totals.cpa, 20);
  for (const metric of ['profit', 'roi', 'cr', 'epc', 'cpc', 'bots']) assert.equal(totals[metric], null);
  assert.equal(result.campaigns.rows[0].current.cpa, 5);
});

test('short pages are not considered complete; repeated pages are errors, never partial rankings', async () => {
  const mock = fixture({ handler: url => {
    if (url.searchParams.get('groupings[]') === 'campaign') return { report: [{ id: '1', name: 'One', ...metrics() }] };
  } });
  const result = await load(mock, { sections: ['campaigns'] });
  assert.equal(result.campaigns.error.code, 'REPEATED_PAGE');
  assert.equal(result.campaigns.totals, undefined);
  assert.ok(mock.calls.some(call => call.url.searchParams.get('offset') === '1'));
});

test('previous-period and dimension failures preserve other complete blocks, without fabricating previous zeros', async () => {
  const mock = fixture({ handler: url => {
    const group = url.searchParams.get('groupings[]');
    if (group === 'geoCountry') return respond({ internalSecret: 'do-not-forward' }, 401);
    if (group === 'campaign' && url.searchParams.get('dateFrom').startsWith('2026-10-08')) return respond({}, 403);
  } });
  const result = await load(mock, { sections: ['campaigns', 'breakdowns'] });
  assert.equal(result.campaigns.previousError.code, 'FORBIDDEN');
  assert.equal(result.campaigns.previousTotals, null);
  assert.ok(result.campaigns.rows.every(row => row.previous === null));
  assert.equal(result.breakdowns.countries.error.code, 'AUTH');
  assert.equal(result.breakdowns.sources.rows.length, 1);
  assert.ok(!JSON.stringify(result).includes('do-not-forward'));
});

test('undocumented nested response shapes remain explicit errors', async () => {
  const nested = fixture({ handler: url => url.pathname.endsWith('/report/campaign') ? { report: [{ children: [{ id: '1', name: 'One', ...metrics() }] }] } : undefined });
  const rejected = await load(nested, { sections: ['campaigns'] });
  assert.equal(rejected.campaigns.error.code, 'API_RESPONSE');
});

test('empty catalog does not emit any unscoped report or fake-zero totals', async () => {
  const mock = fixture({ catalog: [] });
  const result = await load(mock);
  assert.equal(mock.calls.length, 1);
  assert.equal(result.campaigns.totals.clicks, null);
  assert.equal(result.campaigns.rows.length, 0);
  assert.ok(result.heatmap.cells.every(cell => cell.clicks === null));
});

test('a verified full campaign ID domain proves completion even when API ignores pagination', async () => {
  const mock = fixture({ handler: url => url.searchParams.get('groupings[]') === 'campaign' ? { report: ['1', '2'].map(id => ({ id, name: id, ...metrics() })) } : undefined });
  const result = await load(mock, { sections: ['campaigns'] });
  assert.equal(result.campaigns.error, undefined);
  assert.equal(result.campaigns.rows.length, 2);
  const campaignCalls = mock.calls.filter(call => call.url.searchParams.get('groupings[]') === 'campaign');
  assert.equal(campaignCalls.length, 2); // one complete current, one complete previous
});

test('long campaign IDs are split into short scoped GET requests instead of rejecting the whole report', async () => {
  const mock = fixture({ catalog: Array.from({ length: 400 }, (_, i) => ({ id: String(1000000000000000 + i), name: String(i) })) });
  const result = await load(mock, { sections: ['campaigns'] });
  assert.equal(result.campaigns.error, undefined);
  assert.equal(result.campaigns.rows.length, 400);
  assert.ok(result.scope.reportBatches > 1);
  const current = mock.calls.filter(call => call.url.searchParams.get('groupings[]') === 'campaign' &&
    call.url.searchParams.get('dateFrom').startsWith('2026-10-15'));
  assert.equal(new Set(current.flatMap(call => call.url.searchParams.getAll('ids[]'))).size, 400);
  for (const { url } of mock.calls) assert.ok(url.href.length <= 7000);
});

test('all insight blocks support more than 500 campaigns without truncation or the former shared 120-request ceiling', async () => {
  const count = 2501;
  const mock = fixture({ catalog: Array.from({ length: count }, (_, i) => ({ id: i + 1, name: `Campaign ${i + 1}` })), delay: true });
  const result = await load(mock);
  assert.equal(result.scope.campaignCount, count);
  assert.equal(result.campaigns.error, undefined);
  assert.equal(result.campaigns.previousError, undefined);
  assert.equal(result.campaigns.rows.length, count);
  assert.equal(result.campaigns.totals.clicks, count * (count + 1) / 2 * 10);
  assert.equal(result.campaigns.previousTotals.clicks, result.campaigns.totals.clicks);
  assert.ok(result.pace.series.every(series => !series.error && series.rows.length));
  assert.equal(result.heatmap.errors.length, 0);
  assert.ok(Object.values(result.breakdowns).every(dimension => !dimension.error && !dimension.previousError && dimension.rows.length));
  assert.ok(mock.calls.length > 120, 'This fixture must exercise the old shared-request-limit failure');
  assert.ok(mock.maximum <= 3);
  const current = mock.calls.filter(call => call.url.searchParams.get('groupings[]') === 'campaign' &&
    call.url.searchParams.get('dateFrom').startsWith('2026-10-15'));
  const loadedIds = current.flatMap(call => call.url.searchParams.getAll('ids[]'));
  assert.equal(loadedIds.length, count);
  assert.equal(new Set(loadedIds).size, count);
  for (const { url, options } of mock.calls) {
    assert.ok(url.href.length <= 7000);
    assert.equal(options.method, 'GET');
    if (url.pathname.endsWith('/report/campaign')) assert.ok(url.searchParams.getAll('ids[]').length > 0);
  }
});

test('batch aggregation weights ratios by totals and propagates hidden financial columns', async () => {
  const mock = fixture({ catalog: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `C${i}` })), handler: url => {
    if (!url.pathname.endsWith('/report/campaign')) return;
    if (url.searchParams.get('offset') !== '0') return { report: [] };
    const first = url.searchParams.getAll('ids[]').includes('1');
    const hidden = url.searchParams.get('groupings[]') === 'campaignsGroup';
    const values = first
      ? metrics({ clicks: 100, leads: 10, costs: 20, revenue: 50, profit: 30, roi: 150, bots: 1, cr: 10, epc: 0.5, cpc: 0.2 })
      : metrics({ clicks: 900, leads: 180, costs: 180, revenue: 270, profit: 90, roi: 50, bots: 9, cr: 20, epc: 0.3, cpc: 0.2 });
    if (hidden && !first) Object.assign(values, { profit: null, roi: null, cr: null, epc: null, bots: null });
    return { report: [{ id: 'shared', name: 'Shared category', ...values }] };
  } });
  const result = await load(mock, { sections: ['breakdowns'] });
  const values = result.breakdowns.countries.rows[0].current;
  assert.equal(values.clicks, 1000); assert.equal(values.leads, 190);
  assert.equal(values.costs, 200); assert.equal(values.revenue, 320); assert.equal(values.profit, 120);
  assert.equal(values.roi, 60); assert.equal(values.cr, 19); assert.equal(values.epc, 0.32);
  assert.equal(values.cpc, 0.2); assert.equal(values.cpa, 200 / 190); assert.equal(values.bots, 10);
  const hidden = result.breakdowns.groups.rows[0].current;
  for (const metric of ['profit', 'roi', 'cr', 'epc', 'bots']) assert.equal(hidden[metric], null);
  assert.equal(hidden.costs, 200);
});

test('paginated country batches preserve optional unique aggregates, missing values and overflow', async () => {
  const names = ['France', 'Germany', 'Unknown'];
  const mock = fixture({ catalog: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `Campaign ${i + 1}` })), handler: url => {
    const params = url.searchParams;
    if (params.get('groupings[]') !== 'geoCountry') return;
    const first = params.getAll('ids[]').includes('1');
    const previous = params.get('dateFrom').startsWith('2026-10-08');
    const offset = Number(params.get('offset'));
    const uniqueClicks = first ? [previous ? 5 : 10, undefined, Number.MAX_SAFE_INTEGER] : [previous ? 10 : 20, 5, 1];
    const campaignUniques = first ? [previous ? 20 : 40, 0, Number.MAX_SAFE_INTEGER] : [previous ? 40 : 80, 0, 1];
    return { report: names.slice(offset, offset + 1).map((name, i) => ({ name, entity_id: null, level: 1,
      ...metrics({ clicks: first ? 100 : 200, unique_clicks: uniqueClicks[offset + i], unique_campaign_clicks: String(campaignUniques[offset + i]) }),
    })), totals: { total_count: names.length } };
  } });
  const result = await load(mock, { sections: ['breakdowns'] });
  const countries = result.breakdowns.countries;
  assert.equal(countries.error, undefined);
  assert.equal(countries.previousError, undefined);
  assert.deepEqual(countries.rows.map(row => row.current.unique_clicks), [30, null, null]);
  assert.deepEqual(countries.rows.map(row => row.previous.unique_clicks), [15, null, null]);
  assert.deepEqual(countries.rows.map(row => row.current.unique_campaign_clicks), [120, 0, null]);
  assert.deepEqual(countries.rows.map(row => row.previous.unique_campaign_clicks), [60, 0, null]);
  assert.equal(countries.totals.unique_clicks, null);
  assert.equal(countries.previousTotals.unique_clicks, null);
  assert.equal(countries.totals.unique_campaign_clicks, null);
  assert.equal(countries.previousTotals.unique_campaign_clicks, null);
  const france = countries.rows[0].current;
  assert.equal(france.clicks, 300);
  assert.equal(france.cr, 4 / 300 * 100);
  assert.equal(france.epc, 40 / 300);
  assert.equal(france.cpc, 16 / 300);
  const calls = mock.calls.filter(({ url }) => url.searchParams.get('groupings[]') === 'geoCountry');
  assert.equal(calls.length, 12);
  assert.deepEqual(new Set(calls.map(({ url }) => url.searchParams.get('offset'))), new Set(['0', '1', '2']));
  for (const { url } of mock.calls) assert.ok([...url.searchParams.keys()].every(name => !/unique|uniqueness|uc/i.test(name)));
});

test('campaign composition retains both native unique counters across current and previous reports', async () => {
  const mock = fixture({ handler: url => {
    const params = url.searchParams;
    if (params.get('groupings[]') !== 'campaign') return;
    const previous = params.get('dateFrom').startsWith('2026-10-08');
    return { report: params.getAll('ids[]').map(id => ({ entity_id: id, name: `Campaign ${id}`, ...metrics({
      clicks: 100, unique_clicks: Number(id) * (previous ? 3 : 5), unique_campaign_clicks: Number(id) * (previous ? 6 : 10),
    }) })) };
  } });
  const campaigns = (await load(mock, { sections: ['breakdowns'] })).breakdowns.campaigns;
  assert.equal(campaigns.error, undefined);
  assert.equal(campaigns.previousError, undefined);
  assert.deepEqual(campaigns.rows.map(row => row.current.unique_clicks), [5, 10]);
  assert.deepEqual(campaigns.rows.map(row => row.previous.unique_clicks), [3, 6]);
  assert.equal(campaigns.totals.unique_clicks, 15);
  assert.equal(campaigns.previousTotals.unique_clicks, 9);
  assert.equal(campaigns.totals.unique_campaign_clicks, 30);
  assert.equal(campaigns.previousTotals.unique_campaign_clicks, 18);
  assert.equal(campaigns.totals.clicks, 200);
  assert.equal(campaigns.totals.cr, 2);
});

test('a time bucket missing from one batch remains unknown rather than displaying the other batch subtotal', async () => {
  const mock = fixture({ catalog: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `C${i}` })), handler: url => {
    if (url.searchParams.get('groupings[]') !== 'hourOfDay' || !url.searchParams.get('dateFrom').startsWith('2026-10-21') ||
        url.searchParams.getAll('ids[]').includes('1')) return;
    return { report: url.searchParams.get('offset') === '0'
      ? Array.from({ length: 9 }, (_, hour) => ({ name: hour, ...metrics() })).filter(row => row.name !== 2) : [] };
  } });
  const result = await load(mock, { sections: ['pace'] });
  const today = result.pace.series[0];
  assert.equal(today.error, undefined);
  assert.equal(today.rows[0].clicks, 20);
  assert.equal(today.rows[2].clicks, null);
  assert.equal(today.rows[3].clicks, 20);
  assert.equal(today.rows[3].cumulativeClicks, null);
});

test('one failed campaign batch invalidates its full ranking while independent blocks still load', async () => {
  const mock = fixture({ catalog: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `C${i}` })), handler: url => {
    if (url.searchParams.get('groupings[]') === 'campaign' && url.searchParams.get('dateFrom').startsWith('2026-10-15') &&
        !url.searchParams.getAll('ids[]').includes('1')) return respond({}, 403);
  } });
  const result = await load(mock, { sections: ['campaigns', 'pace'] });
  assert.equal(result.campaigns.error.code, 'FORBIDDEN');
  assert.equal(result.campaigns.rows, undefined);
  assert.equal(result.campaigns.totals, undefined);
  assert.ok(result.pace.series.every(series => !series.error && series.rows.length));
});

test('a campaign returned outside its exact ID batch cannot contaminate or duplicate the combined scope', async () => {
  const mock = fixture({ catalog: Array.from({ length: 600 }, (_, i) => ({ id: i + 1, name: `C${i}` })), handler: url => {
    if (url.searchParams.get('groupings[]') === 'campaign' && url.searchParams.getAll('ids[]').includes('1')) {
      return { report: [{ id: '600', name: 'A different batch', ...metrics() }] };
    }
  } });
  const result = await load(mock, { sections: ['campaigns'] });
  assert.equal(result.campaigns.error.code, 'API_RESPONSE');
  assert.equal(result.campaigns.rows, undefined);
});

test('the shared catalog retains its existing 10,000-row bound and never reports a truncated scope', async () => {
  const mock = fixture({ catalog: Array.from({ length: 10001 }, (_, i) => ({ id: i + 1, name: `C${i}` })) });
  const result = await load(mock, { sections: ['campaigns', 'heatmap'] });
  assert.equal(result.campaigns.error.code, 'REPORT_LIMIT');
  assert.equal(result.heatmap.error.code, 'REPORT_LIMIT');
  assert.equal(mock.calls.filter(call => call.url.pathname.endsWith('/report/campaign')).length, 0);
});

// Composition and its CPA read spend from Binom `cost`.
test('traffic composition reads spend from Binom cost', async () => {
  const mock = fixture({ handler: url => {
    const params = url.searchParams;
    if (!url.pathname.endsWith('/report/campaign') || params.get('groupings[]') !== 'trafficSource') return;
    if (params.get('offset') !== '0') return { report: [] };
    const { costs, ...rest } = metrics({ leads: 4 });
    return { report: [{ entity_id: 1, level: 1, name: 'Source', ...rest, cost: '12.00' }] };
  } });
  const sources = (await load(mock, { sections: ['breakdowns'] })).breakdowns.sources;
  assert.equal(sources.rows[0].current.costs, 12);
  assert.equal(sources.rows[0].current.cpa, 3);
  assert.equal(sources.totals.costs, 12);
});
