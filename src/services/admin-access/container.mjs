import {createAdminAccessService} from './service.mjs';
import {getSharedSessionTokens} from '../../shared/session-tokens.mjs';

export const adminAccessService = createAdminAccessService({
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    sessionTokens: getSharedSessionTokens(),
});
