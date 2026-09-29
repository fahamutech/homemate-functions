import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {resourceKeysForPath} from './admin-acl.mjs';

describe('resourceKeysForPath', () => {
    test('partner applications need the partners section (T03)', () => {
        assert.deepEqual(resourceKeysForPath('/admin/partner-applications'), ['partners']);
        assert.deepEqual(resourceKeysForPath('/admin/partner-applications/u-1/broker/decision'), ['partners']);
    });

    test('existing sections are unchanged', () => {
        assert.deepEqual(resourceKeysForPath('/admin/users/u-1'), ['users', 'staff']);
        assert.deepEqual(resourceKeysForPath('/admin/dashboard'), []);
        assert.equal(resourceKeysForPath('/admin/unknown'), null);
    });
});
