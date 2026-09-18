import {createZebraStorageAdapter} from './adapters/zebra-storage.adapter.mjs';
import {createMemoryStorageAdapter} from './adapters/memory-storage.adapter.mjs';
import {StorageError} from './ports.mjs';

/**
 * Composition root for StoragePort. Swapping object stores is a config change
 * plus one adapter file — nothing in the property module knows which one is
 * live. `memory` is the default so the console runs without a storage
 * service; `zebra` needs STORAGE_BASE_URL + credentials.
 */
function createStoragePort() {
    const provider = process.env.STORAGE_PROVIDER ?? 'memory';

    switch (provider) {
        case 'memory':
            return createMemoryStorageAdapter();
        case 'zebra':
            return createZebraStorageAdapter({
                baseUrl: process.env.STORAGE_BASE_URL,
                username: process.env.STORAGE_USERNAME,
                password: process.env.STORAGE_PASSWORD,
            });
        default:
            throw new StorageError('NOT_CONFIGURED', `Unknown STORAGE_PROVIDER "${provider}"`, 500);
    }
}

export const storagePort = createStoragePort();
