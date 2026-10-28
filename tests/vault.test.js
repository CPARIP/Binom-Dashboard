import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptApiKey, decryptApiKey, validateVault, validateVaultPassword } from '../src/vault.js';

const origin = 'https://tracker.example:8443';
const key = 'TEST-VAULT-ONLY-API-KEY';
const password = 'Длинная парольная фраза 🔐';
const credentialId = 'b8990f0a-e435-4f71-ab17-b45ca37f4058';
const options = { origin, key, password, credentialId };
const created = encryptApiKey(options);

test('vault round trip stores only bounded ciphertext and binds the canonical exact origin', async () => {
  const vault = await created;
  assert.deepEqual(Object.keys(vault).sort(), ['version', 'origin', 'credentialId', 'kdf', 'iterations', 'salt', 'iv', 'ciphertext'].sort());
  assert.equal(vault.origin, origin);
  assert.equal(vault.kdf, 'PBKDF2-SHA-256');
  assert.equal(vault.iterations, 600000);
  assert.equal(Buffer.from(vault.salt, 'base64').length, 16);
  assert.equal(Buffer.from(vault.iv, 'base64').length, 12);
  assert.equal(Buffer.from(vault.ciphertext, 'base64').length, key.length + 16);
  assert.ok(!JSON.stringify(vault).includes(key));
  assert.ok(!JSON.stringify(vault).includes(password));
  assert.deepEqual(validateVault(vault, origin), vault);
  assert.notEqual(validateVault(vault, origin), vault, 'Validation returns an independent record');
  assert.equal(await decryptApiKey({ vault, origin, password }), key);
  const canonical = await encryptApiKey({ ...options, origin: 'https://TRACKER.example:8443/' });
  assert.equal(canonical.origin, origin);
  assert.equal(await decryptApiKey({ vault: canonical, origin, password }), key);
});

test('each encryption uses fresh salt and IV even for the same origin, key and password', async () => {
  const first = await created;
  const second = await encryptApiKey(options);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test('incorrect passwords, ciphertext tampering and origin or identity substitution fail safely', async () => {
  const vault = await created;
  const damaged = Buffer.from(vault.ciphertext, 'base64'); damaged[0] ^= 1;
  const cases = [
    { vault, origin, password: 'Incorrect password phrase' },
    { vault: { ...vault, ciphertext: damaged.toString('base64') }, origin, password },
    { vault: { ...vault, credentialId: 'another-credential-id' }, origin, password },
    { vault, origin: 'https://tracker.example', password },
    { vault: { ...vault, origin: 'https://other.example' }, origin: 'https://other.example', password },
  ];
  for (const input of cases) await assert.rejects(decryptApiKey(input), error => {
    assert.equal(error.code, 'VAULT_UNLOCK_FAILED');
    assert.ok(!error.message.includes(key));
    assert.ok(!error.message.includes(input.password));
    assert.ok(!error.message.includes(origin));
    return true;
  });
});

test('vault validation rejects extra fields, accessors, malformed base64 and unbounded KDF parameters', async () => {
  const vault = await created;
  const invalid = [
    null, [], Object.create(vault), { ...vault, key }, { ...vault, version: 2 },
    { ...vault, iterations: 1 }, { ...vault, iterations: 999999999 }, { ...vault, kdf: 'SHA-1' },
    { ...vault, credentialId: '../another' }, { ...vault, credentialId: 'x'.repeat(65) },
    { ...vault, origin: origin + '/' }, { ...vault, salt: vault.salt + '\n' },
    { ...vault, iv: Buffer.alloc(16).toString('base64') }, { ...vault, ciphertext: Buffer.alloc(16).toString('base64') },
    { ...vault, ciphertext: Buffer.alloc(529).toString('base64') },
    { ...vault, salt: 'AAAAAAAAAAAAAAAAAAAAAB==' }, // Noncanonical pad bits.
  ];
  let accessed = false;
  invalid.push({ ...vault, get salt() { accessed = true; return vault.salt; } });
  for (const candidate of invalid) assert.throws(() => validateVault(candidate, origin), { code: 'VAULT_INVALID' });
  assert.equal(accessed, false);
  assert.throws(() => validateVault(vault, 'http://tracker.example:8443'), { code: 'VAULT_INVALID' });
});

test('password validation preserves whitespace and Unicode, with strict length and encoding bounds', () => {
  assert.equal(validateVaultPassword(password), password);
  assert.equal(validateVaultPassword(' exact password '), ' exact password ');
  assert.equal(validateVaultPassword('🔐'.repeat(256)), '🔐'.repeat(256));
  for (const invalid of [undefined, null, {}, '', 'x'.repeat(11), '🔐'.repeat(11), 'x'.repeat(257), '🔐'.repeat(257), 'password-with-\uD800']) {
    assert.throws(() => validateVaultPassword(invalid), { code: 'VAULT_PASSWORD' });
  }
});

test('invalid API keys and origin input never enter encryption or appear in errors', async () => {
  await assert.rejects(encryptApiKey({ ...options, key: key + '\n' }), { code: 'INVALID_KEY' });
  await assert.rejects(encryptApiKey({ ...options, origin: 'http://tracker.example' }), { code: 'INVALID_ORIGIN' });
  await assert.rejects(encryptApiKey({ ...options, credentialId: 'bad/id' }), { code: 'VAULT_INVALID' });
});
