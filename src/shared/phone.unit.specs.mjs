import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readTanzanianMobile, maskPhone} from './phone.mjs';

describe('readTanzanianMobile', () => {
    test('+255 numbers are kept; local 0… numbers become +255…; spaces are ignored', () => {
        assert.equal(readTanzanianMobile('+255712345678'), '+255712345678');
        assert.equal(readTanzanianMobile('0712 345 678'), '+255712345678');
        assert.equal(readTanzanianMobile(' 0682345678 '), '+255682345678');
    });

    test('anything else is null', () => {
        for (const bad of ['12345', '+254712345678', '', null, undefined, '07123456789']) {
            assert.equal(readTanzanianMobile(bad), null, String(bad));
        }
    });
});

describe('maskPhone', () => {
    test('keeps the prefix and the last three digits', () => {
        assert.equal(maskPhone('+255712345678'), '+255 71* *** 678');
    });

    test('nothing to mask is null', () => {
        assert.equal(maskPhone(null), null);
    });
});
