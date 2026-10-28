import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Source-level UI fixture: no extension build, tracker access, or credentials.
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/dashboard.css"><link rel="stylesheet" href="/insights.css"><link rel="stylesheet" href="/binom.css"><style>body{margin:0;background:#f3f6fa;font:13px Arial,sans-serif}.bd{padding:20px}</style></head><body><main class="bd binom light"><div id="insights" class="insights-root"></div></main><script type="module">
import {createInsights} from '/insights.js';
import {setLanguage,getLanguage} from '/i18n.js';
window.initialLanguage=getLanguage();window.setLanguage=setLanguage;window.createInsights=createInsights;setLanguage('ru');
window.widget=createInsights(document.querySelector('#insights'),{preferences:{insightsSections:['top','leaders','attention','pace','heatmap','efficiency']}});
const row=(id,name,clicks,before)=>({id,name,current:{clicks},previous:{clicks:before}});
window.fixture={scope:{label:'Все доступные кампании · независимо от статуса'},warnings:['Тестовое ограничение охвата'],campaigns:{rows:[row('1','Удалённый топ',100,50)]},breakdowns:{campaigns:{rows:[...Array.from({length:12},(_,i)=>row(String(i),'Кампания '+i,12-i,i===10?null:1)),row('unknown','Недоступная кампания',null,100)]},sources:{rows:[row('organic','Organic',0,0),row('unknown','Недоступный источник',null,100),row('search','Search',300,150),row('social','Social',100,200)]},groups:{previousError:{message:'Нет предыдущего отчёта'},rows:[row('group','Одна группа',50,null)]},countries:{error:{message:'Нет доступа к странам'}}}};
window.widget.setResult(window.fixture);
</script></body></html>`;
const files={'/i18n.js':'src/i18n.js','/insights.js':'src/insights.js','/insights.css':'src/insights.css','/dashboard.css':'src/dashboard.css','/binom.css':'src/binom.css'};
const server=createServer(async(req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  const path=files[req.url];if(!path){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',path.endsWith('.js')?'application/javascript':'text/css');res.end(await readFile(path));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1500,height:1100},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await page.evaluate(()=>window.initialLanguage),'en','Standalone modules start in English before an explicit Russian preference');
  const composition=page.locator('[data-insight="breakdowns"]');
  await composition.locator('.breakdown-row').first().waitFor();
  assert.deepEqual(await page.locator('.insight-card').evaluateAll(cards=>cards.map(card=>card.dataset.insight)),['breakdowns'],'Only traffic composition remains, regardless of legacy preferences and campaign payload');
  assert.equal(await page.locator('[data-insight="top"],.insight-campaign,.insight-table,input').count(),0,'Removed ranking and old settings leave no controls');
  assert.match(await page.locator('.insight-scope').textContent(),/независимо от статуса/);
  assert.equal(await page.getByRole('status').textContent(),'Тестовое ограничение охвата');

  const dimension=label=>composition.getByRole('button',{name:label,exact:true});
  assert.deepEqual(await composition.locator('.breakdown-tabs button').allTextContents(),['Кампании','Группы','Источники','Страны'],'Sources immediately precede countries');
  assert.equal(await dimension('Кампании').getAttribute('aria-pressed'),'true','Campaigns is the default composition');
  assert.deepEqual(await composition.locator('.breakdown-name').allTextContents(),[...Array.from({length:10},(_,i)=>'Кампания '+i),'Остальные · 2']);
  assert.equal(await composition.locator('.breakdown-label b').last().textContent(),'3 · 3,85 %','The remainder sums all available campaigns outside the top ten');
  assert.equal(await composition.locator('.breakdown-row').last().locator('small').count(),0,'A partially unknown previous remainder stays unavailable');
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'78','Campaign shares use all available counts, not just the displayed ten');
  assert.equal(await composition.getByText('Недоступная кампания',{exact:true}).count(),0,'Unavailable campaign clicks do not become zero');
  assert.match(await composition.locator('.insight-note').textContent(),/10 крупнейших кампаний; ещё 2 объединены/);
  assert.match(await composition.locator('.insight-note').textContent(),/Без доступного числа кликов: 1/);
  assert.equal(await composition.locator('.breakdown-segment[data-remainder="true"] title').textContent(),'Остальные · 2: 3 · 3,85 %','Remainder tooltip identifies its count and full share');
  const campaignShares=await composition.locator('.breakdown-segment').evaluateAll(parts=>parts.map(part=>Number(part.getAttribute('stroke-dasharray').split(' ')[0])));
  assert.ok(Math.abs(campaignShares.reduce((sum,share)=>sum+share,0)-100)<0.00001,'The top ten plus remainder fill the whole ring');
  assert.deepEqual(await page.evaluate(()=>window.fixture.breakdowns.campaigns.rows.map(row=>row.id)),[...Array.from({length:12},(_,i)=>String(i)),'unknown'],'Campaign ranking never mutates API data');

  await page.evaluate(()=>{
    window.uniqueFixture=structuredClone(window.fixture);
    window.uniqueFixture.breakdowns.campaigns.rows.forEach((row,index)=>{
      row.current.unique_clicks=index<12?index+2:null;
      row.current.unique_campaign_clicks=index<12?(12-index)*3:null;
      row.previous.unique_clicks=index<12?index+1:null;
      row.previous.unique_campaign_clicks=null;
    });
    window.widget.setResult(window.uniqueFixture);window.widget.setCountField('unique_clicks');
  });
  assert.deepEqual(await composition.locator('.breakdown-name').allTextContents(),[...Array.from({length:10},(_,i)=>'Кампания '+(11-i)),'Остальные · 2'],'Top ten ranking uses the selected unique field');
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'90');
  assert.equal(await composition.locator('.breakdown-total span').textContent(),'доступных уникальных кликов');
  assert.equal(await composition.locator('.breakdown-label b').last().textContent(),'5 · 5,56 %','Unique remainder includes all remaining known values');
  assert.equal(await composition.locator('.breakdown-label small').first().textContent(),'+8,33 %','Comparison uses previous uniques without substituting ordinary clicks');
  assert.match(await composition.locator('.breakdown-segment').first().locator('title').textContent(),/уникальные клики, уникальность по трекеру/);
  assert.match(await composition.locator('.insight-note').textContent(),/Без доступного числа уникальных кликов: 1/);
  await page.evaluate(()=>window.widget.setCountField('unique_campaign_clicks'));
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'234');
  assert.equal(await composition.locator('.breakdown-name').first().textContent(),'Кампания 0','A selected campaign scope uses campaign unique counts');
  assert.equal(await composition.locator('.breakdown-label small').count(),0,'Missing previous campaign uniques remain unavailable');
  assert.match(await composition.locator('.insight-description').textContent(),/Уникальность в кампании/);
  assert.deepEqual(await page.evaluate(()=>window.uniqueFixture.breakdowns.campaigns.rows.map(row=>row.current.clicks)),[...Array.from({length:12},(_,i)=>12-i),null],'Changing the count field never mutates original clicks');
  await page.evaluate(()=>{window.widget.setResult(window.fixture);window.widget.setCountField('unique_clicks');});
  assert.equal(await composition.locator('.breakdown-distribution').count(),0,'Missing unique columns never fall back to ordinary counts');
  assert.match(await composition.locator('.insight-empty').textContent(),/не вернул доступные уникальные клики/);
  await page.evaluate(()=>window.widget.setCountField('clicks'));
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'78','Turning uniques off restores unchanged ordinary data');

  await page.evaluate(()=>window.widget.setFilters({campaignId:'campaign-1'}));
  assert.equal(await dimension('Кампании').count(),0,'A selected campaign hides the campaign breakdown');
  assert.equal(await dimension('Группы').getAttribute('aria-pressed'),'true','Hiding the active dimension selects the first available tab');
  await page.evaluate(()=>window.widget.setFilters({groupId:'group-1'}));
  assert.equal(await dimension('Группы').count(),0,'A selected group hides only the group breakdown');
  assert.equal(await dimension('Кампании').getAttribute('aria-pressed'),'true','Restored campaigns become the first available fallback');
  await dimension('Источники').click();
  await page.evaluate(()=>window.widget.setFilters({sourceId:'source-1'}));
  assert.equal(await dimension('Источники').count(),0,'A selected source hides the source breakdown');
  assert.equal(await dimension('Кампании').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>window.widget.setFilters({campaignId:'campaign-1',groupId:'group-1',sourceId:'source-1'}));
  assert.deepEqual(await composition.locator('.breakdown-tabs button').allTextContents(),['Страны'],'Combined filters hide their corresponding dimensions');
  assert.equal(await dimension('Страны').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>window.widget.setFilters({}));
  assert.deepEqual(await composition.locator('.breakdown-tabs button').allTextContents(),['Кампании','Группы','Источники','Страны'],'Clearing filters restores every dimension');
  assert.equal(await dimension('Страны').getAttribute('aria-pressed'),'true','Restoring tabs preserves an active dimension that is still available');
  await dimension('Источники').click();
  assert.deepEqual(await composition.locator('.breakdown-name').allTextContents(),['Search','Social','Organic'],'Composition ranks known counts and retains confirmed zero');
  assert.deepEqual(await composition.locator('.breakdown-label b').allTextContents(),['300 · 75 %','100 · 25 %','0 · 0 %']);
  assert.deepEqual(await composition.locator('.breakdown-label small').allTextContents(),['+100 %','-50 %','Без изменений']);
  assert.equal(await composition.getByText('Недоступный источник',{exact:true}).count(),0,'Unavailable counts are never reconstructed');
  assert.match(await composition.locator('.insight-note').textContent(),/Без доступного числа кликов: 1/);
  // An entry that appears only in the previous period's report is named as such,
  // not counted as an unavailable value, and is still not drawn as a fake zero.
  await page.evaluate(()=>{const fixture=structuredClone(window.fixture);fixture.breakdowns.sources.rows.push({id:'gone',name:'Ушедший источник',onlyPrevious:true,current:{clicks:null},previous:{clicks:40}});window.widget.setResult(fixture);});
  await dimension('Источники').click();
  const previousOnlyNote=await composition.locator('.insight-note').textContent();
  assert.match(previousOnlyNote,/Без доступного числа кликов: 1\./,'Only the genuinely unknown source is unavailable');
  assert.match(previousOnlyNote,/Только в предыдущем периоде: 1\./);
  assert.equal(await composition.getByText('Ушедший источник',{exact:true}).count(),0,'An entry without current clicks is not drawn');
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'400','Previous-only entries do not change the current total');
  // A dimension whose entries all appear only in the previous period says so, in both
  // click views, instead of "no data" or a false hint about the API user's columns.
  await page.evaluate(()=>{const fixture=structuredClone(window.fixture);fixture.breakdowns.sources.rows=[{id:'a',name:'Ушедший A',onlyPrevious:true,current:{clicks:null,unique_clicks:null},previous:{clicks:4,unique_clicks:2}},{id:'b',name:'Ушедший B',onlyPrevious:true,current:{clicks:null,unique_clicks:null},previous:{clicks:0,unique_clicks:0}}];window.widget.setResult(fixture);});
  await dimension('Источники').click();
  const previousOnlyEmpty='В текущем периоде в этом разрезе нет записей. Только в предыдущем периоде: 2.';
  assert.deepEqual(await composition.locator('.insight-empty').allTextContents(),[previousOnlyEmpty]);
  await page.evaluate(()=>window.widget.setCountField('unique_clicks'));
  assert.deepEqual(await composition.locator('.insight-empty').allTextContents(),[previousOnlyEmpty],'No false hint about the unique-click column');
  await page.evaluate(()=>window.widget.setCountField('clicks'));
  await page.evaluate(()=>window.widget.setResult(window.fixture));
  await dimension('Источники').click();
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'400','The figure identifies the sum of available dimension values');
  assert.equal(await composition.locator('.breakdown-segment').count(),2,'Confirmed zero does not create a misleading arc');
  assert.deepEqual(await composition.locator('.breakdown-segment').evaluateAll(parts=>parts.map(part=>Number(part.getAttribute('stroke-dasharray').split(' ')[0]))),[75,25]);
  assert.deepEqual(await composition.locator('.breakdown-bar i').evaluateAll(bars=>bars.map(bar=>bar.style.width)),['75%','25%','0%'],'Bar width represents the same share as the ring');
  assert.deepEqual(await page.evaluate(()=>window.fixture.breakdowns.sources.rows.map(row=>row.id)),['organic','unknown','search','social'],'Sorting never mutates API data');
  await dimension('Группы').focus();await page.keyboard.press('Enter');
  assert.equal(await dimension('Группы').getAttribute('aria-pressed'),'true');
  assert.equal(await dimension('Группы').evaluate(button=>button===document.activeElement),true,'The active tab keeps keyboard focus after rendering');
  assert.equal(await composition.locator('.breakdown-name').textContent(),'Одна группа');
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'50');
  assert.equal(await composition.locator('.breakdown-label small').count(),0,'Missing previous data does not fill the list with meaningless comparisons');
  await dimension('Страны').click();
  assert.equal(await composition.locator('.insight-error').textContent(),'Нет доступа к странам');
  assert.equal(await composition.locator('.breakdown-distribution').count(),0,'A failed dimension removes the stale diagram');
  await dimension('Группы').click();
  assert.match(await composition.locator('.insight-error').textContent(),/Предыдущий период: Нет предыдущего отчёта/);
  assert.equal(await composition.locator('.breakdown-row').count(),1,'Previous-period failure keeps current composition');
  await dimension('Кампании').click();

  await mkdir('.test-results',{recursive:true});
  for(const design of ['binom'])for(const light of [true,false]){ // Binom is the only design
    await page.locator('main').evaluate((element,{design,light})=>{element.className='bd '+design+(light?' light':'');},{design,light});
    await page.setViewportSize({width:1500,height:1100});
    const card=await composition.boundingBox(),root=await page.locator('#insights').boundingBox(),figure=await composition.locator('.breakdown-figure').boundingBox(),list=await composition.locator('.breakdown-list').boundingBox();
    assert.ok(Math.abs(card.width-root.width)<1,'Traffic composition occupies the full available width');
    assert.ok(figure.x+figure.width<list.x,'Desktop diagram and value list are side by side');
    const chartColors=await composition.locator('.breakdown-segment').evaluateAll(parts=>parts.map(part=>getComputedStyle(part).stroke));
    assert.equal(new Set(chartColors.slice(0,10)).size,10,'The ten campaigns retain distinct colors in each theme');
    assert.equal(chartColors.at(-1),'rgb(140, 140, 140)','Remaining campaigns use neutral gray in each theme');
    assert.equal(await composition.locator('.breakdown-row[data-remainder="true"] .breakdown-bar i').evaluate(bar=>getComputedStyle(bar).backgroundColor),chartColors.at(-1),'The remainder legend matches its gray sector');
    await page.screenshot({path:'.test-results/insights-interactions-'+design+'-'+(light?'light':'dark')+'.png',fullPage:true});
    await page.setViewportSize({width:390,height:1000});
    const narrowFigure=await composition.locator('.breakdown-figure').boundingBox(),narrowList=await composition.locator('.breakdown-list').boundingBox();
    assert.ok(narrowList.y>=narrowFigure.y+narrowFigure.height,'Narrow layout places the complete list below the diagram');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Composition never creates page-level horizontal scrolling');
    await page.screenshot({path:'.test-results/insights-interactions-'+design+'-'+(light?'light':'dark')+'-narrow.png',fullPage:true});
  }

  await dimension('Источники').click();
  await page.evaluate(()=>{
    const fixture=structuredClone(window.fixture);fixture.breakdowns.sources.rows=Array.from({length:12},(_,i)=>({id:String(i),name:'Источник '+i,current:{clicks:12-i},previous:{clicks:i===10?null:1}}));window.widget.setResult(fixture);
  });
  assert.equal(await composition.locator('.breakdown-row').count(),9,'Eight largest values plus an explicit remainder are shown');
  assert.equal(await composition.locator('.breakdown-name').last().textContent(),'Остальные · 4');
  assert.equal(await composition.locator('.breakdown-label b').last().textContent(),'10 · 12,82 %');
  assert.equal(await composition.locator('.breakdown-row').last().locator('small').count(),0,'A remainder cannot reconstruct a partially missing comparison');
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'78');
  const shares=await composition.locator('.breakdown-segment').evaluateAll(parts=>parts.map(part=>Number(part.getAttribute('stroke-dasharray').split(' ')[0])));
  assert.ok(Math.abs(shares.reduce((sum,share)=>sum+share,0)-100)<0.00001,'The ring includes every available click, including the remainder');
  assert.match(await composition.locator('.insight-note').textContent(),/ещё 4 объединены/);

  await page.evaluate(()=>{const fixture=structuredClone(window.fixture);fixture.breakdowns.sources={rows:[{id:'zero',name:'Нулевой источник',current:{clicks:0},previous:{clicks:0}}]};window.widget.setResult(fixture);});
  assert.equal(await composition.locator('.breakdown-label b').textContent(),'0 · —');
  assert.equal(await composition.locator('.breakdown-total strong').textContent(),'0');
  assert.equal(await composition.locator('.breakdown-segment').count(),0,'A zero total keeps a neutral ring without invented shares');
  assert.equal((await page.locator('#insights').textContent()).includes('NaN'),false);
  assert.equal((await page.locator('#insights').textContent()).includes('Infinity'),false);
  await page.evaluate(()=>{const fixture=structuredClone(window.fixture);fixture.breakdowns.sources={rows:[{id:'hidden',name:'Скрытые клики',current:{clicks:null}}]};window.widget.setResult(fixture);});
  assert.match(await composition.locator('.insight-empty').textContent(),/нет доступных данных/);
  assert.equal(await composition.locator('.breakdown-distribution').count(),0,'All unknown values are an unavailable result, not zero traffic');
  await page.evaluate(()=>window.widget.setLoading('Выбранная кампания'));
  assert.equal(await page.locator('#insights').getAttribute('data-state'),'loading');
  assert.equal(await page.getByText('Загрузка данных…',{exact:true}).count(),1);
  await page.evaluate(()=>window.widget.setError({message:'Временная ошибка отчёта'}));
  assert.equal(await page.locator('#insights').getAttribute('data-state'),'error');
  assert.equal(await page.locator('.insight-scope').textContent(),'Выбранная кампания','A failed request retains the requested scope');
  assert.equal(await page.getByText('Временная ошибка отчёта',{exact:true}).count(),1);
  await page.evaluate(()=>window.widget.setResult({scope:{label:'Все доступные кампании'},breakdowns:{sources:{rows:[]}},warnings:['<script>Текст предупреждения</script>']}));
  assert.equal(await page.locator('#insights').getAttribute('data-state'),'ready');
  assert.match(await composition.locator('.insight-empty').textContent(),/нет доступных данных/);
  assert.equal(await page.locator('.insight-warnings script').count(),0,'Warning text is never executed as markup');
  assert.equal(await page.locator('.insight-warnings').textContent(),'<script>Текст предупреждения</script>');
  await page.evaluate(()=>{
    window.widget.destroy();window.setLanguage('en');window.widget=window.createInsights(document.querySelector('#insights'));
    const fixture=structuredClone(window.fixture);fixture.scope.mode='all';fixture.warnings=[];
    fixture.breakdowns.campaigns.rows[0].current.clicks=1234;
    fixture.breakdowns.campaigns.rows.push({id:'gone',name:'Gone',onlyPrevious:true,current:{clicks:null},previous:{clicks:3}});
    window.widget.setResult(fixture);
  });
  assert.match(await composition.locator('.insight-note').textContent(),/ Only in the previous period: 1\.$/,'English note for previous-only entries');
  assert.equal(await composition.locator('h3').textContent(),'Traffic composition');
  assert.deepEqual(await composition.locator('.breakdown-tabs button').allTextContents(),['Campaigns','Groups','Sources','Countries']);
  assert.match(await page.locator('.insight-scope').textContent(),/^All accessible campaigns/);
  assert.equal(await composition.locator('.breakdown-name').first().textContent(),'Кампания 0','Campaign names remain exactly as Binom supplied them');
  assert.match(await composition.locator('.breakdown-label b').first().textContent(),/^1,234 · /,'English values use English numeric formatting');
  assert.equal(await composition.locator('.breakdown-name').last().textContent(),'Others · 2');
  assert.match(await composition.locator('.insight-note').textContent(),/^Showing the top 10 campaigns/);
  assert.equal(await composition.locator('[role="list"]').getAttribute('aria-label'),'Campaigns: clicks and shares');
  await page.evaluate(()=>window.widget.setLoading());
  assert.equal(await page.getByText('Loading data…',{exact:true}).count(),1);
  await page.evaluate(()=>window.widget.setError({message:'Не удалось загрузить статистику.'}));
  assert.equal(await page.getByText('Could not load statistics.',{exact:true}).count(),1,'Only known extension error copy is translated');
  assert.deepEqual(errors,[]);
  console.log('Insights interactions: top ten campaigns with gray remainder, filtered dimensions, full-width composition, ring/bar shares, keyboard tabs, unknown/zero values, isolated errors, and Binom light/dark/narrow layouts passed.');
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
