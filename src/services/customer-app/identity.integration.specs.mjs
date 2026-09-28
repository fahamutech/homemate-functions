import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createCustomerIdentityService} from './identity.mjs';
import {createKycService} from '../admin-console/kyc.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * A customer proving who they are from their own phone (CUS-008b).
 *
 * The point of these is the boundary rather than the upload: the customer's
 * door onto KYC shares the backoffice's storage and review queue, so what has
 * to be proved is that it cannot be walked through sideways — one customer's
 * session must not reach another customer's documents, and a customer must not
 * be able to file evidence types the review workflow does not expect from
 * them.
 */

function expectDomainError(code) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        return true;
    };
}

const anImage = () => Buffer.from('not-really-a-jpeg-but-bytes-are-bytes');

describe('customer identity (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let identity;
    let customer;
    let other;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        identity = createCustomerIdentityService({
            pool,
            kyc: createKycService({pool, storagePort: createMemoryStorageAdapter()}),
        });
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('truncate table kyc_documents, users restart identity cascade');
        customer = await makeCustomer('+255700002001', 'Neema Customer');
        other = await makeCustomer('+255700002002', 'Juma Other');
    });

    async function makeCustomer(phone, name) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status)
             values ($1, $2, 'customer', 'active') returning id`,
            [phone, name]
        );
        return rows[0].id;
    }

    function upload(userId, documentType = 'national_id') {
        return identity.addDocument(userId, {
            documentType,
            file: {name: `${documentType}.jpg`, contentType: 'image/jpeg', body: anImage()},
        });
    }

    test('an untouched account has nothing to show and says so plainly', async () => {
        const status = await identity.getIdentity(customer);

        assert.equal(status.kycStatus, 'not_started');
        assert.equal(status.hasPhoto, false);
        assert.deepEqual(status.documents, []);
    });

    test('uploading an ID puts the account into the review queue', async () => {
        const document = await upload(customer);

        assert.equal(document.document_type, 'national_id');
        assert.equal(document.status, 'pending');

        const status = await identity.getIdentity(customer);
        // This is what puts the account behind the moderator's badge; an
        // upload nobody is prompted to look at is evidence wasted.
        assert.equal(status.kycStatus, 'in_review');
        assert.equal(status.documents.length, 1);
    });

    test('records the customer as the uploader, not an operator', async () => {
        const document = await upload(customer);
        const {rows} = await pool.query('select uploaded_by from kyc_documents where id = $1', [
            document.id,
        ]);
        assert.equal(rows[0].uploaded_by, customer);
    });

    test('refuses a document type that is not the customer’s to file', async () => {
        // A business licence belongs to an agency and arrives through the
        // backoffice.
        for (const documentType of ['business_licence', 'bank_statement', 'nonsense']) {
            await assert.rejects(
                upload(customer, documentType),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        }
    });

    test('a landlord applicant files proof of ownership through the same upload (T03)', async () => {
        for (const documentType of ['title_deed', 'utility_bill']) {
            const document = await upload(customer, documentType);
            assert.equal(document.document_type, documentType);
            assert.equal(document.status, 'pending');
        }
        const status = await identity.getIdentity(customer);
        assert.ok(status.acceptedDocumentTypes.includes('title_deed'));
        assert.ok(status.acceptedDocumentTypes.includes('utility_bill'));
    });

    test('a customer only ever sees their own documents', async () => {
        await upload(customer);
        await upload(other);

        const mine = await identity.getIdentity(customer);
        assert.equal(mine.documents.length, 1);
    });

    test('someone else’s document id buys nothing', async () => {
        const theirs = await upload(other);

        await assert.rejects(
            identity.documentContent(customer, theirs.id),
            // Deliberately the same answer as an id that does not exist:
            // whether another customer's id is real is not our customer's
            // business.
            expectDomainError(ErrorCodes.NOT_FOUND)
        );
    });

    test('a customer can read back their own document', async () => {
        const mine = await upload(customer);
        const {body, contentType} = await identity.documentContent(customer, mine.id);

        assert.equal(contentType, 'image/jpeg');
        assert.deepEqual(Buffer.from(body), anImage());
    });

    test('the profile photo is stored and read back through the API', async () => {
        await identity.setPhoto(customer, {
            file: {name: 'me.jpg', contentType: 'image/jpeg', body: anImage()},
        });

        const status = await identity.getIdentity(customer);
        assert.equal(status.hasPhoto, true);

        const {body} = await identity.photoContent(customer);
        assert.deepEqual(Buffer.from(body), anImage());
    });
});
