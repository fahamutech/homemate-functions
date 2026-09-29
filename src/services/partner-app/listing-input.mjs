import {invalid} from '../../shared/errors.mjs';

/**
 * The fields of the listing wizard (BRK-030a–g) a partner may write. Status,
 * owner, organisation, listing type and currency are deliberately absent:
 * status moves only through submit/archive and review, the owner is the
 * landlord party, and HomeMate lists rentals in TZS.
 */
const PROPERTY_FIELDS = [
    'title', 'description', 'propertyTypeId', 'price', 'bedrooms', 'bathrooms', 'sizeSqm',
    'addressLine', 'regionId', 'districtId', 'wardId', 'latitude', 'longitude',
    'furnishing', 'floorNumber', 'totalFloors', 'yearBuilt', 'parkingSpaces', 'maxOccupants',
    'petsAllowed', 'smokingAllowed', 'availableFrom', 'minLeaseMonths', 'maxLeaseMonths',
    'paymentFrequency', 'customPaymentMonths', 'depositMonths', 'advanceRentMonths',
    'noticePeriodDays', 'terms', 'houseRules',
];

function listOrUndefined(input, key) {
    if (input[key] === undefined) return undefined;
    if (!Array.isArray(input[key])) throw invalid(`${key} must be a list`);
    return input[key];
}

/**
 * Splits a wizard body into the property patch (camelCase, for the shared
 * insertProperty/patchProperty writers) and the lists that replace whole
 * sets. A list left out is left alone.
 */
export function readListingInput(input = {}) {
    const property = {};
    for (const field of PROPERTY_FIELDS) {
        if (input[field] !== undefined) property[field] = input[field];
    }
    return {
        property,
        amenityIds: listOrUndefined(input, 'amenityIds'),
        charges: listOrUndefined(input, 'charges'),
        photoOrder: listOrUndefined(input, 'photoOrder'),
        landlordUserId: input.landlordUserId === undefined ? undefined : input.landlordUserId,
    };
}

/** "Neema K." — how a landlord is shown to a broker before they are attached. */
export function maskName(fullName) {
    const parts = `${fullName ?? ''}`.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

const BLOCKER_MESSAGES = {
    missing_title: 'Give the home a title.',
    missing_price: 'Set the monthly rent.',
    missing_property_type: 'Choose what kind of home it is.',
    missing_region: 'Choose the region.',
    missing_location: 'Drop the pin on the map.',
    no_photos: 'Add at least one photo.',
    role_not_active: 'Your partner account is still being verified — you can submit once it is approved.',
    no_landlord: 'Add the landlord of this home.',
    landlord_pending: 'Waiting for the landlord to confirm this listing.',
    landlord_disputed: 'The landlord disputed this listing — sort it out with them first.',
    wrong_status: 'Only a draft or a listing with requested changes can be submitted.',
};

/** Turns partner_listing_submit_blockers() codes (029) into {code, message}. */
export function describeSubmitBlockers(codes) {
    return codes.map((code) => ({code, message: BLOCKER_MESSAGES[code] ?? code.replace(/_/g, ' ')}));
}
