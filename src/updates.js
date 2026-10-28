// Content scripts up to 0.6.12 cannot hand an open tab over to a newer copy: both copies
// would keep rebuilding the menu entry until the page is reloaded. Those copies ask for a
// reload themselves, so a fresh copy goes into open tabs only after a new install or an
// update (including a reload of the same version) from a version that can step aside.
const FIRST_REPLACEABLE = [0, 6, 13];

/** Whether open tracker tabs should receive a fresh content script after onInstalled. */
export function injectsIntoOpenTabs({ reason, previousVersion } = {}) {
  if (reason === 'install') return true;
  if (reason !== 'update' || typeof previousVersion !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(previousVersion)) return false;
  const parts = previousVersion.split('.').map(Number);
  for (let index = 0; index < FIRST_REPLACEABLE.length; index++) {
    const part = parts[index] ?? 0;
    if (part !== FIRST_REPLACEABLE[index]) return part > FIRST_REPLACEABLE[index];
  }
  return true;
}
