import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readDateOfBirth, readNationalId, readTin} from './profile-fields.mjs';

/**
 * The identity fields a person types into "Your details" (BRK-002a, LND-002a)
 * and the profile screen. Each reader returns the value to store, null when
 * left blank, or throws a VALIDATION_FAILED a person can act on.
 */

const rejects = (fn, pattern) =>
    assert.throws(fn, (error) => error.code === 'VALIDATION_FAILED' && error.status === 400 && pattern.test(error.message));

describe('readDateOfBirth', () => {
    test('blank is null', () => {
        for (const blank of [undefined, null, '', '   ']) assert.equal(readDateOfBirth(blank), null);
    });

    test('a real past day is kept as written', () => {
        assert.equal(readDateOfBirth(' 1994-04-12 '), '1994-04-12');
    });

    test('a malformed date is refused', () => {
        for (const bad of ['12/04/1994', '1994-4-12', 'yesterday', '1994-13-40']) {
            rejects(() => readDateOfBirth(bad), /YYYY-MM-DD/);
        }
    });

    test('today or a future day is refused', () => {
        const today = new Date().toISOString().slice(0, 10);
        rejects(() => readDateOfBirth(today), /future/);
        rejects(() => readDateOfBirth('2999-01-01'), /future/);
    });
});

describe('readNationalId (NIDA)', () => {
    test('20 digits with or without dashes are stored in the printed 8-5-5-2 layout', () => {
        assert.equal(readNationalId('19900412123450000123'), '19900412-12345-00001-23');
        assert.equal(readNationalId(' 19900412-12345-00001-23 '), '19900412-12345-00001-23');
        assert.equal(readNationalId('1990-0412-1234-5000-0123'), '19900412-12345-00001-23');
    });

    test('blank is null', () => {
        assert.equal(readNationalId(''), null);
        assert.equal(readNationalId(undefined), null);
    });

    test('anything but exactly 20 digits is refused', () => {
        for (const bad of ['1990041212345000012', '199004121234500001234', '19900412-12345-00001-2X', 'T1990041212345000012', '19900412 12345 00001 23']) {
            rejects(() => readNationalId(bad), /20 digits/);
        }
    });
});

describe('readTin', () => {
    test('9 digits with or without dashes are stored as 123-456-789', () => {
        assert.equal(readTin('123456789'), '123-456-789');
        assert.equal(readTin('123-456-789'), '123-456-789');
    });

    test('blank is null', () => {
        assert.equal(readTin(null), null);
    });

    test('anything else is refused', () => {
        for (const bad of ['12345678', '1234567890', 'abc-def-ghi']) rejects(() => readTin(bad), /9 digits/);
    });
});
