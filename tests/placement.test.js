import test from 'node:test';
import assert from 'node:assert/strict';
import { findMountTarget, isCampaignsUrl, routeKey } from '../src/placement.js';
test('main campaign route aliases work but other admin pages do not', () => {
  const target='https://tracker.example/panel/campaigns';
  for(const path of ['/panel','/panel/','/panel/campaigns','/index']) assert.equal(isCampaignsUrl('https://tracker.example'+path,target),true);
  for(const path of ['/panel/trends','/panel/campaigns/12','/api/doc','/login']) assert.equal(isCampaignsUrl('https://tracker.example'+path,target),false);
  assert.equal(isCampaignsUrl('https://evil.example/panel',target),false);
  assert.equal(isCampaignsUrl('http://tracker.example/panel',target),false);
});
test('query routing does not mount over another section',()=>{
  const target='https://tracker.example/index.php?page=campaigns';
  assert.equal(isCampaignsUrl(target+'&date=7',target),true);
  assert.equal(isCampaignsUrl('https://tracker.example/index.php?page=trends',target),false);
  assert.equal(isCampaignsUrl('https://tracker.example/index.php',target),false);
});
test('hash routing checks section; changed table filters are allowed',()=>{
  const target='https://tracker.example/admin#/campaigns';
  assert.equal(isCampaignsUrl(target+'?date=7',target),true);
  assert.equal(isCampaignsUrl('https://tracker.example/admin#/offers',target),false);
});
// An open Dashboard renames the title and clears aria-current on the native
// Campaigns tab. Without the search field, detection must use Binom's own state.
function openedCampaignsPage({title='Binom | Dashboard',current=[]}={}) {
  const workspace={}, controls={parentElement:workspace};
  return {title,workspace,controls,
    querySelector:selector=>selector.includes('_buttonsAndFilters_')?controls:null,
    querySelectorAll:selector=>selector==='input[placeholder]'?[]:current};
}
test('page detection without the search field uses Binom state hidden by an open Dashboard',()=>{
  const page=openedCampaignsPage();
  const target={parent:page.workspace,before:page.controls};
  assert.equal(findMountTarget(page),null,'Our own title and the cleared tab alone do not identify Campaigns');
  assert.deepEqual(findMountTarget(page,{title:'Binom | Campaigns'}),target,'The native title keeps the page recognized');
  assert.deepEqual(findMountTarget(page,{currentTab:{textContent:' Campaigns '}}),target,'The native current tab keeps the page recognized');
  assert.equal(findMountTarget(page,{title:'Binom | Offers',currentTab:{textContent:'Offers'}}),null,'Another native section is not mistaken for Campaigns');
  const live=openedCampaignsPage({title:'Binom | Campaigns'});
  assert.deepEqual(findMountTarget(live),{parent:live.workspace,before:live.controls},'Without native state the live document is used as before');
});
// Binom adds its own filter parameters to the address after start-up. Only a
// section, routing parameter, router hash or the Dashboard marker is navigation.
test('route key ignores Binom filter parameters but keeps sections and the Dashboard marker',()=>{
  const open='https://tracker.example/panel/?binomDashboard=1';
  assert.equal(routeKey(open+'&auth=TEST-ONLY-TOKEN&status=all&dateType=yesterday'),routeKey(open));
  assert.equal(routeKey('https://tracker.example/panel?binomDashboard=1'),routeKey(open),'A trailing slash is not navigation');
  assert.notEqual(routeKey('https://tracker.example/panel/?status=all'),routeKey(open),'Closing the Dashboard removes its marker');
  assert.notEqual(routeKey('https://tracker.example/panel/offers?binomDashboard=1'),routeKey(open),'Another section is navigation');
  assert.notEqual(routeKey('https://other.example/panel/?binomDashboard=1'),routeKey(open));
  assert.notEqual(routeKey('https://tracker.example/index.php?page=trends'),routeKey('https://tracker.example/index.php?page=campaigns'));
  assert.equal(routeKey('https://tracker.example/index.php?page=campaigns&date=7'),routeKey('https://tracker.example/index.php?page=campaigns'));
  assert.notEqual(routeKey('https://tracker.example/admin#/offers'),routeKey('https://tracker.example/admin#/campaigns'));
  assert.equal(routeKey('https://tracker.example/admin#/campaigns?date=7'),routeKey('https://tracker.example/admin#/campaigns'));
  assert.equal(routeKey('https://tracker.example/panel/#top'),routeKey('https://tracker.example/panel/'),'A plain anchor is not a router hash');
  assert.equal(routeKey('https://tracker.example/panel/?status=all&binomDashboard=1&auth=x'),routeKey('https://tracker.example/panel/?auth=x&binomDashboard=1&status=all'),'Binom may rebuild the whole query in another order');
  for(const name of ['route','section','tab'])assert.notEqual(routeKey(`https://tracker.example/index.php?${name}=offers`),routeKey(`https://tracker.example/index.php?${name}=campaigns`),name);
  assert.notEqual(routeKey('https://tracker.example/admin#!/offers'),routeKey('https://tracker.example/admin#!/campaigns'));
  // isCampaignsUrl treats these paths as one page; canonicalizing between them is not navigation.
  for(const path of ['/panel','/panel/campaigns','/index'])assert.equal(routeKey(`https://tracker.example${path}?binomDashboard=1`),routeKey(open),path);
  assert.notEqual(routeKey('https://tracker.example/panel/?page=a%26b'),routeKey('https://tracker.example/panel/?page=a&b'),'Values cannot collide through separators');
});
