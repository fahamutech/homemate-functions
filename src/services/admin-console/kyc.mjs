import {withActor, query, nullIfBlank} from '../../shared/db.mjs';
import {notFound, invalid} from '../../shared/errors.mjs';

/**
 * KYC — the identity evidence HomeMate holds on the people who transact, and
 * the review workflow around it.
 *
 * Three moving parts, all owned by the database:
 *   - the identity fields on `users` (who they are, how they get paid),
 *   - `kyc_documents` (the files, each individually reviewed),
 *   - `kyc_remediations` (what an operator asked them to fix).
 *
 * Review stamps (who decided, when) come from triggers in 009, so this
 * service never writes `reviewed_by` and cannot get it wrong.
 */

const PROFILE_COLUMNS = {
    dateOfBirth: 'date_of_birth',
    gender: 'gender',
    nationality: 'nationality',
    nationalIdNumber: 'national_id_number',
    tinNumber: 'tin_number',
    physicalAddress: 'physical_address',
    postalAddress: 'postal_address',
    emergencyContactName: 'emergency_contact_name',
    emergencyContactPhone: 'emergency_contact_phone',
    nextOfKinName: 'next_of_kin_name',
    nextOfKinPhone: 'next_of_kin_phone',
    bankName: 'bank_name',
    bankAccountName: 'bank_account_name',
    bankAccountNumber: 'bank_account_number',
    mobileMoneyProvider: 'mobile_money_provider',
    mobileMoneyNumber: 'mobile_money_number',
    notes: 'notes',
};

const DOCUMENT_TYPES = [
    'national_id',
    'passport',
    'drivers_licence',
    'voters_id',
    'tin_certificate',
    'business_licence',
    'title_deed',
    'utility_bill',
    'bank_statement',
    'selfie',
    'other',
];

const REVIEWABLE = ['verified', 'rejected', 'pending'];

export function createKycService({pool, storagePort}) {
    /** Everything an operator needs on one screen: identity, files, open asks. */
    async function getProfile(userId) {
        const {rows} = await query(pool, 'select * from v_users where id = $1', [userId]);
        if (rows.length === 0) throw notFound('User');

        const [documents, remediations] = await Promise.all([
            query(
                pool,
                `select id, document_type, status, thumbnail_key is not null as has_thumbnail,
                        content_type, size_bytes, original_filename, document_number,
                        issued_on, expires_on, rejection_reason, reviewed_at, reviewed_by,
                        uploaded_by, created_at,
                        (expires_on is not null and expires_on < current_date) as expired
                   from kyc_documents where user_id = $1 order by created_at desc`,
                [userId]
            ),
            query(
                pool,
                `select id, kyc_document_id, issue, requested_action, resolved, resolved_at,
                        resolved_by, resolution_note, raised_by, created_at
                   from kyc_remediations where user_id = $1 order by resolved, created_at desc`,
                [userId]
            ),
        ]);

        return {...rows[0], documents: documents.rows, remediations: remediations.rows};
    }

    /**
     * Identity fields only. Name/phone/role stay with the users service —
     * splitting them keeps "correct a typo in a name" separate from "record
     * the evidence we checked", which are different acts with different risk.
     */
    async function updateProfile(userId, patch, actor) {
        const assignments = [];
        const values = [userId];

        for (const [key, column] of Object.entries(PROFILE_COLUMNS)) {
            if (patch[key] === undefined) continue;
            values.push(nullIfBlank(patch[key]));
            assignments.push(`${column} = $${values.length}`);
        }

        if (assignments.length === 0) return getProfile(userId);

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update users set ${assignments.join(', ')} where id = $1 returning id`,
                values
            );
            if (rows.length === 0) throw notFound('User');
            const {rows: fresh} = await client.query('select * from v_users where id = $1', [userId]);
            return fresh[0];
        });
    }

    /** The account-level decision. Verifying does not need every document verified
     *  — an operator may accept a passport alone — but rejecting needs a reason,
     *  which the table constraint enforces. */
    async function reviewUser(userId, {status, rejectionReason, expiresAt}, actor) {
        const next = nullIfBlank(status);
        if (!next) throw invalid('status is required');
        if (next === 'rejected' && !nullIfBlank(rejectionReason)) {
            throw invalid('A rejection reason is required');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update users
                    set kyc_status = $2::kyc_status,
                        kyc_rejection_reason = case when $2 = 'rejected' then $3 else null end,
                        kyc_expires_at = coalesce($4::date, kyc_expires_at)
                  where id = $1
                  returning id`,
                [userId, next, nullIfBlank(rejectionReason), nullIfBlank(expiresAt)]
            );
            if (rows.length === 0) throw notFound('User');
            const {rows: fresh} = await client.query('select * from v_users where id = $1', [userId]);
            return fresh[0];
        });
    }

    /**
     * Uploading an identity document. Bytes go to the StoragePort; only the
     * key comes back into the row, so swapping object stores never touches
     * the domain (IMPLEMENTATION_PLAN.md Section 2.1).
     */
    async function addDocument(userId, input, actor) {
        const documentType = nullIfBlank(input.documentType);
        if (!DOCUMENT_TYPES.includes(documentType)) {
            throw invalid(`documentType must be one of: ${DOCUMENT_TYPES.join(', ')}`);
        }
        if (!input.file?.body?.length) throw invalid('A file is required');

        const {rows: exists} = await query(pool, 'select id from users where id = $1', [userId]);
        if (exists.length === 0) throw notFound('User');

        const stored = await storagePort.put({
            name: input.file.name ?? `${documentType}.bin`,
            contentType: input.file.contentType ?? 'application/octet-stream',
            body: input.file.body,
        });
        const thumbnail = input.thumbnail?.body?.length
            ? await storagePort.put({
                  name: input.thumbnail.name ?? `${documentType}-thumb.webp`,
                  contentType: input.thumbnail.contentType ?? 'image/webp',
                  body: input.thumbnail.body,
              })
            : null;

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `insert into kyc_documents
                     (user_id, document_type, storage_key, thumbnail_key, content_type, size_bytes,
                      original_filename, document_number, issued_on, expires_on, uploaded_by)
                 values ($1, $2::kyc_document_type, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11)
                 returning id`,
                [
                    userId,
                    documentType,
                    stored.key,
                    thumbnail?.key ?? null,
                    stored.contentType ?? input.file.contentType ?? 'application/octet-stream',
                    input.file.body.length,
                    nullIfBlank(input.file.name),
                    nullIfBlank(input.documentNumber),
                    nullIfBlank(input.issuedOn),
                    nullIfBlank(input.expiresOn),
                    actor ?? null,
                ]
            );
            // A first upload moves an untouched account into the review queue,
            // which is what puts it behind the sidebar badge.
            await client.query(
                `update users set kyc_status = 'in_review'
                  where id = $1 and kyc_status in ('not_started', 'pending')`,
                [userId]
            );
            return documentById(client, rows[0].id);
        });
    }

    async function reviewDocument(documentId, {status, rejectionReason}, actor) {
        const next = nullIfBlank(status);
        if (!REVIEWABLE.includes(next)) {
            throw invalid(`status must be one of: ${REVIEWABLE.join(', ')}`);
        }
        if (next === 'rejected' && !nullIfBlank(rejectionReason)) {
            throw invalid('A rejection reason is required');
        }

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update kyc_documents
                    set status = $2::kyc_document_status,
                        rejection_reason = case when $2 = 'rejected' then $3 else null end
                  where id = $1
                  returning id`,
                [documentId, next, nullIfBlank(rejectionReason)]
            );
            if (rows.length === 0) throw notFound('Document');
            return documentById(client, documentId);
        });
    }

    async function removeDocument(documentId, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query('delete from kyc_documents where id = $1 returning id', [
                documentId,
            ]);
            if (rows.length === 0) throw notFound('Document');
            return {id: documentId, deleted: true};
        });
    }

    /** Streams a stored document back through the API rather than handing out a
     *  storage URL — identity documents must never be fetchable without a session. */
    async function documentContent(documentId, {thumbnail = false} = {}) {
        const {rows} = await query(
            pool,
            'select storage_key, thumbnail_key, content_type from kyc_documents where id = $1',
            [documentId]
        );
        if (rows.length === 0) throw notFound('Document');
        const key = thumbnail ? (rows[0].thumbnail_key ?? rows[0].storage_key) : rows[0].storage_key;
        const object = await storagePort.get(key);
        return {body: object.body, contentType: object.contentType ?? rows[0].content_type};
    }

    /** The profile photo is identity evidence too, so it is stored and served
     *  exactly like a document — never as a public URL. */
    async function setProfilePhoto(userId, {file, thumbnail}, actor) {
        if (!file?.body?.length) throw invalid('A file is required');

        const stored = await storagePort.put({
            name: file.name ?? 'profile.webp',
            contentType: file.contentType ?? 'image/webp',
            body: file.body,
        });
        const thumb = thumbnail?.body?.length
            ? await storagePort.put({
                  name: thumbnail.name ?? 'profile-thumb.webp',
                  contentType: thumbnail.contentType ?? 'image/webp',
                  body: thumbnail.body,
              })
            : null;

        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update users
                    set profile_photo_url = $2,
                        profile_photo_thumbnail_url = $3,
                        profile_photo_content_type = $4
                  where id = $1
                  returning id`,
                [userId, stored.key, thumb?.key ?? null, stored.contentType ?? 'image/webp']
            );
            if (rows.length === 0) throw notFound('User');
            const {rows: fresh} = await client.query('select * from v_users where id = $1', [userId]);
            return fresh[0];
        });
    }

    async function profilePhotoContent(userId, {thumbnail = false} = {}) {
        const {rows} = await query(
            pool,
            `select profile_photo_url, profile_photo_thumbnail_url, profile_photo_content_type
               from users where id = $1`,
            [userId]
        );
        if (rows.length === 0) throw notFound('User');
        const key = thumbnail
            ? (rows[0].profile_photo_thumbnail_url ?? rows[0].profile_photo_url)
            : rows[0].profile_photo_url;
        if (!key) throw notFound('Profile photo');
        const object = await storagePort.get(key);
        return {body: object.body, contentType: object.contentType ?? rows[0].profile_photo_content_type};
    }

    // --- remediation ---------------------------------------------------------

    async function openRemediation(userId, {issue, requestedAction, documentId}, actor) {
        if (!nullIfBlank(issue) || !nullIfBlank(requestedAction)) {
            throw invalid('issue and requestedAction are required');
        }

        return withActor(pool, actor, async (client) => {
            const {rows: user} = await client.query('select id from users where id = $1', [userId]);
            if (user.length === 0) throw notFound('User');

            const {rows} = await client.query(
                `insert into kyc_remediations (user_id, kyc_document_id, issue, requested_action, raised_by)
                 values ($1, $2, $3, $4, $5)
                 returning *`,
                [
                    userId,
                    nullIfBlank(documentId),
                    nullIfBlank(issue),
                    nullIfBlank(requestedAction),
                    actor ?? null,
                ]
            );
            return rows[0];
        });
    }

    async function resolveRemediation(remediationId, {resolutionNote} = {}, actor) {
        return withActor(pool, actor, async (client) => {
            const {rows} = await client.query(
                `update kyc_remediations
                    set resolved = true, resolution_note = $2
                  where id = $1 and not resolved
                  returning *`,
                [remediationId, nullIfBlank(resolutionNote)]
            );
            if (rows.length === 0) {
                const {rows: existing} = await client.query(
                    'select id from kyc_remediations where id = $1',
                    [remediationId]
                );
                if (existing.length === 0) throw notFound('Remediation');
                throw invalid('That remediation is already resolved');
            }
            return rows[0];
        });
    }

    async function documentById(client, id) {
        const {rows} = await client.query(
            `select id, user_id, document_type, status, thumbnail_key is not null as has_thumbnail,
                    content_type, size_bytes, original_filename, document_number, issued_on,
                    expires_on, rejection_reason, reviewed_at, reviewed_by, uploaded_by, created_at
               from kyc_documents where id = $1`,
            [id]
        );
        return rows[0];
    }

    return {
        getProfile,
        updateProfile,
        reviewUser,
        addDocument,
        reviewDocument,
        removeDocument,
        documentContent,
        setProfilePhoto,
        profilePhotoContent,
        openRemediation,
        resolveRemediation,
    };
}
