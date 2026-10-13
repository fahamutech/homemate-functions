import {query} from '../../shared/db.mjs';
import {invalid} from '../../shared/errors.mjs';

const PLATFORMS = ['android', 'ios', 'web'];

/**
 * The phones (and browsers) a person receives pushes on. The app registers its
 * FCM token after sign-in and whenever FCM rotates it, and removes it on
 * sign-out so the next person on a shared phone is not sent the last one's
 * notices.
 */
export function createPushDevicesService({pool}) {
    /**
     * Upserts on the token: the same install signing in as someone else moves
     * the token to them, and a token FCM once refused is live again when the
     * app hands it back.
     */
    async function register(userId, {token, platform, appVersion} = {}) {
        const value = typeof token === 'string' ? token.trim() : '';
        if (value.length < 16 || value.length > 4096) throw invalid('token must be an FCM registration token');
        if (!PLATFORMS.includes(platform)) throw invalid(`platform must be one of: ${PLATFORMS.join(', ')}`);

        const {rows} = await query(
            pool,
            `insert into push_devices (user_id, token, platform, app_version)
             values ($1, $2, $3, $4)
             on conflict (token) do update
                set user_id = excluded.user_id,
                    platform = excluded.platform,
                    app_version = coalesce(excluded.app_version, push_devices.app_version),
                    last_seen_at = now(),
                    disabled_at = null,
                    disabled_reason = null
             returning id, platform, created_at, last_seen_at`,
            [userId, value, platform, typeof appVersion === 'string' ? appVersion.slice(0, 64) : null]
        );
        return rows[0];
    }

    /** Only the caller's own token; someone else's is left alone, silently. */
    async function unregister(userId, {token} = {}) {
        const {rowCount} = await query(
            pool,
            'delete from push_devices where user_id = $1 and token = $2',
            [userId, typeof token === 'string' ? token.trim() : '']
        );
        return {removed: rowCount};
    }

    return {register, unregister};
}
