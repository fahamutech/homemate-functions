import {identityAccessService} from '../../src/services/identity-access/container.mjs';
import {IdentityAccessError, IdentityAccessErrorCodes} from '../../src/services/identity-access/ports.mjs';

const created = new Date().toISOString();

const HTTP_STATUS_BY_ERROR_CODE = {
    [IdentityAccessErrorCodes.INVALID_PHONE_NUMBER]: 400,
    [IdentityAccessErrorCodes.CHALLENGE_NOT_FOUND]: 404,
    [IdentityAccessErrorCodes.CHALLENGE_ALREADY_USED]: 409,
    [IdentityAccessErrorCodes.CHALLENGE_EXPIRED]: 410,
    [IdentityAccessErrorCodes.CHALLENGE_LOCKED]: 423,
    [IdentityAccessErrorCodes.INVALID_CODE]: 400,
    [IdentityAccessErrorCodes.USER_NOT_FOUND]: 404,
};

function handleIdentityAccessError(error, response) {
    if (error instanceof IdentityAccessError) {
        response.status(HTTP_STATUS_BY_ERROR_CODE[error.code] ?? 400).json({error: error.code, message: error.message});
        return true;
    }
    return false;
}

export const requestOtp = {
    created,
    method: 'post',
    path: '/auth/otp/request',
    description: 'FR-IAM-001: request a one-time login code by phone number',
    requestSample: {phoneNumber: '+255712345678'},
    responseSample: {challengeId: 'uuid', expiresAt: '2026-01-01T00:05:00.000Z'},
    onRequest: async (request, response) => {
        try {
            const result = await identityAccessService.requestOtp({phoneNumber: request.body?.phoneNumber});
            response.status(200).json(result);
        } catch (error) {
            if (!handleIdentityAccessError(error, response)) {
                console.error('POST /auth/otp/request failed', error);
                response.status(500).json({error: 'INTERNAL_ERROR'});
            }
        }
    },
};

export const verifyOtp = {
    created,
    method: 'post',
    path: '/auth/otp/verify',
    description: 'FR-IAM-002/003: verify a one-time code and receive a session token',
    requestSample: {challengeId: 'uuid', code: '123456'},
    responseSample: {token: 'string', user: {id: 'uuid', phoneNumber: '+255712345678'}},
    onRequest: async (request, response) => {
        try {
            const result = await identityAccessService.verifyOtp({
                challengeId: request.body?.challengeId,
                code: request.body?.code,
            });
            response.status(200).json(result);
        } catch (error) {
            if (!handleIdentityAccessError(error, response)) {
                console.error('POST /auth/otp/verify failed', error);
                response.status(500).json({error: 'INTERNAL_ERROR'});
            }
        }
    },
};

export const me = {
    created,
    method: 'get',
    path: '/auth/me',
    description: 'Returns the authenticated user for the current session token (protected by guards/auth.mjs)',
    onRequest: async (request, response) => {
        try {
            const user = await identityAccessService.getUserById({userId: request.auth.userId});
            response.status(200).json({user});
        } catch (error) {
            if (!handleIdentityAccessError(error, response)) {
                console.error('GET /auth/me failed', error);
                response.status(500).json({error: 'INTERNAL_ERROR'});
            }
        }
    },
};
