import test from 'node:test';
import assert from 'node:assert/strict';
import { injectsIntoOpenTabs } from '../src/updates.js';

test('A fresh copy goes into open tabs only when the previous copy can step aside', () => {
  assert.equal(injectsIntoOpenTabs({ reason: 'install' }), true, 'A new install has no previous copy');
  for (const previousVersion of ['0.6.13', '0.6.14', '0.7.0', '1.0.0', '0.6.13.1']) {
    assert.equal(injectsIntoOpenTabs({ reason: 'update', previousVersion }), true, `Update or reload from ${previousVersion}`);
  }
  // Copies up to 0.6.12 would keep fighting a new copy over the menu until a page reload.
  for (const previousVersion of ['0.6.12', '0.6.9', '0.6.0', '0.5.0', '0.1.0', '0.6', '0']) {
    assert.equal(injectsIntoOpenTabs({ reason: 'update', previousVersion }), false, `Update from ${previousVersion}`);
  }
  for (const previousVersion of ['', undefined, null, 'x.y', '0.6.13-beta', '1.2.3.4.5', 13]) {
    assert.equal(injectsIntoOpenTabs({ reason: 'update', previousVersion }), false, `Unreadable previous version ${String(previousVersion)}`);
  }
  for (const reason of ['chrome_update', 'shared_module_update', undefined]) {
    assert.equal(injectsIntoOpenTabs({ reason, previousVersion: '0.6.13' }), false, `No injection for ${String(reason)}`);
  }
  assert.equal(injectsIntoOpenTabs(), false);
});
