import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {toApplicationView, STEP_ORDER} from './application-view.mjs';

/**
 * The application as the app shows it: which steps are done, what is next,
 * and what the person may do now. The step facts come from
 * partner_application_state() in migration 028; this only shapes them.
 */

const state = (overrides = {}) => ({
    role: 'broker',
    status: 'applied',
    steps: {details: true, identity: true, payout: false, agreement: false},
    missingSteps: ['payout', 'agreement'],
    complete: false,
    identityVerified: false,
    agreementVersion: null,
    currentAgreementVersion: 'v1.0',
    appliedAt: '2026-09-28T10:00:00Z',
    submittedAt: null,
    activatedAt: null,
    reviewedAt: null,
    rejectionReason: null,
    ...overrides,
});

describe('toApplicationView', () => {
    test('steps are listed in screen order, with only the ones this role has', () => {
        assert.deepEqual(STEP_ORDER, ['details', 'identity', 'ownership', 'payout', 'agreement']);
        const view = toApplicationView(state());
        assert.deepEqual(view.steps.map((s) => [s.step, s.complete]), [
            ['details', true],
            ['identity', true],
            ['payout', false],
            ['agreement', false],
        ]);
        const landlord = toApplicationView(
            state({role: 'landlord', steps: {details: true, identity: true, ownership: false, payout: true, agreement: true}})
        );
        assert.deepEqual(landlord.steps.map((s) => s.step), ['details', 'identity', 'ownership', 'payout', 'agreement']);
    });

    test('the next step is the first one not done', () => {
        assert.equal(toApplicationView(state()).nextStep, 'payout');
        assert.equal(toApplicationView(state({steps: {details: true, identity: true, payout: true, agreement: true}, missingSteps: [], complete: true})).nextStep, null);
    });

    test('a complete applied or action-needed application can be submitted', () => {
        const done = {steps: {details: true, identity: true, payout: true, agreement: true}, missingSteps: [], complete: true};
        assert.equal(toApplicationView(state(done)).canSubmit, true);
        assert.equal(toApplicationView(state({...done, status: 'action_needed'})).canSubmit, true);
        assert.equal(toApplicationView(state({...done, status: 'pending_review'})).canSubmit, false);
        assert.equal(toApplicationView(state({...done, status: 'active'})).canSubmit, false);
        assert.equal(toApplicationView(state()).canSubmit, false, 'incomplete');
    });

    test('drafts are open from the first step; submitting listings only once active', () => {
        for (const status of ['applied', 'pending_review', 'action_needed']) {
            const view = toApplicationView(state({status}));
            assert.equal(view.canDraftListings, true, status);
            assert.equal(view.canSubmitListings, false, status);
        }
        const active = toApplicationView(state({status: 'active'}));
        assert.equal(active.canDraftListings, true);
        assert.equal(active.canSubmitListings, true);
        for (const status of [null, 'invited', 'rejected', 'suspended']) {
            const view = toApplicationView(state({status}));
            assert.equal(view.canDraftListings, false, String(status));
            assert.equal(view.canSubmitListings, false, String(status));
        }
    });

    test('a role never applied for reads as not started', () => {
        const view = toApplicationView(state({status: null}));
        assert.equal(view.status, 'not_started');
        assert.equal(view.canSubmit, false);
    });

    test('passes the dates, the agreement versions and the rejection reason through', () => {
        const view = toApplicationView(state({status: 'rejected', rejectionReason: 'No', agreementVersion: 'v0.9'}));
        assert.equal(view.rejectionReason, 'No');
        assert.equal(view.agreementVersion, 'v0.9');
        assert.equal(view.currentAgreementVersion, 'v1.0');
        assert.equal(view.appliedAt, '2026-09-28T10:00:00Z');
        assert.equal(view.identityVerified, false);
    });
});
