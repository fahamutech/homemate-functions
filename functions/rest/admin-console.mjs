import {adminConsole} from '../../src/services/admin-console/container.mjs';
import {route, actorOf} from '../../src/shared/http.mjs';

/**
 * The admin backoffice API. Every route is protected by the `/admin` guard in
 * functions/guards/auth.mjs (admin role required) and every handler is a thin
 * call into src/services/admin-console — which is itself a thin call into the
 * database, where the real rules live.
 */

// --- Dashboard & audit -------------------------------------------------------

export const adminDashboard = route({
    method: 'get',
    path: '/admin/dashboard',
    description: 'KPI cards and recent audit activity for the admin dashboard',
    handler: () => adminConsole.insights.dashboard(),
});

/**
 * Everything waiting on a human, as one number per sidebar entry. The sidebar
 * polls this rather than counting rows itself, so a badge cannot disagree with
 * the list it points at.
 */
export const adminAttention = route({
    method: 'get',
    path: '/admin/attention',
    description: 'Counts of items needing attention, grouped for the sidebar badges',
    handler: () => adminConsole.insights.attention(),
});

export const adminAuditLog = route({
    method: 'get',
    path: '/admin/audit',
    description: 'Searchable audit trail (written by database triggers)',
    handler: (request) => adminConsole.insights.auditLog(request.query),
});

// --- Users (customers, landlords, agencies, brokers) and staff ---------------

export const adminSearchUsers = route({
    method: 'get',
    path: '/admin/users',
    description: 'Search users by name/email/phone with role, status and organization facets',
    handler: (request) => adminConsole.users.search(request.query),
});

export const adminCreateUser = route({
    method: 'post',
    path: '/admin/users',
    description: 'Create a platform user or invite a staff member',
    requestSample: {fullName: 'Amina Hassan', phoneNumber: '+255712345678', role: 'landlord'},
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.users.create(request.body ?? {}, actorOf(request)),
    }),
});

export const adminGetUser = route({
    method: 'get',
    path: '/admin/users/:id',
    description: 'Fetch a single user',
    handler: (request) => adminConsole.users.getById(request.params.id),
});

export const adminUpdateUser = route({
    method: 'patch',
    path: '/admin/users/:id',
    description: 'Update a user profile',
    handler: (request) => adminConsole.users.update(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminChangeUserRoleStatus = route({
    method: 'post',
    path: '/admin/users/:id/roles/:role/status',
    description: 'Suspend (with a reason) or reactivate a person’s broker or landlord role',
    requestSample: {status: 'suspended', reason: 'Listings reported as fake'},
    handler: (request) =>
        adminConsole.users.changeRoleStatus(request.params.id, request.params.role, request.body ?? {}, actorOf(request)),
});

export const adminChangeUserStatus = route({
    method: 'post',
    path: '/admin/users/:id/status',
    description: 'Activate, suspend (with reason) or deactivate a user',
    requestSample: {status: 'suspended', reason: 'Fraudulent listings'},
    handler: (request) => adminConsole.users.changeStatus(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- Organizations (agencies / developers / institutions) -------------------

export const adminSearchOrganizations = route({
    method: 'get',
    path: '/admin/organizations',
    description: 'Search agencies and other organizations',
    handler: (request) => adminConsole.organizations.search(request.query),
});

export const adminCreateOrganization = route({
    method: 'post',
    path: '/admin/organizations',
    description: 'Register an organization',
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.organizations.create(request.body ?? {}, actorOf(request)),
    }),
});

export const adminGetOrganization = route({
    method: 'get',
    path: '/admin/organizations/:id',
    description: 'Fetch a single organization',
    handler: (request) => adminConsole.organizations.getById(request.params.id),
});

export const adminUpdateOrganization = route({
    method: 'patch',
    path: '/admin/organizations/:id',
    description: 'Update organization details',
    handler: (request) =>
        adminConsole.organizations.update(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminChangeOrganizationStatus = route({
    method: 'post',
    path: '/admin/organizations/:id/status',
    description: 'Approve, reject (with reason) or suspend an organization',
    handler: (request) =>
        adminConsole.organizations.changeStatus(request.params.id, request.body ?? {}, actorOf(request)),
});

// --- Properties --------------------------------------------------------------

export const adminSearchProperties = route({
    method: 'get',
    path: '/admin/properties',
    description: 'Search the property registry: text, facets and PostGIS radius',
    handler: (request) => adminConsole.properties.search(request.query),
});

export const adminCreateProperty = route({
    method: 'post',
    path: '/admin/properties',
    description: 'Register a property',
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.properties.create(request.body ?? {}, actorOf(request)),
    }),
});

export const adminGetProperty = route({
    method: 'get',
    path: '/admin/properties/:id',
    description: 'Fetch a property with its media',
    handler: (request) => adminConsole.properties.getById(request.params.id),
});

export const adminUpdateProperty = route({
    method: 'patch',
    path: '/admin/properties/:id',
    description: 'Update property details',
    handler: (request) => adminConsole.properties.update(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminChangePropertyStatus = route({
    method: 'post',
    path: '/admin/properties/:id/status',
    description: 'Moderation decision: submit, approve, reject, request changes, suspend or archive',
    requestSample: {status: 'rejected', reason: 'Photos unclear or insufficient'},
    handler: (request) =>
        adminConsole.properties.changeStatus(request.params.id, request.body ?? {}, actorOf(request)),
});


// --- Dictionaries (master data) ---------------------------------------------

export const adminDictionaryCategories = route({
    method: 'get',
    path: '/admin/dictionaries',
    description: 'List dictionary categories with item counts',
    handler: () => adminConsole.dictionaries.categories(),
});

export const adminCreateDictionaryItem = route({
    method: 'post',
    path: '/admin/dictionaries',
    description: 'Create a dictionary item (region, district, ward, property type, amenity…)',
    handler: async (request) => ({
        status: 201,
        body: await adminConsole.dictionaries.create(request.body ?? {}, actorOf(request)),
    }),
});

/** Search master data across every category — `?category=` narrows it. */
export const adminSearchDictionaryItems = route({
    method: 'get',
    path: '/admin/dictionary-items',
    description: 'Search dictionary items by name or code, across or within a category',
    handler: (request) => adminConsole.dictionaries.list(request.query ?? {}),
});

export const adminImportDictionaryItems = route({
    method: 'post',
    path: '/admin/dictionary-items/import',
    description: 'Bulk import a category; existing codes are updated, parents may be named by code',
    requestSample: {
        category: 'region',
        items: [{code: 'mbeya', name: 'Mbeya'}, {code: 'mbeya_city', name: 'Mbeya City', parentCode: 'mbeya'}],
    },
    handler: (request) => adminConsole.dictionaries.importItems(request.body ?? {}, actorOf(request)),
});

export const adminListDictionaryItems = route({
    method: 'get',
    path: '/admin/dictionaries/:category',
    description: 'List items in a dictionary category, optionally filtered by parent',
    handler: (request) =>
        adminConsole.dictionaries.list({...request.query, category: request.params.category}),
});

export const adminUpdateDictionaryItem = route({
    method: 'patch',
    path: '/admin/dictionaries/item/:id',
    description: 'Update or deactivate a dictionary item',
    handler: (request) =>
        adminConsole.dictionaries.update(request.params.id, request.body ?? {}, actorOf(request)),
});

export const adminArchiveDictionaryItem = route({
    method: 'post',
    path: '/admin/dictionaries/item/:id/archive',
    description: 'Retire an item (and its children) without orphaning records that use it',
    handler: (request) => adminConsole.dictionaries.archive(request.params.id, actorOf(request)),
});

export const adminRestoreDictionaryItem = route({
    method: 'post',
    path: '/admin/dictionaries/item/:id/restore',
    description: 'Put an archived item back on offer',
    handler: (request) => adminConsole.dictionaries.restore(request.params.id, actorOf(request)),
});

export const adminDeleteDictionaryItem = route({
    method: 'delete',
    path: '/admin/dictionaries/item/:id',
    description: 'Delete an item outright — refused when anything already references it',
    handler: (request) => adminConsole.dictionaries.remove(request.params.id, actorOf(request)),
});

// --- Settings ----------------------------------------------------------------

export const adminListSettings = route({
    method: 'get',
    path: '/admin/settings',
    description: 'All platform settings, grouped by category',
    handler: (request) => adminConsole.settings.list(request.query),
});

export const adminUpdateSetting = route({
    method: 'patch',
    path: '/admin/settings/:key',
    description: 'Update a setting value (previous value is archived by a database trigger)',
    requestSample: {value: 5},
    handler: (request) =>
        adminConsole.settings.update(request.params.key, request.body ?? {}, actorOf(request)),
});

export const adminSettingHistory = route({
    method: 'get',
    path: '/admin/settings/:key/history',
    description: 'Version history for a setting',
    handler: (request) => adminConsole.settings.history(request.params.key),
});
