import {adminConsole} from '../../src/services/admin-console/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';
import {invalid} from '../../src/shared/errors.mjs';

/**
 * Identity: the KYC data held on a user, the documents behind it, the review
 * decisions and the remediation asked of them when something is wrong.
 *
 * Files arrive the same way property images do — base64 in the JSON body,
 * already converted in the browser — and are read back through the API, never
 * by handing out a storage URL. An identity document must not be fetchable
 * without a session.
 */

function decodeFilePayload(payload, field, {imageOnly = false} = {}) {
    if (!payload) return null;
    const {base64, name, contentType} = payload;
    if (!base64) throw invalid(`${field}.base64 is required`);
    if (imageOnly && contentType && contentType !== 'image/webp') {
        throw invalid(`${field} must be image/webp — convert in the browser before uploading`);
    }
    return {
        name,
        contentType: imageOnly ? 'image/webp' : (contentType ?? 'application/octet-stream'),
        body: Buffer.from(String(base64).replace(/^data:[^,]+,/, ''), 'base64'),
    };
}

// --- Profile ------------------------------------------------------------------

export const adminGetKycProfile = route({
    method: 'get',
    path: '/admin/users/:id/kyc',
    description: 'Identity details, documents and open remediations for one user',
    handler: (request) => adminConsole.kyc.getProfile(request.params.id),
});

export const adminUpdateKycProfile = route({
    method: 'patch',
    path: '/admin/users/:id/kyc',
    description: 'Record or correct the identity details held on a user',
    requestSample: {nationalIdNumber: '19900412-12345-00001-23', bankName: 'CRDB'},
    handler: (request) =>
        adminConsole.kyc.updateProfile(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminReviewKyc = route({
    method: 'post',
    path: '/admin/users/:id/kyc/review',
    description: 'Verify or reject a user’s identity (a rejection must carry a reason)',
    requestSample: {status: 'verified', expiresAt: '2030-01-01'},
    handler: (request) =>
        adminConsole.kyc.reviewUser(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- Documents ----------------------------------------------------------------

export const adminAddKycDocument = route({
    method: 'post',
    path: '/admin/users/:id/kyc/documents',
    description: 'Attach an identity document; the first one puts the account into review',
    requestSample: {documentType: 'national_id', file: {base64: '…', contentType: 'image/webp'}},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.kyc.addDocument(
            request.params.id,
            {
                documentType: request.body?.documentType,
                documentNumber: request.body?.documentNumber,
                issuedOn: request.body?.issuedOn,
                expiresOn: request.body?.expiresOn,
                file: decodeFilePayload(request.body?.file, 'file'),
                thumbnail: decodeFilePayload(request.body?.thumbnail, 'thumbnail', {imageOnly: true}),
            },
            actorOf(request)
        ),
    }),
});

export const adminReviewKycDocument = route({
    method: 'post',
    path: '/admin/kyc/documents/:documentId/review',
    description: 'Verify or reject a single document',
    requestSample: {status: 'rejected', rejectionReason: 'Photo is unreadable'},
    handler: (request) =>
        adminConsole.kyc.reviewDocument(request.params.documentId, request.body ?? {}, actorOf(request)),
});

export const adminDeleteKycDocument = route({
    method: 'delete',
    path: '/admin/kyc/documents/:documentId',
    description: 'Remove a document uploaded in error',
    handler: (request) => adminConsole.kyc.removeDocument(request.params.documentId, actorOf(request)),
});

export const adminReadKycDocument = route({
    method: 'get',
    path: '/admin/kyc/documents/:documentId/raw',
    description: 'Stream a document through the API (storage credentials stay server-side)',
    handler: async (request, response) => {
        const {body, contentType} = await adminConsole.kyc.documentContent(request.params.documentId, {
            thumbnail: request.query?.thumbnail === '1' || request.query?.thumbnail === 'true',
        });
        response.setHeader('content-type', contentType);
        // `no-store`: an identity document should not linger in a shared cache.
        response.setHeader('cache-control', 'private, no-store');
        response.status(200).send(body);
    },
});

// --- Profile photo ------------------------------------------------------------

export const adminSetProfilePhoto = route({
    method: 'put',
    path: '/admin/users/:id/photo',
    description: 'Set the profile photo used for identity verification',
    handler: (request) =>
        adminConsole.kyc.setProfilePhoto(
            request.params.id,
            {
                file: decodeFilePayload(request.body?.image ?? request.body?.file, 'image', {imageOnly: true}),
                thumbnail: decodeFilePayload(request.body?.thumbnail, 'thumbnail', {imageOnly: true}),
            },
            actorOf(request)
        ),
});

export const adminReadProfilePhoto = route({
    method: 'get',
    path: '/admin/users/:id/photo/raw',
    description: 'Stream a user’s profile photo through the API',
    handler: async (request, response) => {
        const {body, contentType} = await adminConsole.kyc.profilePhotoContent(request.params.id, {
            thumbnail: request.query?.thumbnail === '1' || request.query?.thumbnail === 'true',
        });
        response.setHeader('content-type', contentType);
        response.setHeader('cache-control', 'private, no-store');
        response.status(200).send(body);
    },
});

// --- Remediation ---------------------------------------------------------------

export const adminOpenRemediation = route({
    method: 'post',
    path: '/admin/users/:id/kyc/remediations',
    description: 'Ask a user to fix something about their identity evidence',
    requestSample: {issue: 'National ID has expired', requestedAction: 'Upload a renewed NIDA card'},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.kyc.openRemediation(request.params.id, request.body ?? {}, actorOf(request)),
    }),
});

export const adminResolveRemediation = route({
    method: 'post',
    path: '/admin/kyc/remediations/:remediationId/resolve',
    description: 'Close a remediation once the user has put it right',
    handler: (request) =>
        adminConsole.kyc.resolveRemediation(
            request.params.remediationId,
            request.body ?? {},
            actorOf(request)
        ),
});
