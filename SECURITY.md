# Security

## Reporting a vulnerability

Please report it privately: open this repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue or pull request for a
security problem.

Tell us what is affected, how to reproduce it, and what an attacker could do
with it. We will acknowledge the report and let you know what happens next.

## Secrets

This repository is public. No credential belongs in it: real values live in
the deployment's environment and in GitHub Actions secrets. Every push and
pull request is scanned with gitleaks (`.github/workflows/secret-scan.yml`).

If you find a credential in this repository or its history, report it as
above. It will be rotated first, then removed.
