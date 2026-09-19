import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {resolveLeaseMonths} from './lease-terms.mjs';

describe('resolveLeaseMonths', () => {
    test('falls back to the property minimum when the term is not chosen', () => {
        assert.equal(resolveLeaseMonths(undefined, 6), 6);
        assert.equal(resolveLeaseMonths('', 6), 6);
    });

    test('treats an explicit null as "not chosen"', () => {
        // The mobile client sends `leaseMonths: null` for an untouched field.
        // This used to coerce to 0 and trip bookings_lease_sane, which the app
        // surfaced as a 422 on checkout.
        assert.equal(resolveLeaseMonths(null, 6), 6);
    });

    test('defaults to a year when the property has no minimum either', () => {
        assert.equal(resolveLeaseMonths(null, null), 12);
        assert.equal(resolveLeaseMonths(null, 0), 12);
    });

    test('keeps the fallback inside what the bookings table will accept', () => {
        assert.equal(resolveLeaseMonths(null, 500), 120);
    });

    test('takes a chosen term, as a number or a numeric string', () => {
        assert.equal(resolveLeaseMonths(24, 6), 24);
        assert.equal(resolveLeaseMonths('24', 6), 24);
    });

    test('rejects a term the bookings table would refuse', () => {
        for (const bad of [0, -1, 121, 1.5, 'soon', Number.NaN]) {
            assert.throws(
                () => resolveLeaseMonths(bad, 6),
                (error) => {
                    // A rejected input is the client's mistake, so it comes
                    // back as a validation error rather than as the check
                    // constraint's 422.
                    assert.equal(error.status, 400);
                    return true;
                },
                `expected ${JSON.stringify(bad)} to be rejected`
            );
        }
    });
});
