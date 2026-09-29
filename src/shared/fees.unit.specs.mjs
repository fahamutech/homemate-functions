import {describe, test} from 'node:test';
import assert from 'node:assert/strict';

import {checkoutSplits, listingAgent, tenantFee, firstPayment, partnerEarningPreview} from './fees.mjs';

const settings = {tenantFeePercentage: 50, platformPercentage: 10};
const sum = (shares) => Math.round(shares.reduce((total, s) => total + s.amount, 0) * 100) / 100;

describe('tenantFee', () => {
    test('charges the configured share of one month and shows what that saves', () => {
        const fee = tenantFee(1_200_000, settings);
        assert.equal(fee.amount, 600_000);
        assert.equal(fee.benchmarkAmount, 1_200_000);
        assert.equal(fee.saving, 600_000);
    });

    test('HomeMate keeps its share of the fee, not of the rent', () => {
        const fee = tenantFee(1_200_000, settings);
        assert.equal(fee.platformAmount, 60_000);
        assert.equal(fee.agentAmount, 540_000);
    });

    test('a fee of a full month or more saves nothing rather than a negative amount', () => {
        assert.equal(tenantFee(500_000, {tenantFeePercentage: 100, platformPercentage: 10}).saving, 0);
    });

    test('a listing with no price has no fee', () => {
        assert.equal(tenantFee(null, settings).amount, 0);
    });
});

describe('checkoutSplits', () => {
    const base = {amount: 4_200_000, fee: 600_000, platformPercentage: 10, landlordUserId: 'landlord'};

    test('pays HomeMate from the fee, the agent the rest of it, and the landlord everything else', () => {
        const shares = checkoutSplits({...base, agent: {type: 'broker', userId: 'broker'}});
        assert.deepEqual(
            shares.map((s) => [s.beneficiaryType, s.amount]),
            [
                ['platform', 60_000],
                ['broker', 540_000],
                ['landlord', 3_600_000],
            ]
        );
        assert.equal(sum(shares), base.amount);
    });

    test('a landlord who listed directly keeps the agent share of the fee', () => {
        const shares = checkoutSplits({...base, agent: null});
        assert.deepEqual(
            shares.map((s) => [s.beneficiaryType, s.amount]),
            [
                ['platform', 60_000],
                ['landlord', 4_140_000],
            ]
        );
    });

    test('rows always add up to the payment, whatever the rounding', () => {
        const shares = checkoutSplits({
            amount: 1_000_000.01,
            fee: 333_333.33,
            platformPercentage: 7,
            agent: {type: 'agency', userId: 'agency'},
            landlordUserId: 'landlord',
        });
        assert.equal(sum(shares), 1_000_000.01);
    });

    test('with no fee the whole payment is the landlord’s', () => {
        const shares = checkoutSplits({...base, fee: 0, agent: {type: 'broker', userId: 'broker'}});
        assert.deepEqual(shares.map((s) => s.beneficiaryType), ['landlord']);
        assert.equal(shares[0].amount, base.amount);
    });
});

describe('listingAgent', () => {
    test('prefers the broker, then the agency', () => {
        assert.deepEqual(
            listingAgent([
                {role: 'agency', user_id: 'a'},
                {role: 'broker', user_id: 'b'},
            ]),
            {type: 'broker', userId: 'b'}
        );
        assert.deepEqual(listingAgent([{role: 'agency', user_id: 'a'}]), {type: 'agency', userId: 'a'});
    });

    test('is nobody when only the landlord is on the listing', () => {
        assert.equal(listingAgent([{role: 'landlord', user_id: 'l'}]), null);
    });
});

describe('firstPayment', () => {
    const settings = {tenantFeePercentage: 50, platformPercentage: 10};

    test('deposit, the first month (or the advance instead) and the fee — the checkout total', () => {
        const paid = firstPayment({rent: 800000, depositMonths: 2, advanceMonths: 0}, settings);
        assert.deepEqual(paid, {
            rent: 800000,
            deposit: 1600000,
            advance: 0,
            firstRent: 800000,
            fee: tenantFee(800000, settings),
            total: 2800000,
        });
    });

    test('an advance replaces the first month rather than adding to it', () => {
        const paid = firstPayment({rent: 500000, depositMonths: 1, advanceMonths: 3}, settings);
        assert.equal(paid.firstRent, 1500000);
        assert.equal(paid.total, 500000 + 1500000 + 250000);
    });

    test('no price, nothing to pay', () => {
        assert.equal(firstPayment({rent: null, depositMonths: 2, advanceMonths: 0}, settings).total, 0);
    });
});

describe('partnerEarningPreview', () => {
    const settings = {tenantFeePercentage: 50, platformPercentage: 10};
    const paid = firstPayment({rent: 800000, depositMonths: 2, advanceMonths: 0}, settings);

    test('a broker earns the fee less HomeMate’s share', () => {
        assert.deepEqual(partnerEarningPreview(paid, {viewer: 'broker', brokered: true}), {feeShare: 360000, rentAndDeposit: 0, total: 360000});
    });

    test('a landlord gets rent and deposit in full, and the fee share only with no broker', () => {
        assert.deepEqual(partnerEarningPreview(paid, {viewer: 'landlord', brokered: true}), {feeShare: 0, rentAndDeposit: 2400000, total: 2400000});
        assert.deepEqual(partnerEarningPreview(paid, {viewer: 'landlord', brokered: false}), {feeShare: 360000, rentAndDeposit: 2400000, total: 2760000});
    });
});
