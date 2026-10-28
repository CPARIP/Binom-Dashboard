import { DASHBOARD_MARKER, findMountTarget, isCampaignsUrl } from './placement.js';
import { isTrackerAdminPage } from './theme.js';

const MARKER = DASHBOARD_MARKER;
const NAV_ATTRIBUTE = 'data-binom-dashboard-nav';
const MUTED_ATTRIBUTE = 'data-binom-dashboard-native-inactive';
const VIEW_ATTRIBUTE = 'data-binom-dashboard-view';
const TITLE = 'Binom | Dashboard';
const SHELL_SELECTOR = '[class*="_headerDesktop_"], [class*="_headerMobile_"], [class*="_bottomNavigation_"], [class*="_topNav_"], header, nav';
const CAMPAIGNS_TEXT = /^(?:campaigns|кампании)$/i;
const SECTION_TEXT = /^(?:campaigns|кампании|landers|landings|лендинги|offers|офферы|rotations|ротации|trends|тренды|conversions|конверсии|traffic sources|источники(?: трафика)?|users|пользователи|files|файлы|clicklog|triggers|facebook)$/i;
const MENU_SELECTORS = ['[class*="_bottomNavigation_"]', '[role="tablist"]', 'nav, [role="navigation"]', '[class*="_topNav_"], [class*="_headerMobile_"]'];
const BREADCRUMB_SELECTOR = '[aria-label*="breadcrumb" i], [aria-label*="хлебн" i], [class*="breadcrumb" i], ol';
const STYLES = `
[${NAV_ATTRIBUTE}] { display: inline-flex; position: relative; white-space: nowrap; }
[${NAV_ATTRIBUTE}] > a { display: inline-flex; align-items: center; box-sizing: border-box; height: 100%; padding: 15px 0; font-size: var(--medium-font-size, 14px); font-weight: 600; line-height: 115%; color: var(--color-header-navigation-tabs-item, inherit); text-decoration: none; }
[${NAV_ATTRIBUTE}] > a:hover { color: var(--color-header-navigation-tabs-item-hover, #0e7490); }
[${NAV_ATTRIBUTE}][data-active="true"] > a { color: var(--color-header-navigation-tabs-item-active, #0e7490); }
[${NAV_ATTRIBUTE}][data-active="true"]::after { content: ""; position: absolute; bottom: -1px; left: 0; width: 100%; height: 3px; background: var(--color-header-navigation-tabs-item-border-bottom-active, #0e7490); pointer-events: none; }
[${MUTED_ATTRIBUTE}], [${MUTED_ATTRIBUTE}] a { color: var(--color-header-navigation-tabs-item, inherit) !important; border-bottom-color: transparent !important; text-decoration: none !important; }
[${MUTED_ATTRIBUTE}]::before, [${MUTED_ATTRIBUTE}]::after,
[${MUTED_ATTRIBUTE}] a::before, [${MUTED_ATTRIBUTE}] a::after { background-color: transparent !important; border-bottom-color: transparent !important; box-shadow: none !important; }
[${VIEW_ATTRIBUTE}] { position: fixed; left: 0; right: 0; bottom: 0; z-index: 1; display: flow-root; min-height: 0; min-width: 0; overflow: auto; overscroll-behavior: contain; width: 100%; box-sizing: border-box; background: var(--bt-canvas, var(--color-simple-bg, #f3f6fa)); visibility: hidden; pointer-events: none; }
[${VIEW_ATTRIBUTE}][data-ready="true"] { visibility: visible; pointer-events: auto; }
`;

function textOf(node) { return node.textContent.replace(/\s+/g, ' ').trim(); }
function isPlainClick(event) {
  return event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

/** Only routing parameters are carried into our link. Native URLs may contain an
 * authentication token; neither that token nor arbitrary query fields are copied. */
function cleanCampaignsUrl(value, currentOrigin) {
  let input;
  try { input = new URL(value); } catch { return null; }
  if (input.protocol !== 'https:' || input.origin !== currentOrigin || input.username || input.password) return null;
  if (/\/(?:api|login|logout|signin)(?:\/|$)/i.test(input.pathname)) return null;
  const output = new URL(input.pathname, input.origin);
  for (const name of ['page', 'route', 'section', 'tab']) {
    const route = input.searchParams.get(name);
    if (route && /^[a-zA-Z0-9/_-]{1,100}$/.test(route)) output.searchParams.set(name, route);
  }
  // Hash routers are supported, but hash query parameters are intentionally not copied.
  if (/^#!?\/[a-zA-Z0-9/_-]*$/.test(input.hash.split('?')[0])) output.hash = input.hash.split('?')[0];
  return output;
}

function visibleNativeLink(link, origin, win) {
  if (link.closest(`[${NAV_ATTRIBUTE}], ${BREADCRUMB_SELECTOR}, [hidden], [inert], [aria-hidden="true"]`)
      || !link.getClientRects().length) return false;
  const visibility = win.getComputedStyle(link).visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  try { return new URL(link.getAttribute('href'), origin).origin === origin; }
  catch { return false; }
}

/** A breadcrumb repeats the Campaigns label before the actual menu. Select a
 * visible group of peer sections, preferring Binom's lower navigation row.
 * A broad desktop header is deliberately not a fallback menu container. */
function findMenuTarget(doc, origin, win) {
  for (const selector of MENU_SELECTORS) {
    for (const menu of doc.querySelectorAll(selector)) {
      if (menu.closest(BREADCRUMB_SELECTOR)) continue;
      const links = [...menu.querySelectorAll('a[href]')]
        .filter(link => visibleNativeLink(link, origin, win));
      for (const anchor of links.filter(link => CAMPAIGNS_TEXT.test(textOf(link)))) {
        for (let row = anchor.parentElement; row && menu.contains(row); row = row.parentElement) {
          const peers = links.filter(link => row.contains(link) && SECTION_TEXT.test(textOf(link)));
          if (new Set(peers.map(link => textOf(link).toLowerCase())).size < 2) continue;
          // The nearest shared row supports both direct links and wrapped tabs.
          // Never climb out into the title/breadcrumb/header shell.
          let slot = anchor;
          while (slot.parentElement !== row && slot.parentElement?.querySelectorAll('a[href]').length === 1) slot = slot.parentElement;
          return { anchor, slot };
        }
      }
    }
  }
  return null;
}

/** Add one extension-owned navigation entry and a reversible view. Normal links
 * deliberately initialize Binom's own router; no private Vue history state is edited.
 * onChange is emitted for user navigation, never merely because update() ran. */
export function createDashboardNavigation({ onChange = () => {}, document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  let enabled = false;
  let baseUrl = null;
  let nav = null;
  let link = null;
  let nativeAnchor = null;
  let nativeSlot = null;
  let mutedSnapshot = null;
  let ariaSnapshot = null;
  let stylesheet = null;
  let view = null;
  let nativeContent = null;
  let contentSnapshot = null;
  let originalTitle = null;
  let pendingNavigation = false;
  let pendingTimer = null;
  let destroyed = false;

  function notify() { try { onChange(); } catch { /* UI callbacks cannot block native navigation. */ } }

  function restoreView() {
    view?.remove();
    view = null;
    if (nativeContent && contentSnapshot) {
      for (const [name, original] of Object.entries(contentSnapshot)) {
        if (name === 'inert' ? nativeContent.hasAttribute(name) : nativeContent.getAttribute(name) === 'true') {
          if (original === null) nativeContent.removeAttribute(name);
          else nativeContent.setAttribute(name, original);
        }
      }
    }
    nativeContent = null;
    contentSnapshot = null;
    if (nativeSlot && mutedSnapshot !== null) {
      if (mutedSnapshot.present) nativeSlot.setAttribute(MUTED_ATTRIBUTE, mutedSnapshot.value);
      else nativeSlot.removeAttribute(MUTED_ATTRIBUTE);
    }
    mutedSnapshot = null;
    if (nativeAnchor && ariaSnapshot !== null && !nativeAnchor.hasAttribute('aria-current')) {
      if (ariaSnapshot.present) nativeAnchor.setAttribute('aria-current', ariaSnapshot.value);
    }
    ariaSnapshot = null;
    if (originalTitle !== null && doc.title === TITLE) doc.title = originalTitle;
    originalTitle = null;
    if (nav?.getAttribute('data-active') !== 'false') nav?.setAttribute('data-active', 'false');
    link?.removeAttribute('aria-current');
  }

  function removeNavigation() {
    restoreView();
    nav?.remove(); nav = null; link = null;
    nativeAnchor = null; nativeSlot = null;
    stylesheet?.remove(); stylesheet = null;
  }

  function ensureNavigation({ anchor, slot }) {
    if (nativeAnchor === anchor && nativeSlot === slot && nav?.isConnected && stylesheet?.isConnected
        && nav.parentElement === slot.parentElement && nav.nextElementSibling === slot) return;
    removeNavigation();
    nativeSlot = slot;
    if (!nativeSlot.parentElement) return;
    nativeAnchor = anchor;
    nav = doc.createElement(nativeSlot.tagName === 'LI' ? 'li' : 'div');
    nav.setAttribute(NAV_ATTRIBUTE, '');
    nav.setAttribute('data-active', 'false');
    // Copy only known presentation classes, never attributes, listeners or content.
    for (const className of nativeSlot.classList) if (/^_tab_[\w-]+$/.test(className)) nav.classList.add(className);
    link = doc.createElement('a');
    for (const className of anchor.classList) if (/^_link_[\w-]+$/.test(className)) link.classList.add(className);
    link.textContent = 'Dashboard';
    nav.appendChild(link);
    nativeSlot.parentElement.insertBefore(nav, nativeSlot);
    stylesheet = doc.createElement('style');
    stylesheet.id = 'binom-dashboard-navigation-styles';
    stylesheet.textContent = STYLES;
    (doc.head || doc.documentElement).appendChild(stylesheet);
  }

  function requested() {
    if (!baseUrl || pendingNavigation) return false;
    let current;
    try { current = new URL(win.location.href); } catch { return false; }
    return current.searchParams.get(MARKER) === '1' && isCampaignsUrl(current.href, baseUrl.href);
  }

  /** Binom's own title and current tab, as they were before activate() changed them. */
  function nativePageState() {
    return {
      title: originalTitle !== null && doc.title === TITLE ? originalTitle : doc.title,
      currentTab: ariaSnapshot?.present && ariaSnapshot.value === 'page' && nativeAnchor?.isConnected ? nativeAnchor : null,
    };
  }

  function syncView() {
    if (!enabled || !baseUrl || !requested() || !isTrackerAdminPage(doc, win.location.href)) {
      restoreView(); return;
    }
    const target = findMountTarget(doc, nativePageState());
    const content = target?.parent;
    if (view?.isConnected && nativeContent?.isConnected && content === nativeContent) {
      if (!positionView()) restoreView();
      return;
    }
    restoreView();
    // Never hide the browser-facing shell, portals, body, or document root.
    if (!content?.parentElement || content === doc.body || content === doc.documentElement
        || content.contains(nativeAnchor) || content.querySelector(SHELL_SELECTOR)
        || content.matches('#app, .main, [data-v-app], [role="dialog"]')
        || ['modals', 'contextmenu', 'top'].includes(content.id)) return;
    nativeContent = content;
    view = doc.createElement('section');
    view.setAttribute(VIEW_ATTRIBUTE, '');
    view.setAttribute('aria-label', 'Binom Dashboard');
    // Keep extension UI outside Vue's managed tree. Cover the workspace without
    // collapsing native virtual-table geometry or hiding any application shell.
    doc.body.appendChild(view);
    if (!positionView()) restoreView();
  }

  function positionView() {
    if (!view || !nativeAnchor?.isConnected || !nativeAnchor.getClientRects().length) return false;
    let bottom = nativeAnchor.getBoundingClientRect().bottom;
    for (let node = nativeAnchor.parentElement; node && node !== doc.body; node = node.parentElement) {
      if (!node.matches(SHELL_SELECTOR)) continue;
      const rect = node.getBoundingClientRect();
      if (rect.height > 0 && rect.height < win.innerHeight / 2) bottom = Math.max(bottom, rect.bottom);
    }
    if (!Number.isFinite(bottom) || bottom < 0 || win.innerHeight - bottom < 120) return false;
    const top = `${Math.ceil(bottom)}px`;
    if (view.style.top !== top) view.style.top = top;
    return true;
  }

  function activate(host) {
    if (!view?.isConnected || host?.parentElement !== view || !host.shadowRoot?.querySelector('.bd')
        || host.getBoundingClientRect().width < 100 || host.getBoundingClientRect().height < 40
        || !nativeContent?.isConnected || !positionView()) return false;
    if (view.getAttribute('data-ready') === 'true') return true;
    contentSnapshot = { inert: nativeContent.getAttribute('inert'), 'aria-hidden': nativeContent.getAttribute('aria-hidden') };
    nativeContent.setAttribute('inert', '');
    nativeContent.setAttribute('aria-hidden', 'true');
    view.setAttribute('data-ready', 'true');
    originalTitle = doc.title;
    doc.title = TITLE;
    if (nativeSlot) {
      mutedSnapshot = { present: nativeSlot.hasAttribute(MUTED_ATTRIBUTE), value: nativeSlot.getAttribute(MUTED_ATTRIBUTE) };
      nativeSlot.setAttribute(MUTED_ATTRIBUTE, '');
    }
    if (nativeAnchor) {
      ariaSnapshot = { present: nativeAnchor.hasAttribute('aria-current'), value: nativeAnchor.getAttribute('aria-current') };
      nativeAnchor.removeAttribute('aria-current');
    }
    nav?.setAttribute('data-active', 'true');
    link?.setAttribute('aria-current', 'page');
    return true;
  }

  function onNativeClick(event) {
    if (!enabled || !view || !isPlainClick(event) || event.defaultPrevented) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.closest(`[${NAV_ATTRIBUTE}]`) || !anchor.closest(SHELL_SELECTOR)) return;
    if (anchor === nativeAnchor || CAMPAIGNS_TEXT.test(textOf(anchor))) {
      // A normal load also handles the same-path case a client router may ignore.
      event.preventDefault();
      event.stopImmediatePropagation();
      restoreView();
      notify();
      win.location.assign(baseUrl.href);
      return;
    }
    // Let Binom handle its own links and keep the Dashboard history entry so Back
    // returns here. A canceled native navigation can safely re-open this view.
    pendingNavigation = true;
    restoreView();
    notify();
    win.clearTimeout(pendingTimer);
    pendingTimer = win.setTimeout(() => {
      pendingNavigation = false;
      syncView();
      notify();
    }, 800);
  }

  function onPopState() {
    pendingNavigation = false;
    win.clearTimeout(pendingTimer);
    syncView();
    notify();
  }

  doc.addEventListener('click', onNativeClick, true);
  win.addEventListener('popstate', onPopState);
  const onResize = () => { if (view && !positionView()) { restoreView(); notify(); } };
  win.addEventListener('resize', onResize);
  win.addEventListener('scroll', onResize, true);

  return {
    update(options = {}) {
      if (destroyed) return;
      const nextBaseUrl = cleanCampaignsUrl(options.campaignsHref, win.location.origin);
      if (options.clearRoute === true && nextBaseUrl && isCampaignsUrl(win.location.href, nextBaseUrl.href)) {
        // Remove only our route marker, preserving Binom's URL and history state.
        // Enabling again must not unexpectedly reopen a previously closed view.
        const current = new URL(win.location.href);
        if (current.searchParams.has(MARKER)) {
          current.searchParams.delete(MARKER);
          win.history.replaceState(win.history.state, '', current.href);
        }
      }
      enabled = options.enabled === true;
      baseUrl = enabled ? nextBaseUrl : null;
      const target = baseUrl ? findMenuTarget(doc, baseUrl.origin, win) : null;
      if (!enabled || !baseUrl || !target || !isTrackerAdminPage(doc, win.location.href)) {
        removeNavigation(); return;
      }
      ensureNavigation(target);
      if (!link) return;
      const destination = new URL(baseUrl.href);
      destination.searchParams.set(MARKER, '1');
      if (link.getAttribute('href') !== destination.href) link.setAttribute('href', destination.href);
      syncView();
    },
    getTarget() {
      return view?.isConnected ? { parent: view, before: null } : null;
    },
    activate,
    deactivate: restoreView,
    destroy() {
      destroyed = true;
      enabled = false;
      win.clearTimeout(pendingTimer);
      doc.removeEventListener('click', onNativeClick, true);
      win.removeEventListener('popstate', onPopState);
      win.removeEventListener('resize', onResize);
      win.removeEventListener('scroll', onResize, true);
      removeNavigation();
      baseUrl = null;
    },
  };
}
