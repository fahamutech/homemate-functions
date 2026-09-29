import {query, withActor} from '../../shared/db.mjs';
import {DomainError, ErrorCodes, invalid, notFound} from '../../shared/errors.mjs';
import {PARTNER_ROLES} from '../../shared/roles.mjs';
import {readDateOfBirth, readNationalId, readTin} from '../../shared/profile-fields.mjs';
import {readPayout, toPublicPayout} from './payout.mjs';
import {toApplicationView, earningExample} from './application-view.mjs';
import {loadFeeSettings} from '../../shared/fees.mjs';

/**
 * A signed-in person applying to become a broker or a landlord (T03,
 * BRK-002a–e, LND-002a–d). The application is their `user_roles` row; the
 * details, documents and payout account are the person's own, shared by both
 * roles. How far an application is comes from partner_application_state()
 * in migration 028 — this service only writes the steps and asks.
 *
 * Every function takes the user id from the session, never from the request.
 */

/** Statuses from which "Your details" (re)starts an application. */
const RESTARTABLE = ['invited', 'rejected'];
/** Statuses in which the person may still edit and submit. */
const EDITABLE = ['applied', 'action_needed'];

export function readPartnerRole(role) {
    if (!PARTNER_ROLES.includes(role)) {
        throw invalid(`role must be one of: ${PARTNER_ROLES.join(', ')}`);
    }
    return role;
}

/** One application, shaped for the app. */
export async function applicationView(db, userId, role) {
    const {rows} = await query(db, 'select partner_application_state($1, $2::user_role) as state', [userId, role]);
    if (!rows[0]?.state) throw notFound('Account');
    return toApplicationView(rows[0].state);
}

export function createPartnerOnboardingService({pool}) {
    async function listApplications(userId) {
        const {rows} = await query(pool, 'select * from users where id = $1', [userId]);
        if (rows.length === 0) throw notFound('Account');
        const user = rows[0];
        const applications = [];
        for (const role of PARTNER_ROLES) applications.push(await applicationView(pool, userId, role));
        const [{rows: remediations}, settings] = await Promise.all([
            query(
                pool,
                `select r.id, r.issue, r.requested_action, r.created_at, d.document_type
                   from kyc_remediations r left join kyc_documents d on d.id = r.kyc_document_id
                  where r.user_id = $1 and not r.resolved
                  order by r.created_at desc`,
                [userId]
            ),
            loadFeeSettings(pool),
        ]);
        return {
            // What "Your details" is prefilled with.
            profile: {
                fullName: user.full_name,
                dateOfBirth: user.date_of_birth,
                nationalIdNumber: user.national_id_number,
                tinNumber: user.tin_number,
                physicalAddress: user.physical_address,
                kycStatus: user.kyc_status,
                payout: toPublicPayout(user),
            },
            applications,
            // BRK-002e / LND-002e: what the backoffice asked this person to fix.
            remediations: remediations.map((r) => ({
                id: r.id,
                issue: r.issue,
                requestedAction: r.requested_action,
                documentType: r.document_type ?? null,
                createdAt: r.created_at,
            })),
            // BRK-002c "How you earn — an example".
            feeExample: earningExample(settings),
        };
    }

    /** Step 1: saves the details on the person and starts (or restarts) the application. */
    async function saveDetails(userId, role, input = {}) {
        readPartnerRole(role);
        const fullName = `${input.fullName ?? ''}`.trim();
        if (!fullName) throw invalid('Please enter your full name');
        const dateOfBirth = readDateOfBirth(input.dateOfBirth);
        const nationalIdNumber = readNationalId(input.nationalIdNumber);
        const tinNumber = readTin(input.tinNumber);
        const physicalAddress = `${input.physicalAddress ?? ''}`.trim() || null;

        return withActor(pool, userId, async (client) => {
            const {rows: users} = await client.query(
                'select kyc_status, national_id_number, date_of_birth from users where id = $1 for update',
                [userId]
            );
            if (users.length === 0) throw notFound('Account');
            assertIdentityUnchanged(users[0], {nationalIdNumber, dateOfBirth});

            const {rows: existing} = await client.query(
                'select status from user_roles where user_id = $1 and role = $2 for update',
                [userId, role]
            );
            const status = existing[0]?.status ?? null;
            if (status && !RESTARTABLE.includes(status) && !EDITABLE.includes(status)) {
                throw new DomainError(
                    ErrorCodes.CONFLICT,
                    status === 'pending_review'
                        ? 'Your application is being reviewed — you can edit it if we ask for changes'
                        : `Your ${role} role is already ${status}`,
                    409
                );
            }

            // Blank optional fields keep what is already recorded.
            await client.query(
                `update users
                    set full_name = $2,
                        date_of_birth = coalesce($3::date, date_of_birth),
                        national_id_number = coalesce($4, national_id_number),
                        tin_number = coalesce($5, tin_number),
                        physical_address = coalesce($6, physical_address)
                  where id = $1`,
                [userId, fullName, dateOfBirth, nationalIdNumber, tinNumber, physicalAddress]
            );

            if (status === null) {
                await client.query(`insert into user_roles (user_id, role, status) values ($1, $2, 'applied')`, [userId, role]);
            } else if (RESTARTABLE.includes(status)) {
                await client.query(`update user_roles set status = 'applied' where user_id = $1 and role = $2`, [userId, role]);
            }
            return applicationView(client, userId, role);
        });
    }

    /** Step 3a: where HomeMate pays this person — one account for every role. */
    async function savePayout(userId, input) {
        const {rows: banks} = await query(
            pool,
            `select code from dictionary_items where category = 'bank' and is_active`
        );
        const patch = readPayout(input, {bankCodes: banks.map((b) => b.code)});
        const columns = Object.keys(patch);

        return withActor(pool, userId, async (client) => {
            const {rows} = await client.query(
                `update users set ${columns.map((column, i) => `${column} = $${i + 2}`).join(', ')}
                  where id = $1 returning *`,
                [userId, ...columns.map((column) => patch[column])]
            );
            if (rows.length === 0) throw notFound('Account');
            return {payout: toPublicPayout(rows[0])};
        });
    }

    /** Step 3b: accepts the current agreement for the role. */
    async function acceptAgreement(userId, role, {version} = {}) {
        readPartnerRole(role);
        return withActor(pool, userId, async (client) => {
            const {rows: current} = await client.query('select partner_agreement_version($1::user_role) as version', [role]);
            const expected = current[0].version;
            if (`${version ?? ''}`.trim() !== expected) {
                throw invalid(`Please accept the current ${role} agreement (${expected})`);
            }
            const {rows} = await client.query(
                `update user_roles
                    set agreement_version = $3, agreement_accepted_at = now()
                  where user_id = $1 and role = $2 and status = any($4::partner_role_status[])
                  returning status`,
                [userId, role, expected, EDITABLE]
            );
            if (rows.length === 0) await assertApplicationOpen(client, userId, role);
            return applicationView(client, userId, role);
        });
    }

    /** Step 4: sends a complete application to HomeMate for review. */
    async function submit(userId, role) {
        readPartnerRole(role);
        return withActor(pool, userId, async (client) => {
            await assertApplicationOpen(client, userId, role, {lock: true});

            const before = await applicationView(client, userId, role);
            if (!before.complete) {
                throw new DomainError(
                    ErrorCodes.VALIDATION_FAILED,
                    `Finish these steps first: ${before.missingSteps.join(', ')}`,
                    422,
                    {missingSteps: before.missingSteps}
                );
            }

            await client.query(
                `update user_roles set status = 'pending_review' where user_id = $1 and role = $2`,
                [userId, role]
            );
            await notifyReviewers(client, userId, role);
            return applicationView(client, userId, role);
        });
    }

    return {listApplications, saveDetails, savePayout, acceptAgreement, submit};
}

/**
 * Once HomeMate has verified who someone is, the facts it verified are not
 * edited from the app — a changed NIDA would silently void the check.
 */
function assertIdentityUnchanged(user, {nationalIdNumber, dateOfBirth}) {
    if (user.kyc_status !== 'verified') return;
    const changedNida = nationalIdNumber && user.national_id_number && nationalIdNumber !== user.national_id_number;
    const changedDob = dateOfBirth && user.date_of_birth && dateOfBirth !== user.date_of_birth;
    if (changedNida || changedDob) {
        throw new DomainError(
            ErrorCodes.CONFLICT,
            'Your identity is already verified. To change your NIDA number or date of birth, contact support.',
            409
        );
    }
}

/** The application must exist and be in the person's hands (applied / action needed). */
async function assertApplicationOpen(client, userId, role, {lock = false} = {}) {
    const {rows} = await client.query(
        `select status from user_roles where user_id = $1 and role = $2 ${lock ? 'for update' : ''}`,
        [userId, role]
    );
    const status = rows[0]?.status;
    if (!status || status === 'invited') throw notFound(`A ${role} application`);
    if (!EDITABLE.includes(status)) {
        throw new DomainError(ErrorCodes.CONFLICT, `Your ${role} application is ${status.replace('_', ' ')}`, 409);
    }
}

/**
 * Tells the staff who can act on it: every active admin, and every active
 * staff member whose sidebar includes `partners` (src/shared/admin-acl.mjs).
 * The user_roles audit row records the submission itself.
 */
async function notifyReviewers(client, userId, role) {
    await client.query(
        `insert into notifications (user_id, kind, title, body, subject_table, subject_id)
         select staff.id, 'kyc_update',
                'New ' || $2 || ' application',
                coalesce(applicant.full_name, applicant.phone_number) || ' (' || applicant.phone_number
                    || ') submitted a ' || $2 || ' application for review.',
                'user_roles', applicant.id
           from users staff
           join users applicant on applicant.id = $1
          where staff.status = 'active'
            and (staff.role = 'admin'
                 or (staff.role in ('moderator', 'manager', 'finance_auditor')
                     and coalesce(staff.allowed_routes, '[]'::jsonb) ? 'partners'))`,
        [userId, role]
    );
}
