/**
 * StoragePort — the contract for putting a file somewhere durable and reading
 * it back. HomeMate never stores bytes itself; an adapter talks to whatever
 * object store is configured (today the Zebra/smartstock storage service).
 *
 * @typedef {object} StoredObject
 * @property {string} key        provider-native identifier (path/CID/etc.)
 * @property {string} url        canonical URL as the provider returned it
 * @property {string} name
 * @property {string} contentType
 * @property {number} [sizeBytes]
 *
 * @typedef {object} StoragePort
 * @property {(file: {name: string, contentType: string, body: Buffer}) => Promise<StoredObject>} put
 * @property {(key: string) => Promise<{body: Buffer, contentType: string}>} get
 * @property {string} provider
 */

export class StorageError extends Error {
    constructor(code, message, status = 502) {
        super(message);
        this.name = 'StorageError';
        this.code = code;
        this.status = status;
    }
}
