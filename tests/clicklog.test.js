import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchClicklog, normalizeClicklog, validateClicklogPage } from '../src/clicklog-api.js';
import { validateClicklogPreferences, DEFAULT_CLICKLOG_COLUMNS, CLICKLOG_COLUMNS } from '../src/clicklog-schema.js';
import { setLanguage } from '../src/i18n.js';
const key='TEST-ONLY-CLICKLOG-KEY';
const now=new Date('2026-10-22T12:34:56Z');
const row=(id,time='2026-10-22 12:00:00',extra={})=>({id,click_time:time,campaign_id:'1',campaign:'Synthetic campaign',ip:'192.0.2.1',...extra});
const payload=(rows=[row('100')],info={})=>({rows,pageInfo:{from:'100',to:'1',direction:'next',sorting:'desc',hasNextPage:false,hasPrevPage:false,limit:50,...info}});
const options={origin:'https://tracker.example:8443',key,query:{datePreset:'today',timezone:'UTC'},now};
const call=(data,extra={})=>fetchClicklog({...options,fetchImpl:async()=>new Response(JSON.stringify(data)),...extra});

test('clicklog uses one fixed credential-isolated read endpoint and only documented parameters',async()=>{
  let request;
  const data=await fetchClicklog({...options,campaignIds:['1','2'],query:{...options.query,groupId:'00112233-4455-6677-8899-aabbccddeeff',sourceId:'7',hideBots:true,status:'deleted',compare:true,path:'/mutate',url:'https://evil.example'},fetchImpl:async(url,init)=>{request={url:new URL(url),init};return new Response(JSON.stringify(payload([row('100',undefined,{is_bot:'0'})])));}});
  assert.equal(request.url.origin,options.origin);assert.equal(request.url.pathname,'/public/api/v1/clicklog');
  assert.deepEqual(Object.keys(request.init.headers).sort(),['Accept','Api-Key']);assert.equal(request.init.headers['Api-Key'],key);
  for(const [name,value] of Object.entries({method:'GET',credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer'}))assert.equal(request.init[name],value);
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.url.searchParams.get('datePreset'),'custom_time');assert.equal(request.url.searchParams.get('dateFrom'),'2026-10-22 00:00:00');assert.equal(request.url.searchParams.get('dateTo'),'2026-10-22 12:34:56');
  assert.equal(request.url.searchParams.get('limit'),'50');assert.equal(request.url.searchParams.get('sortType'),'desc');
  assert.deepEqual(request.url.searchParams.getAll('campaignIds[]'),['1','2']);assert.deepEqual(request.url.searchParams.getAll('groupIds[]'),['00112233-4455-6677-8899-aabbccddeeff']);
  for(const name of ['cursor','from','to','direction','sourceId','trafficSourceId','hideBots','filter','status','offset','sortColumn','path','url'])assert.equal(request.url.searchParams.has(name),false);
  assert.equal(JSON.stringify(data).includes(key),false);
});
test('Exclude bots hides clicks Binom marked as bots and pages by the unfiltered edges',async()=>{
  const urls=[];
  const rows=[row('100','2026-10-22 12:00:00',{is_bot:'1'}),row('99','2026-10-22 11:00:00',{is_bot:'0'}),row('98','2026-10-22 10:00:00',{is_bot:true}),
    row('97','2026-10-22 09:00:00',{is_bot:'false'}),row('96','2026-10-22 08:00:00',{is_bot:1})];
  const fetchImpl=async value=>{urls.push(new URL(value));return new Response(JSON.stringify(payload(rows)));};
  const filtered=await call(null,{query:{...options.query,hideBots:true},fetchImpl});
  assert.deepEqual(filtered.rows.map(r=>r.id),['99','97']);
  assert.deepEqual(filtered.edges,{first:{id:'100',click_time:'2026-10-22 12:00:00'},last:{id:'96',click_time:'2026-10-22 08:00:00'}},
    'Paging continues from the unfiltered page edges, not from the shown rows');
  const all=await call(null,{fetchImpl});
  assert.equal(all.rows.length,5,'Without the checkbox bots stay visible');
  assert.deepEqual(all.edges,filtered.edges);
  // A server-side "is_bot = 0" condition timed out on a real tracker: nothing extra is ever sent.
  assert.ok(urls.every(url=>!url.searchParams.has('filter')&&!url.searchParams.has('hideBots')));
});
test('Without Binom bot marks the click log says the filter cannot be applied',async()=>{
  const hideBots={query:{...options.query,hideBots:true}};
  await assert.rejects(call(payload([row('100'),row('99','2026-10-22 11:00:00')]),hideBots),{code:'BOT_FILTER'});
  // Only some clicks carry the mark: an unknown mark is not a bot.
  const mixed=await call(payload([row('100',undefined,{is_bot:'0'}),row('99','2026-10-22 11:00:00')]),hideBots);
  assert.deepEqual(mixed.rows.map(r=>r.id),['100','99']);
  // An empty page has nothing to filter.
  assert.deepEqual((await call({rows:[],pageInfo:[]},hideBots)).rows,[]);
  // Without the checkbox missing marks change nothing.
  assert.equal((await call(payload([row('100')]))).rows.length,1);
});
test('cursor navigation keeps server cursor tokens and bounded page sizes',async()=>{
  let url;
  await call(payload([row('99')]),{page:{limit:25,cursor:'100',direction:'next',from:'100',to:'1'},fetchImpl:async value=>{url=new URL(value);return new Response(JSON.stringify(payload([row('99')])));}});
  assert.equal(url.searchParams.get('cursor'),'100');assert.equal(url.searchParams.get('direction'),'next');assert.equal(url.searchParams.get('from'),'100');assert.equal(url.searchParams.get('to'),'1');assert.equal(url.searchParams.get('limit'),'25');
  for(const bad of [{limit:1000},{limit:'50'},{cursor:'id'},{direction:'next'},{cursor:'id',direction:'previous'},{cursor:'id\n',direction:'next'},{cursor:'id',direction:'next',from:100},{path:'/anything'}])assert.throws(()=>validateClicklogPage(bad),{code:'INVALID_QUERY'});
  assert.deepEqual(validateClicklogPage({limit:100,cursor:'id',direction:'prev',from:null}),{limit:100,cursor:'id',direction:'prev'});
});
test('clicklog bounds user inputs before fetch',async()=>{
  let calls=0;const fetchImpl=async()=>{calls++;return new Response('{}');};
  for(const origin of ['http://tracker.example','https://user:pass@tracker.example','https://tracker.example/path','https://tracker.example?key=x'])await assert.rejects(fetchClicklog({...options,origin,fetchImpl}),{code:'INVALID_ORIGIN'});
  await assert.rejects(fetchClicklog({...options,key:'has spaces',fetchImpl}),{code:'INVALID_KEY'});
  await assert.rejects(fetchClicklog({...options,campaignIds:Array.from({length:9},(_,i)=>String(i+1)),fetchImpl}),{code:'INVALID_QUERY'});
  assert.equal(calls,0);
});
test('only supported display fields leave the worker; unavailable fields stay null',()=>{
  const data=normalizeClicklog(payload([row('100',undefined,{user_agent:'Synthetic UA',os_name:'FixtureOS',os_version:'1',is_bot:'0',referer:'https://private.example/path',url:'https://secret.example',campaign_key:'SECRET',ip_v4:123,browser_name:'x'.repeat(513),language:null})]));
  assert.equal(data.rows[0].user_agent,'Synthetic UA');assert.equal(data.rows[0].is_bot,'0');assert.equal(data.rows[0].ip_v4,'123');assert.equal(data.rows[0].browser_name,null);assert.equal(data.rows[0].language,null);assert.equal(data.rows[0].device_name,null);
  for(const key of ['referer','url','campaign_key'])assert.equal(Object.hasOwn(data.rows[0],key),false);
  assert.deepEqual(normalizeClicklog({rows:[{id:'1'}],pageInfo:null}).pageInfo,null);
  assert.equal(normalizeClicklog({rows:[{id:'1'}]}).rows[0].click_time,null);
});
test('public frontend scalar and flat-array cells preserve IP, OS, browser and country',async()=>{
  const data=await call(payload([row('100',undefined,{
    ip:['192.0.2.1','2001:db8::1'],ip_v4:['192.0.2.1'],ip_v6:['2001:db8::1'],
    os_name:['FixtureOS'],os_version:[14,2],browser_name:['Fixture Browser'],browser_version:[125,'1'],
    country:['Test Country','Example Country'],device_name:['Desktop'],language:['en','ru'],user_agent:['Synthetic UA'],is_bot:false,
  })]));
  const actual=data.rows[0];
  assert.equal(actual.ip,'192.0.2.1, 2001:db8::1');assert.equal(actual.ip_v4,'192.0.2.1');assert.equal(actual.ip_v6,'2001:db8::1');
  assert.equal(actual.os_name,'FixtureOS');assert.equal(actual.os_version,'14, 2');assert.equal(actual.browser_name,'Fixture Browser');assert.equal(actual.browser_version,'125, 1');
  assert.equal(actual.country,'Test Country, Example Country');assert.equal(actual.language,'en, ru');assert.equal(actual.user_agent,'Synthetic UA');assert.equal(actual.is_bot,'false');
  assert.equal(normalizeClicklog(payload([row('1',undefined,{country:'Test Country',os_version:0,browser_version:1.5,is_bot:true})])).rows[0].os_version,'0','Explicit numeric zero is retained');
});
test('display values remain bounded and cannot expose arbitrary nested content',()=>{
  const invalid=[null,undefined,'','   ',[],[null],[''],['safe',null],[['nested']],{value:'SECRET',api_key:'SECRET'},['safe',{api_key:'SECRET'}],['bad\nvalue'],Array(17).fill('x'),'x'.repeat(513),['x'.repeat(256),'y'.repeat(255)],NaN,Infinity];
  for(const value of invalid){
    const actual=normalizeClicklog(payload([row('1',undefined,{ip:value,os_name:value,browser_name:value,country:value})])).rows[0];
    for(const field of ['ip','os_name','browser_name','country'])assert.equal(actual[field],null,`Unsupported ${field} must remain unavailable`);
  }
  const maximum=normalizeClicklog(payload([row('1',undefined,{country:['x'.repeat(255),'y'.repeat(255)],user_agent:'u'.repeat(2048)})])).rows[0];
  assert.equal(maximum.country.length,512);assert.equal(maximum.user_agent.length,2048);
  assert.equal(normalizeClicklog(payload([row('1',undefined,{user_agent:['u'.repeat(2048),'x']})])).rows[0].user_agent,null);
  let coerced=false;const malicious={toString(){coerced=true;return 'SECRET';}};
  const safe=normalizeClicklog(payload([row('1',undefined,{ip:malicious,country:[malicious],referer:'SECRET',campaign_key:'SECRET'})]));
  assert.equal(coerced,false);assert.equal(JSON.stringify(safe).includes('SECRET'),false);
});
test('identity and time fields retain scalar-only rules independently of display arrays',()=>{
  const numeric=normalizeClicklog(payload([row(100,undefined,{campaign_id:7})]));
  assert.equal(numeric.rows[0].id,'100');assert.equal(numeric.rows[0].campaign_id,'7');
  assert.throws(()=>normalizeClicklog(payload([row(100),row('100')])),{code:'REPEATED_PAGE'});
  assert.throws(()=>normalizeClicklog(payload([row(100)]),{limit:50,cursor:'100'}),{code:'REPEATED_PAGE'});
  for(const value of [['100'],{value:'100'},true,100.5,Number.MAX_SAFE_INTEGER+1]){
    const actual=normalizeClicklog(payload([row(value,undefined,{campaign_id:value})])).rows[0];
    assert.equal(actual.id,null);assert.equal(actual.campaign_id,null);
  }
  const unsupported=normalizeClicklog(payload([row('1',['2026-10-22 12:00:00'],{clicked_date:20261022})])).rows[0];
  assert.equal(unsupported.click_time,null);assert.equal(unsupported.clicked_date,null);
  assert.equal(normalizeClicklog(payload([row('1','',{clicked_date:''})])).rows[0].click_time,null);
});
test('malformed times, ascending order, repeated IDs/cursors and oversized pages fail without resorting',()=>{
  for(const time of ['2026-02-30 01:00:00','2026-10-22 25:00:00'])assert.throws(()=>normalizeClicklog(payload([row('1',time)])),{code:'API_RESPONSE'});
  assert.throws(()=>normalizeClicklog(payload([row('1','2026-10-22 11:00:00'),row('2','2026-10-22 12:00:00')])),{code:'API_RESPONSE'});
  assert.throws(()=>normalizeClicklog(payload([row('1'),row('1')])),{code:'REPEATED_PAGE'});
  assert.throws(()=>normalizeClicklog(payload([row('1')]),{limit:50,cursor:'1'}),{code:'REPEATED_PAGE'});
  assert.throws(()=>normalizeClicklog(payload([row('1')],{sorting:'asc'})),{code:'API_RESPONSE'});
  assert.throws(()=>normalizeClicklog(payload(Array.from({length:26},(_,i)=>row(String(i)))),{limit:25}),{code:'API_RESPONSE'});
  assert.equal(normalizeClicklog(payload([row('1','2026-10-22T12:00:00Z')])).rows[0].click_time,'2026-10-22T12:00:00Z','An undocumented date-string format is preserved without guessed conversion');
  assert.equal(normalizeClicklog(payload([row('1')],{sorting:'click_time'})).pageInfo.sorting,'click_time','Public pageInfo sorting is a string, not a documented enum');
  const sameTime=normalizeClicklog(payload([row('2'),row('1')]));assert.deepEqual(sameTime.rows.map(row=>row.id),['2','1'],'Server tie ordering is preserved');
});
test('errors are fixed, redirects are rejected and responses have a byte cap',async()=>{
  for(const [status,code] of [[401,'AUTH'],[403,'FORBIDDEN'],[429,'RATE_LIMIT'],[500,'API_ERROR']])await assert.rejects(call(null,{fetchImpl:async()=>new Response('SECRET RAW '+key,{status})}),error=>error.code===code&&!error.message.includes('SECRET'));
  await assert.rejects(call(null,{fetchImpl:async()=>{throw new Error('URL '+key);}}),error=>error.code==='NETWORK'&&!error.message.includes(key));
  await assert.rejects(call(null,{fetchImpl:async()=>({redirected:true})}),{code:'NETWORK'});
  await assert.rejects(call(null,{fetchImpl:async()=>new Response('not-json')}),{code:'API_RESPONSE'});
  await assert.rejects(call(null,{fetchImpl:async()=>new Response('{}',{headers:{'content-length':'1048577'}})}),{code:'API_RESPONSE'});
  let canceled=false;
  await assert.rejects(call(null,{fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(600000));controller.enqueue(new Uint8Array(600000));},cancel(){canceled=true;}}))}),{code:'API_RESPONSE'});
  assert.equal(canceled,true,'Oversized streams stop reading at the cap');
});
test('only display preferences persist, with a nonempty bounded column selection',()=>{
  assert.deepEqual(validateClicklogPreferences({clicklogColumns:[...DEFAULT_CLICKLOG_COLUMNS],clicklogPageSize:25}),{clicklogColumns:[...DEFAULT_CLICKLOG_COLUMNS],clicklogPageSize:25});
  const previousOrder=['click_time','ip','country','os','campaign','device','traffic_source','is_bot','id'];
  const updatedOrder=['click_time','ip','country','device','os','campaign','traffic_source','is_bot','id'];
  assert.deepEqual([...DEFAULT_CLICKLOG_COLUMNS],updatedOrder);
  assert.deepEqual(validateClicklogPreferences({clicklogColumns:previousOrder}).clicklogColumns,updatedOrder,'Saved selections move device between country and OS');
  const custom=['id','os','country','device'];
  assert.deepEqual(validateClicklogPreferences({clicklogColumns:custom}).clicklogColumns,['country','device','os','id'],'Custom enabled fields are preserved');
  assert.deepEqual(custom,['id','os','country','device'],'Validation does not mutate saved preferences');
  const previousDefaults=['click_time','ip','country','os','browser','campaign'];
  assert.deepEqual(validateClicklogPreferences({clicklogColumns:previousDefaults}).clicklogColumns,previousDefaults,'Existing choices are not overwritten by new defaults');
  for(const bad of [{rows:[]},{clicklogColumns:[]},{clicklogColumns:['ip','ip']},{clicklogColumns:['referer']},{clicklogColumns:['campaign_key']},{clicklogPageSize:1000}])assert.throws(()=>validateClicklogPreferences(bad),{code:'INVALID_PREFERENCES'});
});

test('clicklog column labels follow language changes without altering field keys or order', () => {
  const keys=CLICKLOG_COLUMNS.map(column=>column.key);
  try {
    setLanguage('en');
    assert.deepEqual(CLICKLOG_COLUMNS.slice(0,5).map(column=>column.label),['Click time','IP','Country','Device','OS']);
    setLanguage('ru');
    assert.deepEqual(CLICKLOG_COLUMNS.slice(0,5).map(column=>column.label),['Время клика','IP','Страна','Устройство','ОС']);
    assert.deepEqual(CLICKLOG_COLUMNS.map(column=>column.key),keys);
  } finally { setLanguage('en'); }
});
// The real Binom serializes an empty pageInfo as [] when no click matches.
test('an empty Clicklog page with pageInfo [] is an empty result, other array shapes still fail',()=>{
  assert.deepEqual(normalizeClicklog({rows:[],pageInfo:[]}),{rows:[],pageInfo:null});
  assert.throws(()=>normalizeClicklog({...payload([row('100')]),pageInfo:[]}),{code:'API_RESPONSE'},'Rows without paging information would silently truncate the log');
  for(const pageInfo of [['100'],'none','',0,false])assert.throws(()=>normalizeClicklog({rows:[],pageInfo}),{code:'API_RESPONSE'},JSON.stringify(pageInfo));
  assert.throws(()=>normalizeClicklog({rows:{},pageInfo:[]}),{code:'API_RESPONSE'});
});
