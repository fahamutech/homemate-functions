import {DomainError, ErrorCodes} from './errors.mjs';

const created = new Date().toISOString();

/**
 * Builds a bfast-function route descriptor from a plain async handler.
 *
 * Every endpoint gets identical error handling, status mapping and JSON
 * shaping from here, so a route file contains only what is actually specific
 * to that route. Handlers just return a value (or `{status, body}`) and throw
 * DomainError for expected failures.
 */
export function route({method, path, description, requestSample, responseSample, handler}) {
    return {
        created,
        method,
        path,
        description,
        requestSample,
        responseSample,
        onRequest: async (request, response) => {
            try {
                const result = await handler(request, response);
                if (response.headersSent) return;
                if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
                    response.status(result.status).json(result.body);
                    return;
                }
                response.status(200).json(result ?? {});
            } catch (error) {
                if (error instanceof DomainError) {
                    response.status(error.status).json({error: error.code, message: error.message});
                    return;
                }
                console.error(`${method.toUpperCase()} ${path} failed`, error);
                response.status(500).json({error: ErrorCodes.INTERNAL_ERROR, message: 'Unexpected server error'});
            }
        },
    };
}

/** The admin identity attached by functions/guards/auth.mjs. */
export function actorOf(request) {
    return request.auth?.email ?? request.auth?.userId ?? null;
}
