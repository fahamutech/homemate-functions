import {DomainError, ErrorCodes} from './errors.mjs';

/**
 * Readers for the identity fields a person types about themselves. Each
 * returns the value to store, null for a blank field, or throws a
 * VALIDATION_FAILED written for the person — the database constraints behind
 * them (users_dob_sane in 009) would otherwise answer with a constraint name.
 */

const blank = (value) => value === undefined || value === null || `${value}`.trim() === '';
const invalid = (message) => new DomainError(ErrorCodes.VALIDATION_FAILED, message, 400);

/** Mirrors users_dob_sane in 009: a birthday cannot be today or later. */
export function readDateOfBirth(value) {
    if (blank(value)) return null;
    const text = `${value}`.trim();
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
        throw invalid('Give the date of birth as YYYY-MM-DD');
    }
    if (parsed >= new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')) {
        throw invalid('That date of birth is in the future');
    }
    return text;
}

/** NIDA number: 20 digits, dashes optional; stored as printed on the card (8-5-5-2). */
export function readNationalId(value) {
    if (blank(value)) return null;
    const digits = `${value}`.trim().replace(/-/g, '');
    if (!/^\d{20}$/.test(digits)) {
        throw invalid('The NIDA number must be 20 digits, for example 19900412-12345-00001-23');
    }
    return `${digits.slice(0, 8)}-${digits.slice(8, 13)}-${digits.slice(13, 18)}-${digits.slice(18)}`;
}

/** TRA TIN: 9 digits, dashes optional; stored as 123-456-789. */
export function readTin(value) {
    if (blank(value)) return null;
    const digits = `${value}`.trim().replace(/-/g, '');
    if (!/^\d{9}$/.test(digits)) throw invalid('The TIN must be 9 digits, for example 123-456-789');
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}
