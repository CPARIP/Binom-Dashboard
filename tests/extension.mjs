import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { readFile, writeFile, mkdir, mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

// Genuine browser extension + synthetic HTTPS Binom server. Only in this temporary
// test copy is the fixture host pre-granted, to avoid a native permission prompt.
const temp=await mkdtemp(join(tmpdir(),'binom-extension-test-'));
await cp('dist',join(temp,'extension'),{recursive:true});
const manifest=JSON.parse(await readFile(join(temp,'extension/manifest.json'),'utf8'));
assert.equal(manifest.action.default_popup,'popup.html','The toolbar icon opens the packaged control menu');
manifest.host_permissions=['https://127.0.0.1/*'];
await writeFile(join(temp,'extension/manifest.json'),JSON.stringify(manifest));
await writeFile(join(temp,'extension/fixture-render-failure.js'),`if(new URL(location.href).searchParams.has('fixtureRenderFailure')) {
  const attach=Element.prototype.attachShadow; let failed=false;
  Element.prototype.attachShadow=function(...args) {
    if(this.id==='binom-dashboard-extension'&&!failed){failed=true;document.documentElement.dataset.fixtureRenderFailed='true';throw new Error('Synthetic render failure');}
    return attach.apply(this,args);
  };
}`);
execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(temp,'key.pem'),'-out',join(temp,'cert.pem'),'-subj','/CN=127.0.0.1','-days','1'],{stdio:'ignore'});
const requests=[];
let nextTrendHold=null;
let trackerTimezone='UTC';
let settingsInfoDenied=false;
// The real Binom answers an empty Clicklog page with pageInfo as an empty array.
let clicklogEmpty=false;
// A real Binom answers a campaign without traffic with an empty report and
// explicit zero totals for every visible column (field names as on a real tracker).
const emptyCampaignReports=new Set();
const realZeroTotals=Object.fromEntries(['clicks','lander_clicks','lander_ctr','leads','cr','bots','epc','cpc','revenue','cost','profit','roi','unique_clicks','lander_views','total_count'].map(name=>[name,'0']));
const key='TEST-ONLY-NOT-A-REAL-KEY';
const key2='TEST-ONLY-RESTRICTED-KEY';
const fixtureGroups=[{uuid:'11111111-1111-4111-8111-111111111111',name:'Europe'},{uuid:'22222222-2222-4222-8222-222222222222',name:'LATAM'}];
const fixtureCampaigns=[{id:1,name:'Search · Europe',groupUuid:fixtureGroups[0].uuid,groupName:fixtureGroups[0].name,trafficSourceId:1},{id:2,name:'Social · LATAM',groupUuid:fixtureGroups[1].uuid,groupName:fixtureGroups[1].name,trafficSourceId:2}];
function fixture(path, search = new URLSearchParams()) {
  if (path.includes('login') || path.includes('/api/')) return '<html><head><title>Sign in</title></head><body><input type="password"></body></html>';
  const campaigns = !path.includes('offers');
  // Variant: no campaign search field, and neither the breadcrumb nor the hidden
  // mobile menu carries aria-current. The page is then recognized only by the visible
  // menu tab and the document title, which are exactly what activation changes. In the
  // standard fixture those two extra signals mask the loop.
  const noSearch = search.has('fixtureNoSearch');
  const nativeTab = (label, route, active = false) => `<li class="_tab_fixture_1${active?' _activeTab_fixture_1':''}"><a class="_link_fixture_1${active?' _activeTab_fixture_1':''}" href="/panel/${route}"${active?' aria-current="page"':''}>${label}</a></li>`;
  const menu = `${nativeTab('Campaigns','campaigns',campaigns)}${nativeTab('Landers','landers')}${nativeTab('Offers','offers',!campaigns)}${nativeTab('Rotations','rotations')}${nativeTab('Trends','trends')}${nativeTab('Conversions','conversions')}${nativeTab('Users','users')}${nativeTab('Settings','settings')}`;
  const campaignRows = [
    ['Search · Europe', 'Google Ads', 'Europe', '1,482', '47', '$420.00', '$714.00', '+70.00%'],
    ['Social · LATAM', 'Meta Ads', 'LATAM', '1,108', '31', '$310.00', '$496.00', '+60.00%'],
    ['Native · Global', 'Taboola', 'Global', '976', '22', '$225.00', '$351.00', '+56.00%'],
    ['Display · Europe', 'Google Ads', 'Europe', '842', '18', '$198.00', '$257.00', '+29.80%'],
    ['Search · Canada', 'Google Ads', 'Canada', '615', '14', '$164.00', '$212.00', '+29.27%'],
    ['Social · Test', 'Meta Ads', 'Global', '419', '8', '$138.00', '$112.00', '−18.84%'],
  ];
  const campaignContent = `<div class="_buttonsAndFilters_fixture_1">
    <div class="fixture-actions"><button class="_button_fixture_1 _primary-green_fixture_1">Create ＋</button><button class="_button_fixture_1 _primary-blue_fixture_1">Report ↗</button><button class="_button_fixture_1 _secondary-stroke_fixture_1" disabled>Edit</button><button class="_button_fixture_1 _secondary-stroke_fixture_1" disabled>Clone</button><button class="_button_fixture_1 _secondary-stroke_fixture_1">.csv ↓</button><button class="_button_fixture_1 _primary-green_fixture_1">Info</button></div>
    <div class="fixture-filters">${noSearch?'':'<label class="_field_fixture_1 fixture-search"><input class="_input_fixture_1" aria-label="Find campaigns" placeholder="id/name/key/domain"></label>'}<label class="_field_fixture_1"><select class="_input_fixture_1" aria-label="Campaign users"><option>All users</option></select></label><label class="_field_fixture_1"><select class="_input_fixture_1" aria-label="Campaign state"><option>Active</option></select></label><label class="_field_fixture_1"><select class="_input_fixture_1" aria-label="Campaign group"><option>All groups</option></select></label><label class="_field_fixture_1"><select class="_input_fixture_1" aria-label="Traffic source"><option>All sources</option></select></label><label class="_field_fixture_1"><select class="_input_fixture_1" aria-label="Native date range"><option>Last 7 days</option></select></label><button class="_button_fixture_1 _primary-blue_fixture_1">Refresh ↻</button></div>
    </div><div class="fixture-table-container"><table class="_table_fixture_1"><thead class="_head_fixture_1"><tr><th><input type="checkbox" aria-label="Select all campaigns"></th>${['Name','Traffic source','Group','Clicks','Leads','Cost','Revenue','ROI'].map(label=>`<th><span class="_headCellContent_fixture_1">${label}</span></th>`).join('')}</tr></thead><tbody>${campaignRows.map((row,index)=>`<tr class="_row_fixture_1 ${index===5?'_rowWithNegativeProfit_fixture_1':'_rowWithPositiveProfit_fixture_1'}"><td class="_cell_fixture_1"><input type="checkbox" aria-label="Select ${row[0]}"></td>${row.map((cell,column)=>`<td class="_cell_fixture_1${column===7?` fixture-roi ${index===5?'negative':'positive'}`:''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody><tfoot class="_footerTotal_fixture_1"><tr><td></td><td colspan="3">6 campaigns</td><td>5,442</td><td>140</td><td>$1,455.00</td><td>$2,142.00</td><td>+47.22%</td></tr></tfoot></table></div><div class="fixture-pagination"><button class="_button_fixture_1 _secondary-stroke_fixture_1">‹</button><span>Page 1 of 1</span><button class="_button_fixture_1 _secondary-stroke_fixture_1">›</button><span>50 rows</span></div>`;
  // Binom has a title/breadcrumb row before its actual menu. The earlier
  // Campaigns link must never be mistaken for the menu's Campaigns tab.
  // Selection is styled by classes/pseudo-elements, independently of aria-current.
  // Variant: the real Binom rewrites its own address after start-up, adding its
  // filter parameters one by one with the History API. One rewrite lands after the content
  // script has started but before it builds the panel (as observed on a real tracker): the
  // copy announces itself with its internal binom-dashboard-replaced event synchronously and
  // only builds after an asynchronous status reply, so a microtask lands in between. The
  // fixture is coupled to that event name. Two more rewrites land after the panel is shown.
  // The page counts every panel build from its start.
  const rewriteScript = search.has('fixtureUrlRewrite') ? `<script>(()=>{const root=document.documentElement;window.__fixtureHostAdds=0;new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.id==='binom-dashboard-extension')window.__fixtureHostAdds++;}).observe(root,{childList:true,subtree:true});const set=(name,value)=>{const url=new URL(location.href);url.searchParams.set(name,value);history.replaceState(history.state,'',url.href);};document.addEventListener('binom-dashboard-replaced',()=>queueMicrotask(()=>{set('auth','TEST-ONLY-URL-TOKEN');root.dataset.fixtureEarlyRewrite=document.getElementById('binom-dashboard-extension')?'after-build':'before-build';}),{once:true});const wait=()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]')?setTimeout(()=>{set('status','all');setTimeout(()=>{set('dateType','yesterday');root.dataset.fixtureUrlRewritten='true';},150);},300):setTimeout(wait,50);wait();})();</script>` : '';
  return `<!doctype html><html class="dark"><head><title>Binom | ${campaigns?'Campaigns':'Offers'}</title><style>
    :root{--color-simple-bg:#222731;--color-simple-text:#eee;--color-header-menu-background:#191f25;--color-header-navigation-tabs-item:#a7b0bd;--color-header-navigation-tabs-item-active:#00a1e0;--color-header-navigation-tabs-item-border-bottom-active:#00a1e0;--color-button-primary-green-background:#b6dd7b;--color-button-primary-green-text:#263d43;--color-button-primary-blue-background:#009bda;--color-button-primary-blue-text:#fff;--color-button-secondary-stroke-background:transparent;--color-button-secondary-stroke-border:#68727f;--color-button-secondary-stroke-text:#bdc5cd;--color-field-background-normal:#393e4e;--color-field-border-normal:#535967;--color-field-text-normal:#c4cbd4;--color-row-background:#222731;--color-row-background-even:#222731;--color-row-background-odd:#252b35;--color-row-border:#454b54;--color-row-text:#c4cad1;--color-row-text-positive:#b6dd7b;--color-row-text-negative:#f88989}
    :root.light{--color-simple-bg:#fff;--color-simple-text:#20242d;--color-header-menu-background:#f5f7fb;--color-header-navigation-tabs-item:#667385;--color-button-secondary-stroke-border:#a8b2bf;--color-button-secondary-stroke-text:#354252;--color-field-background-normal:#fff;--color-field-border-normal:#bdc5cf;--color-field-text-normal:#354252;--color-row-background:#fff;--color-row-background-even:#fff;--color-row-background-odd:#f5f7fa;--color-row-border:#d7dde5;--color-row-text:#354252;--color-row-text-positive:#4b8619;--color-row-text-negative:#d44343}
    body{background:var(--color-simple-bg);color:var(--color-simple-text);font:14px Arial;margin:0}
    .fixture-mobile{display:none}.fixture-breadcrumb{display:flex;align-items:center;gap:10px;padding:9px 20px;background:var(--color-header-menu-background)}.fixture-breadcrumb a{color:inherit;text-decoration:none}.fixture-brand{font-size:18px;font-weight:600}.fixture-brand-icon{color:#b6dd7b;font-size:21px}.fixture-utilities{margin-left:auto;font-size:12px;color:#a7b0bd}
    [role="navigation"]{padding:0 20px;background:var(--color-header-menu-background)}[role="navigation"]>ul{display:flex;gap:28px;margin:0;padding:0;list-style:none}
    ._tab_fixture_1{position:relative;display:flex;align-items:stretch}
    ._link_fixture_1{color:var(--color-header-navigation-tabs-item);text-decoration:none;padding:15px 0}
    ._link_fixture_1._activeTab_fixture_1{color:var(--color-header-navigation-tabs-item-active)}
    ._tab_fixture_1._activeTab_fixture_1::after{content:"";position:absolute;bottom:-1px;left:0;width:100%;height:3px;background:var(--color-header-navigation-tabs-item-border-bottom-active)}
    main{padding:20px}._buttonsAndFilters_fixture_1{padding:0;margin-bottom:22px}.fixture-actions,.fixture-filters{display:flex;gap:10px;align-items:center}.fixture-filters{margin-top:12px}.fixture-search{flex:1;min-width:210px}
    ._button_fixture_1{font:inherit;border:1px solid transparent;padding:8px 18px;border-radius:4px;cursor:pointer;white-space:nowrap}._button_fixture_1:disabled{opacity:.4;cursor:default}._primary-green_fixture_1{background:var(--color-button-primary-green-background);color:var(--color-button-primary-green-text)}._primary-blue_fixture_1{background:var(--color-button-primary-blue-background);color:var(--color-button-primary-blue-text)}._secondary-stroke_fixture_1{background:var(--color-button-secondary-stroke-background);border-color:var(--color-button-secondary-stroke-border);color:var(--color-button-secondary-stroke-text)}
    ._field_fixture_1{display:inline-flex;background:var(--color-field-background-normal);border:1px solid var(--color-field-border-normal);border-radius:4px}._input_fixture_1{box-sizing:border-box;width:100%;min-width:116px;border:0;background:transparent;color:var(--color-field-text-normal);padding:9px 12px;font:inherit}input::placeholder{color:var(--color-field-text-normal)}
    table{width:100%;border-collapse:separate;border-spacing:0;table-layout:auto;font:14px Arial;border-radius:0;box-shadow:none}th{padding:8px 14px;text-align:left;font-weight:400;color:#929eaf;white-space:nowrap}th:first-child{width:24px}td{height:28px;padding:0 14px;border-bottom:1px solid var(--color-row-border);white-space:nowrap}td:nth-child(n+5),th:nth-child(n+5){text-align:right}._row_fixture_1{height:28px;background:var(--color-row-background);color:var(--color-row-text)}._row_fixture_1:nth-child(odd){background:var(--color-row-background-odd)}.fixture-roi.positive{color:var(--color-row-text-positive)}.fixture-roi.negative{color:var(--color-row-text-negative)}._footerTotal_fixture_1{color:#929eaf}.fixture-pagination{display:flex;gap:15px;align-items:center;margin-top:16px;color:#929eaf}
    </style></head><body><header class="_headerMobile_fixture_1 fixture-mobile" hidden><div class="_bottomNavigation_fixture_1" role="navigation" aria-label="Mobile tracker sections"><ul class="_container_fixture_1">${noSearch?menu.replaceAll(' aria-current="page"',''):menu}</ul></div></header><header class="_headerDesktop_fixture_1"><div class="fixture-breadcrumb _headerPlace_fixture_1"><span class="fixture-brand-icon">▥</span><span class="fixture-brand">Binom</span><span>|</span><a href="/panel/campaigns"${noSearch?'':' aria-current="page"'}>Campaigns</a><span class="fixture-utilities">Domains　 Groups　 Settings　 Monitor　 Exit <button id="native-theme" aria-label="Native color theme">◐</button></span></div><div class="_bottomNavigation_fixture_1" role="navigation" aria-label="Tracker sections"><ul class="_container_fixture_1">${menu}</ul></div></header><main>${campaigns?campaignContent:'<h1>Offers</h1><p>Native offers content</p>'}</main><script>document.documentElement.className=sessionStorage.getItem('fixtureNativeTheme')||'dark';document.getElementById('native-theme').onclick=()=>{const next=document.documentElement.classList.contains('dark')?'light':'dark';document.documentElement.className=next;sessionStorage.setItem('fixtureNativeTheme',next);};</script>${rewriteScript}</body></html>`;
}
const server=createServer({key:await readFile(join(temp,'key.pem')),cert:await readFile(join(temp,'cert.pem'))},(req,res)=>{
  const url=new URL(req.url,'https://localhost');
  if(url.pathname.startsWith('/public/api/')){
    requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),headers:req.headers});
    assert.equal([key,key2].includes(req.headers['api-key']),true);
    assert.equal(req.headers.cookie,undefined);
    for(const forbidden of ['uniqueClicks','unique','unique_clicks','unique_campaign_clicks'])assert.equal(url.searchParams.has(forbidden),false,`Unique display mode must not add an HTTP parameter: ${forbidden}`);
    res.setHeader('Content-Type','application/json');
    if(url.pathname==='/public/api/v1/settings/info') {
      assert.equal(req.method,'GET');
      assert.equal(url.searchParams.size,0,'Tracker settings use the fixed read route without parameters');
      if(settingsInfoDenied){res.writeHead(403);return res.end(JSON.stringify({message:'Synthetic settings permission denied'}));}
      return res.end(JSON.stringify({timezone:trackerTimezone,email:'synthetic-settings@example.invalid'}));
    }
    if(url.pathname==='/public/api/v1/groups/campaigns')return res.end(JSON.stringify(fixtureGroups));
    if(url.pathname==='/public/api/v1/traffic_source/list/filtered')return res.end(JSON.stringify(url.searchParams.get('offset')==='0'?[{id:1,name:'Google Ads'},{id:2,name:'Social Ads'}]:[]));
    if(url.pathname==='/public/api/v1/campaign/list/filtered')return res.end(JSON.stringify(url.searchParams.get('offset')==='0'?fixtureCampaigns.filter(campaign=>(!url.searchParams.has('groupUuid')||campaign.groupUuid===url.searchParams.get('groupUuid'))&&(!url.searchParams.has('trafficSourceId')||String(campaign.trafficSourceId)===url.searchParams.get('trafficSourceId'))):[]));
    if(url.pathname==='/public/api/v1/clicklog') {
      assert.equal(req.method,'GET');
      assert.equal(url.searchParams.get('sortType'),'desc','Latest clicks request newest-first ordering');
      const limit=Number(url.searchParams.get('limit'));
      assert.ok(Number.isInteger(limit)&&limit>0&&limit<=1000,'Click log page size must be bounded');
      for(const forbidden of ['offset','sortColumn','filter','hideBots','trafficSourceId','accessLevel'])assert.equal(url.searchParams.has(forbidden),false,`Undocumented clicklog parameter: ${forbidden}`);
      const selected=url.searchParams.getAll('campaignIds[]');
      const latest=Date.parse((url.searchParams.get('dateTo')||'2026-10-22 12:00:00').replace(' ','T')+'Z');
      const available=Array.from({length:120},(_,index)=>{
        const campaignId=String(index%2+1);
        const timestamp=new Date(latest-index*60000).toISOString().slice(0,19).replace('T',' ');
        return {id:String(10000-index),clicked_date:timestamp,click_time:timestamp,campaign_id:campaignId,
          campaign:campaignId==='1'?'Search · Europe':'Social · LATAM',ip:[`192.0.2.${index%200+1}`],country:index===1?['Unknown']:index===2?null:['Norway'],
          device_name:index===1||index===2?null:index%2?'Mobile':'Desktop',device_type:index===1?'Unknown':index===2?null:index%2?'mobile':'desktop',device_model:index===0?'Fixture workstation':null,browser_name:['Fixture Browser'],browser_version:12,
          os_name:index===1?['Unknown']:index===2?null:['Windows'],os_version:index===1||index===2?null:[7],user_agent:[`Synthetic browser ${index}`],traffic_source:'Synthetic source',referer_domain:'source.example',is_bot:index%5===0};
      }).filter(row=>!selected.length||selected.includes(row.campaign_id));
      const cursor=url.searchParams.get('cursor');
      const direction=url.searchParams.get('direction')||'next';
      const cursorIndex=cursor===null?-1:available.findIndex(row=>row.id===cursor);
      assert.ok(cursor===null||cursorIndex>=0,'Pagination cursor belongs to the selected click scope');
      const start=cursor===null?0:direction==='prev'?Math.max(0,cursorIndex-limit):cursorIndex+1;
      const rows=available.slice(start,start+limit);
      if(clicklogEmpty)return res.end(JSON.stringify({rows:[],pageInfo:[]}));
      return res.end(JSON.stringify({rows,pageInfo:{from:available[0]?.id||'',to:available.at(-1)?.id||'',direction,sorting:'desc',hasNextPage:start+rows.length<available.length,hasPrevPage:start>0,limit}}));
    }
    if(url.pathname==='/public/api/v1/report/campaign'){
      const ids=url.searchParams.getAll('ids[]');
      assert.ok(ids.length>=1&&ids.length<=500,'Reports must have an explicit bounded campaign scope');
      const from=url.searchParams.get('dateFrom').slice(0,10),to=url.searchParams.get('dateTo').slice(0,10);
      const grouping=url.searchParams.get('groupings[]');
      const restricted=req.headers['api-key']===key2;
      if(ids.length===1&&emptyCampaignReports.has(ids[0])&&['days','hourOfDay'].includes(grouping))return res.end(JSON.stringify({report:[],totals:realZeroTotals}));
      const metrics=(allClicks,leads=2)=>{
        const filtered=url.searchParams.get('hideBots')==='1';
        const clicks=allClicks-(filtered?3:0);
        // Like the real Binom, the stand names spend `cost`.
        return {clicks,leads,bots:filtered?0:3,cost:7,revenue:10,cr:clicks?leads/clicks*100:0,epc:clicks?10/clicks:0,cpc:clicks?7/clicks:0,...(restricted?{}:{unique_clicks:Math.floor(clicks/4),unique_campaign_clicks:Math.floor(clicks/2),profit:3,roi:300/7})};
      };
      const report=[];
      if(grouping==='days') {
        for(let time=Date.parse(from+'T00:00:00Z');time<=Date.parse(to+'T00:00:00Z');time+=86400000)report.push({name:new Date(time).toISOString().slice(0,10),...metrics(ids.reduce((sum,id)=>sum+Number(id)*37,0)+report.length*5)});
      } else if(grouping==='hourOfDay') {
        for(let hour=0;hour<=Number(url.searchParams.get('dateTo').slice(11,13));hour++)report.push({name:String(hour),...metrics((hour+1)*3+ids.length)});
      } else if(grouping==='campaign') {
        for(const id of ids)report.push({entity_id:id,name:id==='1'?'Search · Europe':'Social · LATAM',level:1,...metrics(Number(id)*350+Date.parse(from+'T00:00:00Z')/86400000%50),...(restricted?{}:{unique_clicks:id==='1'?70:20,unique_campaign_clicks:id==='1'?140:35})});
      } else {
        const dimensions={trafficSource:[['1','Google Ads'],[null,'No traffic source']],campaignsGroup:[['eu','Europe'],[null,'No group']],geoCountry:[['DE','Germany'],['BR','Brazil']]};
        assert.ok(dimensions[grouping],'Only supported grouped reports');
        for(const [id,name] of dimensions[grouping]) {
          report.push({...(grouping==='trafficSource'||grouping==='campaignsGroup'?{entity_id:id}:{}),name,level:1,...metrics(report.length?300:700)});
        }
      }
      // Native categorical pagination can expose its total and return null
      // beyond the last page. The adapter must stop at the complete count.
      if(grouping==='geoCountry')return res.end(JSON.stringify({report:Number(url.searchParams.get('offset')||0)>0?null:report,totals:{total_count:String(report.length)}}));
      // Other aggregate pages have an explicit empty terminator; time reports also
      // exercise the complete-range shortcut independently of pagination.
      return res.end(JSON.stringify({report:Number(url.searchParams.get('offset')||0)>0?[]:report}));
    }
    if(url.pathname==='/public/api/v1/trends'){
      const from=url.searchParams.get('dateFrom').slice(0,10);
      const to=url.searchParams.get('dateTo').slice(0,10);
      const restricted=req.headers['api-key']===key2;
      // Real-world compatibility regression: Trends can return the whole range
      // again instead of an empty page when offset is beyond its final bucket.
      const stats=[];
      const dates=[];
      if(url.searchParams.get('grouping')==='hours') {
        for(let hour=0;hour<=Number(url.searchParams.get('dateTo').slice(11,13));hour++)dates.push(`${String(hour).padStart(2,'0')}:00`);
      } else {
        for(let time=Date.parse(`${from}T00:00:00Z`);time<=Date.parse(`${to}T00:00:00Z`);time+=86400000)dates.push(new Date(time).toISOString().slice(0,10));
      }
      for(const [index,date] of dates.entries()){
        const first=index===0;
        const filtered=url.searchParams.get('hideBots')==='1';
        stats.push({date,clicks:first?(restricted?(filtered?5:7):(filtered?400:420)):0,bots:first?(filtered?0:restricted?2:20):0,leads:first?12:0,cost:first?100:0,revenue:first?220:0,...(restricted?{}:{unique_clicks:first?(filtered?160:180):0,unique_campaign_clicks:first?(filtered?210:230):0,profit:first?120:0,roi:first?120:0})});
      }
      // With hideBots=1 Trends omits buckets without unmarked clicks and,
      // ignoring offset, resends the same sparse series on the next request.
      const body=url.searchParams.get('hideBots')==='1'?stats.filter(row=>row.clicks>0):stats;
      const send=()=>res.end(JSON.stringify({stats:body}));
      if(nextTrendHold&&url.searchParams.get('hideBots')==='1') {
        const hold=nextTrendHold;nextTrendHold=null;hold.started();void hold.release.then(send);return;
      }
      return send();
    }
    res.writeHead(404);return res.end('{}');
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture(url.pathname,url.searchParams));
});
await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
const origin=`https://127.0.0.1:${server.address().port}`;
let context;
let campaignsPage, settingsPage;
const vaultPassword = 'TEST-ONLY-UNIQUE-PASSPHRASE-2026';
const browserOptions = {headless:true,channel:'chromium',ignoreHTTPSErrors:true,reducedMotion:'reduce',timezoneId:'Asia/Tokyo',viewport:{width:1500,height:1080},args:[`--disable-extensions-except=${join(temp,'extension')}`,`--load-extension=${join(temp,'extension')}`,'--ignore-certificate-errors']};
try{
  context=await chromium.launchPersistentContext(join(temp,'profile'),browserOptions);
  context.setDefaultTimeout(30000);
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker');
  const extensionId=worker.url().split('/')[2];
  let settings=await context.newPage();
  settingsPage=settings;
  settings.on('pageerror',e=>console.log('Settings page error:',e.message));
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.waitForFunction(()=>document.documentElement.lang==='en');
  assert.equal(await settings.locator('#connect-label').innerText(),'Connect Binom');
  // The former sidebar stays gone; the language lives in the interface panel.
  // The Binom design is the only design, so there is no design choice anywhere.
  assert.equal(await settings.locator('aside, .appearance-card').count(),0,'Connection settings omit the former information sidebar');
  assert.equal(await settings.getByRole('combobox',{name:'Language',exact:true}).count(),1,'Settings offer the language choice');
  assert.equal(await settings.getByRole('combobox',{name:'Design',exact:true}).count(),0,'Settings offer no design choice');
  await settings.evaluate(()=>chrome.scripting.registerContentScripts([{id:'fixture-render-failure',matches:['https://127.0.0.1/*'],js:['fixture-render-failure.js'],runAt:'document_start',world:'ISOLATED'}]));
  await settings.locator('#tracker-url').fill(origin+'/panel/campaigns?auth=TEST-ONLY-TEMP-LOGIN');
  assert.equal(await settings.locator('#timezone, #timezones').count(),0,'Timezone is fetched from Binom; no manual field or browser fallback remains');
  await settings.locator('#api-key').fill(key);
  assert.equal(await settings.locator('#storage-mode').inputValue(),'encrypted');
  await settings.locator('#vault-password').fill(vaultPassword);
  await settings.locator('#vault-password-confirm').fill(vaultPassword);
  const languageMenu=await context.newPage();
  await languageMenu.goto(`chrome-extension://${extensionId}/${manifest.action.default_popup}`);
  await languageMenu.waitForFunction(()=>!document.getElementById('language').disabled);
  assert.equal(await languageMenu.locator('#language').inputValue(),'en','Fresh installations use English');
  assert.equal(await languageMenu.locator('#toggle-dashboard').isDisabled(),true);
  assert.equal(await languageMenu.locator('#toggle-dashboard').getAttribute('title'),'','A switch that cannot act has no action tooltip');
  await languageMenu.locator('#language').selectOption('ru');
  await settings.waitForFunction(()=>document.documentElement.lang==='ru');
  assert.equal(await settings.locator('#ui-language').inputValue(),'ru','The settings language choice follows the popup');
  assert.equal(await settings.locator('#tracker-url').inputValue(),origin+'/panel/campaigns?auth=TEST-ONLY-TEMP-LOGIN');
  assert.equal(await settings.locator('#api-key').inputValue(),key);
  assert.equal(await settings.locator('#vault-password').inputValue(),vaultPassword,'Language switching preserves the unfinished connection form');
  assert.equal(requests.length,0,'Choosing a language before connecting makes no tracker request');
  await languageMenu.close();
  let campaigns=await context.newPage();await campaigns.goto(origin+'/panel/campaigns');
  campaignsPage=campaigns;
  async function switchNative(theme) {
    if(!await campaigns.evaluate(theme=>document.documentElement.classList.contains(theme),theme)) await campaigns.getByRole('button',{name:'Native color theme'}).click();
    await campaigns.waitForFunction(theme=>{const panel=document.querySelector('#binom-dashboard-extension')?.shadowRoot?.querySelector('.bd');return document.documentElement.classList.contains(theme)&&(!panel||panel.classList.contains('light')===(theme==='light'));},theme);
  }
  campaigns.on('pageerror',e=>console.log('Campaigns page error:',e.message));
  campaigns.on('console',m=>{if(m.type()==='error')console.log('Campaigns console:',m.text());});
  await settings.locator('#connect').click();
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Ключ разблокирован');
  assert.equal(await settings.locator('#configured-timezone').textContent(),'UTC','The connection summary displays Binom settings timezone');
  assert.equal(await settings.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone),'Asia/Tokyo','The test browser uses a different local timezone');
  assert.equal(await settings.evaluate(async()=>(await chrome.storage.local.get('config')).config.timezone),'UTC','CONNECT persists the fetched tracker timezone, not the browser timezone');
  assert.ok(requests.some(request=>request.path==='/public/api/v1/settings/info'&&request.headers['api-key']===key));
  // One narrow column (≤ 680 px) instead of the former 960 px sheet.
  const connectionBounds=await settings.getByRole('region',{name:'Подключение',exact:true}).boundingBox();
  assert.ok(connectionBounds.width<=680&&connectionBounds.height<650,'The configured connection card has a bounded width and content-sized height');
  assert.ok(Math.abs(connectionBounds.x+connectionBounds.width/2-750)<1,'The connection card is centered in the settings viewport');
  for (const id of ['api-key','vault-password','vault-password-confirm']) assert.equal(await settings.locator('#'+id).inputValue(),'');
  await campaigns.getByRole('link',{name:'Dashboard',exact:true}).waitFor();
  assert.equal(await campaigns.locator('#binom-dashboard-extension').count(),0,'Campaigns must remain a native table');
  assert.equal(await campaigns.locator('main > .fixture-table-container table').isVisible(),true);
  const mainMenu=campaigns.getByRole('navigation',{name:'Tracker sections'});
  const nativeCampaigns=mainMenu.getByRole('link',{name:'Campaigns',exact:true});
  async function assertMenuPlacement() {
    assert.equal(await campaigns.getByRole('link',{name:'Dashboard',exact:true}).count(),1,'Only one Dashboard entry is allowed');
    assert.equal(await campaigns.locator('.fixture-breadcrumb [data-binom-dashboard-nav]').count(),0,'Dashboard must not enter the breadcrumb row');
    assert.equal(await campaigns.locator('.fixture-mobile [data-binom-dashboard-nav]').count(),0,'A hidden mobile menu must not win over the visible desktop menu');
    assert.equal(await campaigns.locator('.fixture-mobile').isVisible(),false,'The theme must preserve native responsive visibility');
    assert.equal(await mainMenu.locator('[data-binom-dashboard-nav]').count(),1,'Dashboard must be in the native main menu');
    assert.equal(await nativeCampaigns.evaluate(anchor=>anchor.closest('[class*="_tab_"]').previousElementSibling?.hasAttribute('data-binom-dashboard-nav')),true,'Dashboard must be immediately before the main Campaigns tab');
    assert.equal(await campaigns.locator('.fixture-breadcrumb a').getAttribute('aria-current'),'page','The breadcrumb must remain untouched');
  }
  async function assertNativeCampaignState(active) {
    // Back keeps the pointer over Campaigns. Its hover tint is intentionally
    // independent of the active-page pill, so inspect the resting state.
    await campaigns.mouse.move(0,0);
    await nativeCampaigns.evaluate(async anchor=>{
      const slot=anchor.closest('[class*="_tab_"]');
      await Promise.all(slot.getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{})));
    });
    const state=await nativeCampaigns.evaluate(anchor=>{
      const slot=anchor.closest('[class*="_tab_"]');
      const inactivePeer=anchor.closest('[role="navigation"]').querySelector('a[href="/panel/landers"]');
      const underline=getComputedStyle(slot,'::after');
      const painted=value=>value!=='rgba(0, 0, 0, 0)'&&value!=='transparent';
      return {aria:anchor.getAttribute('aria-current'),color:getComputedStyle(anchor).color,inactiveColor:getComputedStyle(inactivePeer).color,highlight:(underline.display!=='none'&&underline.content!=='none'&&painted(underline.backgroundColor))||painted(getComputedStyle(slot).backgroundColor)||painted(getComputedStyle(anchor).backgroundColor),activeClass:slot.classList.contains('_activeTab_fixture_1')};
    });
    assert.equal(state.aria,active?'page':null,'Only the current main menu entry is announced as active');
    assert.equal(state.activeClass,true,'Native active classes must remain reversible');
    assert.equal(state.color===state.inactiveColor,!active,'Campaigns text must follow its visible active state');
    assert.equal(state.highlight,active,'Campaigns underline or themed pill must follow its visible active state');
  }
  async function nativeAppearance() {
    return campaigns.evaluate(()=>{
      const style=selector=>getComputedStyle(document.querySelector(selector));
      const tabNode=document.querySelector('[role="navigation"][aria-label="Tracker sections"] a[href="/panel/campaigns"]');
      const slot=getComputedStyle(tabNode.closest('[class*="_tab_"]'));
      const tab=getComputedStyle(tabNode);
      const toolbar=style('._buttonsAndFilters_fixture_1');
      const table=style('._table_fixture_1');
      const heading=style('._headCellContent_fixture_1');
      return {body:{background:style('body').backgroundColor,font:style('body').fontFamily},tab:{background:tab.backgroundColor,slotBackground:slot.backgroundColor,radius:tab.borderRadius,slotRadius:slot.borderRadius},toolbar:{background:toolbar.backgroundColor,padding:toolbar.padding,radius:toolbar.borderRadius},table:{background:table.backgroundColor,radius:table.borderRadius,shadow:table.boxShadow,font:table.fontFamily,width:document.querySelector('._table_fixture_1').getBoundingClientRect().width},heading:{weight:heading.fontWeight,size:heading.fontSize,transform:heading.textTransform},rowHeight:document.querySelector('._row_fixture_1').getBoundingClientRect().height};
    });
  }
  await assertMenuPlacement();
  await assertNativeCampaignState(true);
  const originalAppearance=await nativeAppearance();
  const originalNativeTheme=await campaigns.evaluate(()=>document.documentElement.classList.contains('dark')?'dark':'light');
  await campaigns.getByRole('link',{name:'Dashboard',exact:true}).click();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.updated')?.textContent.startsWith('Обновлено'));
  await reportsReady();
  assert.equal(await campaigns.locator('.breakdown-tabs [aria-pressed="true"]').textContent(),'Кампании','Campaign composition is the initial default dimension');
  assert.deepEqual(await campaigns.locator('.breakdown-tabs button').allTextContents(),['Кампании','Группы','Источники','Страны'],'Composition exposes only the four supported dimensions');
  assert.equal(await campaigns.locator('.breakdown-tabs').getByRole('button',{name:'Устройства',exact:true}).count(),0,'Device composition is removed');
  assert.equal(requests.some(request=>request.query['groupings[]']==='deviceType'),false,'Initial overview does not request device reports');
  await assertMenuPlacement();
  await assertNativeCampaignState(false);
  assert.equal(await mainMenu.getByRole('link',{name:'Dashboard',exact:true}).getAttribute('aria-current'),'page');
  assert.equal(await campaigns.locator('main').getAttribute('inert'),'','Native campaign controls are inert behind the dedicated view');
  assert.equal(await campaigns.locator('main').getAttribute('aria-hidden'),'true');
  assert.equal(await campaigns.locator('main').evaluate(node=>getComputedStyle(node).display==='none'),false,'Native virtual-table geometry is preserved');
  assert.equal(await campaigns.locator('[data-binom-dashboard-view]').evaluate(node=>node.parentElement===document.body&&node.dataset.ready==='true'),true,'Dashboard activates outside the native app tree after render');
  assert.equal(await campaigns.locator('[data-binom-dashboard-view] > h1').count(),0,'No duplicate Dashboard heading');
  assert.equal(await campaigns.locator('[data-action=theme]').count(),0,'Only the native theme switch remains');
  assert.equal(await campaigns.locator('[data-query="grouping"], [data-query="status"]').count(),0,'The dashboard no longer exposes grouping or status selectors');
  assert.equal(await campaigns.locator('.saved-area, .saved-selections, .save-selection-form, [data-action="save-selection"]').count(),0,'Saved-selection UI is removed');
  assert.equal(await campaigns.locator('.eyebrow').count(),0,'No product eyebrow above the overview');
  assert.equal(await campaigns.locator('.card-value').first().textContent(),'420');
  // Spend arrives as `cost`, as on a real Binom, and reaches the cards and ROI.
  assert.deepEqual(await campaigns.locator('.cards [data-metric="costs"] .card-value, .cards [data-metric="roi"] .card-value').allTextContents(),['100,00 $','120,00 %'],'Spend and ROI come from the cost field');
  assert.equal(await campaigns.locator('[data-query="datePreset"]').inputValue(),'last_30_days','The installed dashboard opens the last 30 days by default');
  const initialTrendsQuery=requests.find(request=>request.path.endsWith('/trends')).query;
  assert.equal((Date.parse(initialTrendsQuery.dateTo.slice(0,10))-Date.parse(initialTrendsQuery.dateFrom.slice(0,10)))/86400000,29,'The first overview API request spans thirty calendar days');
  const uniqueCheckbox=campaigns.locator('[data-query="uniqueClicks"]');
  assert.equal(await campaigns.getByRole('checkbox',{name:'Уникальные клики',exact:true}).count(),1,'The unique-count checkbox uses its full label');
  assert.deepEqual(await campaigns.locator('.toolbar.secondary [data-query]').evaluateAll(inputs=>inputs.map(input=>input.dataset.query)),['compare','uniqueClicks','hideBots'],'Unique clicks follow period comparison and precede the bot filter');
  const metricValues=()=>campaigns.locator('.cards .card:not([data-metric="clicks"]) .card-value').allTextContents();
  const clickValue=()=>campaigns.locator('.cards [data-metric="clicks"] .card-value').textContent();
  const compositionTotal=async()=>Number((await campaigns.locator('.breakdown-total strong').textContent()).replace(/\s/g,''));
  assert.equal(await uniqueCheckbox.isChecked(),false,'Unique clicks start disabled');
  const allClickMetrics=await metricValues();
  assert.deepEqual(await campaigns.locator('.breakdown-row .breakdown-name').allTextContents(),['Social · LATAM','Search · Europe']);
  await uniqueCheckbox.check();
  await reportsReady();
  assert.equal(await clickValue(),'180','Overview uses tracker unique_clicks, independently of unique_campaign_clicks and clicks');
  assert.deepEqual(await metricValues(),allClickMetrics,'Unique display leaves conversions, money and ROI unchanged');
  assert.deepEqual(await campaigns.locator('.breakdown-row .breakdown-name').allTextContents(),['Search · Europe','Social · LATAM'],'Composition ranking follows the selected unique count');
  assert.equal(await compositionTotal(),90,'Campaign composition in the overview uses tracker unique_clicks');
  await mkdir('.test-results',{recursive:true});
  await campaigns.evaluate(()=>window.scrollTo(0,0));
  await campaigns.screenshot({path:'.test-results/extension-unique-overview.png'});
  await campaigns.locator('.insights-root').screenshot({path:'.test-results/extension-unique-composition.png'});
  await uniqueCheckbox.uncheck();
  await reportsReady();
  assert.equal(await clickValue(),'420','Disabling unique display restores original API clicks');
  assert.deepEqual(await metricValues(),allClickMetrics);
  assert.equal(await campaigns.locator('[data-action="pick-overview-campaign"] .select-value').textContent(),'Все кампании');
  assert.deepEqual(await campaigns.locator('[data-query="groupId"] option').evaluateAll(options=>options.filter(option=>option.value).map(option=>({id:option.value,name:option.textContent}))),fixtureGroups.map(group=>({id:group.uuid,name:group.name})),'Group choices retain the API catalog identities');
  await campaigns.locator('[data-action="pick-overview-campaign"]').click();
  await campaigns.locator('.overview-campaign-list .campaign-group-toggle').first().waitFor();
  assert.equal(await campaigns.locator('.overview-campaign-list .campaign-option').count(),0,'Overview campaign groups start collapsed');
  assert.deepEqual(await campaigns.locator('.overview-campaign-list .campaign-group-toggle').evaluateAll(buttons=>buttons.map(button=>button.dataset.groupId).sort()),fixtureGroups.map(group=>group.uuid).sort(),'Campaign membership survives the worker/content boundary');
  await campaigns.locator('.overview-campaign-search').fill('LATAM');
  assert.equal(await campaigns.locator('.overview-campaign-list .campaign-option[data-campaign-id="2"]').count(),1,'Searching a group exposes its campaign');
  await campaigns.locator('.overview-campaign-search').press('Escape');
  assert.equal(await campaigns.locator('[data-action="pick-overview-campaign"]').getAttribute('aria-expanded'),'false');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.clicklog-root')?.dataset.state==='ready');
  assert.equal(await campaigns.locator('.clicklog-table tbody tr').count(),50);
  assert.deepEqual(await campaigns.locator('.clicklog-table th').evaluateAll(nodes=>nodes.map(node=>node.dataset.column)),['click_time','ip','country','device','os','campaign','traffic_source','is_bot','id'],'Default clicklog selection and display order match the requested columns');
  const firstClick=campaigns.locator('.clicklog-table tbody tr').first();
  assert.equal(await firstClick.locator('[data-column="ip"]').textContent(),'192.0.2.1','Array IP from the API survives worker normalization');
  const firstOS=firstClick.locator('[data-column="os"] .clicklog-value-icon');
  assert.equal(await firstOS.getAttribute('aria-label'),'Windows 7','The OS icon retains the complete normalized name and version');
  assert.equal(await firstOS.getAttribute('data-icon'),'os-windows');
  assert.equal(await firstOS.locator('svg').count(),1);
  assert.equal(await firstClick.locator('[data-column="browser"]').count(),0,'Browser remains available as an optional column');
  const firstCountry=firstClick.locator('[data-column="country"] .clicklog-value-icon');
  assert.equal(await firstCountry.getAttribute('aria-label'),'Norway');
  assert.equal(await firstCountry.getAttribute('data-icon'),'country-NO');
  assert.equal(await firstCountry.textContent(),'🇳🇴');
  for(const [index,label] of [[1,'Unknown'],[2,'Не определено']]) {
    const click=campaigns.locator('.clicklog-table tbody tr').nth(index);
    for(const key of ['country','os']) {
      const icon=click.locator(`[data-column="${key}"] .clicklog-value-icon`);
      assert.equal(await icon.getAttribute('data-icon'),`unknown-${key}`);
      assert.equal(await icon.getAttribute('aria-label'),label,'Unknown and absent values remain distinct');
    }
  }
  await campaigns.locator('.clicklog-columns summary').click();
  await campaigns.locator('.clicklog-columns input[data-column="browser"]').check();
  assert.equal(await firstClick.locator('[data-column="browser"]').textContent(),'Fixture Browser 12');
  await campaigns.locator('.clicklog-columns input[data-column="user_agent"]').check();
  assert.equal(await firstClick.locator('[data-column="user_agent"]').textContent(),'Synthetic browser 0');
  assert.equal(await campaigns.locator('.clicklog-columns input[data-column="is_bot"]').isChecked(),true);
  assert.equal(await firstClick.locator('[data-column="is_bot"]').textContent(),'Да');
  assert.equal(await campaigns.locator('.clicklog-columns input[data-column="device"]').isChecked(),true);
  await campaigns.locator('.clicklog-columns input[data-column="id"]').uncheck();
  const firstDevice=firstClick.locator('[data-column="device"] .clicklog-value-icon');
  assert.equal(await firstDevice.getAttribute('data-icon'),'device-desktop','Device family comes from type, independently of model');
  assert.equal(await firstDevice.getAttribute('aria-label'),'desktop Desktop Fixture workstation','Device tooltip keeps type, name and model');
  for(const [index,label] of [[1,'Unknown'],[2,'Не определено']]) {
    const icon=campaigns.locator('.clicklog-table tbody tr').nth(index).locator('[data-column="device"] .clicklog-value-icon');
    assert.equal(await icon.getAttribute('data-icon'),'unknown-device');
    assert.equal(await icon.getAttribute('aria-label'),label);
  }
  await campaigns.locator('.clicklog-columns summary').click();
  const clickTooltip=campaigns.locator('.clicklog-tooltip');
  assert.equal(await clickTooltip.getAttribute('role'),'tooltip');
  assert.equal(await clickTooltip.getAttribute('popover'),'manual');
  await firstCountry.hover();
  await clickTooltip.waitFor({state:'visible'});
  assert.equal(await clickTooltip.textContent(),'Norway');
  assert.equal(await clickTooltip.evaluate(node=>node.matches(':popover-open')),true,'Tooltip appears above the scrolling table');
  assert.equal(await firstCountry.getAttribute('aria-describedby'),await clickTooltip.getAttribute('id'));
  await campaigns.keyboard.press('Escape');
  await clickTooltip.waitFor({state:'hidden'});
  assert.equal(await firstCountry.getAttribute('aria-describedby'),null,'Escape dismisses a hover tooltip without focusing the icon');
  await firstOS.scrollIntoViewIfNeeded();
  await firstOS.focus();
  await clickTooltip.waitFor({state:'visible'});
  assert.equal(await clickTooltip.textContent(),'Windows 7','Keyboard focus exposes the full OS value');
  await firstOS.press('Escape');
  await clickTooltip.waitFor({state:'hidden'});
  await firstDevice.scrollIntoViewIfNeeded();
  await firstDevice.focus();
  await clickTooltip.waitFor({state:'visible'});
  assert.equal(await clickTooltip.textContent(),'desktop Desktop Fixture workstation');
  await firstDevice.press('Escape');
  await clickTooltip.waitFor({state:'hidden'});
  await campaigns.locator('.clicklog-columns summary').click();
  await firstCountry.scrollIntoViewIfNeeded();
  await firstCountry.focus();
  await clickTooltip.waitFor({state:'visible'});
  await campaigns.locator('.clicklog-columns input[data-column="country"]').uncheck();
  await clickTooltip.waitFor({state:'hidden'});
  assert.equal(await campaigns.locator('.clicklog-value-icon[aria-describedby]').count(),0,'Changing columns leaves no obsolete tooltip reference');
  assert.equal(await campaigns.locator('.clicklog-table th[data-column="country"]').count(),0);
  await campaigns.locator('.clicklog-columns input[data-column="country"]').check();
  await campaigns.locator('.clicklog-columns summary').click();
  await campaigns.locator('[data-clicklog-limit]').selectOption('25');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelectorAll('.clicklog-table tbody tr').length===25);
  // A period or selection without clicks is an empty log, not a format error.
  clicklogEmpty=true;
  await campaigns.locator('[data-clicklog-action="refresh"]').click();
  // Wait until the 25-row table is replaced by a result, so the previous ready state cannot pass.
  await campaigns.waitForFunction(()=>{const root=document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.clicklog-root');return root&&!root.querySelector('.clicklog-table')&&root.dataset.state!=='loading';});
  assert.equal(await campaigns.locator('.clicklog-root').getAttribute('data-state'),'ready','An empty Clicklog page with pageInfo [] is not an error');
  assert.equal(await campaigns.locator('.clicklog-state').textContent(),'За выбранный период кликов нет или они недоступны.');
  assert.equal(await campaigns.locator('.clicklog-table').count(),0);
  assert.equal(await campaigns.locator('.clicklog-position').textContent(),'Страница 1 · 0 строк','The empty log is a loaded page, not an error');
  assert.deepEqual(await campaigns.locator('[data-clicklog-action="prev"], [data-clicklog-action="next"]').evaluateAll(buttons=>buttons.map(button=>button.disabled)),[true,true],'An empty log offers no paging');
  clicklogEmpty=false;
  await campaigns.locator('[data-clicklog-action="refresh"]').click();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelectorAll('.clicklog-table tbody tr').length===25);
  await campaigns.locator('.metric-settings summary').click();
  await campaigns.locator('[data-visible-metric="cr"]').check();
  await campaigns.locator('[data-visible-metric="cr"]').uncheck();
  await campaigns.locator('.metric-settings summary').click();
  await campaigns.locator('[data-query="campaignId"]').selectOption('1');
  await reportsReady();
  assert.equal(await campaigns.locator('[data-query="groupId"]').isDisabled(),true);
  assert.ok(requests.some(r=>r.path==='/public/api/v1/report/campaign'&&r.params?.get?.('campaignIds[]')==='1')||requests.some(r=>r.path==='/public/api/v1/report/campaign'));
  const campaignClicks=await clickValue();
  const campaignOtherMetrics=await metricValues();
  // Report rows carry spend as `cost` (7 per day for 30 days).
  assert.equal(await campaigns.locator('.cards [data-metric="costs"] .card-value').textContent(),'210,00 $','A selected campaign reads its spend from cost');
  await uniqueCheckbox.check();
  await reportsReady();
  assert.equal(Number((await clickValue()).replace(/\s/g,'')),Array.from({length:30},(_,index)=>Math.floor((37+index*5)/4)).reduce((sum,value)=>sum+value,0),'A selected campaign uses tracker unique_clicks for all thirty buckets');
  assert.deepEqual(await metricValues(),campaignOtherMetrics,'Tracker unique clicks in a selected campaign do not recalculate other metrics or ratios');
  assert.equal(await compositionTotal(),250,'Selected-campaign composition also uses tracker unique_clicks');
  await uniqueCheckbox.uncheck();
  await reportsReady();
  assert.equal(await clickValue(),campaignClicks);
  // The same campaign in a period without traffic shows zero clicks, not «—».
  emptyCampaignReports.add('1');
  await campaigns.locator('[data-action="refresh"]').click();
  await reportsReady();
  assert.equal(await clickValue(),'0','A selected campaign without traffic shows zero clicks in the overview');
  assert.equal(await campaigns.locator('.cards [data-metric="costs"] .card-value').textContent(),'0,00 $','Zero spend from cost, not «—»');
  emptyCampaignReports.clear();
  await campaigns.locator('[data-action="refresh"]').click();
  await reportsReady();
  assert.equal(await clickValue(),campaignClicks);
  await campaigns.locator('[data-query="campaignId"]').selectOption('');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.updated')?.textContent.startsWith('Обновлено'));

  const botsCheckbox=campaigns.locator('[data-query="hideBots"]');
  async function reportsReady() {
    await campaigns.waitForFunction(()=>{
      const root=document.querySelector('#binom-dashboard-extension')?.shadowRoot;
      const insights=root?.querySelector('.insights-root');
      return /^(Обновлено|Updated)/.test(root?.querySelector('.updated')?.textContent||'')&&(insights?.hidden||insights?.dataset.state==='ready');
    });
  }
  await reportsReady();
  assert.equal(requests.find(request=>request.path.endsWith('/trends')).query.status,'with_traffic','The overview defaults to campaigns with traffic');
  assert.equal(requests.filter(request=>request.path.endsWith('/campaign/list/filtered')).every(request=>!Object.hasOwn(request.query,'status')),true,'Campaign choices come from the complete catalog, independently of Trends traffic status');
  const beforeOneDay=requests.length;
  await campaigns.locator('[data-query="datePreset"]').selectOption('today');
  await reportsReady();
  assert.ok(requests.slice(beforeOneDay).some(request=>request.path.endsWith('/trends')&&request.query.grouping==='hours'),'A one-day overview automatically requests hourly Trends');
  const beforeMultiDay=requests.length;
  await campaigns.locator('[data-query="datePreset"]').selectOption('last_7_days');
  await reportsReady();
  assert.ok(requests.slice(beforeMultiDay).some(request=>request.path.endsWith('/trends')&&request.query.grouping==='days'),'A multi-day overview automatically requests daily Trends');
  assert.equal(requests.filter(request=>request.path.endsWith('/trends')).every(request=>request.query.status==='with_traffic'),true,'Period changes retain the fixed traffic status');
  async function clicklogAfter(before) {
    // Wait for the reload that the action caused, then for its rendered page.
    const deadline=Date.now()+10000;
    while(!requests.slice(before).some(r=>r.path.endsWith('/clicklog'))) {
      if(Date.now()>deadline)throw new Error('The click log was not reloaded');
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.clicklog-root')?.dataset.state==='ready');
    return campaigns.locator('.clicklog-table tbody td[data-column="is_bot"]').allTextContents();
  }
  const beforeBotFilter=requests.length;
  await botsCheckbox.check();
  await reportsReady();
  assert.equal(await campaigns.locator('.card-value').first().textContent(),'400','Checking the real bot filter must display the API-filtered click total');
  const filteredBots=await clicklogAfter(beforeBotFilter);
  assert.ok(filteredBots.length>0&&filteredBots.every(value=>value==='Нет'),'Recent clicks follow Exclude bots');
  // Every fifth stand click is a bot; page two starts with one. Paging must use the unfiltered page edges.
  const clicklogRequests=()=>requests.filter(r=>r.path.endsWith('/clicklog'));
  const firstPage=clicklogRequests().at(-1), pageSize=Number(firstPage.query.limit);
  const beforeNext=requests.length;
  await campaigns.locator('.clicklog-pagination button').last().click();
  assert.ok((await clicklogAfter(beforeNext)).every(value=>value==='Нет'));
  assert.equal(clicklogRequests().at(-1).query.cursor,String(10000-(pageSize-1)),'Next page starts after the last unfiltered click');
  const beforePrev=requests.length;
  await campaigns.locator('.clicklog-pagination button').first().click();
  await clicklogAfter(beforePrev);
  assert.deepEqual([clicklogRequests().at(-1).query.cursor,clicklogRequests().at(-1).query.direction],[String(10000-pageSize),'prev'],'Previous page ends before the first unfiltered click, even a hidden bot');
  assert.equal(await campaigns.locator('.clicklog-table tbody tr').count(),pageSize-pageSize/5,'A page shows its clicks without Binom-marked bots');
  await campaigns.screenshot({path:'.test-results/extension-hide-bots-sparse.png'});
  const beforeBotsBack=requests.length;
  await botsCheckbox.uncheck();
  await reportsReady();
  assert.equal(await campaigns.locator('.card-value').first().textContent(),'420','Removing the bot filter must restore all clicks');
  assert.ok((await clicklogAfter(beforeBotsBack)).includes('Да'),'Unchecking Exclude bots shows marked bot clicks again');
  assert.ok(requests.some(request=>request.path.endsWith('/trends')&&request.query.hideBots==='1'),'The checkbox must reach the Trends API');
  // An older filtered response can arrive after the user has already disabled it.
  // Hold that response deliberately so this regression is independent of timing.
  let trendStarted,releaseTrend;
  const startedTrend=new Promise(resolve=>{trendStarted=resolve;});
  nextTrendHold={started:trendStarted,release:new Promise(resolve=>{releaseTrend=resolve;})};
  await botsCheckbox.check();
  let holdTimeout;
  try { await Promise.race([startedTrend,new Promise((_,reject)=>{holdTimeout=setTimeout(()=>reject(new Error('Filtered Trends request was not started')),5000);})]); }
  finally { clearTimeout(holdTimeout); }
  await botsCheckbox.uncheck();
  await campaigns.evaluate(()=>{
    const root=document.querySelector('#binom-dashboard-extension').shadowRoot;
    window.fixtureBotTotals=[];
    window.fixtureBotObserver=new MutationObserver(()=>{
      const total=root.querySelector('.card-value')?.textContent;
      if(total&&total!=='—')window.fixtureBotTotals.push(total);
    });
    window.fixtureBotObserver.observe(root.querySelector('.cards'),{childList:true,subtree:true,characterData:true});
  });
  releaseTrend();
  await reportsReady();
  assert.equal(await botsCheckbox.isChecked(),false);
  assert.equal(await campaigns.locator('.card-value').first().textContent(),'420','The most recent filter selection wins over an older delayed response');
  const observedBotTotals=await campaigns.evaluate(()=>{window.fixtureBotObserver.disconnect();return window.fixtureBotTotals;});
  assert.ok(observedBotTotals.length>0);
  assert.ok(observedBotTotals.every(value=>value==='420'),'A superseded filtered response must never briefly repaint the total');
  const trendRequests=requests.filter(r=>r.path.endsWith('/trends'));
  assert.equal(trendRequests.filter(r=>r.query.hideBots!=='1').every(r=>r.query.offset==='0'),true,'Complete seven-day report must not request another page');
  // A sparse filtered series is confirmed by one repeated request and never paginated further.
  assert.ok(trendRequests.some(r=>r.query.hideBots==='1'&&r.query.offset==='1'),'A sparse filtered series is confirmed by one repeated request');
  assert.equal(trendRequests.filter(r=>r.query.hideBots==='1').every(r=>['0','1'].includes(r.query.offset)),true,'A repeated sparse series must not be paginated further');
  assert.equal(requests.find(r=>r.path.endsWith('/trends')).query.grouping,'days');
  assert.equal(await campaigns.locator('#binom-dashboard-extension').count(),1);
  assert.equal(await campaigns.evaluate(()=>document.documentElement.outerHTML.includes('TEST-ONLY')),false);
  const state=await settings.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  assert.equal(JSON.stringify(state.local).includes(key),false);
  assert.equal(JSON.stringify(state.local).includes('TEST-ONLY-TEMP-LOGIN'),false);
  assert.equal(state.local.config.campaignsPath,'/panel/campaigns');
  assert.equal(state.session.apiKey.key,key);
  assert.equal(state.local.keyVault.version,1);
  assert.equal(state.local.keyVault.credentialId,state.session.apiKey.credentialId);
  assert.equal(JSON.stringify(state).includes(vaultPassword),false,'Password is never persisted in either extension storage area');
  assert.equal(JSON.stringify(state).includes('synthetic-settings@example.invalid'),false,'Unrelated fields returned by settings/info are not persisted');
  for(const type of ['GET_CAMPAIGNS','GET_CAMPAIGN_CHARTS','GET_INSIGHTS']) {
    const denied=await settings.evaluate(type=>chrome.runtime.sendMessage({type,campaignIds:['1']}),type);
    assert.equal(denied.ok,false);assert.equal(denied.error.code,'ACCESS_DENIED','Options cannot proxy API requests');
  }
  assert.deepEqual(await campaigns.locator('.insight-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.insight)),['breakdowns'],'Traffic composition is the only remaining insight');
  assert.equal(await campaigns.locator('.insight-card:visible').count(),1);
  assert.equal(await campaigns.locator('.insight-settings, .threshold-settings, .heatmap-cell, .pace-stats, .efficiency-cards').count(),0);
  const compositionTabs=['Кампании','Группы','Источники','Страны'];
  const visibleCompositionTabs=()=>campaigns.locator('.breakdown-tabs button').allTextContents();
  assert.deepEqual(await visibleCompositionTabs(),compositionTabs,'Campaigns lead the composition tabs; sources immediately precede countries');
  for(const name of compositionTabs) {
    await campaigns.locator('[data-insight="breakdowns"]').getByRole('button',{name,exact:true}).click();
    assert.equal(await campaigns.locator('[data-insight="breakdowns"] .insight-error').count(),0);
    assert.equal(await campaigns.locator('[data-insight="breakdowns"] .breakdown-row').count(),2,`${name}: both categorical rows must render`);
    assert.equal(await campaigns.locator('[data-insight="breakdowns"] .breakdown-figure').count(),1,`${name}: categorical rows have a diagram`);
  }
  for(const [filter,value,hiddenTab,hiddenGrouping] of [
    ['groupId',fixtureGroups[0].uuid,'Группы','campaignsGroup'],
    ['sourceId','1','Источники','trafficSource'],
    ['campaignId','1','Кампании','campaign'],
  ]) {
    const beforeFilter=requests.length;
    await campaigns.locator(`[data-query="${filter}"]`).selectOption(value);
    await reportsReady();
    assert.deepEqual(await visibleCompositionTabs(),compositionTabs.filter(tab=>tab!==hiddenTab),`${hiddenTab}: a fixed filter hides its redundant composition tab`);
    assert.equal(requests.slice(beforeFilter).some(request=>request.path.endsWith('/report/campaign')&&request.query['groupings[]']===hiddenGrouping),false,`${hiddenTab}: the hidden dimension does not request reports`);
    assert.equal(await campaigns.locator('.breakdown-tabs [aria-pressed="true"]').count(),1,'A visible composition dimension stays selected');
    assert.equal(await campaigns.locator('[data-insight="breakdowns"] .insight-error').count(),0,'Filtered composition remains available');
    await campaigns.locator(`[data-query="${filter}"]`).selectOption('');
    await reportsReady();
    assert.deepEqual(await visibleCompositionTabs(),compositionTabs,`${hiddenTab}: clearing the filter restores the tab`);
  }
  await campaigns.locator('[data-insight="breakdowns"]').getByRole('button',{name:'Источники',exact:true}).click();
  assert.equal(requests.some(request=>request.path.endsWith('/report/campaign')&&request.query['groupings[]']==='deviceType'),false,'Device composition never requests reports');
  assert.equal(requests.filter(request=>request.path.endsWith('/report/campaign')&&request.query['groupings[]']==='geoCountry').every(request=>request.query.offset==='0'),true,'A complete country total must not trigger an out-of-range request');
  const compositionRequests=()=>requests.filter(request=>request.path.endsWith('/report/campaign')&&['campaign','trafficSource','campaignsGroup','geoCountry'].includes(request.query['groupings[]'])).length;
  const compositionBeforeComparison=compositionRequests();
  await campaigns.locator('[data-mode="campaigns"]').click();
  assert.equal(await campaigns.locator('.insights-root').isVisible(),false,'Empty comparison does not display overview composition');
  await campaigns.locator('[data-action="pick-campaigns"]').click();
  assert.equal(await campaigns.locator('.campaign-controls .campaign-option').count(),0,'Comparison campaign groups start collapsed');
  for(const [index,id] of ['1','2'].entries()) {
    await campaigns.locator(`.campaign-controls .campaign-group-toggle[data-group-id="${fixtureGroups[index].uuid}"]`).click();
    await campaigns.locator(`.campaign-controls .campaign-option input[value="${id}"]`).check();
  }
  await campaigns.locator('[data-action="apply-campaigns"]').click();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.updated')?.textContent.startsWith('Обновлено'));
  assert.equal(await campaigns.locator('.campaign-chip').count(),2);
  assert.equal(await campaigns.locator('.chart canvas').count(),1);
  const reportRequests=requests.filter(r=>r.path.endsWith('/report/campaign')&&r.query['groupings[]']==='days');
  assert.ok(reportRequests.some(r=>r.query['ids[]']==='1'));
  assert.ok(reportRequests.some(r=>r.query['ids[]']==='2'));
  assert.equal(await campaigns.locator('.insights-root').isVisible(),false,'Selected campaigns do not restore overview composition');
  assert.equal(await campaigns.locator('[data-insight="top"]').count(),0,'Ranking is removed in every mode');
  assert.equal(compositionRequests(),compositionBeforeComparison,'Comparison does not load composition reports');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.clicklog-root')?.dataset.state==='ready');
  assert.equal(await campaigns.locator('.clicklog-root').isVisible(),true,'Comparison retains latest clicks');
  async function botSensitiveValues() {
    return campaigns.evaluate(()=>{
      const root=document.querySelector('#binom-dashboard-extension').shadowRoot;
      const number=value=>Number(value.replace(/[^\d.-]/g,''));
      return [...root.querySelectorAll('.campaign-total')].map(node=>number(node.textContent));
    });
  }
  const allBotValues=await botSensitiveValues();
  await uniqueCheckbox.check();
  await reportsReady();
  assert.deepEqual(await botSensitiveValues(),[1,2].map(id=>Array.from({length:7},(_,index)=>Math.floor((id*37+index*5)/4)).reduce((sum,value)=>sum+value,0)),'Comparison uses tracker unique_clicks within each campaign');
  await campaigns.evaluate(()=>window.scrollTo(0,0));
  await campaigns.screenshot({path:'.test-results/extension-unique-comparison.png'});
  await uniqueCheckbox.uncheck();
  await reportsReady();
  assert.deepEqual(await botSensitiveValues(),allBotValues,'Comparison restores the original click counts');
  await botsCheckbox.check();
  await reportsReady();
  const filteredBotValues=await botSensitiveValues();
  assert.ok(allBotValues.length>0,'Selected campaigns expose totals');
  assert.equal(filteredBotValues.length,allBotValues.length);
  assert.ok(filteredBotValues.every((value,index)=>Number.isFinite(value)&&value<allBotValues[index]),'Checking the bot filter reduces every displayed campaign total');
  await botsCheckbox.uncheck();
  await reportsReady();
  assert.deepEqual(await botSensitiveValues(),allBotValues,'Campaigns restore unfiltered totals');
  // A campaign without traffic is a zero line, not «—» or «Показатели недоступны».
  const totalsWithTraffic=await campaigns.locator('.campaign-total').allTextContents();
  assert.equal(totalsWithTraffic.some(text=>text==='0'||text==='—'),false,'Both fixture campaigns have traffic before the scenario');
  emptyCampaignReports.add('2');
  await campaigns.locator('[data-action="refresh"]').click();
  await reportsReady();
  assert.deepEqual(await campaigns.locator('.campaign-total').allTextContents(),[totalsWithTraffic[0],'0'],'A campaign without traffic shows zero clicks');
  emptyCampaignReports.add('1');
  await campaigns.locator('[data-action="refresh"]').click();
  await reportsReady();
  assert.deepEqual(await campaigns.locator('.campaign-total').allTextContents(),['0','0'],'Several campaigns without traffic all show zero clicks');
  assert.equal(await campaigns.locator('.state').isHidden(),true,'Campaigns without traffic still draw the chart instead of «Показатели недоступны»');
  emptyCampaignReports.clear();
  await campaigns.locator('[data-action="refresh"]').click();
  await reportsReady();
  assert.deepEqual(await campaigns.locator('.campaign-total').allTextContents(),totalsWithTraffic,'Traffic returns after the scenario');
  assert.equal(compositionRequests(),compositionBeforeComparison,'Comparison bot changes do not request hidden composition');
  console.log('Bot filter UI: overview, selected campaigns and stale-response protection passed.');
  const reportCount=requests.filter(r=>r.path.endsWith('/report/campaign')).length;
  await campaigns.locator('[data-preference="campaignMetric"]').selectOption('roi');
  assert.equal(requests.filter(r=>r.path.endsWith('/report/campaign')).length,reportCount);
  await campaigns.locator('[data-query="datePreset"]').selectOption('today');
  await reportsReady();
  await botsCheckbox.check();
  await reportsReady();
  await uniqueCheckbox.check();
  await reportsReady();
  const requestsBeforeComparisonReset=requests.length;
  await campaigns.locator('[data-action="reset-filters"]').click();
  async function assertEmptyComparison() {
    await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.updated')?.textContent==='Кампании не выбраны');
    assert.equal(await campaigns.locator('[data-mode="campaigns"]').getAttribute('aria-pressed'),'true','Reset preserves the comparison tab');
    assert.equal(await campaigns.locator('.campaign-controls').isVisible(),true);
    assert.equal(await campaigns.locator('.insights-root').isVisible(),false,'Reset in comparison does not restore overview composition');
    assert.equal(await campaigns.locator('.cards').isVisible(),false);
    assert.equal(await campaigns.locator('.campaign-chip').count(),0,'Reset removes every selected campaign');
    assert.equal(await campaigns.locator('.state-title').textContent(),'Выберите кампании для сравнения');
    assert.equal(await campaigns.locator('[data-preference="campaignMetric"]').inputValue(),'clicks','Reset restores clicks as the comparison metric');
    assert.equal(await campaigns.locator('[data-query="datePreset"]').inputValue(),'last_30_days');
    for(const key of ['campaignId','groupId','sourceId'])assert.equal(await campaigns.locator(`[data-query="${key}"]`).inputValue(),'');
    for(const key of ['compare','hideBots','uniqueClicks'])assert.equal(await campaigns.locator(`[data-query="${key}"]`).isChecked(),false);
  }
  await assertEmptyComparison();
  await settings.waitForFunction(async()=>{
    const {preferences}=await chrome.storage.local.get('preferences');
    return preferences?.mode==='campaigns'&&preferences.campaignIds?.length===0&&preferences.campaignMetric==='clicks'&&!preferences.overviewCampaignId;
  });
  await campaigns.reload();
  await assertEmptyComparison();
  assert.equal(requests.slice(requestsBeforeComparisonReset).some(request=>request.path.endsWith('/trends')||request.path.endsWith('/report/campaign')),false,'Reset and reload with no selected campaigns do not fetch chart or composition reports');
  assert.equal(compositionRequests(),compositionBeforeComparison,'Reset and reload stay inside the empty comparison mode');
  await campaigns.locator('[data-action="pick-campaigns"]').click();
  for(const [index,id] of ['1','2'].entries()) {
    await campaigns.locator(`.campaign-controls .campaign-group-toggle[data-group-id="${fixtureGroups[index].uuid}"]`).click();
    const selection=campaigns.locator(`.campaign-controls .campaign-option input[value="${id}"]`);
    assert.equal(await selection.isChecked(),false,'Reload does not restore the selection cleared by reset');
    await selection.check();
  }
  await campaigns.locator('[data-action="apply-campaigns"]').click();
  await reportsReady();
  assert.equal(await campaigns.locator('.campaign-chip').count(),2,'Campaign comparison remains usable after reset and reload');
  await campaigns.locator('[data-mode="overview"]').click();
  await reportsReady();
  assert.equal(await campaigns.locator('.insight-card:visible').count(),1,'Returning to overview restores composition');
  const compositionAfterOverview=compositionRequests();
  await campaigns.locator('[data-mode="campaigns"]').click();
  await reportsReady();
  assert.equal(await campaigns.locator('.insights-root').isVisible(),false);
  assert.equal(compositionRequests(),compositionAfterOverview,'Returning to comparison does not load composition');
  const legacyInsightSections=['leaders','top','attention','pace','heatmap','breakdowns','efficiency'];
  // Legacy saved selections remain compatible storage data, but cannot create
  // controls or silently change the active period, campaigns, metric or grouping.
  const legacySelections=['days','hours'].map(grouping=>({id:`legacy-${grouping}`,name:`Legacy ${grouping}`,
    campaignIds:['1'],campaignMetric:'roi',datePreset:'yesterday',grouping,hideBots:true}));
  assert.equal((await settings.evaluate(preferences=>chrome.runtime.sendMessage({type:'SAVE_PREFERENCES',preferences}),
    {savedSelections:legacySelections,insightsSections:legacyInsightSections})).ok,true);
  const beforeLegacyReload=requests.length;
  await campaigns.reload();
  await reportsReady();
  assert.equal(await campaigns.locator('.insight-card:visible').count(),0,'Legacy enabled sections cannot restore analytics in comparison');
  assert.deepEqual(await campaigns.locator('.insight-card').evaluateAll(nodes=>nodes.map(node=>node.dataset.insight)),['breakdowns'],'Legacy preferences cannot restore removed insight cards');
  assert.equal(compositionRequests(),compositionAfterOverview,'Reloading comparison does not fetch hidden composition');
  assert.equal(requests.some(request=>request.path.endsWith('/report/campaign')&&request.query['groupings[]']==='campaign'),true,'The overview campaign composition requests campaign-grouped data');
  assert.equal(await campaigns.locator('.saved-area, .saved-selections, .save-selection-form, [data-action="save-selection"]').count(),0,'Legacy saved selections cannot restore removed controls');
  assert.equal(await campaigns.locator('.campaign-chip').count(),2);
  assert.equal(await campaigns.locator('[data-preference="campaignMetric"]').inputValue(),'clicks');
  assert.equal(await campaigns.locator('[data-query="datePreset"]').inputValue(),'last_30_days','Reload uses the default period; legacy selections do not override it');
  assert.equal(await botsCheckbox.isChecked(),false);
  const savedClickColumns=['click_time','ip','country','device','os','browser','campaign','user_agent','traffic_source','is_bot'];
  assert.deepEqual(await campaigns.locator('.clicklog-table th').evaluateAll(nodes=>nodes.map(node=>node.dataset.column)),savedClickColumns,'Reload preserves a customized column set in schema order, without restoring default ID');
  assert.ok(requests.slice(beforeLegacyReload).some(request=>request.path.endsWith('/report/campaign')&&request.query['groupings[]']==='days'&&request.query['ids[]']==='1'),'Legacy preferences do not override automatic grouping for the current multi-day report');
  const persisted=await settings.evaluate(async()=> (await chrome.storage.local.get('preferences')).preferences);
  assert.deepEqual(persisted.clicklogColumns,savedClickColumns);
  assert.deepEqual(persisted.savedSelections.map(selection=>selection.grouping),['days','hours'],'Reading a profile preserves legacy selection data without applying it');
  async function connectionDraft() {
    return settings.evaluate(()=>({open:document.getElementById('connection-editor').open,
      trackerUrl:document.getElementById('tracker-url').value}));
  }
  const originalConnectionDraft=await connectionDraft();
  if(!originalConnectionDraft.open)await settings.locator('#connection-editor > summary').click();
  const unsavedConnectionDraft={open:true,trackerUrl:origin+'/panel/campaigns?draft=1'};
  await settings.locator('#tracker-url').fill(unsavedConnectionDraft.trackerUrl);
  // Load the actual packaged action document in an extension-origin tab. This
  // exercises its controls and exact sender boundary with the real worker.
  const popup=await context.newPage();
  await popup.setViewportSize({width:338,height:560});
  popup.on('pageerror',e=>console.log('Popup page error:',e.message));
  await popup.goto(`chrome-extension://${extensionId}/${manifest.action.default_popup}`);
  // The dashboard toggle is a switch named "Дашборд".
  await popup.getByRole('switch',{name:'Дашборд',exact:true,checked:true}).waitFor();
  assert.equal(await popup.getByRole('combobox',{name:'Дизайн',exact:true}).count(),0,'The popup has no design choice');
  assert.equal(await popup.locator('#open-settings').isEnabled(),true);
  assert.equal(await campaigns.locator('.bd[data-design="binom"]').count(),1);
  const filtersBeforeLanguage=await campaigns.locator('[data-query]').evaluateAll(nodes=>nodes.map(n=>[n.dataset.query,n.type==='checkbox'?n.checked:n.value]));
  const compositionBeforeLanguage=await campaigns.locator('.insights-root').isVisible();
  const languageConnectionBefore=await settings.evaluate(async()=>({local:await chrome.storage.local.get(['config','keyVault','credentialId']),session:await chrome.storage.session.get(null)}));
  await popup.locator('#language').selectOption('en');
  await campaigns.locator('.bd[lang="en"]').waitFor();
  await reportsReady();
  await settings.waitForFunction(()=>document.documentElement.lang==='en');
  assert.deepEqual(await campaigns.locator('[data-query]').evaluateAll(nodes=>nodes.map(n=>[n.dataset.query,n.type==='checkbox'?n.checked:n.value])),filtersBeforeLanguage,'Language switching preserves active dashboard filters');
  assert.equal(await campaigns.locator('.insights-root').isVisible(),compositionBeforeLanguage,'Language switching preserves overview/comparison mode');
  assert.equal(await campaigns.locator('[data-mode="overview"]').textContent(),'Overview');
  assert.equal(await campaigns.locator('.clicklog-head h3').textContent(),'Recent clicks');
  assert.deepEqual(await connectionDraft(),unsavedConnectionDraft,'Language switching preserves unsaved connection fields');
  assert.deepEqual(await settings.evaluate(async()=>({local:await chrome.storage.local.get(['config','keyVault','credentialId']),session:await chrome.storage.session.get(null)})),languageConnectionBefore,'Language does not change the connection or key');
  assert.equal(await popup.locator('html').getAttribute('lang'),'en');
  await mkdir('.test-results',{recursive:true});
  await campaigns.screenshot({path:'.test-results/extension-dashboard-english.png',fullPage:true});
  await popup.locator('body').screenshot({path:'.test-results/extension-popup-english.png'});
  await settings.screenshot({path:'.test-results/extension-options-english.png',fullPage:true});
  // The styled language list also works from the keyboard.
  const popupLanguage=popup.getByRole('combobox',{name:'Language',exact:true});
  await popupLanguage.press('End');
  await popupLanguage.press('Enter');
  await campaigns.locator('.bd[lang="ru"]').waitFor();
  await reportsReady();
  await settings.waitForFunction(()=>document.documentElement.lang==='ru');
  assert.deepEqual(await campaigns.locator('[data-query]').evaluateAll(nodes=>nodes.map(n=>[n.dataset.query,n.type==='checkbox'?n.checked:n.value])),filtersBeforeLanguage);
  await mkdir('.test-results',{recursive:true});
  await switchNative('dark');
  const binomDark=await campaigns.locator('.bd[data-design="binom"]').evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
  await campaigns.screenshot({path:'.test-results/extension-dashboard-binom-dark.png',fullPage:true});
  await switchNative('light');
  assert.equal(await campaigns.locator('.bd[data-design="binom"].light').count(),1);
  const binomLight=await campaigns.locator('.bd[data-design="binom"]').evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
  assert.notEqual(binomLight.background,binomDark.background,'Native Binom palette drives the dashboard background');
  assert.notEqual(binomLight.color,binomDark.color,'Native Binom palette keeps foreground text readable');
  await campaigns.screenshot({path:'.test-results/extension-dashboard-binom-light.png',fullPage:true});
  await campaigns.setViewportSize({width:720,height:1080});
  await campaigns.waitForFunction(()=>{
    const panel=document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.bd');
    const view=document.querySelector('[data-binom-dashboard-view]');
    return panel&&view&&panel.scrollWidth<=panel.clientWidth+1&&view.scrollWidth<=view.clientWidth+1;
  });
  await campaigns.locator('[data-binom-dashboard-view]').screenshot({path:'.test-results/extension-dashboard-binom-narrow.png'});
  await campaigns.setViewportSize({width:1500,height:1080});
  assert.deepEqual(await connectionDraft(),unsavedConnectionDraft,'Popup changes preserve unsaved connection fields and the open editor');
  // A stale dashboard button makes completion of the real focus refresh observable
  // without mocking its worker response or relying on a fixed timeout.
  await settings.evaluate(()=>{document.getElementById('open-dashboard').hidden=true;});
  await popup.bringToFront();
  await settings.bringToFront();
  // Headless Chromium does not consistently emit window focus on tab activation.
  // Exercise that handler explicitly; its GET_STATUS still uses the real worker.
  await settings.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await settings.waitForFunction(()=>!document.getElementById('open-dashboard').hidden);
  assert.deepEqual(await connectionDraft(),unsavedConnectionDraft,'Returning focus to options refreshes dashboard availability without discarding the connection draft');
  await popup.locator('body').screenshot({path:'.test-results/extension-popup.png'});
  const connectionBeforeToggle=await settings.evaluate(async()=>({
    local:await chrome.storage.local.get(['config','keyVault','credentialId']),session:await chrome.storage.session.get(null),
  }));
  await popup.locator('#toggle-dashboard').click();
  await popup.getByRole('switch',{name:'Дашборд',exact:true,checked:false}).waitFor();
  await settings.waitForFunction(()=>document.getElementById('open-dashboard').hidden);
  async function assertDisabledDashboard() {
    await campaigns.waitForFunction(()=>!document.querySelector('#binom-dashboard-extension')&&!document.querySelector('[data-binom-dashboard-view]')&&!document.querySelector('[data-binom-dashboard-nav]'));
    assert.equal(await campaigns.locator('main').getAttribute('inert'),null,'Disabling restores native controls');
    assert.equal(await campaigns.locator('main').getAttribute('aria-hidden'),null,'Disabling restores native accessibility');
    assert.equal(await campaigns.locator('main > .fixture-table-container table').isVisible(),true);
    assert.equal(new URL(campaigns.url()).searchParams.has('binomDashboard'),false,'Disabled dashboard relinquishes its route marker');
    await assertNativeCampaignState(true);
  }
  await assertDisabledDashboard();
  const disabledPreferences=await settings.evaluate(async()=>(await chrome.storage.local.get('preferences')).preferences);
  assert.equal(disabledPreferences.dashboardEnabled,false);
  assert.equal(Object.hasOwn(disabledPreferences,'design'),false,'No design preference is stored');
  assert.deepEqual(disabledPreferences.savedSelections,persisted.savedSelections);
  assert.deepEqual(await settings.evaluate(async()=>({local:await chrome.storage.local.get(['config','keyVault','credentialId']),session:await chrome.storage.session.get(null)})),connectionBeforeToggle,'Disabling retains both encrypted and unlocked key state');
  await campaigns.reload();
  await assertDisabledDashboard();
  await popup.reload();
  await popup.getByRole('switch',{name:'Дашборд',exact:true,checked:false}).waitFor();
  await assertDisabledDashboard();
  // The "Дашборд" label is a larger target for the same switch.
  await popup.locator('#dashboard-label').click();
  await popup.getByRole('switch',{name:'Дашборд',exact:true,checked:true}).waitFor();
  await mainMenu.getByRole('link',{name:'Dashboard',exact:true}).waitFor();
  assert.equal(await campaigns.locator('#binom-dashboard-extension').count(),0,'Enabling restores navigation without taking over the current page');
  assert.equal(new URL(campaigns.url()).searchParams.has('binomDashboard'),false);
  await assertMenuPlacement();
  await mainMenu.getByRole('link',{name:'Dashboard',exact:true}).click();
  await reportsReady();
  assert.equal(await campaigns.locator('.bd[data-design="binom"].light').count(),1);
  assert.equal(await campaigns.locator('.saved-selections, .saved-area').count(),0);
  assert.deepEqual(await settings.evaluate(async()=>({local:await chrome.storage.local.get(['config','keyVault','credentialId']),session:await chrome.storage.session.get(null)})),connectionBeforeToggle,'Re-enabling reuses the saved connection without asking for a key');
  await campaigns.reload();
  await reportsReady();
  assert.equal(await campaigns.locator('.bd[data-design="binom"].light').count(),1,'Binom design survives page reload');
  await popup.close();
  assert.deepEqual(await connectionDraft(),unsavedConnectionDraft,'Further popup toggles do not overwrite the open connection editor');
  // The settings page changes the language itself, like the popup,
  // without touching the open connection draft.
  await settings.getByRole('combobox',{name:'Язык',exact:true}).click();
  await settings.getByRole('option',{name:'English',exact:true}).click();
  await campaigns.locator('.bd[lang="en"]').waitFor();
  await settings.waitForFunction(()=>document.documentElement.lang==='en'&&!document.getElementById('ui-language').disabled);
  await settings.getByRole('combobox',{name:'Language',exact:true}).click();
  await settings.getByRole('option',{name:'Русский',exact:true}).click();
  await campaigns.locator('.bd[data-design="binom"][lang="ru"]').waitFor();
  await reportsReady();
  assert.deepEqual(await connectionDraft(),unsavedConnectionDraft,'Settings language changes preserve the connection draft');
  await settings.screenshot({path:'.test-results/extension-options-interface.png',fullPage:true});
  await settings.locator('#tracker-url').fill(originalConnectionDraft.trackerUrl);
  if(!originalConnectionDraft.open)await settings.locator('#connection-editor > summary').click();
  console.log('Popup UI: Binom design, native light/dark, disable/enable, reload persistence and unchanged saved key passed.');
  // The extension never restyles the tracker. With the dashboard enabled the
  // native pages keep their own geometry, typography, panels and colors.
  const trackerThemeApplied=()=>campaigns.evaluate(()=>document.documentElement.hasAttribute('data-binom-dashboard-theme')||document.documentElement.hasAttribute('data-binom-dashboard-appearance')||Boolean(document.getElementById('binom-dashboard-tracker-theme')));
  await switchNative('light');
  assert.equal(await trackerThemeApplied(),false,'No tracker-wide theme is applied');
  assert.equal(await campaigns.locator('.bd.binom.light').count(),1);
  await mkdir('.test-results',{recursive:true});
  await campaigns.screenshot({path:'.test-results/extension-dashboard-page.png',fullPage:true});
  await settings.screenshot({path:'.test-results/options.png',fullPage:true});
  await switchNative('dark');
  await campaigns.setViewportSize({width:720,height:1080});
  await campaigns.waitForFunction(()=>{
    const panel=document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.bd');
    const view=document.querySelector('[data-binom-dashboard-view]');
    return panel&&view&&panel.scrollWidth<=panel.clientWidth+1&&view.scrollWidth<=view.clientWidth+1;
  });
  assert.equal(await campaigns.locator('[data-binom-dashboard-view]').evaluate(view=>view.getBoundingClientRect().right<=window.innerWidth+1),true,'The dedicated dashboard must fit the narrow viewport without horizontal overflow');
  await campaigns.locator('[data-binom-dashboard-view]').screenshot({path:'.test-results/extension-dashboard-binom-dark-narrow.png'});
  await campaigns.setViewportSize({width:1500,height:1080});
  await switchNative(originalNativeTheme);
  await nativeCampaigns.click();
  await campaigns.waitForFunction(()=>!document.querySelector('#binom-dashboard-extension'));
  await mainMenu.getByRole('link',{name:'Dashboard',exact:true}).waitFor();
  assert.equal(await campaigns.locator('main > .fixture-table-container table').isVisible(),true);
  await assertMenuPlacement();
  await assertNativeCampaignState(true);
  assert.deepEqual(await nativeAppearance(),originalAppearance,'The native Campaigns page keeps its own look while the dashboard is enabled');
  assert.equal(await trackerThemeApplied(),false);
  await campaigns.screenshot({path:'.test-results/native-campaigns-'+originalNativeTheme+'.png',fullPage:true});
  await switchNative(originalNativeTheme==='dark'?'light':'dark');
  const otherAppearance=await nativeAppearance();
  assert.notEqual(otherAppearance.body.background,originalAppearance.body.background,'Binom switches its own palette');
  assert.equal(otherAppearance.rowHeight,originalAppearance.rowHeight);
  assert.equal(await trackerThemeApplied(),false);
  await assertMenuPlacement();
  await assertNativeCampaignState(true);
  await switchNative('light');
  await campaigns.goBack();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.campaign-chip'));
  await assertMenuPlacement();
  await assertNativeCampaignState(false);
  await campaigns.reload();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.campaign-chip'));
  assert.equal(await campaigns.locator('.saved-selections, .saved-area').count(),0,'Reload does not restore removed saved-selection UI');
  await assertMenuPlacement();
  await assertNativeCampaignState(false);
  // Reloads and native Vue-like workspace replacement must retain the header and
  // native geometry, with exactly one active extension surface.
  for(let iteration=0;iteration<3;iteration++) {
    await campaigns.reload();
    await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]')&&document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.campaign-chip'));
    await assertMenuPlacement();
    assert.equal(await campaigns.locator('[data-binom-dashboard-view]').count(),1);
    assert.ok(await campaigns.locator('main').evaluate(node=>node.clientWidth>100&&node.clientHeight>100));
  }
  await campaigns.evaluate(()=>{const old=document.querySelector('main');const next=old.cloneNode(true);next.removeAttribute('inert');next.removeAttribute('aria-hidden');old.replaceWith(next);});
  await campaigns.waitForFunction(()=>document.querySelector('main').inert&&document.querySelector('[data-binom-dashboard-view][data-ready="true"]'));
  assert.equal(await campaigns.locator('[data-binom-dashboard-view]').count(),1);
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1&fixtureRenderFailure=1');
  await campaigns.waitForFunction(()=>document.documentElement.dataset.fixtureRenderFailed==='true');
  assert.equal(await campaigns.locator('[data-binom-dashboard-view][data-ready="true"]').count(),0,'A failed render cannot cover Binom with an empty surface');
  assert.equal(await campaigns.locator('main').getAttribute('inert'),null);
  assert.equal(await campaigns.locator('main > .fixture-table-container table').isVisible(),true);
  await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]'));
  await assertMenuPlacement();
  // Without the search field the page is recognized only by the native active
  // tab and the title, both of which activation itself changes. The open Dashboard
  // must stay mounted instead of being destroyed and rebuilt with new API requests.
  const catalogRequests=()=>requests.filter(request=>request.path.endsWith('/groups/campaigns')).length;
  const catalogRequestsBeforeOpen=catalogRequests();
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1&fixtureNoSearch=1');
  await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]')&&document.querySelector('#binom-dashboard-extension')?.shadowRoot?.querySelector('.bd'));
  // Playwright locators pierce the open shadow root; count only Binom's own document.
  assert.equal(await campaigns.evaluate(()=>document.querySelectorAll('input[placeholder]').length),0,'This fixture has no campaign search field');
  // Observe only after the first widget's catalog request has reached the fixture server.
  for(let attempt=0;attempt<100&&catalogRequests()<=catalogRequestsBeforeOpen;attempt++)await campaigns.waitForTimeout(100);
  assert.ok(catalogRequests()>catalogRequestsBeforeOpen,'The first Dashboard loads its catalogs');
  await campaigns.evaluate(()=>{
    window.__fixtureMounts=0;
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)if(node.nodeType===1&&(node.id==='binom-dashboard-extension'||node.hasAttribute('data-binom-dashboard-view')))window.__fixtureMounts++;}).observe(document.documentElement,{childList:true,subtree:true});
  });
  const catalogRequestsBeforeWait=catalogRequests();
  await campaigns.waitForTimeout(2500);
  assert.equal(await campaigns.evaluate(()=>window.__fixtureMounts),0,'An open Dashboard must not be rebuilt in a loop when only the tab and title identify Campaigns');
  assert.equal(catalogRequests(),catalogRequestsBeforeWait,'A stable Dashboard must not reload catalogs while it stays open');
  assert.equal(await campaigns.locator('[data-binom-dashboard-view][data-ready="true"]').count(),1);
  assert.equal(await campaigns.title(),'Binom | Dashboard');
  assert.deepEqual(await campaigns.evaluate(()=>[...document.querySelectorAll('[aria-current="page"]')].map(node=>node.textContent.trim())),['Dashboard'],'No native signal other than the ones activation changed identifies Campaigns in this fixture');
  // Binom adds its own filter parameters to the address after start-up. That is
  // not navigation: the open Dashboard must keep its panel and must not load again.
  const catalogRequestsBeforeRewrite=catalogRequests();
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1&fixtureUrlRewrite=1');
  await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]')&&document.querySelector('#binom-dashboard-extension')?.shadowRoot?.querySelector('.bd'));
  await campaigns.waitForFunction(()=>document.documentElement.dataset.fixtureUrlRewritten==='true');
  assert.equal(await campaigns.evaluate(()=>document.documentElement.dataset.fixtureEarlyRewrite),'before-build','One rewrite lands between the content script start and the panel build, as on a real Binom');
  assert.deepEqual(await campaigns.evaluate(()=>['auth','status','dateType'].map(name=>new URL(location.href).searchParams.has(name))),[true,true,true],'The fixture rewrote the address with Binom-like filter parameters');
  // The content script compares addresses once per second; wait for two comparisons.
  await campaigns.waitForTimeout(2500);
  assert.equal(await campaigns.evaluate(()=>window.__fixtureHostAdds),1,'Binom rewriting its filter parameters must not rebuild the Dashboard: one page load builds the panel once');
  assert.equal(catalogRequests(),catalogRequestsBeforeRewrite+1,'One Dashboard opening loads its catalogs once');
  assert.equal(await campaigns.locator('[data-binom-dashboard-view][data-ready="true"]').count(),1);
  // Changing the section is still navigation and closes the Dashboard.
  // The once-per-second address check must close it. Without that check only the 15-second
  // status poll would, about 12 s later, so a short timeout tells the two apart.
  await campaigns.evaluate(()=>{const url=new URL(location.href);url.pathname='/panel/offers';history.pushState(null,'',url.href);});
  await campaigns.waitForFunction(()=>!document.querySelector('#binom-dashboard-extension')&&!document.querySelector('main[inert]'),null,{timeout:3000});
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1');
  await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]'));
  // Dashboard → Campaigns → Dashboard is a full page load. The period, dates,
  // filters and checkboxes the user chose must come back; the reset button still clears them.
  const dashboardState=()=>campaigns.evaluate(()=>{
    const root=document.querySelector('#binom-dashboard-extension').shadowRoot;
    return Object.fromEntries([...root.querySelectorAll('[data-query]')].map(control=>[control.dataset.query,control.type==='checkbox'?control.checked:control.value]));
  });
  const visitCampaignsAndReturn=async()=>{
    await mainMenu.getByRole('link',{name:'Campaigns',exact:true}).click();
    await campaigns.waitForFunction(()=>!document.querySelector('#binom-dashboard-extension')&&document.querySelector('main > .fixture-table-container table'));
    await campaigns.getByRole('link',{name:'Dashboard',exact:true}).click();
    await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]'));
    await reportsReady();
    // The group and source selects are filled when their catalogs arrive.
    await campaigns.waitForFunction(()=>{const root=document.querySelector('#binom-dashboard-extension').shadowRoot;return root.querySelectorAll('[data-query="groupId"] option').length>1&&root.querySelectorAll('[data-query="sourceId"] option').length>1;});
  };
  const storedFilters=()=>settings.evaluate(async()=>(await chrome.storage.local.get('preferences')).preferences.dashboardQuery);
  // The panel saves its filters asynchronously, and some controls (unique clicks, the
  // date fields) start no load that reportsReady() could wait for. Poll storage until
  // it holds the expected value (up to 5 s) instead of reading it once. An async
  // predicate in waitForFunction does not wait for its promise, so poll from the test.
  const storedFiltersWhen=async predicate=>{
    let stored=null;
    for(let attempt=0;attempt<50;attempt++){stored=await storedFilters();if(predicate(stored))break;await campaigns.waitForTimeout(100);}
    return stored;
  };
  const storedFiltersEqual=expected=>storedFiltersWhen(stored=>isDeepStrictEqual(stored,expected));
  assert.equal(await campaigns.locator('[data-mode="campaigns"]').getAttribute('aria-pressed'),'true','The scenario starts in the campaign comparison it restores at the end');
  await campaigns.locator('[data-mode="overview"]').click();
  await reportsReady();
  const defaultState=await dashboardState();
  assert.equal(defaultState.datePreset,'last_30_days');
  await campaigns.locator('[data-query="datePreset"]').selectOption('yesterday');
  await reportsReady();
  await campaigns.locator('[data-query="groupId"]').selectOption(fixtureGroups[1].uuid);
  await reportsReady();
  await campaigns.locator('[data-query="sourceId"]').selectOption('2');
  await reportsReady();
  for(const name of ['compare','hideBots','uniqueClicks']) { await campaigns.locator(`[data-query="${name}"]`).check(); await reportsReady(); }
  const chosenState=await dashboardState();
  assert.deepEqual([chosenState.datePreset,chosenState.groupId,chosenState.sourceId,chosenState.compare,chosenState.hideBots,chosenState.uniqueClicks],['yesterday',fixtureGroups[1].uuid,'2',true,true,true]);
  // Only the exact filter fields are stored, next to the connection; no key or statistics.
  const chosenFilters={datePreset:'yesterday',groupId:fixtureGroups[1].uuid,sourceId:'2',compare:true,hideBots:true,uniqueClicks:true};
  assert.deepEqual(await storedFiltersEqual(chosenFilters),chosenFilters,'Only the exact filter fields are stored');
  assert.deepEqual(Object.keys(await settings.evaluate(()=>chrome.storage.local.get(null))).sort(),['config','credentialId','keyVault','preferences']);
  await visitCampaignsAndReturn();
  assert.deepEqual(await dashboardState(),chosenState,'Dashboard keeps its period, filters and checkboxes after a visit to Campaigns');
  const [customFrom,customTo]=[-9,-3].map(offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10));
  await campaigns.locator('[data-query="datePreset"]').selectOption('custom_time');
  await campaigns.locator('[data-query="dateFrom"]').fill(customFrom);
  await campaigns.locator('[data-query="dateTo"]').fill(customTo);
  // Dates are stored when they settle, right before their load starts.
  const storedDates=await storedFiltersWhen(stored=>stored?.dateFrom===customFrom&&stored?.dateTo===customTo);
  assert.deepEqual([storedDates?.dateFrom,storedDates?.dateTo],[customFrom,customTo],'Settled custom dates are stored');
  await reportsReady();
  await visitCampaignsAndReturn();
  const customState=await dashboardState();
  assert.deepEqual([customState.datePreset,customState.dateFrom,customState.dateTo],['custom_time',customFrom,customTo],'Custom dates come back too');
  await campaigns.locator('[data-action="reset-filters"]').click();
  await reportsReady();
  // Leave only after the reset has reached storage, as a user would.
  const defaultFilters={datePreset:'last_30_days',groupId:'',sourceId:'',compare:false,hideBots:false,uniqueClicks:false};
  assert.deepEqual(await storedFiltersEqual(defaultFilters),defaultFilters,'Reset stores the default filters');
  await visitCampaignsAndReturn();
  const resetState=await dashboardState();
  assert.deepEqual({...resetState,dateFrom:undefined,dateTo:undefined},{...defaultState,dateFrom:undefined,dateTo:undefined},'Reset filters returns to the defaults, also after a visit to Campaigns');
  // An unreadable stored filter is dropped alone: the language and metrics survive.
  const preferencesBeforeCorruption=await settings.evaluate(async()=>(await chrome.storage.local.get('preferences')).preferences);
  await settings.evaluate(async preferences=>chrome.storage.local.set({preferences:{...preferences,dashboardQuery:{datePreset:'last_90_days'}}}),preferencesBeforeCorruption);
  await settings.reload();
  await settings.waitForFunction(()=>document.documentElement.lang==='ru'&&document.getElementById('connection-state').textContent==='Ключ разблокирован');
  await campaigns.reload();
  await campaigns.waitForFunction(()=>document.querySelector('[data-binom-dashboard-view][data-ready="true"]'));
  await reportsReady();
  assert.equal(await campaigns.locator('[data-mode="overview"]').textContent(),'Обзор','A bad stored filter does not reset the language');
  assert.equal((await dashboardState()).datePreset,'last_30_days','A bad stored filter falls back to the default period');
  await settings.evaluate(async preferences=>chrome.storage.local.set({preferences}),preferencesBeforeCorruption);
  // Reset also clears the compared campaigns (existing behaviour); restore the comparison
  // that later steps of this test rely on.
  {
    await campaigns.locator('[data-mode="campaigns"]').click();
    await campaigns.locator('[data-action="pick-campaigns"]').click();
    for(const [index,id] of ['1','2'].entries()) {
      await campaigns.locator(`.campaign-controls .campaign-group-toggle[data-group-id="${fixtureGroups[index].uuid}"]`).click();
      await campaigns.locator(`.campaign-controls .campaign-option input[value="${id}"]`).check();
    }
    await campaigns.locator('[data-action="apply-campaigns"]').click();
    await reportsReady();
    assert.equal(await campaigns.locator('.campaign-chip').count(),2);
  }
  await mainMenu.getByRole('link',{name:'Offers',exact:true}).click();
  await campaigns.waitForFunction(()=>location.pathname.endsWith('/offers')&&!document.querySelector('#binom-dashboard-extension'));
  assert.equal(await campaigns.locator('#binom-dashboard-extension').count(),0);
  assert.equal(await campaigns.locator('main').isVisible(),true);
  await switchNative('dark');
  assert.equal(await campaigns.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(34, 39, 49)');
  assert.equal(await campaigns.locator('#binom-dashboard-tracker-theme').count(),0,'No tracker theme on other sections');
  await campaigns.goto(origin+'/panel/login');
  await campaigns.waitForTimeout(700);
  assert.equal(await campaigns.locator('#binom-dashboard-tracker-theme').count(),0);
  assert.equal(await campaigns.getByRole('link',{name:'Dashboard',exact:true}).count(),0);
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.campaign-chip'));

  // Lock clears both active reports and the plaintext key, but retains selections.
  await settings.locator('#lock-key').click();
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Заблокировано');
  console.log('Vault UI: locked.');
  await campaigns.locator('.state').getByText('Разблокируйте сохранённый ключ или введите API-ключ в настройках расширения.',{exact:true}).waitFor();
  assert.equal(await campaigns.locator('.chart canvas').count(),0,'Locked dashboard must discard old chart data');
  assert.deepEqual(await settings.evaluate(()=>chrome.storage.session.get(null)),{});
  console.log('Vault UI: session cleared.');
  const lockedLocal=await settings.evaluate(()=>chrome.storage.local.get(null));
  assert.deepEqual(lockedLocal.preferences.savedSelections,persisted.savedSelections);
  const requestsWhileLocked=requests.length;
  await settings.locator('#unlock-password').fill('WRONG-TEST-PASSWORD');
  await settings.locator('#unlock').click();
  await settings.waitForFunction(()=>document.getElementById('feedback').textContent.includes('Не удалось разблокировать'));
  assert.equal(await settings.locator('#unlock-password').inputValue(),'');
  assert.deepEqual(await settings.evaluate(()=>chrome.storage.local.get(null)),lockedLocal);
  assert.equal(requests.length,requestsWhileLocked,'Wrong password must not send API requests');
  console.log('Vault UI: wrong password rejected.');
  await settings.reload();
  trackerTimezone='Europe/Moscow';
  settingsInfoDenied=true;
  const beforeDeniedUnlock=requests.length;
  await settings.locator('#unlock-password').fill(vaultPassword);
  await settings.locator('#unlock').click();
  await settings.locator('#feedback.error').waitFor();
  assert.equal(await settings.locator('#connection-state').textContent(),'Заблокировано','Denied timezone lookup cannot unlock with the stale saved timezone');
  assert.deepEqual(await settings.evaluate(()=>chrome.storage.session.get(null)),{});
  assert.deepEqual(await settings.evaluate(()=>chrome.storage.local.get(null)),lockedLocal,'A settings 403 during UNLOCK preserves config and ciphertext');
  assert.equal(await settings.locator('#unlock-password').inputValue(),'');
  assert.deepEqual(requests.slice(beforeDeniedUnlock).map(request=>request.path),['/public/api/v1/settings/info'],'A denied unlock must not issue statistics requests');
  settingsInfoDenied=false;
  const beforeTimezoneUnlock=requests.length;
  await settings.locator('#unlock-password').fill(vaultPassword);
  await settings.locator('#unlock').click();
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Ключ разблокирован');
  assert.equal(await settings.locator('#configured-timezone').textContent(),'Europe/Moscow','UNLOCK refreshes the timezone from Binom settings');
  assert.equal(await settings.evaluate(async()=>(await chrome.storage.local.get('config')).config.timezone),'Europe/Moscow');
  assert.deepEqual(await settings.evaluate(async()=>(await chrome.storage.local.get('keyVault')).keyVault),lockedLocal.keyVault,'Refreshing the timezone does not replace the encrypted credential');
  console.log('Vault UI: unlocked.');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.chart canvas'));
  assert.ok(requests.slice(beforeTimezoneUnlock).some(request=>request.path.endsWith('/report/campaign')&&request.query.timezone==='Europe/Moscow'),'Refreshed reports use the timezone returned at unlock');
  assert.equal(await campaigns.locator('.saved-selections, .saved-area').count(),0,'Unlock does not restore removed saved-selection UI');

  // Key replacement with identical URL must discard the previous user's totals.
  // The previous user's stored group and source must not survive either.
  await settings.evaluate(async group=>{const {preferences}=await chrome.storage.local.get('preferences');await chrome.storage.local.set({preferences:{...preferences,dashboardQuery:{datePreset:'yesterday',groupId:group,sourceId:'1',compare:false,hideBots:false,uniqueClicks:false}}});},fixtureGroups[0].uuid);
  await settings.locator('#connection-editor > summary').click();
  const beforeDeniedConnect=await settings.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  settingsInfoDenied=true;
  await settings.locator('#vault-password').fill(vaultPassword);
  await settings.locator('#vault-password-confirm').fill(vaultPassword);
  await settings.locator('#api-key').fill(key2);
  await settings.locator('#connect').click();
  await settings.locator('#feedback.error').waitFor();
  assert.deepEqual(await settings.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)})),beforeDeniedConnect,'A settings 403 during CONNECT preserves the working connection, session and encrypted key');
  assert.equal(await settings.locator('#configured-timezone').textContent(),'Europe/Moscow');
  for(const id of ['api-key','vault-password','vault-password-confirm'])assert.equal(await settings.locator('#'+id).inputValue(),'');
  settingsInfoDenied=false;
  trackerTimezone='UTC';
  await settings.locator('#vault-password').fill(vaultPassword);
  await settings.locator('#vault-password-confirm').fill(vaultPassword);
  await settings.locator('#api-key').fill(key2);await settings.locator('#connect').click();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.card-value')?.textContent==='7');
  await settings.waitForFunction(()=>document.getElementById('configured-timezone').textContent==='UTC');
  assert.equal(await settings.evaluate(async()=>(await chrome.storage.local.get('config')).config.timezone),'UTC','Replacing the connection fetches the new tracker timezone again');
  assert.deepEqual(await settings.evaluate(async()=> (await chrome.storage.local.get('preferences')).preferences.savedSelections),[],'Replacing the API user clears old saved campaign sets');
  const filtersAfterKeyChange=await settings.evaluate(async()=>(await chrome.storage.local.get('preferences')).preferences.dashboardQuery);
  assert.ok(!filtersAfterKeyChange||(filtersAfterKeyChange.groupId===''&&filtersAfterKeyChange.sourceId===''&&filtersAfterKeyChange.datePreset==='last_30_days'),'Replacing the API user drops the previous stored filters');
  assert.equal(await campaigns.locator('.card-value').nth(4).textContent(),'—');
  assert.equal(await campaigns.locator('#binom-dashboard-extension').count(),1);
  const restrictedOtherMetrics=await metricValues();
  await uniqueCheckbox.check();
  await reportsReady();
  assert.equal(await clickValue(),'—','Missing unique fields remain unavailable instead of copying clicks or inventing zero');
  assert.deepEqual(await metricValues(),restrictedOtherMetrics);
  assert.match(await campaigns.locator('.unique-clicks-note').textContent(),/«Unique Clicks» в Trends под пользователем API/,'Missing overview uniques point to the native Trends column');
  await campaigns.locator('[data-mode="campaigns"]').click();
  await campaigns.locator('[data-action="pick-campaigns"]').click();
  await campaigns.locator(`.campaign-controls .campaign-group-toggle[data-group-id="${fixtureGroups[0].uuid}"]`).click();
  await campaigns.locator('.campaign-controls .campaign-option input[value="1"]').check();
  await campaigns.locator('[data-action="apply-campaigns"]').click();
  await reportsReady();
  assert.equal(await campaigns.locator('.campaign-total').textContent(),'—','Unavailable tracker uniques in comparison are not replaced with click counts');
  assert.match(await campaigns.locator('.state-detail').textContent(),/«Unique Clicks» в отчёте Report под пользователем API/,'Missing comparison tracker uniques point to Report rather than Clicklog');
  assert.match(await campaigns.locator('.state-detail').textContent(),/Код: r:A;t:A;a:0;g:0\./,'The missing-uniques diagnostic exposes only fixed field-presence, aggregate and gap flags');
  assert.match(await campaigns.locator('.unique-clicks-note').textContent(),/Код: r:A;t:A;a:0;g:0\./,'The same safe diagnostic is visible beside the filter');
  await campaigns.evaluate(()=>window.scrollTo(0,0));
  await campaigns.screenshot({path:'.test-results/extension-unique-missing-comparison.png'});
  await campaigns.locator('[data-action="reset-filters"]').click();
  await campaigns.locator('[data-mode="overview"]').click();
  await reportsReady();
  assert.equal(await uniqueCheckbox.isChecked(),false);
  assert.equal(await clickValue(),'7');
  await campaigns.goto(origin+'/panel/trends');
  await campaigns.waitForTimeout(500);
  assert.equal(await campaigns.locator('#binom-dashboard-extension').count(),0);
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1');
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.card-value')?.textContent==='7');

  // An extension update or reload orphans the content script of an open
  // tab. The tab must get a working Dashboard back without a page reload, and the
  // orphan must not leave a second menu entry, view or stylesheet behind. The
  // chrome://extensions Reload button is used: headless Chromium does not bring an
  // extension back after chrome.runtime.reload().
  const extensionsPage=await context.newPage();
  await extensionsPage.goto('chrome://extensions/');
  if(await extensionsPage.locator('#devMode').getAttribute('aria-pressed')!=='true')await extensionsPage.locator('#devMode').click();
  const workerBeforeReload=worker;
  await extensionsPage.locator(`extensions-item#${extensionId} #dev-reload-button`).click();
  for(let attempt=0;attempt<100&&!context.serviceWorkers().some(candidate=>candidate!==workerBeforeReload);attempt++)await campaigns.waitForTimeout(100);
  worker=context.serviceWorkers().find(candidate=>candidate!==workerBeforeReload);
  assert.ok(worker,'The reloaded extension starts a new service worker');
  await extensionsPage.close();
  await campaigns.bringToFront();
  await campaigns.waitForFunction(()=>document.querySelectorAll('[data-binom-dashboard-nav]').length===1&&document.querySelector('#binom-dashboard-extension')?.shadowRoot?.textContent.includes('Разблокируйте сохранённый ключ паролем в настройках расширения.'));
  await campaigns.waitForTimeout(2000);
  assert.deepEqual(await campaigns.evaluate(()=>({nav:document.querySelectorAll('[data-binom-dashboard-nav]').length,styles:document.querySelectorAll('#binom-dashboard-navigation-styles').length,views:document.querySelectorAll('[data-binom-dashboard-view]').length,hosts:document.querySelectorAll('#binom-dashboard-extension').length})),{nav:1,styles:1,views:1,hosts:1},'The orphaned copy removes its own UI; exactly one live Dashboard remains');
  assert.equal(await campaigns.evaluate(()=>document.querySelectorAll('#binom-dashboard-tracker-theme').length),0,'No tracker theme stylesheet after the extension reload');
  // The orphan must retire before the new copy activates. Otherwise its cleanup removes
  // the new copy's inert marker now, and the new copy later restores the orphan's one,
  // leaving Binom's content inert after the Dashboard closes.
  assert.equal(await campaigns.evaluate(()=>document.querySelectorAll('[inert]').length),1,'Only Binom content covered by the live Dashboard is inert');
  settings=await context.newPage();settingsPage=settings;
  settings.on('pageerror',e=>console.log('Settings page error:',e.message));
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Заблокировано');
  await settings.locator('#unlock-password').fill(vaultPassword);
  await settings.locator('#unlock').click();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.card-value')?.textContent==='7');
  // A page may dispatch the retirement event itself; a live copy must ignore it.
  await campaigns.evaluate(()=>document.dispatchEvent(new CustomEvent('binom-dashboard-replaced')));
  await campaigns.waitForTimeout(1500);
  assert.equal(await campaigns.evaluate(()=>document.querySelectorAll('[data-binom-dashboard-nav]').length),1,'A page-sent retirement event does not stop the live copy');
  assert.equal(await campaigns.locator('.card-value').first().textContent(),'7');

  // Close and reopen the real persistent browser profile: ciphertext survives,
  // session key does not. No mocked clearing stands in for this restart test.
  const beforeRestart=await settings.evaluate(()=>chrome.storage.local.get(null));
  console.log('Vault UI: starting real browser restart.');
  await context.close();
  console.log('Vault UI: browser closed.');
  context=await chromium.launchPersistentContext(join(temp,'profile'),browserOptions);
  context.setDefaultTimeout(30000);
  worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  console.log('Vault UI: browser and worker restarted.');
  assert.equal(worker.url().split('/')[2],extensionId);
  settings=await context.newPage();settingsPage=settings;
  console.log('Vault restart: options tab created.');
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  console.log('Vault restart: options loaded.');
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Заблокировано');
  console.log('Vault restart: key is locked.');
  assert.deepEqual(await settings.evaluate(()=>chrome.storage.session.get(null)),{});
  assert.deepEqual(await settings.evaluate(()=>chrome.storage.local.get(null)),beforeRestart);
  campaigns=await context.newPage();campaignsPage=campaigns;
  const restartedRequestCount=requests.length;
  await campaigns.goto(origin+'/panel/campaigns?binomDashboard=1');
  await campaigns.getByText('Разблокируйте сохранённый ключ паролем в настройках расширения.',{exact:true}).waitFor();
  assert.equal(requests.length,restartedRequestCount);
  await settings.screenshot({path:'.test-results/options-locked.png',fullPage:true});
  await settings.locator('#unlock-password').fill(vaultPassword);
  await settings.locator('#unlock').click();
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.card-value')?.textContent==='7');
  assert.equal(await settings.locator('#unlock-password').inputValue(),'');
  await settings.locator('#forget-saved-key').click();
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Нужен ключ');
  const forgotten=await settings.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  assert.equal(forgotten.local.keyVault,undefined);assert.deepEqual(forgotten.session,{});
  assert.deepEqual(forgotten.local.preferences,beforeRestart.preferences);
  assert.deepEqual(forgotten.local.config,beforeRestart.config);
  // Explicit session-only mode still works and cannot leave ciphertext behind.
  await settings.locator('#storage-mode').selectOption('session');
  await settings.locator('#api-key').fill(key2);
  await settings.locator('#connect').click();
  await settings.waitForFunction(()=>document.getElementById('connection-state').textContent==='Ключ на сеанс');
  assert.equal((await settings.evaluate(()=>chrome.storage.local.get(null))).keyVault,undefined);
  await campaigns.waitForFunction(()=>document.querySelector('#binom-dashboard-extension')?.shadowRoot.querySelector('.card-value')?.textContent==='7');
  // Status request counter (asserted below). Content messages reach every extension page,
  // so count them in the options page: a restarted service worker would lose a listener.
  await settings.evaluate(()=>{window.__statusFromTabs=0;chrome.runtime.onMessage.addListener((message,sender)=>{if(message?.type==='GET_STATUS'&&sender.tab)window.__statusFromTabs++;});});
  await settings.locator('#disconnect').click();
  await campaigns.waitForFunction(()=>!document.querySelector('#binom-dashboard-extension'));
  assert.equal(await campaigns.getByRole('link',{name:'Dashboard',exact:true}).count(),0);
  assert.equal(await campaigns.locator('main > .fixture-table-container table').isVisible(),true);
  assert.equal(await campaigns.locator('#binom-dashboard-tracker-theme').count(),0);
  const removed=await settings.evaluate(async()=>({local:await chrome.storage.local.get(null),session:await chrome.storage.session.get(null)}));
  assert.deepEqual(removed,{local:{preferences:{language:'ru'}},session:{}},'Disconnect retains only the selected interface language');
  // The still-open Binom tab now gets an error for every status request.
  // Failures must back off instead of waking the service worker every second. The old
  // code throttled only from the last success (just before DISCONNECT) and then polled
  // every second, so measure 16–22 s later. Fixed code retries about 2, 6, 14 and 30 s
  // after the failure, so 0 or 1 request falls into the window.
  await campaigns.bringToFront();
  assert.equal(await campaigns.evaluate(()=>document.visibilityState),'visible','Status polling runs only in a visible tab');
  await campaigns.waitForTimeout(16000);
  const statusBeforeWindow=await settings.evaluate(()=>window.__statusFromTabs);
  assert.ok(statusBeforeWindow>=1,'The options page receives the tab status requests (positive control)');
  await campaigns.waitForTimeout(6000);
  const statusPolls=await settings.evaluate(()=>window.__statusFromTabs)-statusBeforeWindow;
  assert.ok(statusPolls<=1,`A disconnected tab must back off status polling; got ${statusPolls} requests in 6 s`);
  assert.equal(requests.length>0,true);
  assert.deepEqual([...new Set(requests.map(r=>r.path))].sort(),['/public/api/v1/groups/campaigns','/public/api/v1/traffic_source/list/filtered','/public/api/v1/trends','/public/api/v1/campaign/list/filtered','/public/api/v1/report/campaign','/public/api/v1/clicklog','/public/api/v1/settings/info'].sort());
  assert.equal(requests.some(r=>JSON.stringify(r.query).includes(key)),false);
  console.log('Real Chromium extension + HTTPS fixture passed: dashboard/insights, popup language and enable controls, Binom design light/dark, automatic Binom timezone with 403 rollback, encrypted key persistence across browser restart, wrong password, lock/unlock, key replacement, forget, session-only and disconnect.');
}catch(error){
  console.error('Test failure:',error);
  console.log('Test failure diagnostics:', {requests:requests.length,settings:await settingsPage?.locator('#feedback').textContent({timeout:1000}).catch(()=>'(unavailable)'),widget:await campaignsPage?.evaluate(()=>document.getElementById('binom-dashboard-extension')?.shadowRoot?.textContent?.slice(-2000)||'no widget').catch(()=>'(closed)')});
  if(campaignsPage&&!campaignsPage.isClosed())await campaignsPage.screenshot({path:'.test-results/extension-failure.png',fullPage:true,timeout:3000}).catch(()=>{});
  throw error;
}finally{
  await context?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});
}
