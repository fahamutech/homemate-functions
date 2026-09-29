import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readPayout, toPublicPayout, MOBILE_MONEY_PROVIDERS} from './payout.mjs';

/**
 * "Getting paid" (BRK-002d, LND-002c): where HomeMate sends a partner's money.
 * One method at a time, mobile money or bank, and never a half-filled one.
 */

const BANKS = ['crdb', 'nmb'];
const rejects = (input, pattern) =>
    assert.throws(() => readPayout(input, {bankCodes: BANKS}), (error) =>
        error.code === 'VALIDATION_FAILED' && pattern.test(error.message));

describe('readPayout', () => {
    test('the four Tanzanian wallets are the mobile money providers', () => {
        assert.deepEqual(MOBILE_MONEY_PROVIDERS, ['mpesa', 'mixx_by_yas', 'airtel_money', 'halopesa']);
    });

    test('mobile money: wallet number in +255 form, name kept', () => {
        assert.deepEqual(
            readPayout({method: 'mobile_money', provider: 'mpesa', accountName: ' Neema Kileo ', accountNumber: '+255712345678'}, {bankCodes: BANKS}),
            {
                payout_method: 'mobile_money',
                mobile_money_provider: 'mpesa',
                mobile_money_account_name: 'Neema Kileo',
                mobile_money_number: '+255712345678',
            }
        );
    });

    test('mobile money: a local 07… number is turned into +255…', () => {
        const patch = readPayout(
            {method: 'mobile_money', provider: 'airtel_money', accountName: 'Juma', accountNumber: '0682 345 678'},
            {bankCodes: BANKS}
        );
        assert.equal(patch.mobile_money_number, '+255682345678');
    });

    test('bank: provider must be a bank from the dictionary', () => {
        assert.deepEqual(
            readPayout({method: 'bank', provider: 'crdb', accountName: 'Neema Kileo', accountNumber: '0150-123456789'}, {bankCodes: BANKS}),
            {
                payout_method: 'bank',
                bank_name: 'crdb',
                bank_account_name: 'Neema Kileo',
                bank_account_number: '0150123456789',
            }
        );
        rejects({method: 'bank', provider: 'mpesa', accountName: 'N', accountNumber: '0150123456789'}, /bank/);
    });

    test('an unknown method is refused', () => {
        rejects({method: 'cash', provider: 'mpesa', accountName: 'N', accountNumber: '+255712345678'}, /method/);
        rejects({}, /method/);
    });

    test('an unknown wallet is refused', () => {
        rejects({method: 'mobile_money', provider: 'tigo', accountName: 'N', accountNumber: '+255712345678'}, /provider/);
    });

    test('the account name is required', () => {
        rejects({method: 'mobile_money', provider: 'mpesa', accountName: '  ', accountNumber: '+255712345678'}, /name/);
    });

    test('a wallet number that is not a Tanzanian mobile number is refused', () => {
        for (const bad of ['12345', '+254712345678', '', undefined]) {
            rejects({method: 'mobile_money', provider: 'mpesa', accountName: 'N', accountNumber: bad}, /mobile number/);
        }
    });

    test('a bank account number must be 6 to 20 digits', () => {
        for (const bad of ['12345', '123456789012345678901', 'ABC123456', '']) {
            rejects({method: 'bank', provider: 'nmb', accountName: 'N', accountNumber: bad}, /account number/);
        }
    });
});

describe('toPublicPayout', () => {
    test('nothing chosen yet is null', () => {
        assert.equal(toPublicPayout({payout_method: null}), null);
    });

    test('shows the chosen method only', () => {
        const row = {
            payout_method: 'bank',
            bank_name: 'crdb',
            bank_account_name: 'Neema',
            bank_account_number: '0150123456789',
            mobile_money_provider: 'mpesa',
            mobile_money_account_name: 'Neema',
            mobile_money_number: '+255712345678',
        };
        assert.deepEqual(toPublicPayout(row), {method: 'bank', provider: 'crdb', accountName: 'Neema', accountNumber: '0150123456789'});
        assert.deepEqual(toPublicPayout({...row, payout_method: 'mobile_money'}), {
            method: 'mobile_money',
            provider: 'mpesa',
            accountName: 'Neema',
            accountNumber: '+255712345678',
        });
    });
});
