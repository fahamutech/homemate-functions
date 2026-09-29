import {invalid} from '../../shared/errors.mjs';
import {readTanzanianMobile} from '../../shared/phone.mjs';

/** The wallets HomeMate pays out to. Banks come from the `bank` dictionary (028). */
export const MOBILE_MONEY_PROVIDERS = ['mpesa', 'mixx_by_yas', 'airtel_money', 'halopesa'];
const METHODS = ['mobile_money', 'bank'];

const text = (value) => (value === undefined || value === null ? '' : `${value}`.trim());

function readWalletNumber(value) {
    const number = readTanzanianMobile(value);
    if (!number) throw invalid('The wallet must be a Tanzanian mobile number like +255712345678');
    return number;
}

/**
 * Turns the "Getting paid" form into the `users` columns to write. Only the
 * chosen method's columns are returned; the other method's details are kept,
 * so switching back does not mean typing them again.
 *
 * @param {{method, provider, accountName, accountNumber}} input
 * @param {{bankCodes: string[]}} options active codes in the `bank` dictionary
 */
export function readPayout(input = {}, {bankCodes}) {
    const method = text(input.method);
    if (!METHODS.includes(method)) throw invalid(`method must be one of: ${METHODS.join(', ')}`);

    const provider = text(input.provider).toLowerCase();
    const accountName = text(input.accountName);

    if (method === 'mobile_money') {
        if (!MOBILE_MONEY_PROVIDERS.includes(provider)) {
            throw invalid(`provider must be one of: ${MOBILE_MONEY_PROVIDERS.join(', ')}`);
        }
        if (!accountName) throw invalid('Enter the name the wallet is registered to');
        return {
            payout_method: 'mobile_money',
            mobile_money_provider: provider,
            mobile_money_account_name: accountName,
            mobile_money_number: readWalletNumber(input.accountNumber),
        };
    }

    if (!bankCodes.includes(provider)) throw invalid('Choose your bank from the list');
    if (!accountName) throw invalid('Enter the name on the bank account');
    const accountNumber = text(input.accountNumber).replace(/[\s-]/g, '');
    if (!/^\d{6,20}$/.test(accountNumber)) throw invalid('The bank account number must be 6 to 20 digits');
    return {
        payout_method: 'bank',
        bank_name: provider,
        bank_account_name: accountName,
        bank_account_number: accountNumber,
    };
}

/** The payout account as the app shows it back, or null when none is chosen. */
export function toPublicPayout(row) {
    if (row.payout_method === 'mobile_money') {
        return {
            method: 'mobile_money',
            provider: row.mobile_money_provider,
            accountName: row.mobile_money_account_name ?? null,
            accountNumber: row.mobile_money_number,
        };
    }
    if (row.payout_method === 'bank') {
        return {method: 'bank', provider: row.bank_name, accountName: row.bank_account_name, accountNumber: row.bank_account_number};
    }
    return null;
}
