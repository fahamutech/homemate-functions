import {createAdminAccessService} from './service.mjs';
import {getSharedSessionTokens} from '../../shared/session-tokens.mjs';
import {getPool} from '../../db/pool.mjs';

export const adminAccessService = createAdminAccessService({
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    sessionTokens: getSharedSessionTokens(),
    pool: getPool(),
});
