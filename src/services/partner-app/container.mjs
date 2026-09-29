import {getPool} from '../../db/pool.mjs';
import {smsPort} from '../customer-access/container.mjs';
import {createPartnerOnboardingService} from './onboarding.mjs';
import {createPartnerReviewService} from './review.mjs';

/**
 * Composition root for partner onboarding (T03). Decisions are texted through
 * the same SMS port customer sign-in uses — one vendor, one set of credentials.
 */
const pool = getPool();

export const partnerOnboarding = createPartnerOnboardingService({pool});
export const partnerReview = createPartnerReviewService({pool, notificationPort: smsPort});
