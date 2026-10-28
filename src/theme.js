const BLOCKED_ROUTE = /(?:^|\/)(?:api|login|logout|signin|sign-in|authentication)(?:\/|$)/i;
const ADMIN_ROUTE = /(?:^|\/)(?:index|panel|campaigns|landings|landers|offers|rotations|affiliate-networks|traffic-sources|trends|conversions|clicklog|triggers|users|files|facebook|domains|groups|settings|monitor)(?:\/|$)/i;
const SHELL_SELECTOR = '[class*="_headerDesktop_"], [class*="_headerMobile_"], [class*="_bottomNavigation_"], [class*="_topNav_"], header, nav';

function routeText(value) {
  try { return decodeURIComponent(value).replace(/^#!?/, '').replace(/[?#].*$/, ''); }
  catch { return value; }
}

/** Only the authenticated-looking admin shell qualifies. This is a visual guard,
 * not an authentication check. The caller also checks the configured exact origin.
 * Page URLs may carry native session parameters: never retain, log or return them. */
export function isTrackerAdminPage(doc, currentHref) {
  let page;
  try { page = new URL(currentHref); } catch { return false; }
  if (page.protocol !== 'https:' || page.username || page.password || !doc?.body) return false;
  if (BLOCKED_ROUTE.test(routeText(page.pathname)) || BLOCKED_ROUTE.test(routeText(page.hash))) return false;
  for (const key of ['page', 'route', 'section']) {
    if (BLOCKED_ROUTE.test(routeText(page.searchParams.get(key) || ''))) return false;
  }
  // Match semantic navigation targets, never account names, credentials or table data.
  const destinations = new Set();
  for (const shell of doc.querySelectorAll(SHELL_SELECTOR)) {
    for (const link of shell.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(link.getAttribute('href'), page.origin); } catch { continue; }
      if (url.origin !== page.origin) continue;
      const routes = [url.pathname, url.hash];
      for (const key of ['page', 'route', 'section']) routes.push(url.searchParams.get(key) || '');
      // One link contributes at most one destination; query/hash routers take
      // precedence over their common pathname (for example /index?page=offers).
      const route = routes.reverse().map(routeText)
        .find(candidate => ADMIN_ROUTE.test(candidate) && !BLOCKED_ROUTE.test(candidate));
      if (route) destinations.add(route.toLowerCase().replace(/\/+$/, ''));
      if (destinations.size >= 2) return true;
    }
  }
  return false;
}

/** Binom's own colorTheme store applies exactly .light / .dark to <html>.
 * Reading that signal avoids guessing from page colors.
 * No settings, session storage or credentials need to be inspected. */
export function nativeAppearance(doc) {
  const root = doc?.documentElement;
  if (root?.classList.contains('dark')) return 'dark';
  if (root?.classList.contains('light')) return 'light';
  return null;
}

/** Follows Binom's native light/dark switch and reports changes to the
 * Dashboard. The extension no longer restyles the tracker itself. */
export function watchNativeAppearance({ document: doc = globalThis.document, window: win = globalThis.window, onAppearanceChange = () => {} } = {}) {
  const media = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-color-scheme: dark)') : null;
  let observer = null;
  let destroyed = false;

  function getAppearance() {
    return nativeAppearance(doc) || (media?.matches ? 'dark' : 'light');
  }
  let appearance = getAppearance();

  function refresh() {
    if (destroyed) return;
    const next = getAppearance();
    if (next === appearance) return;
    appearance = next;
    try { onAppearanceChange(appearance); } catch { /* A widget callback cannot break the page. */ }
  }

  if (typeof win.MutationObserver === 'function' && doc.documentElement) {
    observer = new win.MutationObserver(refresh);
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  media?.addEventListener('change', refresh);

  return {
    getAppearance,
    destroy() {
      destroyed = true;
      observer?.disconnect();
      observer = null;
      media?.removeEventListener('change', refresh);
    },
  };
}
