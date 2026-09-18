import {getPool} from '../../db/pool.mjs';
import {createCustomerAppService} from './service.mjs';
import {storagePort} from '../storage/container.mjs';
import {createNominatimAdapter} from '../geocoding/adapters/nominatim.adapter.mjs';

/**
 * Composition root for everything the signed-in app does. It shares the
 * StoragePort and MapPort with the backoffice rather than opening its own —
 * one set of credentials, one place to change provider.
 */
const pool = getPool();

export const customerApp = createCustomerAppService({pool});
export const customerGeocoding = createNominatimAdapter();
export {storagePort};
