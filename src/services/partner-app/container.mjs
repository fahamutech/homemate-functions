import {getPool} from '../../db/pool.mjs';
import {smsPort} from '../customer-access/container.mjs';
import {createPartnerOnboardingService} from './onboarding.mjs';
import {createPartnerReviewService} from './review.mjs';
import {createPartnerListingsService} from './listings.mjs';
import {createLandlordDirectoryService} from './landlords.mjs';
import {createLandlordConfirmationsService} from './confirmations.mjs';
import {createPropertiesService} from '../admin-console/properties.mjs';
import {storagePort} from '../storage/container.mjs';

/**
 * Composition root for partner onboarding (T03). Decisions are texted through
 * the same SMS port customer sign-in uses — one vendor, one set of credentials.
 */
const pool = getPool();

export const partnerOnboarding = createPartnerOnboardingService({pool});
export const partnerReview = createPartnerReviewService({pool, notificationPort: smsPort});

/**
 * Partner listings (T04) share the backoffice's StoragePort and property
 * reader, so a listing made on a phone lands in the same bucket and reads
 * back through the same code a moderator's does.
 */
export const partnerListings = createPartnerListingsService({
    pool,
    storagePort,
    notificationPort: smsPort,
    properties: createPropertiesService({pool}),
});
export const landlordDirectory = createLandlordDirectoryService({pool});
export const landlordConfirmations = createLandlordConfirmationsService({pool});
