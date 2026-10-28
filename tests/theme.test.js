import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/theme.js', import.meta.url))], bundle: true, write: false, format: 'esm' });
const { watchNativeAppearance, nativeAppearance } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

// The extension only follows Binom's light/dark switch; it never restyles
// the tracker, so the fixture throws on any attempt to change the page.
function fixture(initialTheme = 'dark', systemDark = false, onAppearanceChange = null) {
  const classes = new Set(initialTheme ? [initialTheme] : []);
  const mediaListeners = new Set();
  const changes = [];
  let observer;
  const forbidden = name => () => { throw new Error(`The tracker page must not be changed (${name})`); };
  const root = {
    classList: { contains: name => classes.has(name) },
    getAttribute: () => null,
    setAttribute: forbidden('setAttribute'),
    removeAttribute: forbidden('removeAttribute'),
    appendChild: forbidden('appendChild'),
  };
  const media = { matches: systemDark, addEventListener: (_name, fn) => mediaListeners.add(fn), removeEventListener: (_name, fn) => mediaListeners.delete(fn) };
  const doc = { documentElement: root, head: root, body: {}, createElement: forbidden('createElement') };
  const win = {
    location: { href: 'https://tracker.example/panel/campaigns' },
    dispatchEvent: forbidden('dispatchEvent'),
    matchMedia: () => media,
    getComputedStyle: () => { throw new Error('Native palette must not be inferred from page CSS'); },
    get localStorage() { throw new Error('Theme sync must not inspect site storage'); },
    MutationObserver: class {
      constructor(callback) { observer = this; this.callback = callback; }
      observe(_root, options) { this.options = options; }
      disconnect() { this.options = null; }
    },
  };
  const watcher = watchNativeAppearance({ document: doc, window: win, onAppearanceChange: onAppearanceChange || (value => changes.push(value)) });
  return {
    watcher, changes, mediaListeners,
    get observerOptions() { return observer?.options; },
    nativeTheme(value) { classes.clear(); if (value) classes.add(value); if (observer?.options) observer.callback(); },
    systemTheme(value) { media.matches = value; for (const callback of mediaListeners) callback(); },
  };
}

test('the native Binom switch drives light/dark without restyling the tracker', () => {
  const f = fixture('dark');
  assert.equal(f.watcher.getAppearance(), 'dark');
  assert.deepEqual(f.observerOptions, { attributes: true, attributeFilter: ['class'] }, 'Only native class changes are observed');
  f.nativeTheme('light');
  assert.equal(f.watcher.getAppearance(), 'light');
  f.nativeTheme('light');
  f.nativeTheme('dark');
  assert.deepEqual(f.changes, ['light', 'dark'], 'Only actual changes are reported');
  f.watcher.destroy();
  assert.equal(f.mediaListeners.size, 0);
  assert.equal(f.observerOptions, null);
  f.nativeTheme('light');
  assert.deepEqual(f.changes, ['light', 'dark'], 'Nothing is reported after destroy');
});

test('the system palette is only a fallback when Binom has no light/dark class', () => {
  const f = fixture(null, true);
  assert.equal(f.watcher.getAppearance(), 'dark');
  f.systemTheme(false);
  assert.equal(f.watcher.getAppearance(), 'light');
  f.nativeTheme('dark');
  f.systemTheme(true);
  f.systemTheme(false);
  assert.equal(f.watcher.getAppearance(), 'dark', 'Binom wins over the system preference');
  assert.deepEqual(f.changes, ['light', 'dark']);
  f.watcher.destroy();
});

test('a widget callback error cannot break the page or stop later updates', () => {
  let calls = 0;
  const f = fixture('dark', false, () => { calls += 1; throw new Error('widget'); });
  assert.doesNotThrow(() => f.nativeTheme('light'));
  assert.equal(f.watcher.getAppearance(), 'light');
  assert.doesNotThrow(() => f.nativeTheme('dark'));
  assert.equal(calls, 2, 'Every real change still reaches the widget');
  f.watcher.destroy();
  assert.equal(nativeAppearance({ documentElement: { classList: { contains: name => name === 'light' } } }), 'light');
  assert.equal(nativeAppearance(null), null);
});
