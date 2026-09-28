import {invalid} from '../../shared/errors.mjs';

/** A moderator's decision → the partner role status it leads to. */
export const DECISION_STATUS = {approve: 'active', action_needed: 'action_needed', reject: 'rejected'};

const text = (value) => {
    const trimmed = value === undefined || value === null ? '' : `${value}`.trim();
    return trimmed || null;
};

/**
 * Validates `POST /admin/partner-applications/:userId/:role/decision`.
 * A rejection needs a reason; "action needed" needs the issue (defaulting to
 * the reason) and the action the person should take, which become a
 * kyc_remediations row.
 */
export function readDecision(input = {}) {
    const decision = text(input.decision);
    if (!Object.hasOwn(DECISION_STATUS, decision ?? '')) {
        throw invalid(`decision must be one of: ${Object.keys(DECISION_STATUS).join(', ')}`);
    }
    const reason = text(input.reason);

    if (decision === 'reject' && !reason) throw invalid('A rejection needs a reason the applicant can read');

    let remediation = null;
    if (decision === 'action_needed') {
        const issue = text(input.remediation?.issue) ?? reason;
        const requestedAction = text(input.remediation?.requestedAction);
        if (!issue) throw invalid('Say what the issue is (remediation.issue or reason)');
        if (!requestedAction) throw invalid('Say what the applicant should do (remediation.requestedAction)');
        remediation = {issue, requestedAction, documentId: text(input.remediation?.documentId)};
    }

    return {decision, status: DECISION_STATUS[decision], reason, remediation};
}
