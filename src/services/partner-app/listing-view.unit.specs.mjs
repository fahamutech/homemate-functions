import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {toPartnerListing, mediaUrl, EDITABLE_STATUSES} from './listing-view.mjs';

describe('toPartnerListing', () => {
    const row = {
        id: 'p-1',
        reference_code: 'HM-P-000001',
        title: 'Masaki 2BR',
        status: 'changes_requested',
        price: '900000.00',
        rejection_reason: 'Add a kitchen photo',
        created_at: 'c',
        submitted_at: 's',
        reviewed_at: 'r',
        reviewed_by: 'moderator@homemate.co.tz',
        owner_phone: '+255713700002',
        cover_url: 'storage-key',
        cover_thumbnail_url: 'storage-key-thumb',
        house_rules: 'No parties',
    };

    test('camelCases the record and keeps storage keys, the owner’s phone and the reviewer out', () => {
        const view = toPartnerListing(row, {userId: 'u-1', createdBy: 'u-1'});
        assert.equal(view.referenceCode, 'HM-P-000001');
        assert.equal(view.houseRules, 'No parties');
        for (const hidden of ['coverUrl', 'coverThumbnailUrl', 'reviewedBy', 'ownerPhone', 'cover_url']) {
            assert.equal(hidden in view, false, hidden);
        }
    });

    test('status history and editability', () => {
        const view = toPartnerListing(row, {userId: 'u-1', createdBy: 'u-1'});
        assert.deepEqual(view.statusHistory, {createdAt: 'c', submittedAt: 's', reviewedAt: 'r', rejectionReason: 'Add a kitchen photo'});
        assert.equal(view.editable, true);
        assert.equal(toPartnerListing(row, {userId: 'u-2', createdBy: 'u-1'}).editable, false, 'not the creator');
        assert.equal(toPartnerListing({...row, status: 'pending_review'}, {userId: 'u-1', createdBy: 'u-1'}).editable, false);
        assert.deepEqual(EDITABLE_STATUSES, ['draft', 'changes_requested']);
    });
});

describe('mediaUrl', () => {
    test('photos are read through the app media route, never from storage', () => {
        assert.equal(mediaUrl('m-1'), '/app/media/m-1/raw');
        assert.equal(mediaUrl('m-1', {thumbnail: true}), '/app/media/m-1/raw?thumbnail=1');
        assert.equal(mediaUrl(null), null);
    });
});
