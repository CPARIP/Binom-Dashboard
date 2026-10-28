import test from 'node:test';
import assert from 'node:assert/strict';
import { t, setLanguage, getLanguage, locale, translateMessage } from '../src/i18n.js';
import { DEFAULT_PREFERENCES, SAFE_ERROR_MESSAGES, validatePreferences } from '../src/security.js';

test('language defaults and trusted errors are bilingual without translating tracker data', () => {
  assert.equal(DEFAULT_PREFERENCES.language, 'en');
  assert.equal(getLanguage(), 'en');
  assert.equal(locale(), 'en-US');
  for (const text of Object.values(SAFE_ERROR_MESSAGES)) assert.notEqual(translateMessage(text), text, text);
  assert.equal(translateMessage('Ответ Binom не соответствует ожидаемому формату. Код: row-identity.'), 'The Binom response does not match the expected format. Code: row-identity.');
  for (const name of ['Реклама — США', 'Campaign <Example>', 'The Netherlands']) assert.equal(translateMessage(name), name);
  setLanguage('ru');
  assert.equal(locale(), 'ru-RU');
  assert.equal(t('Клики', 'Clicks'), 'Клики');
  assert.equal(translateMessage(SAFE_ERROR_MESSAGES.AUTH), SAFE_ERROR_MESSAGES.AUTH);
  setLanguage('en');
  assert.equal(t('Клики', 'Clicks'), 'Clicks');
  for (const language of ['en', 'ru']) assert.deepEqual(validatePreferences({ language }), { language });
  for (const language of ['EN', 'fr', '', null, {}, []]) assert.throws(() => validatePreferences({ language }), { code: 'INVALID_PREFERENCES' });
});
