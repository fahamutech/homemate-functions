import pg from 'pg';

/**
 * A Postgres `date` is a calendar day, not an instant. node-postgres parses it
 * into a JS Date at local midnight, so serialising it — `toISOString()`, or
 * `JSON.stringify` on an API response — shifts it into UTC and, anywhere east
 * of Greenwich, reports the day before. In Dar es Salaam (UTC+3) a lease
 * starting on the 1st came back as the 31st.
 *
 * Dates therefore stay text, exactly as the database wrote them. Timestamps
 * are genuinely instants and keep their normal parsing.
 */
const DATE_OID = 1082;

pg.types.setTypeParser(DATE_OID, (value) => value);
