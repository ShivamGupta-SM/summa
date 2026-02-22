# Summa — Monetization & Open Source Strategy

**Status:** Draft
**Date:** 2026-02-22

---

## Market Context

Financial ledger infrastructure is a **high-value, underserved category** in the TypeScript ecosystem.

### Competitors & Comparables

| Company / Project | Model | Funding / Revenue | Notes |
|---|---|---|---|
| **Formance** | Open-core ledger (Go) | $21M+ raised | Closest competitor — open source ledger with cloud offering |
| **Modern Treasury** | SaaS API | $2B+ valuation | Payment operations platform, not self-hostable |
| **TigerBeetle** | Open-source financial DB (Zig) | $100M+ raised | Purpose-built database, different layer |
| **Medici.js** | Open-source (MongoDB) | Community only | Popular but limited — no event sourcing, no plugins, MongoDB-only |
| **Hledger / Beancount** | Open-source CLI | Donations | Plain-text accounting, not embeddable |

### Summa's Positioning

Summa is the **only production-grade, TypeScript-native, event-sourced double-entry ledger** with:
- 25+ composable plugins
- 4 database adapters (Drizzle, Prisma, Kysely, Memory)
- Built-in CAPTCHA-free integrity (SHA-256 hash chains)
- Embeddable library + standalone API + CLI
- Reactive client SDK (React, Vue, Svelte)

**Target audience:**
- Indian fintech startups (UPI, lending, neobanking, wallets)
- SaaS platforms with wallet/credit features
- E-commerce platforms (marketplace payouts, refunds)
- Accounting/ERP tools
- Any TypeScript team building financial infrastructure

---

## Revenue Model: Open Core + Cloud

### Tier 1 — Open Source (MIT License)

**What's free:**
- Core library (`summa`, `@summa-ledger/core`)
- All 4 database adapters
- All current plugins (25+)
- CLI (`@summa-ledger/cli`)
- Client SDK (`@summa-ledger/client`)
- Documentation site

**Why free:**
- Adoption and trust — every npm install is a potential customer
- Community contributions — bug reports, PRs, testing at scale
- SEO and discoverability
- Hiring signal for future team

### Tier 2 — Summa Cloud (Hosted SaaS)

Managed multi-tenant ledger API. Users don't self-host — they call the API.

| Plan | Price | Includes |
|---|---|---|
| **Free** | $0/month | 1,000 transactions/month, 1 ledger, community support |
| **Pro** | $49-99/month | 50K transactions/month, 5 ledgers, email support, dashboard |
| **Business** | $299-499/month | 500K transactions/month, unlimited ledgers, priority support, SLA |
| **Enterprise** | Custom | Unlimited, dedicated infra, SSO, audit exports, phone support |

**Cloud features (not in open source):**
- Hosted multi-tenant API with dashboard
- Usage analytics and billing
- Team management and RBAC
- Managed backups and disaster recovery
- Uptime SLA (99.9%+)
- Webhook monitoring dashboard

### Tier 3 — Enterprise Add-ons

Sold separately or bundled with Enterprise plan:

| Add-on | Price | Description |
|---|---|---|
| **Compliance Pack** | $200/month | SOC 2 audit exports, data retention policies, compliance reports |
| **Multi-Region** | $500/month | Cross-region replication, geo-routing, disaster recovery |
| **Premium Support** | $500/month | Dedicated Slack channel, 4-hour response SLA, architecture review |
| **Consulting** | $200-500/hr | Migration assistance, architecture design, custom plugin development |

### Tier 4 — Sponsorware / Early Access

For major new features:
- Announce feature publicly
- Sponsors get early access (1-3 months before open source release)
- After exclusivity window, feature becomes open source
- Creates urgency and rewards supporters

---

## Revenue Projections (Conservative)

| Timeline | Monthly Revenue | Source |
|---|---|---|
| 0-6 months | $0 | Building community, getting stars, writing content |
| 6-12 months | $500-2,000 | Early cloud users, first consulting gigs |
| 12-18 months | $2,000-8,000 | Cloud growth, enterprise pilots |
| 18-24 months | $8,000-25,000 | Product-market fit, word of mouth |
| 24+ months | $25,000+ | Scale cloud, raise funding if needed |

---

## Go-to-Market: Open Source Launch

### Phase 1 — Launch Ready (2-4 weeks)

- [ ] All packages build and test cleanly
- [ ] Publish to npm public registry (`summa`, `@summa-ledger/core`, `@summa-ledger/cli`, all adapters)
- [ ] GitHub repo public with proper LICENSE, CONTRIBUTING, CODE_OF_CONDUCT (already done)
- [ ] GitHub Actions CI/CD: build → test → typecheck → lint → publish
- [ ] Changesets configured for versioning (already done)
- [ ] README polish: add terminal demo GIF, badges, quick comparison table
- [ ] 2-3 example apps: basic wallet, marketplace payout, SaaS credits

### Phase 2 — Visibility & Adoption (1-2 months)

- [ ] **Launch posts:**
  - Hacker News: "Show HN: Summa — Event-sourced financial ledger for TypeScript"
  - Reddit: r/typescript, r/node, r/fintech, r/javascript
  - Twitter/X thread with architecture diagram
  - Dev.to / Hashnode deep-dive article
- [ ] **Content marketing:**
  - "How to build a fintech ledger in TypeScript" (tutorial)
  - "Why your wallet system needs double-entry bookkeeping" (thought leadership)
  - "Summa vs Formance vs Medici.js — honest comparison" (SEO)
  - "Event sourcing for financial systems — a practical guide" (educational)
- [ ] **Community:**
  - Discord or GitHub Discussions for support
  - "Good first issue" labels for contributors
  - Monthly changelog / devlog posts
- [ ] **Indian fintech angle:**
  - UPI-specific examples and guides
  - Hindi/regional content for Indian developer community
  - Target Indian startup accelerators (Y Combinator India, Razorpay Rize)

### Phase 3 — Cloud Launch (2-4 months)

- [ ] Multi-tenant API service (Hono-based, already have server patterns)
- [ ] Auth layer: API keys with scoped permissions (plugin already exists)
- [ ] Usage tracking and billing (Stripe integration)
- [ ] Dashboard: account explorer, transaction viewer, event timeline
- [ ] Landing page: summa.dev or summaledger.com
- [ ] Pricing page with clear free → paid conversion path
- [ ] Onboarding flow: sign up → get API key → first transaction in 30 seconds

### Phase 4 — Growth (4-12 months)

- [ ] Case studies from early adopters
- [ ] Integration guides (Stripe, Razorpay, PayPal, UPI)
- [ ] Terraform / Pulumi modules for self-hosted enterprise
- [ ] SOC 2 compliance (if targeting enterprise)
- [ ] Conference talks (JSConf India, Node Congress, etc.)
- [ ] Evaluate funding (if traction justifies it)

---

## Key Metrics to Track

| Metric | Target (6 months) | Target (12 months) |
|---|---|---|
| GitHub Stars | 500+ | 2,000+ |
| npm weekly downloads | 200+ | 1,000+ |
| Cloud signups | 50+ | 500+ |
| Paying customers | 5+ | 30+ |
| MRR | $500+ | $5,000+ |
| Discord/community members | 100+ | 500+ |
| Contributors | 5+ | 15+ |

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Low adoption | No revenue funnel | Aggressive content marketing, real-world examples, comparison content |
| Formance dominance | Market already taken | Differentiate on TypeScript-native, plugin ecosystem, developer experience |
| Self-hosting cannibalization | Users don't pay for cloud | Cloud offers dashboard, monitoring, managed infra that self-host doesn't |
| Maintenance burden | Burnout as solo maintainer | Attract contributors early, keep scope focused, charge for support |
| GST portal dependency changes | gst-verification breaks | Separate concern — keep gst-verification independent from Summa |
| Pricing too low | Unsustainable | Start low, increase with value; enterprise tier covers costs |

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-02-22 | Open Core model (MIT for library, proprietary for cloud) | Maximizes adoption while preserving monetization path |
| 2026-02-22 | Cloud-first monetization (not enterprise licenses) | Lower barrier to entry, recurring revenue, easier to scale |
| 2026-02-22 | Keep all current plugins in open source | Generous open source builds trust; monetize on hosting, not features |

---

## Next Steps

1. **Immediate:** Finalize all packages for public npm publish
2. **This week:** Set up GitHub Actions CI/CD pipeline
3. **Next 2 weeks:** Polish README, create demo GIF, write launch blog post
4. **Month 1:** Public launch on HN, Reddit, Twitter
5. **Month 2-3:** Build cloud MVP (API + dashboard + billing)
