/**
 * One error type and one Postgres-error translation for the whole backend.
 *
 * Because the database is the source of truth, most "validation" failures
 * arrive as Postgres errors (check_violation from a trigger, unique_violation
 * from an index, foreign_key_violation from a reference). Translating them in
 * exactly one place means a new endpoint gets correct, consistent error
 * responses without writing any validation code of its own.
 */
export class DomainError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {number} [status]
     * @param {Record<string, unknown>} [details] extra fields the client can act on
     */
    constructor(code, message, status = 400, details = undefined) {
        super(message);
        this.name = 'DomainError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

export const ErrorCodes = Object.freeze({
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
    REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
    UNAUTHORIZED: 'UNAUTHORIZED',
    FORBIDDEN: 'FORBIDDEN',
    RATE_LIMITED: 'RATE_LIMITED',
    ROLE_NOT_ACTIVE: 'ROLE_NOT_ACTIVE',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/**
 * Database constraints are the source of truth for these rules, but their
 * names are not something a person should ever read. Anything enforced by a
 * named constraint gets a sentence here that says what to actually do; the
 * raw constraint name is what would otherwise leak into the UI.
 */
const CONSTRAINT_MESSAGES = {
    properties_publishable_data_complete:
        'Before a listing can be approved it needs a price, a property type, a region and a map location.',
    properties_rejection_reason_required: 'A rejected listing must carry a reason.',
    properties_custom_frequency_needs_months:
        'A custom payment mode must say how many months each payment covers.',
    properties_lease_range_sane: 'The maximum lease cannot be shorter than the minimum lease.',
    properties_floor_sane: 'The floor number cannot be higher than the number of floors in the building.',
    properties_year_built_sane: 'That year built is not a plausible date.',
    properties_deposit_sane: 'The deposit must be between 0 and 24 months of rent.',
    properties_advance_sane: 'Advance rent must be between 0 and 24 months.',
    properties_price_non_negative: 'A price cannot be negative.',
    properties_title_not_blank: 'A listing needs a title.',
    property_charges_amount_non_negative: 'A charge cannot be negative.',
    property_charges_name_not_blank: 'A charge needs a name.',
    property_parties_commission_sane: 'Commission must be between 0 and 100 percent.',
    property_parties_one_primary_per_role:
        'That property already has a primary party in this role — clear the existing one first.',
    organizations_rejection_reason_required: 'A rejected organization must carry a reason.',
    organizations_name_not_blank: 'An organization needs a name.',
    users_suspension_reason_required: 'A suspended account must carry a reason.',
    users_staff_requires_email: 'Staff accounts need an email address.',
    users_email_key: 'That email address is already registered.',
    users_phone_number_key: 'That phone number is already registered.',
    dictionary_items_category_code_key: 'That code already exists in this category.',
    payment_methods_code_key: 'That payment method code already exists.',
};

const PG_ERROR_CODES = {
    UNIQUE_VIOLATION: '23505',
    FOREIGN_KEY_VIOLATION: '23503',
    CHECK_VIOLATION: '23514',
    NOT_NULL_VIOLATION: '23502',
    INVALID_TEXT_REPRESENTATION: '22P02',
};

/**
 * Turns a thrown Postgres error into a DomainError. Anything unrecognised is
 * returned untouched so genuine bugs still surface as 500s rather than being
 * silently reported as bad input.
 */
export function translatePostgresError(error) {
    if (!error || typeof error.code !== 'string') return error;

    switch (error.code) {
        case PG_ERROR_CODES.UNIQUE_VIOLATION:
            return new DomainError(
                ErrorCodes.CONFLICT,
                CONSTRAINT_MESSAGES[error.constraint] ??
                    error.detail ??
                    'A record with those details already exists',
                409
            );
        case PG_ERROR_CODES.FOREIGN_KEY_VIOLATION:
            return new DomainError(
                ErrorCodes.REFERENCE_NOT_FOUND,
                error.detail ?? 'A referenced record does not exist',
                422
            );
        case PG_ERROR_CODES.CHECK_VIOLATION: {
            // Triggers raise `check_violation` too. A trigger's own RAISE
            // message is already written for a person, so it is kept; a table
            // constraint only carries its name, which is not.
            const named = CONSTRAINT_MESSAGES[error.constraint];
            const message = named ?? error.message ?? 'The change violates a data rule';
            return new DomainError(
                `${error.message}`.includes('transition') ? ErrorCodes.ILLEGAL_TRANSITION : ErrorCodes.VALIDATION_FAILED,
                error.hint ? `${message} ${error.hint}` : message,
                422
            );
        }
        case PG_ERROR_CODES.NOT_NULL_VIOLATION:
            return new DomainError(ErrorCodes.VALIDATION_FAILED, `${error.column} is required`, 422);
        case PG_ERROR_CODES.INVALID_TEXT_REPRESENTATION:
            return new DomainError(ErrorCodes.VALIDATION_FAILED, 'A value has the wrong format', 422);
        default:
            return error;
    }
}

export function notFound(what = 'Record') {
    return new DomainError(ErrorCodes.NOT_FOUND, `${what} not found`, 404);
}

export function invalid(message) {
    return new DomainError(ErrorCodes.VALIDATION_FAILED, message, 400);
}
