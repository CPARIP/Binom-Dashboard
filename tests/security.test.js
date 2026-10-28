import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFERENCES, hostPermissionPattern, isContentSender, isOptionsSender,
  isPlainRecord, normalizeCampaignsPath, normalizeOrigin, publicError,
  validateApiKey, validateConnection, validatePreferences, validateSavedConfig,
} from '../src/security.js';

const origin = 'https://tracker.example:8443';
const extensionId = 'extension-id';
const optionsUrl = `chrome-extension://${extensionId}/options.html`;
const popupUrl = `chrome-extension://${extensionId}/popup.html`;
const contentSender = () => ({ id: extensionId, frameId: 0, url: `${origin}/?page=campaigns`, origin,
  tab: { id: 12, url: `${origin}/?page=campaigns` } });
const fails = (fn, code) => assert.throws(fn, (error) => error.code === code);

test('origin normalization retains exact HTTPS origin and rejects credential forwarding tricks', () => {
  assert.equal(normalizeOrigin(' HTTPS://Tracker.Example:8443/ '), origin);
  assert.equal(hostPermissionPattern(origin), 'https://tracker.example/*');
  for (const value of [
    'http://tracker.example', 'javascript:alert(1)', 'file:///tmp', '//tracker.example',
    'https://user:pass@tracker.example', 'https://tracker.example/path',
    'https://tracker.example/..', 'https://tracker.example?api-key=secret',
    'https://tracker.example#token', 'https://tracker.example\\@attacker.example',
    'https://tracker.\nexample', 'https://*.example', '', null, {},
  ]) fails(() => normalizeOrigin(value), 'INVALID_ORIGIN');
});

test('campaign paths allow SPA routes but cannot introduce another origin or saved secret', () => {
  assert.equal(normalizeCampaignsPath('/admin/?page=campaigns#/reports?tab=all', origin), '/admin/?page=campaigns#/reports?tab=all');
  assert.equal(normalizeCampaignsPath('/#/campaigns', origin), '/#/campaigns');
  for (const value of [
    'https://attacker.example/', '//attacker.example/', '/\\attacker.example',
    '/a\nb', '/?api-key=secret', '/?API_KEY=secret', '/#/campaigns?token=secret',
    '/#password=secret', 'campaigns', null,
  ]) fails(() => normalizeCampaignsPath(value, origin), 'INVALID_PATH');
});

test('campaign navigation strips temporary query auth while preserving legitimate routing', () => {
  assert.equal(normalizeCampaignsPath('/?auth=TEST_ONLY', origin), '/');
  assert.equal(normalizeCampaignsPath('/admin/?page=campaigns&auth=TEST_ONLY&view=all', origin), '/admin/?page=campaigns&view=all');
  assert.equal(normalizeCampaignsPath('/?AUTH=TEST_ONLY&page=campaigns&auth=TEST_ONLY#/reports?tab=all', origin), '/?page=campaigns#/reports?tab=all');
  assert.equal(normalizeCampaignsPath('/?%61uth=TEST_ONLY&page=campaigns', origin), '/?page=campaigns');
  assert.equal(normalizeCampaignsPath('/?page=campaigns&binomDashboard=1&auth=TEST_ONLY', origin), '/?page=campaigns');
  assert.equal(normalizeCampaignsPath('/index?binomDashboard=1#/campaigns', origin), '/index#/campaigns');
  assert.equal(normalizeCampaignsPath('/?page=campaigns&authentication=help', origin), '/?page=campaigns&authentication=help');
  const config=validateSavedConfig({origin,campaignsPath:'/?page=campaigns&auth=TEST_ONLY',timezone:'UTC'});
  assert.equal(config.campaignsPath,'/?page=campaigns');
  assert.equal(JSON.stringify(config).includes('TEST_ONLY'),false);
  for(const path of [
    '/#auth=TEST_ONLY', '/#/campaigns?auth=TEST_ONLY', '/#/campaigns?AUTH=TEST_ONLY',
    '/#/campaigns?%61uth=TEST_ONLY', '/?auth=TEST_ONLY#/campaigns?auth=TEST_ONLY',
  ]) fails(()=>normalizeCampaignsPath(path,origin),'INVALID_PATH');
});

test('connection validation produces a separate config and session secret', () => {
  const result = validateConnection({ origin, campaignsPath: '/?page=campaigns', key: 'a-secret-value' });
  assert.deepEqual(result.config, { origin, campaignsPath: '/?page=campaigns' });
  assert.equal(result.key, 'a-secret-value');
  assert.equal(JSON.stringify(result.config).includes('secret'), false);
  assert.deepEqual(validateConnection({ origin, key: 'k' }).config, { origin, campaignsPath: '/' });
  fails(() => validateConnection({ origin, key: 'k', timezone: 'UTC' }), 'INVALID_MESSAGE');
  fails(() => validateConnection({ origin, key: 'k', endpoint: '/api/delete' }), 'INVALID_MESSAGE');
  fails(() => validateConnection({ origin }), 'INVALID_MESSAGE');
  fails(() => validateConnection(Object.create({ origin, key: 'k' })), 'INVALID_MESSAGE');
  fails(() => validateConnection(JSON.parse('{"origin":"https://tracker.example","key":"k","__proto__":{}}')), 'INVALID_MESSAGE');
  fails(() => validateSavedConfig({ ...result.config, key: 'k' }), 'INVALID_MESSAGE');
});

test('keys cannot inject headers and are never silently persisted by validators', () => {
  assert.equal(validateApiKey('key-123._+/='), 'key-123._+/=');
  for (const key of ['', 'a\r\nX-Evil: value', 'has space', 'я', 'a'.repeat(513), null]) {
    fails(() => validateApiKey(key), 'INVALID_KEY');
  }
});

test('only the exact extension options page may configure a connection', () => {
  assert.equal(isOptionsSender({ id: extensionId, url: optionsUrl }, extensionId, optionsUrl), true);
  assert.equal(isOptionsSender({ id: extensionId, url: optionsUrl, frameId: 0, tab: { id: 1 } }, extensionId, optionsUrl), true);
  for (const sender of [
    { id: 'other', url: optionsUrl }, { id: extensionId, url: `${optionsUrl}?external=1` },
    { id: extensionId, url: `${origin}/options.html` }, { id: extensionId, url: optionsUrl, frameId: 3 },
    Object.create({ id: extensionId, url: optionsUrl }), null,
  ]) assert.equal(isOptionsSender(sender, extensionId, optionsUrl), false);
});

test('content requests require the exact origin in both the document and top-level tab', () => {
  assert.equal(isContentSender(contentSender(), extensionId, origin), true);
  const attacks = [
    { id: 'other' }, { frameId: 1 }, { origin: 'null' },
    { url: 'https://tracker.example.evil.test:8443/' },
    { url: 'https://tracker.example/' }, { url: 'http://tracker.example:8443/' },
    { url: 'https://user:pass@tracker.example:8443/' },
    { tab: { id: 12, url: 'https://other.example/' } },
    { tab: { id: -1, url: `${origin}/` } },
    { tab: Object.create({ id: 12, url: `${origin}/` }) },
  ];
  for (const patch of attacks) assert.equal(isContentSender({ ...contentSender(), ...patch }, extensionId, origin), false);
  assert.equal(isContentSender(Object.create(contentSender()), extensionId, origin), false);
  assert.equal(isContentSender(contentSender(), extensionId, null), false);
});

test('preferences accept only bounded display options, never networking or credentials', () => {
  assert.deepEqual(validatePreferences({ theme: 'dark', collapsed: true, autoRefresh: 60, metrics: ['clicks', 'roi'] }),
    { theme: 'dark', collapsed: true, autoRefresh: 60, metrics: ['clicks', 'roi'] });
  assert.deepEqual(validatePreferences({ metrics: [] }), { metrics: [] });
  assert.deepEqual(validatePreferences({}), {});
  for (const input of [
    { origin }, { key: 'secret' }, { endpoint: '/api/delete' }, { autoRefresh: 1 }, { autoRefresh: '60' },
    { collapsed: 'false' }, { theme: '<img>' }, { metrics: ['clicks', 'clicks'] }, { metrics: ['api-key'] },
    { metrics: 'clicks' }, { metrics: new Array(1) }, Object.create({ theme: 'dark' }),
    JSON.parse('{"__proto__":{"theme":"dark"}}'),
  ]) fails(() => validatePreferences(input), 'INVALID_PREFERENCES');
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES), true);
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES.metrics), true);
});

test('comparison and tracker appearance preferences are bounded canonical display data', () => {
  const input={mode:'campaigns',campaignIds:['1','23','456','7890','12345','123456','1234567','12345678'],campaignMetric:'roi',trackerTheme:true};
  const result=validatePreferences(input);
  const {trackerTheme:_legacyTrackerTheme,...display}=input;
  assert.deepEqual(result,display,'The legacy tracker theme flag is accepted but dropped');
  assert.notEqual(result.campaignIds,input.campaignIds,'Validated IDs must be copied');
  assert.deepEqual(validatePreferences({mode:'overview',campaignIds:[],campaignMetric:'clicks',trackerTheme:false}),
    {mode:'overview',campaignIds:[],campaignMetric:'clicks'});
  for(const campaignMetric of ['clicks','leads','costs','revenue','profit','roi']) {
    assert.equal(validatePreferences({campaignMetric}).campaignMetric,campaignMetric);
  }
  assert.deepEqual(validatePreferences({campaignIds:['1000000000000000','9007199254740991']}),
    {campaignIds:['1000000000000000','9007199254740991']},'Catalog-valid safe integer IDs must also be persistable');
  for(const campaignIds of [
    Array.from({length:9},(_,index)=>String(index+1)), ['1','1'], ['1','01'],
    ['0'], ['01'], ['-1'], ['1.0'], ['1e2'], [' 1'], ['1 '], ['+1'], ['١'],
    ['9007199254740992'], ['12345678901234567'], ['../delete'], ['1&api-key=TEST_ONLY'],
    [1], [null], [undefined], new Array(1), '1', null, {},
  ]) fails(()=>validatePreferences({campaignIds}),'INVALID_PREFERENCES');
  for(const patch of [
    {mode:'grid'}, {mode:true}, {mode:null}, {campaignMetric:'cost'}, {campaignMetric:'api-key'},
    {campaignMetric:1}, {campaignMetric:null}, {trackerTheme:'true'}, {trackerTheme:1},
    {trackerTheme:null}, {trackerTheme:{}}, {mode:'campaigns',origin},
  ]) fails(()=>validatePreferences(patch),'INVALID_PREFERENCES');
  let accessed=false;
  const accessor={get trackerTheme(){accessed=true;return true;}};
  fails(()=>validatePreferences(accessor),'INVALID_PREFERENCES');
  assert.equal(accessed,false);
  assert.equal(DEFAULT_PREFERENCES.mode,'overview');
  assert.equal(DEFAULT_PREFERENCES.campaignMetric,'clicks');
  assert.equal(Object.hasOwn(DEFAULT_PREFERENCES,'trackerTheme'),false,'No tracker theme preference remains');
  assert.equal(Object.isFrozen(DEFAULT_PREFERENCES.campaignIds),true);
});

test('only the Binom design remains: stored legacy design fields are accepted and dropped', () => {
  assert.equal(Object.hasOwn(DEFAULT_PREFERENCES,'design'),false);
  assert.equal(DEFAULT_PREFERENCES.dashboardEnabled,true);
  for(const [design,trackerTheme] of [['binom',false],['legacy',true]]) {
    assert.deepEqual(validatePreferences({design}),{});
    assert.deepEqual(validatePreferences({trackerTheme}),{},'The legacy tracker theme flag is dropped');
    assert.deepEqual(validatePreferences({design,trackerTheme}),{});
    for(const dashboardEnabled of [true,false]) {
      assert.deepEqual(validatePreferences({design,dashboardEnabled}),{dashboardEnabled},'A stored legacy design never blocks the other preferences');
    }
    assert.deepEqual(validatePreferences({design,trackerTheme:!trackerTheme}),{},'An inconsistent legacy pair is dropped too and never resets the other preferences');
  }
  assert.deepEqual(validatePreferences({dashboardEnabled:false}),{dashboardEnabled:false});
  for(const patch of [
    {design:'Old design'}, {design:'x'.repeat(17)}, {design:''}, {design:null}, {design:true}, {design:{}},
    {dashboardEnabled:'false'}, {dashboardEnabled:0}, {dashboardEnabled:null}, {dashboardEnabled:{}},
  ]) fails(()=>validatePreferences(patch),'INVALID_PREFERENCES');
  let accessed=false;
  for(const key of ['design','dashboardEnabled']) {
    fails(()=>validatePreferences(Object.defineProperty({},key,{enumerable:true,get(){accessed=true;return true;}})),'INVALID_PREFERENCES');
  }
  assert.equal(accessed,false,'Display validators never evaluate supplied accessors');
});

test('validation never invokes accessor payloads and error responses redact raw errors', () => {
  let accessed = false;
  const payload = { get origin() { accessed = true; return origin; }, key: 'secret' };
  assert.equal(isPlainRecord(payload), false);
  fails(() => validateConnection(payload), 'INVALID_MESSAGE');
  assert.equal(accessed, false);
  const raw = new Error('api-key: TOP_SECRET https://private.example/?key=TOP_SECRET');
  assert.deepEqual(publicError(raw), { code: 'INTERNAL', message: 'Не удалось выполнить действие. Повторите попытку.' });
  assert.equal(JSON.stringify(publicError({ code: 'AUTH', message: raw.message })).includes('TOP_SECRET'), false);
  for (const code of ['REPEATED_PAGE', 'REPORT_LIMIT']) {
    const result = publicError({ code, message: raw.message });
    assert.equal(result.code, code);
    assert.equal(JSON.stringify(result).includes('TOP_SECRET'), false);
  }
  assert.equal(publicError({ code: '__proto__' }).code, 'INTERNAL');
});

test('insight settings and saved selections are bounded display data without request parameters', () => {
  const selection = { id: 'set-1', name: ' Listings ', campaignIds: ['1', '2'], campaignMetric: 'roi',
    datePreset: 'last_7_days', grouping: 'auto', hideBots: true };
  const input = { insightsSections: ['leaders', 'attention', 'heatmap'],
    alertThresholds: { dropPercent: 50, spikePercent: 100, botIncreasePoints: 10, minClicks: 20 }, savedSelections: [selection] };
  const result = validatePreferences(input);
  assert.equal(result.savedSelections[0].name, 'Listings');
  assert.equal(result.savedSelections[0].dateFrom, '');
  assert.notEqual(result.savedSelections[0].campaignIds, selection.campaignIds);
  assert.notEqual(result.alertThresholds, input.alertThresholds);
  assert.equal(validatePreferences({savedSelections:[{...selection,datePreset:'custom_time',dateFrom:'2026-10-01',dateTo:'2026-10-21'}]}).savedSelections[0].dateTo,'2026-10-21');
  for(const patch of [
    {insightsSections:['top','top']}, {insightsSections:['api-key']}, {insightsSections:new Array(1)},
    {alertThresholds:{...input.alertThresholds,minClicks:0}}, {alertThresholds:{...input.alertThresholds,dropPercent:101}},
    {alertThresholds:{...input.alertThresholds,spikePercent:Infinity}}, {alertThresholds:{...input.alertThresholds,url:origin}},
    {savedSelections:Array(21).fill(selection)}, {savedSelections:[selection,selection]}, {savedSelections:new Array(1)},
  ]) fails(()=>validatePreferences(patch),'INVALID_PREFERENCES');
  for(const patch of [
    {id:'../bad'}, {name:' '}, {name:'x'.repeat(61)}, {name:'x\ny'}, {campaignIds:[]}, {campaignIds:['01']},
    {key:'secret'}, {query:{url:origin}}, {campaignMetric:'hiddenProfit'}, {grouping:'hours'},
    {datePreset:'custom_time',dateFrom:'2026-02-30',dateTo:'2026-03-01'},
    {datePreset:'custom_time',dateFrom:'2025-01-01',dateTo:'2026-01-02'},
    {datePreset:'custom_time',dateFrom:'2026-10-21',dateTo:'2026-10-01'},
  ]) fails(()=>validatePreferences({savedSelections:[{...selection,...patch}]}),'INVALID_PREFERENCES');
  let accessed=false;
  fails(()=>validatePreferences({alertThresholds:{get minClicks(){accessed=true;return 20;}}}),'INVALID_PREFERENCES');
  assert.equal(accessed,false);
});

test('worker isolates keys, protects the vault lifecycle, rolls back failures and invalidates stale reads', async () => {
  const localData = {};
  const sessionData = {};
  const accessLevels = [];
  const grants = new Set(['https://tracker.example/*']);
  let registered = [];
  let listener;
  const notices = [];
  let failNext = null;
  let registerHook = null;
  let storageReadHook = null;
  let tabRemoved;
  let installed;
  const injections = [];
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  let openedSettings=0;
  const maybeFail = point => {
    if (failNext === point) { failNext = null; throw new Error('PRIVATE_TEST_FAILURE'); }
  };
  const area = (data, name) => ({
    setAccessLevel: async ({ accessLevel }) => { accessLevels.push([name, accessLevel]); },
    get: async (keys) => {
      if (storageReadHook) await storageReadHook(name);
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys])
        .filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
    },
    set: async (values) => { maybeFail(`${name}.set`); Object.assign(data, structuredClone(values)); },
    remove: async (keys) => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  let networkCalls=0;
  let settingsCalls = 0, settingsStatus = 200, settingsTimezone = 'Asia/Ho_Chi_Minh', settingsHook = null;
  const settingsResponse = () => new Response(JSON.stringify({ timezone: settingsTimezone, email: 'PRIVATE_SETTINGS_EMAIL' }), { status: settingsStatus });
  globalThis.fetch=async(url, options)=>{
    if (url === origin + '/public/api/v1/settings/info') {
      settingsCalls++;
      if (settingsHook) await settingsHook();
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'error');
      assert.ok(options.headers['Api-Key']);
      return settingsResponse();
    }
    networkCalls++;throw new Error('Unexpected network request in security gate test');
  };
  globalThis.chrome = {
    runtime: { id: extensionId, getURL: (path) => `chrome-extension://${extensionId}/${path}`,
      onMessage: { addListener: (fn) => { listener = fn; } }, onInstalled: { addListener: (fn) => { installed = fn; } },
      openOptionsPage: async () => { openedSettings++; } },
    action: { onClicked: { addListener: () => {} } },
    storage: { local: area(localData, 'local'), session: area(sessionData, 'session') },
    permissions: {
      contains: async ({ origins }) => origins.every((item) => grants.has(item)),
      getAll: async () => ({ origins: [...grants] }),
      remove: async ({ origins }) => { origins.forEach((item) => grants.delete(item)); return true; },
    },
    scripting: {
      getRegisteredContentScripts: async () => structuredClone(registered),
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (scripts) => { maybeFail('register'); if (registerHook) await registerHook(); registered = structuredClone(scripts); },
      executeScript: async (details) => { injections.push(structuredClone(details)); return []; },
    },
    tabs: { query: async () => [{ id: 12, url: `${origin}/?page=campaigns` }],
      onRemoved: { addListener: fn => { tabRemoved = fn; } },
      sendMessage: async (_id, message) => { notices.push(structuredClone(message)); } },
  };
  try {
    await import('../src/background.js?security-test');
    // Let the startup registration repair finish before exercising messages.
    await new Promise((resolve) => setImmediate(resolve));
    installed({ reason: 'install' });
    await settle();
    assert.equal(injections.length, 0, 'A fresh install has no connection and injects nothing');
    const send = (message, sender = contentSender()) => new Promise((resolve) => listener(message, sender, resolve));
    const optionsSender = { id: extensionId, url: optionsUrl, frameId: 0 };
    const popupSender = { id: extensionId, url: popupUrl, frameId: 0 };
    assert.equal((await send({ type: 'GET_STATUS' }, popupSender)).data.preferences.language, 'en');
    assert.equal((await send({ type: 'SAVE_PREFERENCES', preferences: { language: 'ru' } }, popupSender)).ok, true, 'A trusted menu can choose a language before connecting');
    assert.equal((await send({ type: 'SAVE_PREFERENCES', preferences: { language: 'fr' } }, popupSender)).error.code, 'INVALID_PREFERENCES');
    assert.equal((await send({ type: 'SAVE_PREFERENCES', preferences: { language: 'en', theme: 'light' } }, popupSender)).error.code, 'NOT_CONNECTED');
    assert.equal((await send({ type: 'SAVE_PREFERENCES', preferences: { language: 'en' } })).error.code, 'NOT_CONNECTED');
    assert.equal(settingsCalls, 0, 'Language changes do not contact Binom');
    const connection = { type: 'CONNECT', origin, campaignsPath: '/?page=campaigns&auth=TEST_ONLY', timezone: 'UTC', key: 'ONLY_IN_SESSION' };
    assert.equal((await send(connection)).error.code, 'ACCESS_DENIED');
    assert.equal((await send({ ...connection, origin: 'https://unapproved.example' }, optionsSender)).error.code, 'PERMISSION_REQUIRED');
    assert.equal(settingsCalls, 0, 'Sender and host permission checks precede settings fetch');
    const connected = await send(connection, optionsSender);
    assert.equal(connected.ok, true);
    assert.equal(connected.data.hasKey, true);
    assert.equal(connected.data.preferences.language, 'ru', 'Connecting preserves the selected interface language');
    assert.equal(connected.data.config.timezone, 'Asia/Ho_Chi_Minh', 'Binom setting wins over legacy CONNECT timezone');
    assert.equal(settingsCalls, 1);
    assert.equal(JSON.stringify([connected, localData, sessionData, notices]).includes('PRIVATE_SETTINGS_EMAIL'), false);
    const beforeSettingsFailure = structuredClone({ local: localData, session: sessionData });
    settingsStatus = 403;
    assert.equal((await send(connection, optionsSender)).error.code, 'FORBIDDEN');
    assert.deepEqual({ local: localData, session: sessionData }, beforeSettingsFailure, 'Denied settings must preserve working connection');
    settingsStatus = 200;
    settingsTimezone = 'invalid/timezone';
    assert.equal((await send(connection, optionsSender)).error.code, 'TIMEZONE_UNAVAILABLE');
    assert.deepEqual({ local: localData, session: sessionData }, beforeSettingsFailure);
    settingsTimezone = 'UTC';
    settingsHook = async () => { grants.clear(); };
    assert.equal((await send(connection, optionsSender)).error.code, 'PERMISSION_REQUIRED');
    assert.deepEqual({ local: localData, session: sessionData }, beforeSettingsFailure, 'Revoked permission cannot commit a fetched setting');
    settingsHook = null;
    grants.add('https://tracker.example/*');
    assert.equal(connected.data.config.campaignsPath,'/?page=campaigns');
    assert.equal(JSON.stringify(localData).includes('TEST_ONLY'),false);
    assert.equal(JSON.stringify(connected).includes('ONLY_IN_SESSION'), false);
    assert.equal(JSON.stringify(localData).includes('ONLY_IN_SESSION'), false);
    assert.equal(typeof sessionData.apiKey.credentialId, 'string');
    assert.equal(sessionData.apiKey.credentialId, localData.credentialId);
    assert.deepEqual(sessionData.apiKey, { origin, key: 'ONLY_IN_SESSION', credentialId: localData.credentialId });
    assert.deepEqual(accessLevels.sort(), [['local', 'TRUSTED_CONTEXTS'], ['session', 'TRUSTED_CONTEXTS']]);
    assert.equal(registered[0].allFrames, false);
    assert.equal(registered[0].world, 'ISOLATED');
    const status = await send({ type: 'GET_STATUS' });
    assert.equal(status.data.config.origin, origin);
    assert.equal(JSON.stringify(status).includes('ONLY_IN_SESSION'), false);
    const popupStatus=await send({type:'GET_STATUS'},popupSender);
    assert.equal(popupStatus.ok,true);
    assert.equal(popupStatus.data.hasKey,true);
    assert.equal(JSON.stringify(popupStatus).includes('ONLY_IN_SESSION'),false,'Popup status must never disclose a credential');
    const preferencesBeforeMigration=structuredClone(localData.preferences);
    for(const trackerTheme of [true,false]) {
      localData.preferences={trackerTheme,campaignIds:['1']};
      const migrated=await send({type:'GET_STATUS'},popupSender);
      assert.equal(['design','trackerTheme'].some(key=>Object.hasOwn(migrated.data.preferences,key)),false,'A stored legacy design choice reads as the only design');
      assert.equal(migrated.data.preferences.dashboardEnabled,true,'Legacy installations keep the dashboard enabled');
      assert.equal(migrated.data.preferences.language,'en','Legacy preferences without language use English');
      assert.deepEqual(migrated.data.preferences.campaignIds,['1']);
      assert.deepEqual(localData.preferences,{trackerTheme,campaignIds:['1']},'Reading legacy preferences does not rewrite storage');
    }
    // A real 0.6.12 install with another design chosen keeps its language, metrics and
    // overview filters; the next save stores the preferences without the legacy fields.
    const legacyQuery={datePreset:'yesterday',groupId:'',sourceId:'',compare:true,hideBots:false,uniqueClicks:false};
    localData.preferences={design:'legacy',trackerTheme:true,language:'ru',metrics:['clicks','revenue'],visibleMetrics:['clicks','leads','revenue'],dashboardQuery:legacyQuery,dashboardEnabled:true};
    const upgraded=(await send({type:'GET_STATUS'},popupSender)).data.preferences;
    assert.deepEqual([upgraded.language,upgraded.metrics,upgraded.visibleMetrics,upgraded.dashboardQuery],['ru',['clicks','revenue'],['clicks','leads','revenue'],legacyQuery],'An install that used another design keeps its other preferences');
    assert.equal(['design','trackerTheme'].some(key=>Object.hasOwn(upgraded,key)),false);
    assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{language:'ru'}},popupSender)).ok,true);
    assert.equal(['design','trackerTheme'].some(key=>Object.hasOwn(localData.preferences,key)),false,'The next save stores no legacy design fields');
    assert.deepEqual([localData.preferences.language,localData.preferences.metrics,localData.preferences.dashboardQuery],['ru',['clicks','revenue'],legacyQuery]);
    if(preferencesBeforeMigration===undefined)delete localData.preferences;
    else localData.preferences=preferencesBeforeMigration;
    assert.equal((await send({type:'OPEN_SETTINGS'},popupSender)).ok,true);
    assert.equal(openedSettings,1);
    for(const sender of [
      {...popupSender,url:`${popupUrl}?external=1`}, {...popupSender,url:`${popupUrl}#external`},
      {...popupSender,url:`${origin}/popup.html`}, {...popupSender,id:'other-extension'},
      {...popupSender,frameId:1}, Object.create(popupSender),
    ]) {
      for(const message of [{type:'GET_STATUS'},{type:'SAVE_PREFERENCES',preferences:{design:'legacy'}},{type:'OPEN_SETTINGS'}]) {
        assert.equal((await send(message,sender)).error.code,'ACCESS_DENIED',`${message.type} requires the exact popup document`);
      }
    }
    for(const message of [connection,{type:'UNLOCK',password:'TEST-ONLY-PASSWORD'},
      {type:'LOCK'},{type:'FORGET_SAVED_KEY'},{type:'DISCONNECT'},
      ...['GET_DASHBOARD','GET_CATALOGS','GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_CAMPAIGN_OVERVIEW','GET_CLICKLOG','GET_INSIGHTS'].map(type=>({type,query:{},campaignIds:['1']})),
    ]) assert.equal((await send(message,popupSender)).error.code,'ACCESS_DENIED',`Popup cannot invoke ${message.type}`);
    assert.equal(openedSettings,1,'Rejected popup lookalikes must not open settings');
    assert.equal((await send({ type: 'GET_STATUS' }, { ...contentSender(), frameId: 9 })).error.code, 'ACCESS_DENIED');
    assert.equal((await send({ type: 'GET_DASHBOARD', query: {} }, { ...contentSender(), url: 'https://evil.example/' })).error.code, 'ACCESS_DENIED');
    for(const type of ['GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_CAMPAIGN_OVERVIEW','GET_CLICKLOG','GET_INSIGHTS']) {
      const message={type,query:{},campaignIds:['1']};
      for(const sender of [
        optionsSender, {...contentSender(),frameId:1}, {...contentSender(),url:'https://evil.example/'},
        {...contentSender(),tab:{id:12,url:'https://evil.example/'}}, {...contentSender(),id:'other-extension'},
      ]) assert.equal((await send(message,sender)).error.code,'ACCESS_DENIED',`${type} must enforce the content-origin boundary`);
    }
    for(const campaignIds of [['../delete'],Array.from({length:9},(_,index)=>String(index+1)),['1','1'],[1]]) {
      assert.equal((await send({type:'GET_CAMPAIGN_CHARTS',query:{},campaignIds})).error.code,'INVALID_QUERY');
    }
    assert.equal((await send({type:'GET_CAMPAIGN_CHARTS',query:{datePreset:'/api/delete'},campaignIds:['1']})).error.code,'INVALID_QUERY');
    for(const sections of [['campaigns','campaigns'],['../delete'],['clicklog'],[null],new Array(1),'all']) {
      assert.equal((await send({type:'GET_INSIGHTS',query:{},sections})).error.code,'INVALID_QUERY');
    }
    for(const campaignIds of [['1','1'],[1],['../delete']]) {
      assert.equal((await send({type:'GET_INSIGHTS',query:{},campaignIds,sections:[]})).error.code,'INVALID_QUERY');
    }
    grants.clear();
    for(const type of ['GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_CAMPAIGN_OVERVIEW','GET_CLICKLOG','GET_INSIGHTS']) {
      assert.equal((await send({type,query:{},campaignIds:['1']})).error.code,'PERMISSION_REQUIRED');
    }
    grants.add('https://tracker.example/*');
    sessionData.apiKey.origin = 'https://other.example';
    assert.equal((await send({ type: 'GET_DASHBOARD', query: {} })).error.code, 'KEY_REQUIRED');
    for(const type of ['GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_CAMPAIGN_OVERVIEW','GET_CLICKLOG','GET_INSIGHTS']) {
      assert.equal((await send({type,query:{},campaignIds:['1']})).error.code,'KEY_REQUIRED');
    }
    assert.equal((await send({ type: 'SAVE_PREFERENCES', preferences: { key: 'leak' } })).error.code, 'INVALID_PREFERENCES');
    assert.equal((await send({ type: 'SAVE_PREFERENCES', preferences: { theme: 'dark' } })).data.preferences.theme, 'dark');
    assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{mode:'campaigns',campaignIds:['1','2'],campaignMetric:'roi'}})).ok,true);
    const appearance=await send({type:'SAVE_PREFERENCES',preferences:{trackerTheme:true,theme:'light'}},optionsSender);
    assert.equal(appearance.ok,true,'Options can save appearance without a session key');
    assert.equal(['design','trackerTheme'].some(key=>Object.hasOwn(appearance.data.preferences,key)),false,'A legacy tracker theme flag is not stored');
    assert.equal(appearance.data.preferences.theme,'light');
    assert.deepEqual(appearance.data.preferences.campaignIds,['1','2'],'Appearance saves must preserve panel selection');
    assert.equal(appearance.data.preferences.mode,'campaigns');
    assert.equal(appearance.data.preferences.campaignMetric,'roi');
    assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{trackerTheme:'true'}},optionsSender)).error.code,'INVALID_PREFERENCES');
    assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{trackerTheme:false}}, {...optionsSender,url:`${optionsUrl}?external=1`})).error.code,'ACCESS_DENIED');
    assert.ok(notices.some(notice=>notice.type==='BINOM_PREFERENCES_CHANGED'));
    for(const design of ['binom','legacy']) {
      const popupAppearance=await send({type:'SAVE_PREFERENCES',preferences:{design}},popupSender);
      assert.equal(popupAppearance.ok,true,'A legacy design value is accepted while the key is unavailable');
      assert.equal(['design','trackerTheme'].some(key=>Object.hasOwn(popupAppearance.data.preferences,key)),false,'The popup does not store it either');
      assert.deepEqual(popupAppearance.data.preferences.campaignIds,['1','2']);
    }
    assert.equal(networkCalls,0,'Rejected reads and display preferences must never touch the network');

    // Exercise the real Web Crypto vault through the same worker boundary used by
    // options. The harness intentionally never passes a secret to a tracker tab.
    const vaultKey = 'ENCRYPTED_API_KEY_ONLY_IN_SESSION';
    const vaultPassword = 'A test passphrase with 12+ characters';
    const encryptedConnection = { ...connection, key: vaultKey, storageMode: 'encrypted', password: vaultPassword };
    const forbiddenSenders = [contentSender(), popupSender, { ...optionsSender, frameId: 1 },
      { ...optionsSender, id: 'other-extension' }, { ...optionsSender, url: `${optionsUrl}?external=1` },
      { ...optionsSender, url: `${origin}/options.html` }];
    for (const message of [encryptedConnection, { type: 'UNLOCK', password: vaultPassword },
      { type: 'LOCK' }, { type: 'FORGET_SAVED_KEY' }]) {
      for (const sender of forbiddenSenders) assert.equal((await send(message, sender)).error.code, 'ACCESS_DENIED');
    }
    const encrypted = await send(encryptedConnection, optionsSender);
    assert.equal(encrypted.ok, true);
    assert.equal(encrypted.data.keyStorage, 'encrypted');
    assert.equal(encrypted.data.hasSavedKey, true);
    assert.equal(encrypted.data.hasKey, true);
    assert.equal(encrypted.data.locked, false);
    assert.equal(sessionData.apiKey.key, vaultKey);
    assert.equal(localData.keyVault.credentialId, localData.credentialId);
    assert.equal(sessionData.apiKey.credentialId, localData.credentialId);
    assert.equal(localData.keyVault.origin, origin);
    for (const value of [localData, encrypted, notices]) {
      assert.equal(JSON.stringify(value).includes(vaultKey), false);
      assert.equal(JSON.stringify(value).includes(vaultPassword), false);
    }
    const beforeDashboardToggle={config:structuredClone(localData.config),vault:structuredClone(localData.keyVault),
      credentialId:localData.credentialId,session:structuredClone(sessionData),registered:structuredClone(registered),grants:[...grants]};
    for(const dashboardEnabled of [false,true]) {
      const toggled=await send({type:'SAVE_PREFERENCES',preferences:{dashboardEnabled}},popupSender);
      assert.equal(toggled.ok,true);
      assert.equal(toggled.data.preferences.dashboardEnabled,dashboardEnabled);
      const toggleStatus=await send({type:'GET_STATUS'},popupSender);
      assert.equal(toggleStatus.data.hasKey,true);
      assert.equal(toggleStatus.data.hasSavedKey,true);
      assert.equal(Object.hasOwn(toggled.data.preferences,'design'),false);
      assert.deepEqual({config:localData.config,vault:localData.keyVault,credentialId:localData.credentialId,
        session:sessionData,registered,grants:[...grants]},beforeDashboardToggle,'Dashboard visibility must not disconnect or lock the saved connection');
    }
    await send({ type: 'SAVE_PREFERENCES', preferences: {
      trackerTheme: true, mode: 'campaigns', campaignIds: ['1', '2'], campaignMetric: 'roi',
      savedSelections: [{ id: 'saved-one', name: 'Saved campaigns', campaignIds: ['1', '2'],
        campaignMetric: 'clicks', datePreset: 'last_7_days', grouping: 'auto', hideBots: false }],
    } }, optionsSender);
    const savedPreferences = structuredClone(localData.preferences);
    const encryptedSnapshot = structuredClone(localData.keyVault);
    const locked = await send({ type: 'LOCK' }, optionsSender);
    assert.equal(locked.ok, true);
    assert.equal(locked.data.configured, true);
    assert.equal(locked.data.hasKey, false);
    assert.equal(locked.data.hasSavedKey, true);
    assert.equal(locked.data.locked, true);
    assert.deepEqual(sessionData, {});
    assert.deepEqual(localData.preferences, savedPreferences);
    assert.deepEqual(localData.keyVault, encryptedSnapshot);
    assert.equal((await send({ type: 'GET_DASHBOARD', query: {} })).error.code, 'KEY_REQUIRED');

    const callsBeforeWrongPassword = settingsCalls;
    const wrongPassword = await send({ type: 'UNLOCK', password: 'A different wrong passphrase' }, optionsSender);
    assert.equal(wrongPassword.error.code, 'VAULT_UNLOCK_FAILED');
    assert.equal(settingsCalls, callsBeforeWrongPassword, 'Failed decryption never sends settings request');
    assert.deepEqual(localData.keyVault, encryptedSnapshot, 'A failed unlock must never overwrite the saved ciphertext');
    assert.deepEqual(localData.preferences, savedPreferences);
    assert.deepEqual(sessionData, {});
    assert.equal((await send({ type: 'UNLOCK', password: 'short' }, optionsSender)).error.code, 'VAULT_PASSWORD');
    grants.clear();
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).error.code, 'PERMISSION_REQUIRED');
    assert.deepEqual(sessionData, {});
    grants.add('https://tracker.example/*');
    const beforeDeniedUnlock = structuredClone(localData);
    settingsStatus = 403;
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).error.code, 'FORBIDDEN');
    assert.deepEqual(localData, beforeDeniedUnlock);
    assert.deepEqual(sessionData, {}, 'No stale-timezone unlock fallback');
    settingsStatus = 200;
    settingsTimezone = 'invalid/timezone';
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).error.code, 'TIMEZONE_UNAVAILABLE');
    assert.deepEqual(localData, beforeDeniedUnlock);
    assert.deepEqual(sessionData, {});
    settingsTimezone = 'Europe/Berlin';
    settingsHook = async () => { grants.clear(); };
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).error.code, 'PERMISSION_REQUIRED');
    assert.deepEqual(localData, beforeDeniedUnlock);
    assert.deepEqual(sessionData, {});
    settingsHook = null;
    grants.add('https://tracker.example/*');
    for (const failure of ['local.set', 'session.set']) {
      failNext = failure;
      assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).error.code, 'INTERNAL');
      assert.deepEqual(localData, beforeDeniedUnlock, 'Failed unlock storage preserves old config/vault');
      assert.deepEqual(sessionData, {});
    }
    const pendingUnlock = send({ type: 'UNLOCK', password: vaultPassword }, optionsSender);
    const queuedLock = send({ type: 'LOCK' }, optionsSender);
    assert.equal((await pendingUnlock).ok, true);
    assert.equal((await queuedLock).data.hasKey, false, 'LOCK must serialize after an already-running unlock');
    assert.deepEqual(sessionData, {});
    const unlocked = await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender);
    assert.equal(unlocked.ok, true);
    assert.equal(unlocked.data.hasKey, true);
    assert.equal(unlocked.data.locked, false);
    assert.equal(unlocked.data.config.timezone, 'Europe/Berlin', 'Unlock re-reads changed Binom timezone');
    assert.deepEqual(localData.keyVault, encryptedSnapshot);
    assert.equal(JSON.stringify([unlocked, localData, sessionData, notices]).includes('PRIVATE_SETTINGS_EMAIL'), false);
    settingsTimezone = 'UTC';
    assert.deepEqual(localData.preferences, savedPreferences);
    assert.equal(sessionData.apiKey.key, vaultKey);
    assert.equal(sessionData.apiKey.credentialId, localData.credentialId);
    const contentStatus = await send({ type: 'GET_STATUS' });
    for (const value of [contentStatus, unlocked, notices]) {
      assert.equal(JSON.stringify(value).includes(vaultKey), false);
      assert.equal(JSON.stringify(value).includes(vaultPassword), false);
      assert.equal(JSON.stringify(value).includes(encryptedSnapshot.ciphertext), false);
    }

    const beforeOpenUnlock = structuredClone({ local: localData, session: sessionData });
    for (const failure of ['local.set', 'session.set']) {
      failNext = failure;
      assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).error.code, 'INTERNAL');
      assert.deepEqual({ local: localData, session: sessionData }, beforeOpenUnlock, 'Unlock rollback preserves a previously working session and its timezone together');
    }

    // Replacing a connection is transactional, including registration/storage
    // failures after an earlier write has succeeded.
    for (const failure of ['session.set', 'local.set', 'register']) {
      const before = { local: structuredClone(localData), session: structuredClone(sessionData), scripts: structuredClone(registered) };
      failNext = failure;
      const rejected = await send({ ...encryptedConnection, key: 'REPLACEMENT_MUST_ROLL_BACK' }, optionsSender);
      assert.equal(rejected.ok, false, failure);
      assert.equal(rejected.error.code, 'INTERNAL', failure);
      assert.equal(JSON.stringify(rejected).includes('PRIVATE_TEST_FAILURE'), false);
      assert.deepEqual(localData, before.local, `${failure}: local state rollback`);
      assert.deepEqual(sessionData, before.session, `${failure}: session rollback`);
      assert.deepEqual(registered, before.scripts, `${failure}: content registration rollback`);
      assert.equal((await send({ type: 'GET_STATUS' }, optionsSender)).data.hasKey, true);
    }
    for (const invalid of [
      { ...encryptedConnection, password: 'short' }, { ...encryptedConnection, password: undefined },
      { ...encryptedConnection, storageMode: 'plain' }, { ...encryptedConnection, origin: 'http://insecure.example' },
      { ...encryptedConnection, key: 'header\ninjection' },
    ]) {
      const before = { local: structuredClone(localData), session: structuredClone(sessionData) };
      assert.equal((await send(invalid, optionsSender)).ok, false);
      assert.deepEqual(localData, before.local);
      assert.deepEqual(sessionData, before.session);
    }

    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    const reportMessage = { type: 'GET_DASHBOARD', query: {
      datePreset: 'custom_time', dateFrom: '2020-01-01', dateTo: '2020-01-01', timezone: 'UTC',
    } };
    const fakeReport = () => new Response(JSON.stringify({ stats: Array.from({ length: 24 }, (_, hour) => ({
      date: `${String(hour).padStart(2, '0')}:00`, clicks: 1, leads: 0, costs: 0, revenue: 0, profit: 0, roi: null,
    })) }), { status: 200 });
    const noNetwork = globalThis.fetch;
    const documentSender = documentId => ({ ...contentSender(), documentId });

    // Reload announces a new top-level document before starting its reports. The
    // previous insights pipeline must stop even though its first fetch resolved.
    {
      const started = deferred(), release = deferred();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) {
          started.resolve(); await release.promise;
          return new Response(JSON.stringify([{ id: 1, name: 'First page campaign' }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      };
      try {
        const pending = send({ type: 'GET_INSIGHTS', query: reportMessage.query, sections: ['campaigns'] }, documentSender('before-reload'));
        await started.promise;
        const status = await send({ type: 'GET_STATUS' }, documentSender('after-reload'));
        assert.equal(status.ok, true);
        assert.equal(JSON.stringify(status).includes('after-reload'), false, 'Document tracking stays internal');
        release.resolve();
        assert.equal((await pending).error?.code, 'SETTINGS_CHANGED');
        assert.equal(fetchCount, 1, 'A new document must prevent old insights catalog/report pagination');
      } finally { release.resolve(); globalThis.fetch = noNetwork; }
    }

    // Local preferences may already have been read while the session read is
    // still pending. Disabling must invalidate this stale enabled snapshot too.
    {
      const started=deferred(),release=deferred();
      let fetchCount=0;
      storageReadHook=async areaName=>{
        if(areaName!=='session')return;
        storageReadHook=null;started.resolve();await release.promise;
      };
      globalThis.fetch=async()=>{fetchCount++;return fakeReport();};
      try {
        const pending=send(reportMessage,documentSender('disable-during-storage-read'));
        await started.promise;
        assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{dashboardEnabled:false}},popupSender)).ok,true);
        release.resolve();
        assert.equal((await pending).error?.code,'SETTINGS_CHANGED');
        assert.equal(fetchCount,0,'A stale enabled snapshot must not start a request after disabling');
      } finally {
        release.resolve();storageReadHook=null;globalThis.fetch=noNetwork;
        await send({type:'SAVE_PREFERENCES',preferences:{dashboardEnabled:true}},popupSender);
      }
    }

    // Turning the dashboard off must invalidate both final report delivery and
    // catalog pagination, including a quick off/on cycle in the same document.
    for(const message of [reportMessage,{type:'GET_CAMPAIGNS'}]) {
      const started=deferred(),release=deferred();
      let fetchCount=0;
      globalThis.fetch=async()=>{
        fetchCount++;
        if(fetchCount===1){started.resolve();await release.promise;}
        if(message.type==='GET_CAMPAIGNS')return new Response(JSON.stringify(fetchCount===1?[{id:1,name:'Obsolete campaign page'}]:[]),{status:200});
        return fakeReport();
      };
      try {
        const sender=documentSender(`toggle-${message.type}`);
        const pending=send(message,sender);
        await started.promise;
        assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{dashboardEnabled:false}},popupSender)).ok,true);
        for(const type of ['GET_DASHBOARD','GET_CATALOGS','GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_CAMPAIGN_OVERVIEW','GET_CLICKLOG','GET_INSIGHTS']) {
          assert.equal((await send({type,query:reportMessage.query,campaignIds:['1']},sender)).error?.code,'DASHBOARD_DISABLED',`${type} must not fetch while the dashboard is disabled`);
        }
        assert.equal(fetchCount,1,'Disabled requests never reach the server');
        assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{dashboardEnabled:true}},popupSender)).ok,true);
        assert.equal((await send({type:'GET_STATUS'},sender)).ok,true);
        release.resolve();
        assert.equal((await pending).error?.code,'SETTINGS_CHANGED','Enabling again must not revive a previous panel request');
        assert.equal(fetchCount,1,'An obsolete catalog must not dispatch another page');
        assert.equal((await send(message,sender)).ok,true,'The newly enabled panel can issue fresh requests');
      } finally {
        release.resolve();globalThis.fetch=noNetwork;
        await send({type:'SAVE_PREFERENCES',preferences:{dashboardEnabled:true}},popupSender);
      }
    }

    // New filters supersede the same kind of read; finishing the old request
    // must not remove the newer request's still-active token.
    {
      const oldStarted = deferred(), newStarted = deferred();
      const releaseOld = deferred(), releaseNew = deferred();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) {
          oldStarted.resolve(); await releaseOld.promise;
          return new Response(JSON.stringify([{ id: 1, name: 'Obsolete campaign page' }]), { status: 200 });
        }
        if (fetchCount === 2) { newStarted.resolve(); await releaseNew.promise; }
        return new Response('[]', { status: 200 });
      };
      try {
        const sender = documentSender('same-kind-document');
        const oldRead = send({ type: 'GET_CAMPAIGNS' }, sender);
        await oldStarted.promise;
        const newRead = send({ type: 'GET_CAMPAIGNS' }, sender);
        await newStarted.promise;
        releaseOld.resolve();
        assert.equal((await oldRead).error?.code, 'SETTINGS_CHANGED');
        assert.equal(fetchCount, 2, 'The superseded read must not dispatch page two');
        releaseNew.resolve();
        assert.equal((await newRead).ok, true, 'Old cleanup must preserve the replacement token');
      } finally { releaseOld.resolve(); releaseNew.resolve(); globalThis.fetch = noNetwork; }
    }

    // Message order, not storage completion order, determines the latest request.
    // Keep that ordering even after the newer response has already been delivered.
    {
      const started = deferred(), release = deferred();
      let fetchCount = 0;
      storageReadHook = async areaName => {
        if (areaName !== 'local') return;
        storageReadHook = null;
        started.resolve(); await release.promise;
      };
      globalThis.fetch = async () => { fetchCount++; return fakeReport(); };
      try {
        const sender = documentSender('storage-order-document');
        const oldRead = send(reportMessage, sender);
        await started.promise;
        assert.equal((await send(reportMessage, sender)).ok, true);
        release.resolve();
        assert.equal((await oldRead).error?.code, 'SETTINGS_CHANGED');
        assert.equal(fetchCount, 1, 'An older handler must not start after its newer replacement has finished');
      } finally { release.resolve(); storageReadHook = null; globalThis.fetch = noNetwork; }
    }

    // Other widgets/tabs and status refreshes must continue independently. Only
    // an authorised top-level document may invalidate a tab's existing pipeline.
    {
      const started = deferred(), release = deferred();
      let fetchCount = 0;
      globalThis.fetch = async url => {
        fetchCount++;
        if (fetchCount === 1) { started.resolve(); await release.promise; return fakeReport(); }
        return url.includes('/campaign/list/filtered') ? new Response('[]', { status: 200 }) : fakeReport();
      };
      try {
        const sender = documentSender('independent-document');
        const pending = send(reportMessage, sender);
        await started.promise;
        assert.equal((await send({ type: 'GET_STATUS' }, sender)).ok, true);
        assert.equal((await send({ type: 'GET_STATUS' }, optionsSender)).ok, true);
        for (const type of ['GET_STATUS', 'GET_DASHBOARD']) {
          const denied = await send({ ...reportMessage, type }, { ...sender, documentId: 'untrusted-document', url: 'https://evil.example/' });
          assert.equal(denied.error?.code, 'ACCESS_DENIED');
        }
        assert.equal((await send({ type: 'GET_CAMPAIGNS' }, sender)).ok, true);
        const otherTab = { ...documentSender('other-tab-document'), tab: { ...sender.tab, id: 13 } };
        assert.equal((await send(reportMessage, otherTab)).ok, true);
        release.resolve();
        assert.equal((await pending).ok, true);
        assert.equal(fetchCount, 3);
      } finally { release.resolve(); globalThis.fetch = noNetwork; }
    }

    // Closing a tab discards its tracking record and invalidates any final reply.
    {
      const started = deferred(), release = deferred();
      globalThis.fetch = async () => { started.resolve(); await release.promise; return fakeReport(); };
      try {
        const pending = send(reportMessage, documentSender('closed-document'));
        await started.promise;
        tabRemoved(12);
        release.resolve();
        assert.equal((await pending).error?.code, 'SETTINGS_CHANGED');
      } finally { release.resolve(); globalThis.fetch = noNetwork; }
    }

    // Locking invalidates a report already in flight, so the page cannot redraw
    // old statistics after the credential has been removed.
    {
      const started = deferred(), release = deferred();
      globalThis.fetch = async () => { started.resolve(); await release.promise; return fakeReport(); };
      try {
        const pending = send(reportMessage);
        await started.promise;
        assert.equal((await send({ type: 'LOCK' }, optionsSender)).ok, true);
        release.resolve();
        assert.equal((await pending).error.code, 'SETTINGS_CHANGED');
        assert.deepEqual(sessionData, {});
        globalThis.fetch = noNetwork;
        assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).ok, true);
      } finally { release.resolve(); globalThis.fetch = noNetwork; }
    }
    // Capturing a key at the beginning of a paginated operation must not allow
    // subsequent pages to reuse it after the user has locked the extension.
    {
      const started = deferred(), release = deferred();
      let fetchCount = 0;
      globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount === 1) {
          started.resolve();
          await release.promise;
          return new Response(JSON.stringify([{ id: 1, name: 'First page campaign' }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      };
      try {
        const pending = send({ type: 'GET_CAMPAIGNS' });
        await started.promise;
        assert.equal((await send({ type: 'LOCK' }, optionsSender)).ok, true);
        release.resolve();
        const response = await pending;
        assert.equal(response.ok, false);
        assert.ok(['NETWORK', 'SETTINGS_CHANGED'].includes(response.error.code));
        assert.equal(fetchCount, 1, 'Pagination must not dispatch the captured key again after LOCK');
        assert.deepEqual(sessionData, {});
        globalThis.fetch = noNetwork;
        assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).ok, true);
      } finally { release.resolve(); globalThis.fetch = noNetwork; }
    }
    // No new read may start during the provisional replacement window. An old
    // in-flight report must also remain invalid after rollback restores its key.
    {
      const registrationStarted = deferred(), rejectRegistration = deferred();
      const reportStarted = deferred(), releaseReport = deferred();
      const before = { local: structuredClone(localData), session: structuredClone(sessionData) };
      let fetchCount = 0;
      registerHook = async () => {
        registerHook = null;
        registrationStarted.resolve();
        await rejectRegistration.promise;
        throw new Error('PRIVATE_REGISTRATION_FAILURE');
      };
      globalThis.fetch = async (_url, options) => {
        if (_url.endsWith('/public/api/v1/settings/info')) {
          assert.equal(options.headers['Api-Key'], 'TRANSIENT_REPLACEMENT_KEY');
          return settingsResponse();
        }
        fetchCount++;
        assert.equal(options.headers['Api-Key'], vaultKey);
        reportStarted.resolve(); await releaseReport.promise; return fakeReport();
      };
      try {
        const pending = send(reportMessage);
        await reportStarted.promise;
        const connecting = send({ ...encryptedConnection, key: 'TRANSIENT_REPLACEMENT_KEY' }, optionsSender);
        await registrationStarted.promise;
        const provisional = await send(reportMessage);
        assert.equal(provisional.error?.code, 'SETTINGS_CHANGED', 'Reads must be blocked during a provisional connection');
        assert.equal(fetchCount, 1, 'The temporary key must never reach report fetch');
        rejectRegistration.resolve();
        assert.equal((await connecting).error.code, 'INTERNAL');
        assert.deepEqual(localData, before.local);
        assert.deepEqual(sessionData, before.session);
        releaseReport.resolve();
        assert.equal((await pending).error?.code, 'SETTINGS_CHANGED', 'An old report must not survive connection replacement and rollback');
      } finally {
        rejectRegistration.resolve(); releaseReport.resolve(); registerHook = null; globalThis.fetch = noNetwork;
      }
    }

    // A restart retains only ciphertext. An otherwise valid old session key from
    // the same origin cannot match a new connection's credential identity.
    const priorSession = structuredClone(sessionData.apiKey);
    const changed = await send({ ...encryptedConnection, key: 'NEW_CREDENTIAL_ID_KEY' }, optionsSender);
    assert.equal(changed.ok, true);
    assert.notEqual(localData.credentialId, priorSession.credentialId);
    const currentSession = structuredClone(sessionData.apiKey);
    sessionData.apiKey = priorSession;
    assert.equal((await send({ type: 'GET_STATUS' }, optionsSender)).data.hasKey, false);
    assert.equal((await send({ type: 'GET_DASHBOARD', query: {} })).error.code, 'KEY_REQUIRED');
    sessionData.apiKey = currentSession;
    const beforeRestart = structuredClone(localData);
    delete sessionData.apiKey;
    const injectionsBeforeRestart = injections.length;
    await import('../src/background.js?security-vault-restart');
    await settle();
    // An extension update orphans open tabs' content scripts. Only an
    // install/update event re-injects, into the open tracker tab's top frame; a routine
    // service-worker start does not.
    assert.equal(injections.length, injectionsBeforeRestart, 'A service-worker start alone injects nothing');
    const injectionsBeforeUpdate = injections.length;
    installed({ reason: 'chrome_update' });
    await settle();
    assert.equal(injections.length, injectionsBeforeUpdate, 'A browser update does not inject scripts');
    // A copy up to 0.6.12 cannot step aside; it asks for a page reload itself.
    installed({ reason: 'update', previousVersion: '0.6.12' });
    await settle();
    assert.equal(injections.length, injectionsBeforeUpdate, 'An update from 0.6.12 leaves the open tab to its own reload prompt');
    installed({ reason: 'update', previousVersion: '0.6.13' });
    await settle();
    assert.deepEqual(injections.slice(injectionsBeforeUpdate), [{ target: { tabId: 12, frameIds: [0] }, files: ['content.js'], world: 'ISOLATED' }], 'An extension update injects a fresh content script into the open tracker tab');
    assert.deepEqual(sessionData, {}, 'Re-injection does not restore a session key');
    const restarted = await send({ type: 'GET_STATUS' }, optionsSender);
    assert.equal(restarted.data.hasKey, false);
    assert.equal(restarted.data.hasSavedKey, true);
    assert.equal(restarted.data.locked, true);
    assert.deepEqual(localData, beforeRestart);
    assert.deepEqual(sessionData, {});
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).data.hasKey, true);
    assert.equal(sessionData.apiKey.key, 'NEW_CREDENTIAL_ID_KEY');

    // Saved envelopes must remain bound to their exact HTTPS origin and current
    // credential ID, even if persistent storage was damaged or replaced.
    const validVault = structuredClone(localData.keyVault);
    await send({ type: 'LOCK' }, optionsSender);
    localData.keyVault.origin = 'https://other.example';
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).ok, false);
    assert.deepEqual(sessionData, {});
    localData.keyVault = structuredClone(validVault);
    localData.keyVault.credentialId = 'substituted-credential';
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).ok, false);
    assert.deepEqual(sessionData, {});
    localData.keyVault = structuredClone(validVault);
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).ok, true);

    const beforeForget = { config: structuredClone(localData.config), preferences: structuredClone(localData.preferences) };
    const forgotten = await send({ type: 'FORGET_SAVED_KEY' }, optionsSender);
    assert.equal(forgotten.ok, true);
    assert.equal(forgotten.data.configured, true);
    assert.equal(forgotten.data.hasKey, false);
    assert.equal(forgotten.data.hasSavedKey, false);
    assert.equal(localData.keyVault, undefined);
    assert.deepEqual(sessionData, {});
    assert.deepEqual(localData.config, beforeForget.config);
    assert.deepEqual(localData.preferences, beforeForget.preferences);
    assert.equal((await send({ type: 'UNLOCK', password: vaultPassword }, optionsSender)).ok, false);
    const sessionOnly = await send({ ...connection, storageMode: 'session' }, optionsSender);
    assert.equal(sessionOnly.ok, true);
    assert.equal(sessionOnly.data.keyStorage, 'session');
    assert.equal(sessionOnly.data.hasSavedKey, false);
    assert.equal(localData.keyVault, undefined);
    assert.equal((await send(encryptedConnection, optionsSender)).ok, true, 'Restore a vault to verify DISCONNECT deletes it too');
    assert.equal(networkCalls, 0, 'Connection lifecycle sends only fixed settings reads, never reports or arbitrary routes');
    assert.ok(settingsCalls > 1, 'Connect/unlock read Binom timezone');
    assert.equal((await send({ type: 'DISCONNECT' })).error.code, 'ACCESS_DENIED');
    const disconnected = await send({ type: 'DISCONNECT' }, optionsSender);
    assert.equal(disconnected.data.configured, false);
    assert.deepEqual(sessionData, {});
    assert.deepEqual(localData, { preferences: { language: 'ru' } }, 'Disconnect retains only the interface language');
    assert.equal(registered.length, 0);
    assert.equal(grants.size, 0);
    assert.ok(notices.some((notice) => notice.type === 'BINOM_CONFIG_CHANGED' && notice.configured === false));
    assert.equal(JSON.stringify(notices).includes('ONLY_IN_SESSION'), false);
    for(const type of ['GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_CAMPAIGN_OVERVIEW','GET_CLICKLOG','GET_INSIGHTS']) {
      assert.equal((await send({type,query:{},campaignIds:['1']})).error.code,'NOT_CONNECTED');
    }
    assert.equal((await send({type:'SAVE_PREFERENCES',preferences:{trackerTheme:true}},optionsSender)).error.code,'NOT_CONNECTED');
  } finally {
    globalThis.fetch=previousFetch;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});


test('dashboard card and clicklog preferences admit only supported bounded fields',()=>{
  const patch={visibleMetrics:['cr','epc','cpc','bots'],overviewCampaignId:'12',campaignMetric:'epc',clicklogColumns:['click_time','ip','country','user_agent'],clicklogPageSize:25};
  assert.deepEqual(validatePreferences(patch),patch);
  for(const invalid of [{visibleMetrics:[]},{visibleMetrics:['uc']},{visibleMetrics:['cr','cr']},{visibleMetrics:new Array(1)},{overviewCampaignId:'../1'},{overviewCampaignId:'01'},{clicklogColumns:new Array(1)},{clicklogColumns:['unknown_geo']},{clicklogPageSize:200},{rows:[{ip:'192.0.2.1'}]}])assert.throws(()=>validatePreferences(invalid),{code:'INVALID_PREFERENCES'});
});

// The overview period, filters and checkboxes are kept between page loads, as
// exact fields only; an unfinished custom range may be stored as typed.
test('stored Dashboard filters accept only the exact period, filter and checkbox fields', () => {
  const base = { datePreset: 'yesterday', groupId: '', sourceId: '', compare: false, hideBots: true, uniqueClicks: false };
  assert.deepEqual(validatePreferences({ dashboardQuery: base }).dashboardQuery, base);
  const group = '0AD80269-87B7-43F5-A2AF-A53090148E21';
  assert.equal(validatePreferences({ dashboardQuery: { ...base, groupId: group, sourceId: '12' } }).dashboardQuery.groupId, group, 'The catalog identity is kept as Binom sent it');
  for (const custom of [{ dateFrom: '2026-10-01', dateTo: '2026-10-14' }, { dateFrom: '', dateTo: '2026-10-14' }, { dateFrom: '2026-10-20', dateTo: '2026-10-01' }]) {
    assert.deepEqual(validatePreferences({ dashboardQuery: { ...base, datePreset: 'custom_time', ...custom } }).dashboardQuery, { ...base, datePreset: 'custom_time', ...custom });
  }
  const invalid = [
    null, [], { ...base, datePreset: 'last_90_days' }, { ...base, extra: 1 }, { ...base, timezone: 'UTC' }, { ...base, campaignId: '1' },
    { ...base, groupId: 'not-a-uuid' }, { ...base, sourceId: '0' }, { ...base, sourceId: 12 }, { ...base, hideBots: 'true' }, { ...base, compare: undefined },
    { ...base, dateFrom: '2026-10-01', dateTo: '2026-10-02' }, { ...base, datePreset: 'custom_time', dateFrom: '2026-02-30', dateTo: '2026-03-01' },
    { ...base, datePreset: 'custom_time', dateFrom: '2026-10-01' }, { ...base, datePreset: 'custom_time', dateFrom: '01.10.2026', dateTo: '2026-10-02' },
  ];
  for (const dashboardQuery of invalid) assert.throws(() => validatePreferences({ dashboardQuery }), { code: 'INVALID_PREFERENCES' }, JSON.stringify(dashboardQuery));
});
