import {StorageError} from '../ports.mjs';

/**
 * In-memory StoragePort for tests and for running the admin console without a
 * storage service. Same contract as the Zebra adapter, no network.
 */
export function createMemoryStorageAdapter() {
    const objects = new Map();
    let counter = 0;

    return {
        provider: 'memory',

        async put({name, contentType, body}) {
            counter += 1;
            const key = `/storage/mem-${counter}/${name}`;
            objects.set(key, {body, contentType});
            return {key, url: key, name, contentType, sizeBytes: body.length};
        },

        async get(key) {
            const stored = objects.get(key);
            if (!stored) throw new StorageError('NOT_FOUND', 'That file is not in storage', 404);
            return stored;
        },

        /** test-only inspection */
        get size() {
            return objects.size;
        },
    };
}
