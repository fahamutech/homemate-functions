import {getPool} from '../../db/pool.mjs';
import {createCustomerAppService} from './service.mjs';
import {createCustomerJourneyService} from './journey.mjs';
import {createCustomerIdentityService} from './identity.mjs';
import {createKycService} from '../admin-console/kyc.mjs';
import {storagePort} from '../storage/container.mjs';
import {paymentPorts} from '../admin-console/container.mjs';
import {createNominatimAdapter} from '../geocoding/adapters/nominatim.adapter.mjs';

/**
 * Composition root for everything the signed-in app does. It shares the
 * StoragePort and MapPort with the backoffice rather than opening its own —
 * one set of credentials, one place to change provider.
 */
const pool = getPool();

export const customerApp = createCustomerAppService({pool});

/**
 * Holds, checkout and tenancies. It shares the backoffice's `paymentPorts`
 * register on purpose: a method the portal configured against the sandbox
 * adapter must open a charge through that same adapter when the phone presses
 * pay, or the two halves of the system disagree about what "paid" means.
 */
export const customerJourney = createCustomerJourneyService({pool, paymentPorts});

/**
 * The KYC service is the backoffice's, on purpose: a document a customer
 * uploads from the phone must land in the same `kyc_documents` rows, the same
 * object store and the same review queue a moderator already works through.
 * `customerIdentity` is the narrow, session-scoped door onto it — it can add
 * evidence about the signed-in customer and read it back, and nothing else.
 */
export const customerIdentity = createCustomerIdentityService({
    pool,
    kyc: createKycService({pool, storagePort}),
});

export const customerGeocoding = createNominatimAdapter();
export {storagePort};
