import {partnerOnboarding} from '../../src/services/partner-app/container.mjs';
import {route} from '../../src/shared/http.mjs';

/**
 * Applying to be a broker or a landlord from the app (T03, BRK-002a–e,
 * LND-002a–d). Under `/app`, so a customer session is required; the person is
 * always the one in the session. Identity documents keep using
 * /app/me/kyc/documents — there is one KYC store.
 */

const me = (request) => request.auth.userId;

export const partnerListApplications = route({
    method: 'get',
    path: '/app/partner/applications',
    description: 'Both partner roles with status and step completion, plus the profile to prefill',
    handler: (request) => partnerOnboarding.listApplications(me(request)),
});

export const partnerSaveDetails = route({
    method: 'put',
    path: '/app/partner/applications/:role',
    description: 'Step 1 “Your details”: saves them on the person and starts the application',
    requestSample: {
        fullName: 'Neema Kileo',
        dateOfBirth: '1990-04-12',
        nationalIdNumber: '19900412-12345-00001-23',
        tinNumber: '123-456-789',
        physicalAddress: 'Plot 12, Mikocheni, Dar es Salaam',
    },
    handler: (request) => partnerOnboarding.saveDetails(me(request), request.params.role, request.body ?? {}),
});

export const partnerSavePayout = route({
    method: 'put',
    path: '/app/me/payout',
    description: 'Where HomeMate pays this person: mobile money or a bank account',
    requestSample: {method: 'mobile_money', provider: 'mpesa', accountName: 'Neema Kileo', accountNumber: '+255712345678'},
    handler: (request) => partnerOnboarding.savePayout(me(request), request.body ?? {}),
});

export const partnerAcceptAgreement = route({
    method: 'post',
    path: '/app/partner/applications/:role/agreement',
    description: 'Accept the current partner agreement for the role',
    requestSample: {version: 'v1.0'},
    handler: (request) =>
        partnerOnboarding.acceptAgreement(me(request), request.params.role, {version: request.body?.version}),
});

export const partnerSubmitApplication = route({
    method: 'post',
    path: '/app/partner/applications/:role/submit',
    description: 'Send a complete application for review; 422 with details.missingSteps otherwise',
    handler: (request) => partnerOnboarding.submit(me(request), request.params.role),
});
