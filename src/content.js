import { createDashboard } from './dashboard.js';
import { watchNativeAppearance } from './theme.js';
import { createDashboardNavigation } from './navigation.js';
import { routeKey } from './placement.js';
import { setLanguage } from './i18n.js';

// After an extension update or reload the previous copy keeps running in its own, now
// orphaned, isolated world and can no longer reach the extension. A new copy announces
// itself with this DOM event so the orphan removes its UI and stops.
const REPLACED_EVENT = 'binom-dashboard-replaced';
const STATUS_INTERVAL = 15000;
const STATUS_RETRY_MIN = 2000;
// Longer than the service worker's idle timeout, so a disconnected tab lets it sleep.
// Reconnecting still notifies the tab at once (BINOM_CONFIG_CHANGED).
const STATUS_RETRY_MAX = 60000;

function extensionContextValid() {
  try { return Boolean(chrome.runtime?.id); } catch { return false; }
}

// Dynamic script registration plus injection into an existing tab can run twice.
if (!globalThis.__BINOM_DASHBOARD_V1__) {
  globalThis.__BINOM_DASHBOARD_V1__ = true;
  // Retire orphaned copies before building any UI of our own.
  document.dispatchEvent(new CustomEvent(REPLACED_EVENT));
  let status = null;
  let widget = null;
  let host = null;
  let stopped = false;
  let scheduled = null;
  // Only section and Dashboard route changes count as navigation, not Binom's own
  // filter parameters that it adds to the address after start-up.
  let lastRoute = routeKey(location.href);
  // Failed status checks back off instead of repeating every second while the tab
  // stays open.
  let nextStatusAt = 0;
  let statusRetryDelay = STATUS_RETRY_MIN;
  let statusPending = false;
  let statusRefreshQueued = false;
  let statusGeneration = 0;
  let retryMountAfter = 0;
  let languageQuery = null;
  // Binom's native switch owns light/dark; the tracker itself is never restyled.
  const appearance = watchNativeAppearance({ onAppearanceChange: theme => { widget?.updateAppearance?.({ theme }); } });
  const navigation = createDashboardNavigation({ onChange: () => {
    lastRoute = routeKey(location.href);
    removeWidget();
    schedule();
  } });

  function syncAppearance() {
    widget?.updateAppearance?.({ theme: appearance.getAppearance() });
  }

  async function message(payload) {
    let response;
    try { response = await chrome.runtime.sendMessage(payload); }
    catch {
      // Let the caller finish handling this error before the widget is torn down.
      if (!extensionContextValid()) setTimeout(stop, 0);
      const e = new Error('Расширение обновлено. Перезагрузите страницу Binom.'); e.code = 'EXTENSION_RELOADED'; throw e;
    }
    if (!response?.ok) {
      const e = new Error(response?.error?.message || 'Не удалось загрузить статистику.');
      e.code = response?.error?.code || 'REQUEST_FAILED';
      throw e;
    }
    return response.data;
  }
  function removeWidget() {
    if (host && navigation.getTarget()?.parent === host.parentElement) navigation.deactivate();
    try { widget?.destroy(); } catch { /* Always restore the native view even if cleanup fails. */ }
    widget = null;
    host?.remove();
    host = null;
  }
  function settings() { void message({ type: 'OPEN_SETTINGS' }).catch(() => {}); }
  function mount() {
    if (stopped || Date.now() < retryMountAfter) return;
    try { mountDashboard(); }
    catch {
      removeWidget();
      navigation.deactivate();
      // A failed render must leave Binom usable, and must not retry on every DOM mutation.
      retryMountAfter = Date.now() + 3000;
      clearTimeout(scheduled);
      scheduled = setTimeout(mount, 3100);
    }
  }
  function mountDashboard() {
    syncAppearance();
    navigation.update({
      enabled: Boolean(status?.configured && status.config.origin === location.origin && status.preferences?.dashboardEnabled !== false),
      clearRoute: status?.preferences?.dashboardEnabled === false,
      campaignsHref: status?.configured ? status.config.origin + status.config.campaignsPath : null,
    });
    const target = navigation.getTarget();
    if (!target) { removeWidget(); return; }
    if (host?.isConnected && widget && host.parentElement === target.parent) {
      if (document.querySelector('input[type="password"]')) { removeWidget(); navigation.deactivate(); }
      else if (!navigation.activate(host)) throw new Error('Dashboard is not ready');
      return;
    }
    if (host) removeWidget();
    host = document.createElement('div');
    host.id = 'binom-dashboard-extension';
    host.style.cssText = 'display:block;flex:none;position:relative;width:100%;box-sizing:border-box;z-index:1;';
    target.parent.insertBefore(host, target.before);
    widget = createDashboard(host, {
      // Defaults and the stored period/filters come from the widget itself.
      initialQuery: languageQuery || { timezone: status.config.timezone },
      preferences: { ...status.preferences, theme: appearance.getAppearance() },
      loadDashboard: async query => {
        const latest = await message({ type: 'GET_STATUS' });
        if (!latest.hasKey) { const e = new Error(latest.hasSavedKey
          ? 'Разблокируйте сохранённый ключ паролем в настройках расширения.'
          : 'Введите API-ключ в настройках расширения. Можно сохранить его с паролем.'); e.code = 'NO_KEY'; throw e; }
        return message({ type: 'GET_DASHBOARD', query });
      },
      loadCatalogs: async () => {
        if (!status.hasKey) return { groups: [], sources: [], warnings: [] };
        return message({ type: 'GET_CATALOGS' });
      },
      loadCampaigns: async () => message({ type: 'GET_CAMPAIGNS' }),
      loadCampaignOverview: async (query, campaignIds) => message({ type: 'GET_CAMPAIGN_OVERVIEW', query, campaignIds }),
      loadClicklog: async (query, campaignIds, page) => message({ type: 'GET_CLICKLOG', query, campaignIds, page }),
      loadCampaignCharts: async (query, campaignIds) => message({ type: 'GET_CAMPAIGN_CHARTS', query, campaignIds }),
      loadInsights: async (query, campaignIds, sections) => message({ type: 'GET_INSIGHTS', query, campaignIds, sections }),
      onSettings: settings,
      onPreferencesChange: preferences => {
        const { theme: _theme, language: _language, dashboardEnabled: _dashboardEnabled, ...panelPreferences } = preferences;
        return message({ type: 'SAVE_PREFERENCES', preferences: panelPreferences });
      },
    });
    languageQuery = null;
    if (!navigation.activate(host)) throw new Error('Dashboard is not ready');
    // Notify chart/layout observers after opening the dedicated view.
    window.dispatchEvent(new Event('resize'));
  }
  async function updateStatus(force = false) {
    if (stopped) return;
    if (statusPending) { if (force) statusRefreshQueued = true; return; }
    if (!force && Date.now() < nextStatusAt) return;
    statusPending = true;
    const generation = statusGeneration;
    try {
      const next = await message({ type: 'GET_STATUS' });
      nextStatusAt = Date.now() + STATUS_INTERVAL;
      statusRetryDelay = STATUS_RETRY_MIN;
      if (generation !== statusGeneration) return;
      const changed = JSON.stringify(next.config) !== JSON.stringify(status?.config) || next.hasKey !== status?.hasKey || next.hasSavedKey !== status?.hasSavedKey;
      const languageChanged = next.preferences?.language !== status?.preferences?.language;
      languageQuery = !changed && languageChanged && widget ? widget.getQuery() : null;
      setLanguage(next.preferences?.language);
      status = next;
      if (changed || languageChanged) removeWidget();
      mount();
    } catch {
      if (stopped) return;
      nextStatusAt = Date.now() + statusRetryDelay;
      statusRetryDelay = Math.min(statusRetryDelay * 2, STATUS_RETRY_MAX);
      status = null; removeWidget(); syncAppearance(); navigation.update({ enabled: false });
    } finally {
      statusPending = false;
      if (statusRefreshQueued) { statusRefreshQueued = false; void updateStatus(true); }
    }
  }
  function schedule() {
    clearTimeout(scheduled);
    scheduled = setTimeout(mount, Math.max(150, retryMountAfter - Date.now() + 10));
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const routeTimer = setInterval(() => {
    // The extension was disabled, removed or reloaded without a replacement copy.
    if (!extensionContextValid()) { stop(); return; }
    const route = routeKey(location.href);
    if (route !== lastRoute) { lastRoute = route; removeWidget(); schedule(); }
    if (host && (!host.isConnected || !host.shadowRoot?.querySelector('.bd'))) {
      removeWidget(); navigation.deactivate(); schedule();
    }
    if (!document.hidden) void updateStatus();
  }, 1000);
  const configChanged = event => {
    if (event?.type === 'BINOM_PREFERENCES_CHANGED') { void updateStatus(true); return; }
    if (event?.type !== 'BINOM_CONFIG_CHANGED') return;
    // Replacing a key on the same site can change its user's permissions.
    // Discard all prior aggregates and catalogs even when the URL is unchanged.
    statusGeneration += 1;
    status = null;
    removeWidget();
    syncAppearance();
    navigation.update({ enabled: false });
    void updateStatus(true);
  };
  chrome.runtime.onMessage.addListener(configChanged);
  // Page scripts can dispatch synthetic window events; only real ones count. Otherwise a
  // page could stop the extension (pagehide) or bypass the status backoff (focus).
  const focus = event => { if (event.isTrusted) void updateStatus(true); };
  window.addEventListener('focus', focus);
  // A page or a live copy may dispatch the event too; only an orphan stops.
  const onReplaced = () => { if (!extensionContextValid()) stop(); };
  document.addEventListener(REPLACED_EVENT, onReplaced);
  function stop() {
    if (stopped) return;
    stopped = true; observer.disconnect(); clearTimeout(scheduled); clearInterval(routeTimer);
    window.removeEventListener('focus', focus);
    document.removeEventListener(REPLACED_EVENT, onReplaced);
    try { chrome.runtime.onMessage.removeListener(configChanged); } catch { /* An orphaned context may reject extension APIs. */ }
    appearance.destroy();
    navigation.destroy();
    removeWidget();
  }
  window.addEventListener('pagehide', event => { if (event.isTrusted && !event.persisted) stop(); });
  void updateStatus(true);
}
