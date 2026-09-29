import {test, describe, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createPartnerOnboardingService} from './onboarding.mjs';
import {createPartnerReviewService} from './review.mjs';
import {createCustomerIdentityService} from '../customer-app/identity.mjs';
import {createKycService} from '../admin-console/kyc.mjs';
import {createMemoryStorageAdapter} from '../storage/adapters/memory-storage.adapter.mjs';
import {createSandboxNotificationAdapter} from '../identity-access/adapters/sandbox-notification.adapter.mjs';
import {createCustomerAccessService} from '../customer-access/service.mjs';
import {createCustomerAccessRepository} from '../customer-access/repository.mjs';
import {createSessionTokenService} from '../../shared/session-tokens.mjs';
import {ErrorCodes} from '../../shared/errors.mjs';

/**
 * Partner onboarding (T03, migration 028) against a real database: a signed-in
 * customer applies to become a broker or a landlord — details, identity,
 * ownership (landlords), getting paid, agreement, submit — and a moderator
 * approves, asks for action, or rejects.
 */

const MODERATOR = 'moderator@homemate.co.tz';
const NIDA = '19900412-12345-00001-23';

function expectDomainError(code, pattern) {
    return (error) => {
        assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
        if (pattern) assert.match(error.message, pattern);
        return true;
    };
}

const anImage = () => Buffer.from('bytes-of-a-photo');

describe('partner onboarding (Postgres integration)', () => {
    /** @type {pg.Pool} */
    let pool;
    let sms;
    let onboarding;
    let review;
    let identity;
    let kyc;
    let access;

    before(async () => {
        pool = new pg.Pool({connectionString: process.env.DATABASE_URL});
        sms = createSandboxNotificationAdapter();
        kyc = createKycService({pool, storagePort: createMemoryStorageAdapter()});
        identity = createCustomerIdentityService({pool, kyc});
        onboarding = createPartnerOnboardingService({pool});
        review = createPartnerReviewService({pool, notificationPort: sms});
        access = createCustomerAccessService({
            repository: createCustomerAccessRepository({pool}),
            notificationPort: sms,
            sessionTokens: createSessionTokenService('integration-secret'),
        });
    });

    after(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            'truncate table notifications, kyc_remediations, kyc_documents, users, organizations restart identity cascade'
        );
        await pool.query('truncate table audit_log restart identity');
        await pool.query(
            `update settings set value = '"v1.0"'::jsonb
              where key in ('partner.agreement_version.broker', 'partner.agreement_version.landlord')`
        );
        sms.sentMessages.length = 0;
    });

    async function customer(phone = '+255713500001', extra = {}) {
        const {rows} = await pool.query(
            `insert into users (phone_number, full_name, role, status, kyc_status, email, allowed_routes)
             values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
            [
                phone,
                extra.fullName ?? 'Neema Kileo',
                extra.role ?? 'customer',
                extra.status ?? 'active',
                extra.kycStatus ?? 'not_started',
                extra.email ?? null,
                extra.allowedRoutes ? JSON.stringify(extra.allowedRoutes) : null,
            ]
        );
        return rows[0].id;
    }

    const details = (overrides = {}) => ({
        fullName: 'Neema Kileo',
        dateOfBirth: '1990-04-12',
        nationalIdNumber: '19900412123450000123',
        tinNumber: '123456789',
        physicalAddress: 'Plot 12, Mikocheni, Dar es Salaam',
        ...overrides,
    });

    const mpesa = {method: 'mobile_money', provider: 'mpesa', accountName: 'Neema Kileo', accountNumber: '0712345678'};

    async function upload(userId, documentType) {
        return identity.addDocument(userId, {
            documentType,
            file: {name: `${documentType}.jpg`, contentType: 'image/jpeg', body: anImage()},
        });
    }

    async function applicationFor(userId, role) {
        const {applications} = await onboarding.listApplications(userId);
        return applications.find((a) => a.role === role);
    }

    /** Walks every step a broker needs, up to (not including) submit. */
    async function completeBrokerSteps(userId) {
        await onboarding.saveDetails(userId, 'broker', details());
        await upload(userId, 'national_id');
        await upload(userId, 'selfie');
        await onboarding.savePayout(userId, mpesa);
        await onboarding.acceptAgreement(userId, 'broker', {version: 'v1.0'});
    }

    async function roleRow(userId, role) {
        const {rows} = await pool.query('select * from user_roles where user_id = $1 and role = $2', [userId, role]);
        return rows[0] ?? null;
    }

    describe('the application list', () => {
        test('a customer who never applied sees both roles, not started, nothing allowed yet', async () => {
            const me = await customer();
            const {applications} = await onboarding.listApplications(me);

            assert.deepEqual(applications.map((a) => [a.role, a.status]), [['broker', 'not_started'], ['landlord', 'not_started']]);
            const broker = applications[0];
            assert.deepEqual(broker.steps.map((s) => s.step), ['details', 'identity', 'payout', 'agreement']);
            assert.deepEqual(applications[1].steps.map((s) => s.step), ['details', 'identity', 'ownership', 'payout', 'agreement']);
            assert.equal(broker.nextStep, 'details');
            assert.equal(broker.canSubmit, false);
            assert.equal(broker.canDraftListings, false);
            assert.equal(broker.canSubmitListings, false);
            assert.equal(broker.currentAgreementVersion, 'v1.0');
        });

        test('carries the "How you earn" example, from the fee settings (BRK-002c)', async () => {
            const me = await customer();
            const {feeExample} = await onboarding.listApplications(me);
            assert.deepEqual(feeExample, {
                rent: 1200000,
                tenantFee: 600000,
                tenantFeePercentage: 50,
                platformAmount: 60000,
                platformPercentage: 10,
                youReceive: 540000,
            });
        });

        test('lists what the backoffice asked for while action is needed (BRK-002e)', async () => {
            const me = await customer();
            const selfie = await upload(me, 'selfie');
            await pool.query(
                `insert into kyc_remediations (user_id, kyc_document_id, issue, requested_action, raised_by)
                 values ($1, $2, 'Your selfie is too dark', 'Take a new selfie facing a window', 'ops@homemate.co.tz'),
                        ($1, null, 'Old one', 'Done already', 'ops@homemate.co.tz')`,
                [me, selfie.id]
            );
            await pool.query(`update kyc_remediations set resolved = true where issue = 'Old one'`);
            const {remediations} = await onboarding.listApplications(me);
            assert.equal(remediations.length, 1);
            assert.equal(remediations[0].issue, 'Your selfie is too dark');
            assert.equal(remediations[0].requestedAction, 'Take a new selfie facing a window');
            assert.equal(remediations[0].documentType, 'selfie');
        });

        test('details are prefilled from the customer profile', async () => {
            const me = await customer();
            const {profile} = await onboarding.listApplications(me);
            assert.equal(profile.fullName, 'Neema Kileo');
            assert.equal(profile.nationalIdNumber, null);
            assert.equal(profile.payout, null);
        });
    });

    describe('step 1 — your details', () => {
        test('saving details starts the application and fills the details step', async () => {
            const me = await customer();
            const view = await onboarding.saveDetails(me, 'broker', details());

            assert.equal(view.status, 'applied');
            assert.equal(view.steps.find((s) => s.step === 'details').complete, true);
            assert.equal(view.nextStep, 'identity');
            assert.equal(view.canDraftListings, true, 'drafts open from the first step');
            assert.equal(view.canSubmitListings, false);
            assert.ok(view.appliedAt);

            const {rows} = await pool.query(
                'select full_name, national_id_number, tin_number, physical_address, date_of_birth from users where id = $1',
                [me]
            );
            assert.deepEqual(rows[0], {
                full_name: 'Neema Kileo',
                national_id_number: NIDA,
                tin_number: '123-456-789',
                physical_address: 'Plot 12, Mikocheni, Dar es Salaam',
                date_of_birth: '1990-04-12',
            });
        });

        test('each missing detail keeps the step open', async () => {
            const me = await customer();
            for (const missing of ['dateOfBirth', 'nationalIdNumber', 'physicalAddress']) {
                const view = await onboarding.saveDetails(me, 'broker', details({[missing]: ''}));
                assert.equal(view.steps.find((s) => s.step === 'details').complete, false, missing);
                await pool.query('update users set date_of_birth = null, national_id_number = null, physical_address = null where id = $1', [me]);
            }
        });

        test('a name is required; a bad NIDA or date of birth is refused', async () => {
            const me = await customer();
            await assert.rejects(onboarding.saveDetails(me, 'broker', details({fullName: ' '})), expectDomainError(ErrorCodes.VALIDATION_FAILED, /name/));
            await assert.rejects(onboarding.saveDetails(me, 'broker', details({nationalIdNumber: '123'})), expectDomainError(ErrorCodes.VALIDATION_FAILED, /20 digits/));
            await assert.rejects(onboarding.saveDetails(me, 'broker', details({dateOfBirth: '2999-01-01'})), expectDomainError(ErrorCodes.VALIDATION_FAILED, /future/));
            assert.equal(await roleRow(me, 'broker'), null, 'nothing was started');
        });

        test('only broker and landlord can be applied for', async () => {
            const me = await customer();
            for (const role of ['customer', 'agency', 'admin']) {
                await assert.rejects(onboarding.saveDetails(me, role, details()), expectDomainError(ErrorCodes.VALIDATION_FAILED));
            }
        });

        test('a verified person cannot change their NIDA or date of birth here', async () => {
            const me = await customer('+255713500001', {kycStatus: 'verified'});
            await pool.query(`update users set national_id_number = $2, date_of_birth = '1990-04-12' where id = $1`, [me, NIDA]);

            await assert.rejects(
                onboarding.saveDetails(me, 'broker', details({nationalIdNumber: '19900412123450000999'})),
                expectDomainError(ErrorCodes.CONFLICT, /support/)
            );
            // Same values are fine.
            const view = await onboarding.saveDetails(me, 'broker', details());
            assert.equal(view.status, 'applied');
        });

        test('an application under review cannot be edited', async () => {
            const me = await customer();
            await completeBrokerSteps(me);
            await onboarding.submit(me, 'broker');
            await assert.rejects(onboarding.saveDetails(me, 'broker', details()), expectDomainError(ErrorCodes.CONFLICT));
        });

        test('an invited landlord who applies moves to applied', async () => {
            const me = await customer();
            await pool.query(`insert into user_roles (user_id, role, status) values ($1, 'landlord', 'invited')`, [me]);
            const view = await onboarding.saveDetails(me, 'landlord', details());
            assert.equal(view.status, 'applied');
        });
    });

    describe('step 2 — identity (checks belong to the person)', () => {
        test('needs an ID document and a selfie', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());
            await upload(me, 'national_id');
            assert.equal((await applicationFor(me, 'broker')).steps.find((s) => s.step === 'identity').complete, false);
            await upload(me, 'selfie');
            assert.equal((await applicationFor(me, 'broker')).steps.find((s) => s.step === 'identity').complete, true);
        });

        test('a rejected document does not count', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());
            const id = await upload(me, 'passport');
            await upload(me, 'selfie');
            await kyc.reviewDocument(id.id, {status: 'rejected', rejectionReason: 'Expired'}, MODERATOR);
            assert.equal((await applicationFor(me, 'broker')).steps.find((s) => s.step === 'identity').complete, false);
        });

        test('an already verified customer skips the ID step', async () => {
            const me = await customer('+255713500001', {kycStatus: 'verified'});
            const view = await onboarding.saveDetails(me, 'broker', details());
            assert.equal(view.steps.find((s) => s.step === 'identity').complete, true);
            assert.equal(view.identityVerified, true);
            assert.equal(view.nextStep, 'payout');
        });
    });

    describe('landlords — proof of ownership', () => {
        test('the landlord path needs a title deed or a utility bill', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'landlord', details());
            await upload(me, 'national_id');
            await upload(me, 'selfie');
            await onboarding.savePayout(me, mpesa);
            await onboarding.acceptAgreement(me, 'landlord', {version: 'v1.0'});

            let view = await applicationFor(me, 'landlord');
            assert.deepEqual(view.missingSteps, ['ownership']);
            await assert.rejects(onboarding.submit(me, 'landlord'), (error) => {
                assert.equal(error.code, ErrorCodes.VALIDATION_FAILED);
                assert.equal(error.status, 422);
                assert.deepEqual(error.details, {missingSteps: ['ownership']});
                return true;
            });

            await upload(me, 'utility_bill');
            view = await applicationFor(me, 'landlord');
            assert.equal(view.complete, true);
            assert.equal((await onboarding.submit(me, 'landlord')).status, 'pending_review');
        });

        test('a title deed counts as well', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'landlord', details());
            await upload(me, 'title_deed');
            assert.equal((await applicationFor(me, 'landlord')).steps.find((s) => s.step === 'ownership').complete, true);
        });
    });

    describe('step 3 — getting paid and the agreement', () => {
        test('payout details belong to the person and serve both roles', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());
            await onboarding.saveDetails(me, 'landlord', details());
            const saved = await onboarding.savePayout(me, mpesa);

            assert.deepEqual(saved.payout, {method: 'mobile_money', provider: 'mpesa', accountName: 'Neema Kileo', accountNumber: '+255712345678'});
            for (const role of ['broker', 'landlord']) {
                assert.equal((await applicationFor(me, role)).steps.find((s) => s.step === 'payout').complete, true);
            }
        });

        test('a bank from the bank dictionary is accepted; an unknown bank is not', async () => {
            const me = await customer();
            const saved = await onboarding.savePayout(me, {method: 'bank', provider: 'crdb', accountName: 'Neema Kileo', accountNumber: '0150123456789'});
            assert.equal(saved.payout.method, 'bank');
            assert.equal(saved.payout.provider, 'crdb');
            await assert.rejects(
                onboarding.savePayout(me, {method: 'bank', provider: 'bank_of_nowhere', accountName: 'N', accountNumber: '0150123456789'}),
                expectDomainError(ErrorCodes.VALIDATION_FAILED)
            );
        });

        test('the agreement must be the current version, and is stamped', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());

            await assert.rejects(onboarding.acceptAgreement(me, 'broker', {version: 'v0.9'}), expectDomainError(ErrorCodes.VALIDATION_FAILED, /v1\.0/));
            const view = await onboarding.acceptAgreement(me, 'broker', {version: 'v1.0'});
            assert.equal(view.agreementVersion, 'v1.0');
            assert.equal(view.steps.find((s) => s.step === 'agreement').complete, true);
            const row = await roleRow(me, 'broker');
            assert.ok(row.agreement_accepted_at);
        });

        test('a new agreement version reopens the agreement step', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());
            await onboarding.acceptAgreement(me, 'broker', {version: 'v1.0'});
            await pool.query(`update settings set value = '"v2.0"'::jsonb where key = 'partner.agreement_version.broker'`);
            assert.equal((await applicationFor(me, 'broker')).steps.find((s) => s.step === 'agreement').complete, false);
        });

        test('the agreement needs an application to attach to', async () => {
            const me = await customer();
            await assert.rejects(onboarding.acceptAgreement(me, 'broker', {version: 'v1.0'}), expectDomainError(ErrorCodes.NOT_FOUND));
        });
    });

    describe('step 4 — submit', () => {
        test('an incomplete application is refused with the missing steps', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());
            await assert.rejects(onboarding.submit(me, 'broker'), (error) => {
                assert.equal(error.status, 422);
                assert.deepEqual(error.details.missingSteps, ['identity', 'payout', 'agreement']);
                return true;
            });
        });

        test('submitting without ever applying is not found', async () => {
            const me = await customer();
            await assert.rejects(onboarding.submit(me, 'broker'), expectDomainError(ErrorCodes.NOT_FOUND));
        });

        test('a complete application goes to review, and staff who handle partners are told', async () => {
            const me = await customer();
            const admin = await customer('+255713500090', {role: 'admin', email: 'admin2@homemate.co.tz', fullName: 'Admin'});
            const partnersMod = await customer('+255713500091', {role: 'moderator', email: 'p@homemate.co.tz', allowedRoutes: ['partners']});
            const otherMod = await customer('+255713500092', {role: 'moderator', email: 'o@homemate.co.tz', allowedRoutes: ['properties']});
            await completeBrokerSteps(me);

            const view = await onboarding.submit(me, 'broker');

            assert.equal(view.status, 'pending_review');
            assert.ok(view.submittedAt);
            assert.equal(view.canSubmit, false);
            const {rows} = await pool.query('select user_id, kind::text, subject_table from notifications order by user_id');
            const told = rows.map((r) => r.user_id).sort();
            assert.deepEqual(told, [admin, partnersMod].sort());
            assert.ok(!told.includes(otherMod));
            assert.equal(rows[0].subject_table, 'user_roles');

            await assert.rejects(onboarding.submit(me, 'broker'), expectDomainError(ErrorCodes.CONFLICT));
        });
    });

    describe('the moderator', () => {
        async function submittedBroker(phone = '+255713500001') {
            const me = await customer(phone);
            await completeBrokerSteps(me);
            await onboarding.submit(me, 'broker');
            return me;
        }

        test('the queue shows the person, their documents and the step state, filterable', async () => {
            const broker = await submittedBroker();
            const landlord = await customer('+255713500002', {fullName: 'Amina Landlord'});
            await onboarding.saveDetails(landlord, 'landlord', details({fullName: 'Amina Landlord'}));

            const pending = await review.queue({status: 'pending_review'});
            assert.equal(pending.items.length, 1);
            const item = pending.items[0];
            assert.equal(item.userId, broker);
            assert.equal(item.role, 'broker');
            assert.equal(item.person.fullName, 'Neema Kileo');
            assert.equal(item.person.phoneNumber, '+255713500001');
            assert.equal(item.person.nationalIdNumber, NIDA);
            assert.deepEqual(item.documents.map((d) => d.document_type).sort(), ['national_id', 'selfie']);
            assert.equal(item.application.complete, true);

            assert.equal((await review.queue({role: 'landlord'})).items.length, 1);
            assert.equal((await review.queue({q: 'amina'})).items[0].userId, landlord);
            assert.equal((await review.queue({q: '500001'})).items[0].userId, broker);
            assert.equal((await review.queue({})).pagination.total, 2);
            assert.equal((await review.queue({})).items.every((i) => i.role !== 'customer'), true);
        });

        test('full broker path: approve → active, stamped, told, and the role switch works', async () => {
            const me = await submittedBroker();

            const decided = await review.decide(me, 'broker', {decision: 'approve'}, MODERATOR);

            assert.equal(decided.status, 'active');
            assert.equal(decided.application.canSubmitListings, true);
            const row = await roleRow(me, 'broker');
            assert.equal(row.status, 'active');
            assert.ok(row.activated_at);
            assert.ok(row.reviewed_at);
            assert.equal(row.reviewed_by, MODERATOR);

            const {rows: notes} = await pool.query('select kind::text, title from notifications where user_id = $1', [me]);
            assert.equal(notes.length, 1);
            assert.equal(notes[0].kind, 'kyc_update');
            assert.equal(sms.lastMessageTo('+255713500001').template, 'partner-application-decision');
            assert.equal(sms.lastMessageTo('+255713500001').params.decision, 'approve');

            const {rows: audit} = await pool.query(
                `select actor from audit_log where table_name = 'user_roles' and operation = 'UPDATE' order by id desc limit 1`
            );
            assert.equal(audit[0].actor, MODERATOR);

            const switched = await access.switchActiveRole({userId: me, role: 'broker'});
            assert.equal(switched.activeRole, 'broker');
        });

        test('approving with verified ID and selfie also verifies the person', async () => {
            const me = await submittedBroker();
            const {rows: docs} = await pool.query('select id from kyc_documents where user_id = $1', [me]);
            for (const doc of docs) await kyc.reviewDocument(doc.id, {status: 'verified'}, MODERATOR);

            await review.decide(me, 'broker', {decision: 'approve'}, MODERATOR);

            const {rows} = await pool.query('select kyc_status::text, kyc_reviewed_by from users where id = $1', [me]);
            assert.equal(rows[0].kyc_status, 'verified');
            assert.equal(rows[0].kyc_reviewed_by, MODERATOR);
        });

        test('approving without verified documents leaves the person’s KYC alone', async () => {
            const me = await submittedBroker();
            await review.decide(me, 'broker', {decision: 'approve'}, MODERATOR);
            const {rows} = await pool.query('select kyc_status::text from users where id = $1', [me]);
            assert.equal(rows[0].kyc_status, 'in_review');
        });

        test('action needed → remediation → the person fixes it and resubmits → back to review', async () => {
            const me = await submittedBroker();
            const {rows: docs} = await pool.query(`select id from kyc_documents where user_id = $1 and document_type = 'selfie'`, [me]);

            const decided = await review.decide(
                me,
                'broker',
                {decision: 'action_needed', reason: 'Selfie is blurry', remediation: {requestedAction: 'Take a new selfie in good light', documentId: docs[0].id}},
                MODERATOR
            );
            assert.equal(decided.status, 'action_needed');
            const {rows: remediations} = await pool.query('select issue, requested_action, kyc_document_id, raised_by from kyc_remediations where user_id = $1', [me]);
            assert.deepEqual(remediations[0], {
                issue: 'Selfie is blurry',
                requested_action: 'Take a new selfie in good light',
                kyc_document_id: docs[0].id,
                raised_by: MODERATOR,
            });
            assert.equal(sms.lastMessageTo('+255713500001').params.decision, 'action_needed');

            const view = await applicationFor(me, 'broker');
            assert.equal(view.canSubmit, true);
            assert.equal(view.canDraftListings, true);
            await upload(me, 'selfie');
            const resubmitted = await onboarding.submit(me, 'broker');
            assert.equal(resubmitted.status, 'pending_review');
        });

        test('reject needs a reason, and the reason reaches the applicant', async () => {
            const me = await submittedBroker();
            await assert.rejects(review.decide(me, 'broker', {decision: 'reject'}, MODERATOR), expectDomainError(ErrorCodes.VALIDATION_FAILED, /reason/));

            const decided = await review.decide(me, 'broker', {decision: 'reject', reason: 'NIDA does not match the ID'}, MODERATOR);
            assert.equal(decided.status, 'rejected');
            assert.equal(decided.application.rejectionReason, 'NIDA does not match the ID');

            // A rejected applicant may start again; the old reason is cleared.
            const again = await onboarding.saveDetails(me, 'broker', details());
            assert.equal(again.status, 'applied');
            assert.equal(again.rejectionReason, null);
        });

        test('only an application under review can be decided', async () => {
            const me = await customer();
            await onboarding.saveDetails(me, 'broker', details());
            await assert.rejects(review.decide(me, 'broker', {decision: 'approve'}, MODERATOR), expectDomainError(ErrorCodes.CONFLICT));
            await assert.rejects(review.decide(me, 'landlord', {decision: 'approve'}, MODERATOR), expectDomainError(ErrorCodes.NOT_FOUND));
        });

        test('an SMS failure does not undo the decision', async () => {
            const me = await submittedBroker();
            const failing = createPartnerReviewService({
                pool,
                notificationPort: {send: async () => { throw new Error('provider down'); }},
            });
            const decided = await failing.decide(me, 'broker', {decision: 'approve'}, MODERATOR);
            assert.equal(decided.status, 'active');
            assert.equal((await roleRow(me, 'broker')).status, 'active');
        });

        test('the sidebar badge counts applications waiting for review', async () => {
            await submittedBroker();
            const {rows} = await pool.query('select partner_applications_pending from v_attention_counts');
            assert.equal(Number(rows[0].partner_applications_pending), 1);
        });
    });
});
