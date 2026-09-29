import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {earningState, EARNING_STATES, maskAccount, feeArithmetic, earningTimeline, readEarningRole} from './earning-view.mjs';

describe('earningState — the one mapping from payment and payout to what a partner sees', () => {
    const cases = [
        [{paymentStatus: 'pending'}, 'being_checked'],
        [{paymentStatus: 'pending', declared: true}, 'being_checked'],
        [{paymentStatus: 'successful', payoutStatus: null}, 'ready'],
        [{paymentStatus: 'successful', payoutStatus: 'cancelled'}, 'ready'],
        [{paymentStatus: 'successful', payoutStatus: 'scheduled'}, 'in_payout'],
        [{paymentStatus: 'successful', payoutStatus: 'processing'}, 'in_payout'],
        [{paymentStatus: 'successful', payoutStatus: 'paid'}, 'paid'],
        [{paymentStatus: 'successful', payoutStatus: 'on_hold', holdReason: 'KYC'}, 'on_hold'],
        [{paymentStatus: 'successful', payoutStatus: 'failed', failureReason: 'Wrong number'}, 'on_hold'],
        [{paymentStatus: 'reversed'}, 'reversed'],
        [{paymentStatus: 'refunded', payoutStatus: 'paid'}, 'reversed'],
        [{paymentStatus: 'partially_refunded'}, 'reversed'],
        [{paymentStatus: 'failed'}, 'failed'],
    ];
    for (const [input, expected] of cases) {
        test(`${input.paymentStatus} / ${input.payoutStatus ?? 'no payout'} → ${expected}`, () => {
            assert.equal(earningState(input).state, expected);
        });
    }

    test('a hold carries its reason; a failed payout reads as held with the failure', () => {
        assert.deepEqual(earningState({paymentStatus: 'successful', payoutStatus: 'on_hold', holdReason: 'KYC'}), {state: 'on_hold', holdReason: 'KYC'});
        assert.deepEqual(earningState({paymentStatus: 'successful', payoutStatus: 'failed', failureReason: 'Wrong number'}), {
            state: 'on_hold',
            holdReason: 'Wrong number',
        });
        assert.deepEqual(earningState({paymentStatus: 'successful', payoutStatus: 'paid'}), {state: 'paid', holdReason: null});
    });

    test('the states the totals are reported in', () => {
        assert.deepEqual(EARNING_STATES, ['being_checked', 'ready', 'in_payout', 'paid', 'on_hold', 'reversed']);
    });
});

describe('maskAccount', () => {
    test('shows only the last digits', () => {
        assert.equal(maskAccount('+255712345678'), '•••• 5678');
        assert.equal(maskAccount('0150123456789'), '•••• 6789');
        assert.equal(maskAccount('123'), '•••• 123');
        assert.equal(maskAccount(null), null);
    });
});

describe('feeArithmetic — from the booking snapshot, never today’s settings', () => {
    const booking = {monthly_rent: '1000000.00', service_fee: '500000.00', service_fee_percentage: '50.00', platform_fee_percentage: '10.00'};

    test('the broker’s share of a brokered home', () => {
        assert.deepEqual(feeArithmetic(booking, {role: 'broker', hasBroker: true}), {
            monthlyRent: 1000000,
            feePercentage: 50,
            feeAmount: 500000,
            platformPercentage: 10,
            platformAmount: 50000,
            yourShare: 450000,
        });
    });

    test('a self-listed landlord takes the fee share; a brokered landlord does not', () => {
        assert.equal(feeArithmetic(booking, {role: 'landlord', hasBroker: false}).yourShare, 450000);
        assert.equal(feeArithmetic(booking, {role: 'landlord', hasBroker: true}).yourShare, 0);
    });

    test('an old booking keeps its own percentages', () => {
        const old = {monthly_rent: '800000.00', service_fee: '240000.00', service_fee_percentage: '30.00', platform_fee_percentage: '20.00'};
        const fee = feeArithmetic(old, {role: 'broker', hasBroker: true});
        assert.equal(fee.feeAmount, 240000);
        assert.equal(fee.platformAmount, 48000);
        assert.equal(fee.yourShare, 192000);
    });

    test('no booking (a rent payment recorded by hand) has no fee', () => {
        assert.equal(feeArithmetic(null, {role: 'landlord', hasBroker: false}), null);
    });
});

describe('earningTimeline', () => {
    test('paid → verified → in a payout → paid out, each done once it has a date', () => {
        const steps = earningTimeline({
            payment_created_at: 'a',
            customer_declared_paid_at: 'b',
            payment_confirmed_at: 'c',
            payout_created_at: null,
            payout_paid_at: null,
        });
        assert.deepEqual(steps, [
            {key: 'paid', at: 'b', done: true},
            {key: 'verified', at: 'c', done: true},
            {key: 'payout_created', at: null, done: false},
            {key: 'paid_out', at: null, done: false},
        ]);
    });
});

describe('readEarningRole', () => {
    test('broker or landlord, from the query or else the active role', () => {
        assert.equal(readEarningRole('broker', 'customer'), 'broker');
        assert.equal(readEarningRole(undefined, 'landlord'), 'landlord');
        assert.throws(() => readEarningRole(undefined, 'customer'), (error) => error.code === 'VALIDATION_FAILED');
        assert.throws(() => readEarningRole('agency', 'broker'), (error) => error.code === 'VALIDATION_FAILED');
    });
});
