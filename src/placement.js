/** Query parameter that opens the Dashboard over the Campaigns page. */
export const DASHBOARD_MARKER = 'binomDashboard';
/** Paths that all show Binom's Campaigns page. */
const CAMPAIGN_PATH_ALIASES = new Set(['/index', '/panel', '/panel/campaigns']);

/** The part of an address that selects a Binom section or the Dashboard view. After
 * start-up Binom rewrites its own filter parameters (status, dateType, auth…) with the
 * History API; that is not navigation and must not rebuild an open Dashboard. */
export function routeKey(href) {
  let url;
  try { url = new URL(href); } catch { return String(href); }
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const hash = url.hash.startsWith('#/') || url.hash.startsWith('#!/') ? url.hash.split('?')[0] : '';
  return JSON.stringify([url.origin, CAMPAIGN_PATH_ALIASES.has(path) ? '/panel/campaigns' : path,
    ...['page', 'route', 'section', 'tab', DASHBOARD_MARKER].map(name => url.searchParams.get(name)), hash]);
}

/** Route and DOM detection are independent of credentials. Binom's hashed CSS classes may change. */
export function isCampaignsUrl(currentHref, configuredHref) {
  let current, configured;
  try { current = new URL(currentHref); configured = new URL(configuredHref); } catch { return false; }
  if (current.origin !== configured.origin) return false;
  const trim = path => path.replace(/\/+$/, '') || '/';
  const path = trim(current.pathname), target = trim(configured.pathname);
  if (/\/(?:api|login|logout|signin)(?:\/|$)/i.test(path)) return false;
  if (path !== target && !(CAMPAIGN_PATH_ALIASES.has(path) && CAMPAIGN_PATH_ALIASES.has(target))) return false;
  for (const key of ['page', 'route', 'section', 'tab']) {
    const value = current.searchParams.get(key);
    const expected = configured.searchParams.get(key);
    if (expected ? value !== expected : value && !/^(campaigns?|index)$/i.test(value)) return false;
  }
  // Hash-based routers must match the configured route; normal anchors can vary.
  const hashRoute = hash => hash.startsWith('#/') || hash.startsWith('#!/') ? hash.split('?')[0] : '';
  if (hashRoute(current.hash) !== hashRoute(configured.hash)) return false;
  return true;
}

/** `native` describes Binom's own page state while the extension has changed it:
 * an open Dashboard renames the document title and clears aria-current on the native
 * Campaigns tab. Detection must judge Binom's state, otherwise opening the view would
 * hide the very signals that found the page and rebuild it in a loop. */
export function findMountTarget(doc, native = {}) {
  // Never display cached/API statistics over the login form, even on an aliased route.
  if (doc.querySelector('input[type="password"]')) return null;
  const marker = [...doc.querySelectorAll('input[placeholder]')].find(el => /id\s*\/\s*name\s*\/\s*key\s*\/\s*domain/i.test(el.placeholder));
  if (marker) {
    const controls = marker.closest('[class*="_buttonsAndFilters_"], [data-campaign-controls]');
    if (controls?.parentElement) return { parent: controls.parentElement, before: controls };
  }
  const current = [...doc.querySelectorAll('[aria-current="page"], .router-link-exact-active, .router-link-active, nav .active, [role="tab"][aria-selected="true"]')];
  if (native.currentTab) current.push(native.currentTab);
  const active = current.some(el => /^(campaigns|кампании)$/i.test(el.textContent.trim()));
  const titled = /(?:^|\|)\s*(?:campaigns|кампании)\s*(?:\||$)/i.test(native.title ?? doc.title);
  if (!active && !titled && !marker) return null;
  const controls = doc.querySelector('[class*="_buttonsAndFilters_"], [data-campaign-controls]');
  if (controls?.parentElement) return { parent: controls.parentElement, before: controls };
  // Never choose an arbitrary popover/portal with a hashed "placement" class.
  // Only a table inside an identified workspace can be a fallback mount point.
  const table = doc.querySelector('main table, [role="main"] table, main [role="table"], [class*="_content_"] > [class*="_placement_"]');
  if (table?.parentElement) return { parent: table.parentElement, before: table };
  return null;
}
