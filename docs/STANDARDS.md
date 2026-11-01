# Development Standards

## Tooling
- Node 22 LTS, pnpm 9, Turborepo. TypeScript `strict: true`, `noUncheckedIndexedAccess: true` everywhere.
- ESLint (typescript-eslint strict + import order) and Prettier from `packages/config`. Husky + lint-staged run lint/format on commit.
- Commits: Conventional Commits (`feat(rides): atomic offer acceptance`). Branches `feat/…`, `fix/…`, `chore/…`. PRs into `main` need green CI + one review; `main` is always deployable to staging.

## Backend (NestJS)
- One module per bounded context; a module's Prisma tables are touched only by its own services. Other modules call its exported service.
- Controllers are thin: parse (Zod DTO) → call service → map to response DTO. No business logic in controllers or gateways.
- Business rules that ops may change (fares, TTLs, radii, commission, fees, limits) come from `PricingConfiguration` / `PlatformSetting`, never constants.
- Multi-row writes use `prisma.$transaction` with explicit isolation where needed (`Serializable` for ledger posting, row locks via `$queryRaw … FOR UPDATE` for acceptance).
- Side-effects after commit only (outbox/BullMQ). Never emit a socket event or send SMS inside a transaction that can still roll back.
- Money: use `Money` helpers from `contracts`; never `Number()` a kobo value; never compute money in the client.
- Only `LedgerService.post()` writes `LedgerTransaction`/`LedgerEntry` (lint rule `no-restricted-syntax`).
- Every admin write goes through `AuditInterceptor` + explicit `AdminActionLog` for operational actions.
- Logging: pino JSON with `requestId`, `userId`, `rideId`; never log tokens, OTPs, full phone numbers, card data or document numbers (redaction list in logger config).
- Errors: throw `DomainError(code, details)`; the global filter maps codes to HTTP status. No raw `throw new Error` in services.

## Mobile (Expo)
- Expo Router file routes; screens in `app/`, feature logic in `src/features/<feature>/` (hooks, components, api).
- All API calls through `mobile-core` client (auth refresh, idempotency keys, offline queue). No `fetch` in screens.
- Server data via TanStack Query; Zustand only for session/UI state. Socket events update the Query cache.
- Every screen handles four states explicitly: loading (skeleton), empty, error (with retry), success.
- Forms: React Hook Form + the same Zod schema from `contracts`.
- Accessibility: touch targets ≥ 44 pt, `accessibilityLabel` on icon buttons, dynamic type respected, colour contrast AA.
- Strings only via `i18n` (`t('ride.searching')`); no hard-coded copy. English launch catalogue must be complete; other locales fall back to English.
- Permissions requested in context with an explainer screen first (location, notifications, camera for documents).

## Admin (React + Vite)
- shadcn/ui components, Tailwind tokens from `ui-tokens`. TanStack Table for lists with server-side pagination/filters.
- Route-level permission checks mirror server permissions (UX only — the server enforces).
- Destructive or money actions require a confirmation dialog stating the exact effect and amount, plus a reason field.

## Database
- Schema changes only via Prisma migrations; hand-written SQL goes into the migration file, reviewed like code.
- Never edit an applied migration. Expand → migrate data → contract for breaking changes.
- New tables: `createdAt`/`updatedAt` timestamptz, explicit `onDelete`, indexes for every FK used in lists.
- Financial and trip history: `onDelete: Restrict`, no soft delete, no hard delete.

## Testing
| Layer | Tool | Must cover |
|---|---|---|
| Unit | Vitest | state machine (every edge, every actor), fare validation, commission rounding, ledger postings balance, matching ranking/eligibility, idempotency |
| Integration | Vitest + Testcontainers (Postgres+PostGIS, Redis) | each REST endpoint's happy path + main errors; concurrency tests: 20 parallel accepts on one request → exactly one Ride; duplicate webhooks → one ledger txn |
| E2E API | Vitest + socket.io-client | the 20-step journey from the brief, scripted against a running stack |
| Mobile | Jest + RNTL for components; Maestro flows on Android emulator for booking + driver trip | |
| Admin | Vitest + Playwright for verification, refunds, pricing change | |

Coverage gate: 80% lines on `rides`, `fare-negotiation`, `ledger`, `payments`, `commission`, `wallet`; others reported, not gated.

## Definition of done (per feature)
Code + tests merged, CI green, Swagger/contracts updated, loading/empty/error states present, audit/logging in place, verified on staging against sandbox providers, docs touched if behaviour changed.
