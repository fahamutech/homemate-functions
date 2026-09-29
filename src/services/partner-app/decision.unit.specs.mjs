import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {readDecision, DECISION_STATUS} from './decision.mjs';

/**
 * A moderator's decision on a partner application. Nothing is auto-approved,
 * a rejection says why, and "action needed" says what to fix.
 */

const rejects = (input, pattern) =>
    assert.throws(() => readDecision(input), (error) => error.code === 'VALIDATION_FAILED' && pattern.test(error.message));

describe('readDecision', () => {
    test('maps each decision to the role status it leads to', () => {
        assert.deepEqual(DECISION_STATUS, {approve: 'active', action_needed: 'action_needed', reject: 'rejected'});
    });

    test('approve needs nothing else', () => {
        assert.deepEqual(readDecision({decision: 'approve'}), {decision: 'approve', status: 'active', reason: null, remediation: null});
    });

    test('approve keeps an optional note', () => {
        assert.equal(readDecision({decision: 'approve', reason: ' Looks good '}).reason, 'Looks good');
    });

    test('reject needs a reason', () => {
        rejects({decision: 'reject'}, /reason/);
        rejects({decision: 'reject', reason: '   '}, /reason/);
        assert.deepEqual(readDecision({decision: 'reject', reason: 'NIDA does not match the ID'}), {
            decision: 'reject',
            status: 'rejected',
            reason: 'NIDA does not match the ID',
            remediation: null,
        });
    });

    test('action_needed needs the action to take; the issue defaults to the reason', () => {
        rejects({decision: 'action_needed', reason: 'Blurry ID'}, /requestedAction/);
        assert.deepEqual(
            readDecision({decision: 'action_needed', reason: 'Blurry ID', remediation: {requestedAction: 'Upload a sharper photo', documentId: 'd-1'}}),
            {
                decision: 'action_needed',
                status: 'action_needed',
                reason: 'Blurry ID',
                remediation: {issue: 'Blurry ID', requestedAction: 'Upload a sharper photo', documentId: 'd-1'},
            }
        );
    });

    test('action_needed needs an issue from somewhere', () => {
        rejects({decision: 'action_needed', remediation: {requestedAction: 'Upload again'}}, /issue/);
        assert.equal(
            readDecision({decision: 'action_needed', remediation: {issue: 'Selfie missing', requestedAction: 'Take a selfie'}}).remediation.issue,
            'Selfie missing'
        );
    });

    test('an unknown decision is refused', () => {
        rejects({decision: 'maybe'}, /decision/);
        rejects({}, /decision/);
    });
});
