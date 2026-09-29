import {invalid} from './errors.mjs';

/**
 * Files from the app arrive as base64 in the JSON body: the app has no
 * storage credentials and never will, so every byte goes through the API.
 */
export function decodeUpload(payload, field) {
    if (!payload) return null;
    const base64 = payload.base64 ?? payload.data;
    if (!base64) throw invalid(`${field}.base64 is required`);
    return {
        name: payload.name,
        contentType: payload.contentType ?? 'application/octet-stream',
        body: Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64'),
    };
}
