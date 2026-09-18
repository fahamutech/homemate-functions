import {adminAccessService} from '../../src/services/admin-access/container.mjs';
import {AdminAccessError, AdminAccessErrorCodes} from '../../src/services/admin-access/ports.mjs';

const created = new Date().toISOString();

const HTTP_STATUS_BY_ERROR_CODE = {
    [AdminAccessErrorCodes.INVALID_CREDENTIALS]: 401,
    [AdminAccessErrorCodes.NOT_CONFIGURED]: 500,
    [AdminAccessErrorCodes.ACCOUNT_INACTIVE]: 403,
    [AdminAccessErrorCodes.KYC_REQUIRED]: 403,
};

export const adminLogin = {
    created,
    method: 'post',
    path: '/auth/admin/login',
    description: 'Env-predefined admin login (email + password from ADMIN_EMAIL/ADMIN_PASSWORD)',
    requestSample: {email: 'admin@homemate.co.tz', password: 'string'},
    responseSample: {token: 'string', admin: {email: 'admin@homemate.co.tz', role: 'admin'}},
    onRequest: async (request, response) => {
        try {
            const result = await adminAccessService.login({
                email: request.body?.email,
                password: request.body?.password,
            });
            response.status(200).json(result);
        } catch (error) {
            if (error instanceof AdminAccessError) {
                response.status(HTTP_STATUS_BY_ERROR_CODE[error.code] ?? 400).json({error: error.code, message: error.message});
                return;
            }
            console.error('POST /auth/admin/login failed', error);
            response.status(500).json({error: 'INTERNAL_ERROR'});
        }
    },
};

export const adminMe = {
    created,
    method: 'get',
    path: '/auth/admin/me',
    description: 'Returns the authenticated admin for the current session token (protected by guards/auth.mjs)',
    onRequest: (request, response) => {
        response.status(200).json({
            admin: {
                email: request.auth.email,
                role: request.auth.role,
                allowedRoutes: request.auth.allowedRoutes ?? null,
            },
        });
    },
};
