import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {decodeUpload} from './uploads.mjs';

describe('decodeUpload', () => {
    test('decodes base64 (or a data URL) into name, content type and bytes', () => {
        const file = decodeUpload({name: 'a.webp', contentType: 'image/webp', base64: 'data:image/webp;base64,aGk='}, 'image');
        assert.deepEqual(file, {name: 'a.webp', contentType: 'image/webp', body: Buffer.from('hi')});
        assert.deepEqual(decodeUpload({data: 'aGk='}, 'file').contentType, 'application/octet-stream');
    });

    test('nothing sent is null; a payload without bytes is refused', () => {
        assert.equal(decodeUpload(undefined, 'image'), null);
        assert.throws(() => decodeUpload({name: 'x'}, 'image'), (error) => error.code === 'VALIDATION_FAILED' && /image\.base64/.test(error.message));
    });
});
