/** The onboarding steps in screen order (BRK-002a–e, LND-002a–d). Only landlords have `ownership`. */
export const STEP_ORDER = ['details', 'identity', 'ownership', 'payout', 'agreement'];

const DRAFTING = ['applied', 'pending_review', 'action_needed', 'active'];
const SUBMITTABLE = ['applied', 'action_needed'];

/**
 * Shapes one partner_application_state() result (migration 028) for the app
 * and the backoffice: the steps as an ordered list, what comes next, and
 * what the person may do now. The step facts themselves are the database's.
 */
export function toApplicationView(state) {
    const steps = STEP_ORDER.filter((step) => step in (state.steps ?? {})).map((step) => ({
        step,
        complete: Boolean(state.steps[step]),
    }));
    const status = state.status ?? null;

    return {
        role: state.role,
        status: status ?? 'not_started',
        steps,
        nextStep: steps.find((s) => !s.complete)?.step ?? null,
        missingSteps: steps.filter((s) => !s.complete).map((s) => s.step),
        complete: steps.every((s) => s.complete),
        canSubmit: Boolean(state.complete) && SUBMITTABLE.includes(status),
        canDraftListings: DRAFTING.includes(status),
        canSubmitListings: status === 'active',
        identityVerified: Boolean(state.identityVerified),
        agreementVersion: state.agreementVersion ?? null,
        currentAgreementVersion: state.currentAgreementVersion ?? null,
        appliedAt: state.appliedAt ?? null,
        submittedAt: state.submittedAt ?? null,
        activatedAt: state.activatedAt ?? null,
        reviewedAt: state.reviewedAt ?? null,
        rejectionReason: state.rejectionReason ?? null,
    };
}
