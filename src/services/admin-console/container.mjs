import {getPool} from '../../db/pool.mjs';
import {createUsersService} from './users.mjs';
import {createOrganizationsService} from './organizations.mjs';
import {createPropertiesService} from './properties.mjs';
import {createPropertyDetailsService} from './property-details.mjs';
import {createPaymentMethodsService} from './payment-methods.mjs';
import {createDictionariesService} from './dictionaries.mjs';
import {createKycService} from './kyc.mjs';
import {createMoneyService} from './money.mjs';
import {createCustomerOpsService} from './customer-ops.mjs';
import {createSettingsService} from './settings.mjs';
import {createInsightsService} from './insights.mjs';
import {storagePort} from '../storage/container.mjs';
import {createSandboxPaymentAdapter} from '../payments/adapters/sandbox-payment.adapter.mjs';
import {createNominatimAdapter} from '../geocoding/adapters/nominatim.adapter.mjs';

const pool = getPool();

/**
 * Registered PaymentPort adapters. A payment method row may only name a
 * provider that appears here (payment-methods.mjs enforces it), so a
 * misconfigured method is caught in the admin console rather than at checkout.
 * `manual` covers methods settled outside the platform (bank transfer, cash):
 * they still open as pending and are closed by a finance officer.
 */
export const paymentPorts = {
    sandbox: createSandboxPaymentAdapter(),
    manual: createSandboxPaymentAdapter(),
};

export const geocodingPort = createNominatimAdapter();

export const adminConsole = {
    users: createUsersService({pool}),
    organizations: createOrganizationsService({pool}),
    properties: createPropertiesService({pool}),
    propertyDetails: createPropertyDetailsService({pool, storagePort}),
    paymentMethods: createPaymentMethodsService({pool, paymentPorts}),
    dictionaries: createDictionariesService({pool}),
    kyc: createKycService({pool, storagePort}),
    money: createMoneyService({pool, paymentPorts}),
    customerOps: createCustomerOpsService({pool}),
    settings: createSettingsService({pool}),
    insights: createInsightsService({pool}),
    geocoding: geocodingPort,
};
