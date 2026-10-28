import { SecurityError, isPlainRecord, normalizeOrigin, validateApiKey } from './security.js';

const VERSION = 1;
const KDF = 'PBKDF2-SHA-256';
const ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BITS = 128;
const MAX_KEY_BYTES = 512;
const FIELDS = ['version', 'origin', 'credentialId', 'kdf', 'iterations', 'salt', 'iv', 'ciphertext'];
const encoder = new TextEncoder();

function fail(code) { throw new SecurityError(code); }

/** Do not trim or normalize a passphrase: each Unicode code point is intentional.
 * Reject lone surrogates so UTF-8 replacement cannot make different inputs equal. */
export function validateVaultPassword(password) {
  if (typeof password !== 'string' || password.length > 512) fail('VAULT_PASSWORD');
  const characters = [...password];
  if (characters.length < 12 || characters.length > 256 || characters.some(character => {
    const point = character.codePointAt(0);
    return point >= 0xD800 && point <= 0xDFFF;
  }) || encoder.encode(password).length > 1024) fail('VAULT_PASSWORD');
  return password;
}

function validCredentialId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function base64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function bytesFromBase64(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('VAULT_INVALID');
  let decoded;
  try { decoded = atob(value); } catch { fail('VAULT_INVALID'); }
  if (decoded.length < min || decoded.length > max) fail('VAULT_INVALID');
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  // atob tolerates nonzero padding bits; only one canonical representation is valid.
  if (base64(bytes) !== value) fail('VAULT_INVALID');
  return bytes;
}

/** Parse a fixed-size, fixed-cost record before performing any cryptography.
 * A modified KDF work factor can never turn an unlock into unbounded work. */
export function validateVault(vault, origin) {
  try {
    const expectedOrigin = normalizeOrigin(origin);
    if (!isPlainRecord(vault) || Object.keys(vault).length !== FIELDS.length ||
        Object.keys(vault).some(field => !FIELDS.includes(field)) ||
        vault.version !== VERSION || vault.kdf !== KDF || vault.iterations !== ITERATIONS ||
        !validCredentialId(vault.credentialId) || vault.origin !== normalizeOrigin(vault.origin) ||
        vault.origin !== expectedOrigin) fail('VAULT_INVALID');
    bytesFromBase64(vault.salt, SALT_BYTES, SALT_BYTES);
    bytesFromBase64(vault.iv, IV_BYTES, IV_BYTES);
    bytesFromBase64(vault.ciphertext, 1 + TAG_BITS / 8, MAX_KEY_BYTES + TAG_BITS / 8);
    return Object.fromEntries(FIELDS.map(field => [field, vault[field]]));
  } catch {
    fail('VAULT_INVALID');
  }
}

function additionalData(origin, credentialId) {
  // Binding metadata to the GCM tag prevents moving a saved key to another site
  // or silently substituting its credential identity during a concurrent change.
  return encoder.encode(JSON.stringify(['binom-dashboard-api-key', VERSION, origin, credentialId]));
}

async function deriveKey(password, salt, usage) {
  const passwordBytes = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, [usage],
    );
  } finally {
    // Best effort for mutable buffers; JavaScript strings cannot be explicitly erased.
    passwordBytes.fill(0);
  }
}

/** The returned record contains ciphertext only. No password or derived key is persisted. */
export async function encryptApiKey({ key, origin, password, credentialId }) {
  const canonicalOrigin = normalizeOrigin(origin);
  const apiKey = validateApiKey(key);
  validateVaultPassword(password);
  if (!validCredentialId(credentialId)) fail('VAULT_INVALID');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = encoder.encode(apiKey);
  try {
    const encryptionKey = await deriveKey(password, salt, 'encrypt');
    const encrypted = await crypto.subtle.encrypt({
      name: 'AES-GCM', iv, additionalData: additionalData(canonicalOrigin, credentialId), tagLength: TAG_BITS,
    }, encryptionKey, plaintext);
    return {
      version: VERSION, origin: canonicalOrigin, credentialId, kdf: KDF, iterations: ITERATIONS,
      salt: base64(salt), iv: base64(iv), ciphertext: base64(new Uint8Array(encrypted)),
    };
  } catch {
    fail('VAULT_INVALID');
  } finally {
    plaintext.fill(0);
  }
}

/** Wrong password, damaged ciphertext and mismatched origin all fail uniformly.
 * The caller decides when to place a successful result into session-only storage. */
export async function decryptApiKey({ vault, origin, password }) {
  validateVaultPassword(password);
  let plaintext;
  try {
    const parsed = validateVault(vault, origin);
    const salt = bytesFromBase64(parsed.salt, SALT_BYTES, SALT_BYTES);
    const iv = bytesFromBase64(parsed.iv, IV_BYTES, IV_BYTES);
    const ciphertext = bytesFromBase64(parsed.ciphertext, 1 + TAG_BITS / 8, MAX_KEY_BYTES + TAG_BITS / 8);
    const decryptionKey = await deriveKey(password, salt, 'decrypt');
    plaintext = new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv, additionalData: additionalData(parsed.origin, parsed.credentialId), tagLength: TAG_BITS,
    }, decryptionKey, ciphertext));
    return validateApiKey(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    fail('VAULT_UNLOCK_FAILED');
  } finally {
    plaintext?.fill(0);
  }
}
