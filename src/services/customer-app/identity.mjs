import {query} from '../../shared/db.mjs';
import {invalid, notFound} from '../../shared/errors.mjs';

/**
 * The customer's own identity evidence — CUS-008b, the third step of "Complete
 * your profile".
 *
 * The storage, the review queue and the `kyc_status` transitions are the same
 * ones the backoffice drives, so this delegates to the shared KYC service
 * rather than growing a second copy of them: a document uploaded from the
 * phone has to land in exactly the queue a moderator already watches, or it is
 * evidence nobody will ever look at.
 *
 * What it does *not* delegate is authority. Every function here takes the
 * customer id from the session and passes only that id down, so there is no
 * path from this module to somebody else's documents. A customer may add
 * evidence and see its status; verifying, rejecting and deleting stay with the
 * backoffice.
 */

/** What a customer may upload about themselves, and nothing else. */
const SELF_SERVE_TYPES = ['national_id', 'passport', 'drivers_licence', 'voters_id', 'selfie'];

export function createCustomerIdentityService({pool, kyc}) {
    /** The status card the profile screen shows, with each document's outcome. */
    async function getIdentity(customerId) {
        const {rows} = await query(
            pool,
            `select kyc_status, kyc_rejection_reason, kyc_expires_at,
                    profile_photo_url is not null as has_photo
               from users where id = $1`,
            [customerId]
        );
        const user = rows[0] ?? {};

        const {rows: documents} = await query(
            pool,
            // Deliberately not the storage key: the app fetches bytes through
            // /app/me/kyc/documents/:id/raw, never from the object store.
            `select id, document_type, status, rejection_reason, created_at, reviewed_at,
                    thumbnail_key is not null as has_thumbnail
               from kyc_documents where user_id = $1 order by created_at desc`,
            [customerId]
        );

        return {
            kycStatus: user.kyc_status ?? 'not_started',
            rejectionReason: user.kyc_rejection_reason ?? null,
            expiresAt: user.kyc_expires_at ?? null,
            hasPhoto: Boolean(user.has_photo),
            acceptedDocumentTypes: SELF_SERVE_TYPES,
            documents,
        };
    }

    async function addDocument(customerId, input) {
        if (!SELF_SERVE_TYPES.includes(input.documentType)) {
            throw invalid(`documentType must be one of: ${SELF_SERVE_TYPES.join(', ')}`);
        }
        // The actor is the customer themselves, which is what `uploaded_by`
        // should say — this was not an operator acting on their behalf.
        return kyc.addDocument(customerId, input, customerId);
    }

    async function documentContent(customerId, documentId, {thumbnail = false} = {}) {
        // Ownership is checked here rather than trusting the id in the path.
        const {rows} = await query(pool, 'select id from kyc_documents where id = $1 and user_id = $2', [
            documentId,
            customerId,
        ]);
        if (rows.length === 0) {
            // Same answer as a document that does not exist: whether somebody
            // else's id is real is not a customer's business.
            throw notFound('Document');
        }
        return kyc.documentContent(documentId, {thumbnail});
    }

    function setPhoto(customerId, files) {
        return kyc.setProfilePhoto(customerId, files, customerId);
    }

    function photoContent(customerId, options) {
        return kyc.profilePhotoContent(customerId, options);
    }

    return {getIdentity, addDocument, documentContent, setPhoto, photoContent};
}
