# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Summa, please report it responsibly.

**Do NOT open a public issue for security vulnerabilities.**

Instead, please email security@summa.dev (or open a private security advisory on GitHub).

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 1 week
- **Fix & Release**: As soon as possible, typically within 2 weeks

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Security Best Practices

When using Summa in production:

1. **Use PostgreSQL** — The memory adapter is for testing only
2. **Enable advisory locks** — Prevents race conditions in concurrent environments
3. **Verify hash chains** — Regularly run `summa verify --chain` to detect tampering
4. **Run reconciliation** — Use the reconciliation plugin to detect balance drift
5. **Secure your database** — Use strong credentials, TLS connections, and network isolation
6. **Keep dependencies updated** — Regularly update Summa and its dependencies
