import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

/**
 * Derive a 256-bit key from an arbitrary string using SHA-256.
 */
function deriveKey(key: string): Buffer {
  return createHash('sha256').update(key).digest();
}

/**
 * Encrypt plaintext using AES-256-GCM.
 *
 * Output format (base64-encoded): IV (12 bytes) + auth tag (16 bytes) + ciphertext
 *
 * @param text - The plaintext to encrypt
 * @param key - The encryption key (will be hashed to 256 bits)
 * @returns Base64-encoded encrypted string
 */
export function encrypt(text: string, key: string): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // Pack: IV + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a string that was encrypted with `encrypt()`.
 *
 * @param encrypted - Base64-encoded encrypted string
 * @param key - The same key used for encryption
 * @returns The original plaintext
 * @throws If decryption fails (wrong key, tampered data, etc.)
 */
export function decrypt(encrypted: string, key: string): string {
  const derivedKey = deriveKey(key);
  const packed = Buffer.from(encrypted, 'base64');

  // Unpack: IV + authTag + ciphertext
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Compute a SHA-256 hash of the input text.
 *
 * @param text - The text to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
