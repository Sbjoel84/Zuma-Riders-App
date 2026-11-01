# Ride-hailing platform (working name: `zuma`)

inDrive-style, fare-negotiation ride-hailing for Nigeria, launching in Abuja.
Passenger app · Driver app · Admin dashboard · NestJS API — one backend, one PostgreSQL database.

## Phase 1 status — Architecture & planning

| Deliverable | Where | State |
|---|---|---|
| Architecture document | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Draft for review |
| Decision records | [docs/DECISIONS.md](docs/DECISIONS.md) | 13 ADRs |
| API contracts (REST + WebSocket) | [docs/API_CONTRACTS.md](docs/API_CONTRACTS.md) | Draft for review |
| Development standards | [docs/STANDARDS.md](docs/STANDARDS.md) | Draft for review |
| Prisma schema | [packages/database/prisma/schema.prisma](packages/database/prisma/schema.prisma) | 72 models, 45 enums; validates against Prisma 7.10 engine |
| DB integrity SQL | [packages/database/prisma/sql/001_integrity.sql](packages/database/prisma/sql/001_integrity.sql) | Written; **not yet executed** against a live Postgres — first run is Phase 2 step 2 |
| ER diagram | published separately (domain-split diagrams generated from the schema) | Done |
| Directory structure | ARCHITECTURE §2 | Defined; scaffold in Phase 2 |

## Decisions needed from the project owner

1. **Brand name and domain** — needed for bundle IDs (`com.<brand>.passenger`/`.driver`), store listings and API/admin domains. `zuma` is a placeholder.
2. **Commission rate(s)** at launch, per category, and whether cash trips carry the same rate.
3. **Driver negative-balance limit** for unpaid cash commission before they're blocked from going online.
4. **Motorcycle and tricycle categories in Abuja** — FCT has restricted commercial motorcycles/tricycles in parts of the city. Needs a legal check before enabling; the schema supports per-city, per-area category restrictions either way.
5. **SMS/OTP provider** (proposal: Termii) and **masked calling** provider, or chat-only contact at launch.
6. **Hosting** for API/realtime/worker (proposal: Railway or Fly.io) and Redis (Redis Cloud — needs keyspace notifications, so not a purely serverless Redis).
7. **Payout timing** — how long earnings sit in *pending* before withdrawable (proposal: 24 h), minimum withdrawal, who pays transfer fees.
8. **Wallet withdrawals for passengers** — allowed or refund-only? (Affects licensing posture: holding customer funds may raise CBN considerations; worth a legal opinion.)
9. **Data retention periods** in ARCHITECTURE §7 — need NDPA/legal sign-off; appoint a DPO contact.
10. **Emergency numbers & SOS procedure** per city, and whether an ops team will staff the safety queue 24/7 at launch.

## Accounts/credentials to provision (Phase 2–6)

Neon (with PostGIS), Redis Cloud, hosting provider, Vercel, object storage (S3/R2), Google Maps Platform (Places, Routes, Geocoding, Maps SDK — billing enabled), Paystack + Flutterwave (test then live, business verification), SMS provider, Expo/EAS, Apple Developer Program, Google Play Console, Sentry, GitHub org/repo.
