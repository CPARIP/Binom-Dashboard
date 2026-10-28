import test from 'node:test';
import assert from 'node:assert/strict';
import { describeClicklogIcon } from '../src/clicklog-icons.js';
import { setLanguage } from '../src/i18n.js';

test('countries use local flags for ISO codes and English/Russian names', () => {
  for (const value of ['US', 'us', 'USA', 'United States', 'United States of America', 'США', 'Соединенные Штаты']) {
    const icon = describeClicklogIcon('country', value);
    assert.equal(icon.icon, 'country-US');
    assert.equal(icon.emoji, '🇺🇸');
    assert.equal(icon.label, value);
    assert.equal(icon.svg, undefined);
  }
  for (const [value, code, flag] of [
    ['UK', 'GB', '🇬🇧'], ['Russian Federation', 'RU', '🇷🇺'], ['Россия', 'RU', '🇷🇺'],
    ['The Netherlands', 'NL', '🇳🇱'],
    ['Вьетнам', 'VN', '🇻🇳'], ['Viet Nam', 'VN', '🇻🇳'], ['Deutschland', null, null],
    ['Türkiye', 'TR', '🇹🇷'], ["Côte d’Ivoire", 'CI', '🇨🇮'], ['Korea, Republic of', 'KR', '🇰🇷'],
  ]) {
    const icon = describeClicklogIcon('country', value);
    assert.equal(icon.icon, code ? `country-${code}` : 'unknown-country');
    assert.equal(icon.emoji ?? null, flag);
    assert.equal(icon.label, value);
  }
});

test('unknown, multiple and non-country values never receive a guessed flag', () => {
  for (const value of ['Unknown', 'Unknown country', 'EU', 'APAC', 'en', 'en-US', '192.0.2.1', 'US, DE', 'United States, Russia', 'ZZ', 'Atlantis']) {
    const icon = describeClicklogIcon('country', value);
    assert.equal(icon.icon, 'unknown-country', value);
    assert.equal(icon.emoji, undefined);
    assert.equal(icon.label, value);
    assert.match(icon.svg, /<svg /);
  }
});

test('device families support explicit aliases without guessing unfamiliar devices', () => {
  for (const [values, family] of [
    [['Desktop', 'computer', 'Laptop', 'ноутбук'], 'desktop'],
    [['Mobile', 'smartphone', 'feature phone', 'телефон'], 'mobile'],
    [['Tablet', 'планшет'], 'tablet'],
    [['TV', 'Smart-TV', 'телевизор'], 'tv'],
    [['Console', 'gaming console'], 'console'],
    [['Wearable', 'smartwatch', 'умные часы'], 'wearable'],
  ]) for (const value of values) {
    const icon = describeClicklogIcon('device', value);
    assert.equal(icon.icon, `device-${family}`, value);
    assert.equal(icon.label, value);
    assert.match(icon.svg, /aria-hidden="true"/);
  }
  for (const value of ['Unknown', 'car browser', 'mobile, tablet', 'not a smartphone']) assert.equal(describeClicklogIcon('device', value).icon, 'unknown-device');
});

test('OS families accept ordinary versions and aliases while preserving raw tooltip labels', () => {
  for (const [values, family] of [
    [['Windows', 'Windows NT 10.0', 'Microsoft Windows 11'], 'windows'],
    [['Android', 'Android 14'], 'android'],
    [['MacOS', 'Mac OS X 10.15.7', 'OS X', 'Macintosh'], 'macos'],
    [['iOS', 'iPhone OS 17', 'iPadOS 18'], 'ios'],
    [['Linux', 'Ubuntu 24.04', 'Debian', 'Red Hat Enterprise Linux'], 'linux'],
    [['ChromeOS', 'Chrome OS', 'Chromium OS'], 'chromeos'],
  ]) for (const value of values) {
    const icon = describeClicklogIcon('os', value);
    assert.equal(icon.icon, `os-${family}`, value);
    assert.equal(icon.label, value);
    assert.match(icon.svg, /<svg /);
  }
  for (const value of ['Unknown', 'Windows, Android', 'Darwin', 'unrecognized Android device']) assert.equal(describeClicklogIcon('os', value).icon, 'unknown-os');
});

test('unavailable labels are explicit and arbitrary values never enter artwork', () => {
  const payload = '<img src=x onerror="alert(1)">';
  for (const key of ['country', 'device', 'os']) {
    const icon = describeClicklogIcon(key, payload);
    assert.equal(icon.label, payload, 'The caller inserts the exact raw label as text');
    assert.equal(icon.svg.includes(payload), false);
    assert.equal(/(?:https?:|onerror|<script|<image)/i.test(icon.svg), false);
    assert.equal(icon.emoji, undefined);
    for (const value of [null, undefined, '', '   ', ['US'], { country: 'US' }]) assert.equal(describeClicklogIcon(key, value).label, 'Unknown');
  }
  const spaced = '  Android 14  ';
  assert.equal(describeClicklogIcon('os', spaced).label, spaced);
  assert.equal(describeClicklogIcon('os', spaced).icon, 'os-android');
});

test('only unavailable icon labels follow the selected extension language', () => {
  try {
    setLanguage('ru');
    assert.equal(describeClicklogIcon('device', null).label, 'Не определено');
    assert.equal(describeClicklogIcon('country', 'United States').label, 'United States');
    setLanguage('en');
    assert.equal(describeClicklogIcon('device', null).label, 'Unknown');
    assert.equal(describeClicklogIcon('country', 'Россия').label, 'Россия');
    assert.equal(describeClicklogIcon('os', 'Windows 11').label, 'Windows 11');
  } finally { setLanguage('en'); }
});
