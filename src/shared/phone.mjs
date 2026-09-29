/**
 * Tanzanian mobile numbers, stored everywhere as E.164 (+255XXXXXXXXX).
 */

/** +255XXXXXXXXX from either +255… or a local 0… number (spaces allowed), else null. */
export function readTanzanianMobile(value) {
    const compact = `${value ?? ''}`.trim().replace(/\s+/g, '');
    const international = /^0\d{9}$/.test(compact) ? `+255${compact.slice(1)}` : compact;
    return /^\+255\d{9}$/.test(international) ? international : null;
}

/** "+255 71* *** 678" — enough to recognise a number, not to dial it. */
export function maskPhone(phone) {
    if (!phone) return null;
    return `${phone.slice(0, 4)} ${phone.slice(4, 6)}* *** ${phone.slice(-3)}`;
}
