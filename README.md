# homemate-functions

The HomeMate Africa API: one [bfast](https://www.npmjs.com/package/bfast) server,
written in plain Node (ES modules), on Postgres with PostGIS. It serves two
clients:

- [homemate-mobile](https://github.com/fahamutech/homemate-mobile): the Flutter
  app for customers, brokers and landlords (one account, many roles).
- [homemate-portal](https://github.com/fahamutech/homemate-portal): the
  backoffice for HomeMate staff.

## Running it locally

You need Node 22+ and Postgres 16 with the PostGIS extension installed (the
first migration enables it).

```bash
createdb homemate
cp .env.example .env        # then edit DATABASE_URL and the secrets
npm ci
npm run dev                 # http://localhost:3001
```

The server applies any pending migration before it takes traffic. Run
`npm run migrate` to migrate without starting it. `GET /health` reports the
schema version the database is on.

SMS defaults to the **sandbox** adapter: no message leaves the machine, and
`GET /customer/auth/otp/last?phoneNumber=+255…` returns the last code "sent" to
a number. That route only exists while the sandbox adapter is in use; with
`SMS_PROVIDER=nextsms` it returns 404.

## Configuration

Every setting is an environment variable; `.env.example` lists them with
comments. The ones that must be real in any shared deployment:

| Variable | Why it matters |
|---|---|
| `DATABASE_URL` | The Postgres connection |
| `SESSION_TOKEN_SECRET` | Signs session tokens. Anyone holding it can sign in as anyone. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | The bootstrap backoffice administrator |
| `SMS_PROVIDER` + `SMS_*` | Real OTP delivery. Leaving the sandbox on in production would expose every code |
| `STORAGE_PROVIDER` + `STORAGE_*` | Where photos and identity documents are kept (`memory` loses them on restart) |

## How it is put together

```
functions/        HTTP routes (rest/), guards and scheduled jobs — thin
src/services/     the domain: one folder per bounded context
src/shared/       session tokens, roles, fees, errors, HTTP helpers
src/db/           the connection pool
migrations/       numbered plain-SQL files, applied in order, never edited
specs/e2e/        end-to-end journeys over HTTP
```

- **Plain SQL, no ORM.** Rules that must hold for every client (quotas,
  state transitions, publish guards) live in the database as constraints,
  triggers and functions.
- **Migrations are append-only.** To change the schema, add the next
  numbered file; never edit one that has shipped.
- **Ports and adapters.** SMS, storage, payments and geocoding sit behind
  ports, so tests and local runs use in-memory adapters.
- **Roles.** A person has one account and any of the roles `customer`,
  `broker` and `landlord` (`user_roles`). The session carries them and the
  active one. Partner routes under `/app/partner` and `/app/landlord` check
  the role on every request, and clients announce it in `X-Partner-Role`.

## Tests

```bash
cp .env.example .env.test   # point DATABASE_URL at a separate, disposable database
npm run migrate:test
npm test                    # unit, then integration and e2e against Postgres
```

Unit specs sit next to the code (`*.unit.specs.mjs`); integration specs
(`*.integration.specs.mjs`) and `specs/e2e` need the test database. CI runs
all three against a fresh PostGIS container.

## Deploying

`main` is protected: changes arrive through a reviewed pull request with
green CI. Every push to `main` fires a webhook that rebuilds and restarts the
production server, which migrates itself on start. Check `/health` after a
merge.

## Secrets

This repository is public, so anything committed is published, and deleting
it later does not take it back.

- Real values live only in the deployment's environment and in GitHub Actions
  secrets. `.env`, `.env.test` and other key files are gitignored.
- `.github/workflows/secret-scan.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks)
  over the full history on every push and pull request. Run it yourself with
  `gitleaks git .` before pushing.
- If a secret is ever committed, **rotate it first**, then remove it.

See [SECURITY.md](SECURITY.md) to report a vulnerability.
