import { t } from '../src/i18n.js';
import { createDashboard } from '../src/dashboard.js';
import { getInstanceByDom } from 'echarts/core';

const campaignGroups = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Тестовая группа' },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Повторяющаяся группа' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Повторяющаяся группа' },
];
const groupOf = id => {
  const index = (Number(id) - 1) % 5, group = campaignGroups[index];
  return group ? { groupId: group.id, groupName: group.name } : index === 3 ? { groupId: null, groupName: null } : {};
};
const campaigns = [
  { id: '1', name: 'Search · Europe' }, { id: '2', name: 'Social · LATAM' },
  { id: '3', name: 'Native · Asia' }, { id: '4', name: 'Display · Global' },
  { id: '5', name: 'Search · MENA' }, { id: '6', name: 'Social · Europe' },
  { id: '7', name: 'Native · LATAM' }, { id: '8', name: 'Video · Asia' },
  { id: '9', name: 'Search · Canada' }, { id: '10', name: 'Display · India' },
].map(campaign => ({ ...campaign, ...groupOf(campaign.id) }));
// The larger picker fixture leaves the ten analytical demo campaigns unchanged.
const campaignCatalog = new URLSearchParams(location.search).get('catalog') === 'large'
  ? [...campaigns, ...Array.from({ length: 811 }, (_, index) => {
    const id = String(index + 11);
    return { id, name: id === '821' ? 'Последняя кампания · 821' : `Campaign ${id.padStart(4, '0')}`, ...groupOf(id) };
  })] : campaigns;
window.demoDataCalls = { overview: 0, campaignCatalog: 0, campaignCharts: 0, lastCampaignQuery: null, insights: 0, insightsCompleted: 0, lastInsightScope: null };
window.demoFailures = new Set();
window.demoWarnings = [];
window.demoInsightFailures = new Set();
window.demoSavedPreferences = null;
window.demoMissingUnique = false;
// Test hook: a previous period whose clicks and revenue are zero.
window.demoZeroPrevious = false;
window.demoResults = {};
// Deliberate synthetic values for the optional Binom columns, never an inference
// the extension may apply to tracker data.
const demoUniques = (clicks, variation = 0) => window.demoMissingUnique
  ? { unique_clicks: null, unique_campaign_clicks: null }
  : { unique_clicks: Math.round(clicks * (.35 + variation % 4 * .07)), unique_campaign_clicks: Math.round(clicks * (.72 + variation % 3 * .06)) };
const sumDemoUniques = rows => Object.fromEntries(['unique_clicks','unique_campaign_clicks'].map(key=>[key,rows.every(row=>typeof row[key]==='number')?rows.reduce((sum,row)=>sum+row[key],0):null]));

function makeResult(query) {
  const start = new Date(query.dateFrom + 'T12:00:00Z');
  const end = new Date(query.dateTo + 'T12:00:00Z');
  const hourly = query.grouping === 'hours' || (query.grouping === 'auto' && query.dateFrom === query.dateTo);
  const count = hourly ? 24 : Math.min(366, Math.round((end-start)/86400000)+1);
  const factor = query.groupId ? .62 : query.sourceId ? .42 : 1;
  const rows = Array.from({ length:count },(_,i)=>{
    const date = new Date(start); date.setUTCDate(date.getUTCDate()+i);
    const clicks = Math.round((840+Math.sin(i*.84)*240+(i%4)*51+i*19)*factor);
    const leads = Math.round(clicks*(.027+Math.sin(i*.64)*.005));
    const costs = Math.round(clicks*(.33+(i%3)*.02)*100)/100;
    const revenue = leads*21; const profit = revenue-costs;
    return { date:hourly?`${String(i).padStart(2,'0')}:00 - ${String((i+1)%24).padStart(2,'0')}:00`:date.toISOString().slice(0,10),clicks,...demoUniques(clicks,i),leads,costs,revenue,profit,roi:profit/costs*100, cr:leads/clicks*100, epc:revenue/clicks, cpc:costs/clicks, bots:Math.round(clicks*.02) };
  });
  const sum = data => {
    const total=Object.fromEntries(['clicks','leads','costs','revenue','profit','bots'].map(k=>[k,data.reduce((n,row)=>n+row[k],0)]));
    Object.assign(total,sumDemoUniques(data));total.roi=total.costs?total.profit/total.costs*100:null;total.cr=total.clicks?total.leads/total.clicks*100:null;total.epc=total.clicks?total.revenue/total.clicks:null;total.cpc=total.clicks?total.costs/total.clicks:null;return total;
  };
  const previousRows=query.compare?rows.map((r,i)=>{const clicks=Math.round(r.clicks*(.82+(i%3)*.03)),leads=Math.round(r.leads*.81),costs=r.costs*.9,revenue=leads*21,profit=revenue-costs;return {...r,clicks,...demoUniques(clicks,i+1),leads,costs,revenue,profit,roi:profit/costs*100};}):null;
  return { rows,totals:sum(rows),previousRows,previousTotals:previousRows?(window.demoZeroPrevious?{...sum(previousRows),clicks:0,revenue:0,cr:0,epc:0}:sum(previousRows)):null,query,fetchedAt:new Date().toISOString(),warnings:[...window.demoWarnings] };
}
function makeInsights(query, selected, sections) {
  const base = makeResult({ ...query, compare: true });
  const rows = campaigns.filter(row => !selected.length || selected.includes(row.id)).map((row, i) => {
    const clicks = Math.round(base.totals.clicks * (0.12 + (10 - Number(row.id)) * .025));
    const prior = Number(row.id) === 2 ? clicks * 3 : Number(row.id) === 3 ? Math.round(clicks / 3) : Math.round(clicks * .82);
    const leads = Number(row.id) === 4 ? 0 : Math.round(clicks * .03), costs = clicks * .3, revenue = leads * 20, profit = revenue - costs;
    return { ...row, current: { clicks, ...demoUniques(clicks,i), leads, costs, revenue, profit, roi: profit / costs * 100, bots: Math.round(clicks * (Number(row.id) === 2 ? .3 : .02)), cr: leads / clicks * 100, epc: revenue / clicks, cpc: costs / clicks, cpa: leads ? costs / leads : null }, previous: window.demoInsightFailures.has('previous') ? null : { clicks: prior, ...demoUniques(prior,i+1), bots: Math.round(prior * .01) }, sparkline: base.rows.map((point, index) => ({ date: point.date, clicks: Math.round(point.clicks * (.15 + i * .02) * (1 + Math.sin(index * .8 + i) * .3)) })) };
  });
  const totals = Object.fromEntries(['clicks', 'leads', 'costs', 'revenue', 'profit', 'bots'].map(key => [key, rows.reduce((sum, row) => sum + row.current[key], 0)]));
  Object.assign(totals,sumDemoUniques(rows.map(row=>row.current)));
  Object.assign(totals, { cr: totals.leads / totals.clicks * 100, epc: totals.revenue / totals.clicks, cpc: totals.costs / totals.clicks, cpa: totals.leads ? totals.costs / totals.leads : null });
  const result = { query, scope: { label: selected.length ? t("Выбранные кампании", "Selected campaigns") : t("Все доступные кампании · независимо от статуса", "All available campaigns · regardless of status") }, warnings: [] };
  const campaignReport = window.demoInsightFailures.has('campaigns') ? { error: { message: t("Нет доступа к отчёту кампаний.", "No access to the campaign report.") } } : { rows, totals, ...(window.demoInsightFailures.has('previous') ? { previousError: { message: t("Предыдущий отчёт временно недоступен.", "The previous report is temporarily unavailable.") } } : {}) };
  if (sections.includes('campaigns')) result.campaigns = campaignReport;
  if (sections.includes('pace')) result.pace = { throughTime: '15:30', series: [t("Сегодня", "Today"), t("Вчера", "Yesterday")].map((name, j) => { let cumulative = 0; const day = j ? '2026-10-20' : '2026-10-21'; return { id: ['today','yesterday'][j], name, day, range: { dateFrom: `${day} 00:00:00`, dateTo: `${day} 15:30:00` }, rows: Array.from({length:16}, (_, i) => { const clicks = Math.round(140 + i * 19 + Math.sin(i * .8 + j) * 70 - j * 18); cumulative += clicks; return { date: String(i).padStart(2,'0')+':00', clicks, cumulativeClicks: cumulative }; }) }; }) };
  if (sections.includes('heatmap')) result.heatmap = { range: { dateFrom: '2026-10-14', dateTo: '2026-10-20' }, cells: Array.from({length:168}, (_, i) => ({ day: ['2026-10-19','2026-10-20','2026-10-14','2026-10-15','2026-10-16','2026-10-17','2026-10-18'][Math.floor(i/24)], weekday: Math.floor(i/24), hour: i%24, clicks: Math.round(20 + Math.sin(i%24 / 24 * Math.PI) * 280 + Math.floor(i/24) * 15) })), errors: window.demoInsightFailures.has('heatmap') ? [{ day: '2026-10-17', message: t("Не удалось загрузить день.", "Could not load this day.") }] : [] };
  if (sections.includes('breakdowns')) result.breakdowns = Object.fromEntries(Object.entries({sources:['Search','Social','Native','Direct'],groups:['Листинги','Реферальные','Тесты'],countries:['Germany','Brazil','India','Mexico']}).map(([key,names]) => [key, window.demoInsightFailures.has(key) ? { error: { message: t("Этот разрез недоступен пользователю.", "This breakdown is unavailable to the user.") } } : { rows: names.map((name,i)=>{const clicks=Math.round(totals.clicks*(.45-i*.1)),previous=Math.round(totals.clicks*(.39-i*.1));return {id:String(i+1),name,current:{clicks,...demoUniques(clicks,i)},previous:{clicks:previous,...demoUniques(previous,i+1)}};}) }]));
  if (result.breakdowns) result.breakdowns.campaigns = campaignReport;
  return result;
}
const dashboardOptions = {
  initialQuery: { timezone:'Europe/Moscow' },
  preferences: { language: new URLSearchParams(location.search).get('lang') === 'ru' ? 'ru' : 'en', theme:'dark',metrics:['clicks','leads','revenue','profit'] },
  demo:true,
  loadInsights:async(query,ids,sections)=> {
    window.demoDataCalls.insights++; window.demoDataCalls.lastInsightScope={query,ids,sections};
    // One-shot synthetic hold lets UI tests release a superseded response deterministically.
    const hold=window.demoInsightHold; window.demoInsightHold=null;
    await new Promise(resolve=>setTimeout(resolve,180)); if(hold) await hold;
    const next=makeInsights(query,ids,sections); window.demoDataCalls.insightsCompleted++; window.demoResults.insights=next; return next;
  },
  loadCampaignOverview:async(query,ids)=> { window.demoDataCalls.campaignOverview=(window.demoDataCalls.campaignOverview||0)+1; window.demoDataCalls.lastOverviewIds=ids; await new Promise(r=>setTimeout(r,150));return window.demoResults.campaignOverview=makeResult(query); },
  loadClicklog:async(query,ids,page)=> {
    window.demoDataCalls.clicklog=(window.demoDataCalls.clicklog||0)+1;
    window.demoDataCalls.lastClicklog={query,ids,page};
    const rows=Array.from({length:120},(_,i)=>({id:String(120-i),click_time:query.dateTo+' 12:'+String(59-Math.floor(i/60)).padStart(2,'0')+':'+String(59-i%60).padStart(2,'0'),ip:'192.0.2.'+(i%254+1),country:'Norway',device_type:'Desktop',os_name:'Windows',os_version:'11',browser_name:'Fixture Browser',browser_version:'2',campaign:campaigns[i%10].name,campaign_id:campaigns[i%10].id,user_agent:'Synthetic user agent '+i,language:'ru',is_bot:'0'})).filter(row=>!ids.length||ids.includes(row.campaign_id));
    const index=page.cursor?rows.findIndex(row=>row.id===page.cursor):0;
    const start=page.cursor?(page.direction==='next'?index+1:Math.max(0,index-page.limit)):0;
    return {rows:rows.slice(start,start+page.limit),pageInfo:{from:rows[0]?.id,to:rows.at(-1)?.id,hasNextPage:start+page.limit<rows.length,hasPrevPage:start>0,sorting:'desc',limit:page.limit}};
  },
  loadDashboard:async query=> { window.demoDataCalls.overview++; await new Promise(r=>setTimeout(r,150));return window.demoResults.overview=makeResult(query); },
  loadCatalogs:async()=>window.demoCatalogs||({groups:campaignGroups,sources:[{id:'1',name:'Тестовый источник'}],warnings:[]}),
  loadCampaigns:async()=> { window.demoDataCalls.campaignCatalog++; return { campaigns: campaignCatalog, warnings: [] }; },
  loadCampaignCharts:async(query,campaignIds)=> {
    window.demoDataCalls.campaignCharts++;
    window.demoDataCalls.lastCampaignQuery = { ...query };
    await new Promise(r=>setTimeout(r,150));
    const base = makeResult({ ...query, compare: false, groupId: '', sourceId: '' });
    return window.demoResults.campaigns={
      campaigns:campaignIds.map(id=> {
        if(window.demoFailures.has(String(id))) return { id,rows:[],totals:{},error:{code:'DEMO_UNAVAILABLE',message:t("Демонстрация: данные кампании временно недоступны.", "Demo: campaign data is temporarily unavailable.")} };
        const seed=Number(id);
        const rows=base.rows.map((row,i)=> {
          const clicks=Math.round(row.clicks*(.35+seed*.12+Math.sin(i*.67+seed)*.12));
          const leads=Math.round(clicks*(.02+seed*.003));
          const costs=Math.round(clicks*(.28+(seed%3)*.06)*100)/100;
          const revenue=leads*(18+seed),profit=revenue-costs;
          return { ...row,clicks,...demoUniques(clicks,i+seed),leads,costs,revenue,profit,roi:costs?profit/costs*100:null };
        });
        const totals=Object.fromEntries(['clicks','leads','costs','revenue','profit'].map(key=>[key,rows.reduce((sum,row)=>sum+row[key],0)]));
        Object.assign(totals,sumDemoUniques(rows));
        totals.roi=totals.costs?totals.profit/totals.costs*100:null;
        return { id, rows, totals };
      }), query, grouping:query.grouping, fetchedAt:new Date().toISOString(), warnings:[...window.demoWarnings],
    };
  },
  onPreferencesChange:preferences=> { if (window.demoSaveFailure) throw new Error('Demo storage unavailable'); window.demoSavedPreferences = structuredClone(preferences); },
  onSettings:()=>alert(t("Это демонстрация. Настройки подключения находятся в установленном расширении.", "This is a demo. Connection settings are available in the installed extension.")),
};
window.demoDashboard = createDashboard(document.getElementById('dashboard'), dashboardOptions);
window.demoChartOption = () => getInstanceByDom(document.getElementById('dashboard').shadowRoot.querySelector('.chart'))?.getOption();

// Keep the static demo shell in the same palette as the widget for honest previews.
const demoHost = document.getElementById('dashboard');
const syncDemoShell = () => {
  const light = demoHost.shadowRoot.querySelector('.bd').classList.contains('light');
  document.body.style.backgroundColor = light ? '#f3f6fa' : '#222731';
  document.body.style.color = light ? '#1b1f2a' : '#cbd3e0';
};
const shellObserver = new MutationObserver(syncDemoShell);
shellObserver.observe(demoHost.shadowRoot.querySelector('.bd'), { attributes: true, attributeFilter: ['class'] });
syncDemoShell();

// Test hooks: replace the group/source catalog, and remount as a new page
// load does, from the stored preferences only (no in-memory query).
window.demoCatalogs = null;
window.demoRemount = (preferences = {}) => {
  window.demoDashboard.destroy();
  shellObserver.disconnect();
  window.demoDashboard = createDashboard(demoHost, { ...dashboardOptions,
    preferences: { ...dashboardOptions.preferences, ...window.demoSavedPreferences, ...preferences } });
  shellObserver.observe(demoHost.shadowRoot.querySelector('.bd'), { attributes: true, attributeFilter: ['class'] });
  syncDemoShell();
};

// Remount exactly as the extension does when the popup changes the language.
window.demoRemountLanguage = language => {
  const initialQuery = window.demoDashboard.getQuery();
  window.demoDashboard.destroy();
  shellObserver.disconnect();
  window.demoDashboard = createDashboard(demoHost, { ...dashboardOptions, initialQuery,
    preferences: { ...dashboardOptions.preferences, ...window.demoSavedPreferences, language } });
  shellObserver.observe(demoHost.shadowRoot.querySelector('.bd'), { attributes: true, attributeFilter: ['class'] });
  syncDemoShell();
};
