import {randomBytes, scrypt as scryptCallback, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

/**
 * Password hashing for backoffice staff accounts (moderator / manager /
 * finance_auditor / admin) — the only users who authenticate with a
 * password rather than phone OTP. Uses Node's built-in scrypt so this needs
 * no extra dependency, matching shared/session-tokens.mjs's "no external
 * dependency" auth stack. Stored as "<salt-hex>:<derived-key-hex>".
 */
export async function hashPassword(plainPassword) {
    const salt = randomBytes(16);
    const derivedKey = await scrypt(plainPassword, salt, KEY_LENGTH);
    return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(plainPassword, storedHash) {
    if (typeof plainPassword !== 'string' || typeof storedHash !== 'string' || !storedHash.includes(':')) {
        return false;
    }
    const [saltHex, keyHex] = storedHash.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    const expectedKey = Buffer.from(keyHex, 'hex');
    const derivedKey = await scrypt(plainPassword, salt, expectedKey.length);
    return timingSafeEqual(derivedKey, expectedKey);
}

// No 0/O/1/l/I — a one-time password that gets read aloud or over chat
// shouldn't hinge on telling those apart.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** A random initial password for a newly invited staff account. */
export function generateInitialPassword(length = 12) {
    const bytes = randomBytes(length);
    let password = '';
    for (let i = 0; i < length; i += 1) {
        password += PASSWORD_ALPHABET[bytes[i] % PASSWORD_ALPHABET.length];
    }
    return password;
}
