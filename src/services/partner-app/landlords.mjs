import {query, withActor} from '../../shared/db.mjs';
import {DomainError, ErrorCodes, invalid} from '../../shared/errors.mjs';
import {STAFF_ROLES} from '../../shared/roles.mjs';
import {readTanzanianMobile, maskPhone} from '../../shared/phone.mjs';
import {maskName} from './listing-input.mjs';

/**
 * The broker's "Landlord" step (BRK-030e): find the landlord by phone, or
 * invite them. A lookup only ever answers about landlords — whether a number
 * belongs to a plain customer (or to nobody) is not a broker's business, so
 * both read as "not a landlord yet".
 */
export function createLandlordDirectoryService({pool}) {
    async function lookup(phone) {
        const phoneNumber = readPhone(phone);
        const card = await landlordCard(pool, phoneNumber);
        return card ? {found: true, landlord: card} : {found: false};
    }

    /** Creates or reuses the person by phone and gives them an `invited` landlord role. */
    async function invite(brokerId, {fullName, phone} = {}) {
        const name = `${fullName ?? ''}`.trim();
        if (!name) throw invalid('Enter the landlord’s full name');
        const phoneNumber = readPhone(phone);

        return withActor(pool, brokerId, async (client) => {
            const {rows: existing} = await client.query('select id, role from users where phone_number = $1', [phoneNumber]);
            let userId = existing[0]?.id;
            if (existing[0] && STAFF_ROLES.includes(existing[0].role)) {
                throw new DomainError(ErrorCodes.CONFLICT, 'That number cannot be invited as a landlord', 409);
            }
            if (!userId) {
                // The 027 trigger gives the new account its customer role; the
                // person proves the phone with an OTP when they first sign in.
                const {rows} = await client.query(
                    `insert into users (phone_number, full_name, role, status) values ($1, $2, 'customer', 'active') returning id`,
                    [phoneNumber, name]
                );
                userId = rows[0].id;
            }

            const {rows: role} = await client.query(
                `select status from user_roles where user_id = $1 and role = 'landlord'`,
                [userId]
            );
            if (role[0]?.status === 'rejected') {
                throw new DomainError(ErrorCodes.CONFLICT, 'That person cannot be added as a landlord right now', 409);
            }
            if (!role[0]) {
                await client.query(`insert into user_roles (user_id, role, status) values ($1, 'landlord', 'invited')`, [userId]);
            }
            return {landlord: await landlordCard(client, phoneNumber)};
        });
    }

    return {lookup, invite};
}

function readPhone(phone) {
    const phoneNumber = readTanzanianMobile(phone);
    if (!phoneNumber) throw invalid('Enter a Tanzanian mobile number like +255712345678');
    return phoneNumber;
}

/** A landlord as a broker may see them before attaching: masked name and number, and how many homes. */
async function landlordCard(db, phoneNumber) {
    const {rows} = await query(
        db,
        `select u.id, u.full_name, u.phone_number, ur.status,
                (select count(distinct pp.property_id)::int
                   from property_parties pp join properties p on p.id = pp.property_id
                  where pp.user_id = u.id and pp.role = 'landlord' and p.status <> 'archived') as homes
           from users u
           join user_roles ur on ur.user_id = u.id and ur.role = 'landlord' and ur.status <> 'rejected'
          where u.phone_number = $1`,
        [phoneNumber]
    );
    const row = rows[0];
    if (!row) return null;
    return {userId: row.id, name: maskName(row.full_name), phone: maskPhone(row.phone_number), homes: row.homes, status: row.status};
}
