# Prisma RLS Multi-Tenant POC (PostgreSQL + NestJS)

A rigorously tested reference for **PostgreSQL Row-Level Security as a tenant-isolation backstop**, on the latest stable **Prisma 7 + NestJS 11**. Two layers, a *surgical* binding that runs near the no-RLS performance ceiling, DB-enforced isolation where it matters, and a type-safe API so misuse is a compile error. 39 tests including negative controls, benchmarks, and a real HTTP load test.

Audience: backend engineers deciding how to enforce tenant isolation in a shared-database multi-tenant SaaS. Date: 2026-06-22.

## The design in one picture

```
Request -> CLS sets tenantId (from the verified JWT claim)
        -> TenantTxInterceptor:
             - normal route          -> prisma.app   (Layer 1, app-layer WHERE-injection, NO transaction)   ~3500 req/s
             - @TenantTransaction()  -> prisma.tx    (one tx, SET LOCAL app.tenant_id, RLS + atomic)         ~2000 req/s
Postgres: FORCE RLS on sensitive tables, app-layer WHERE on the rest, coverage guard in CI
```

**Two layers:**

1. **Layer 1 (every table, automatic, zero transaction): app-layer WHERE-injection.** A Prisma `$extends` client injects `tenantId` into reads, stamps it on creates, and post-filters `findUnique`. Batch-safe for free because the tenant lives in the query, not the connection.
2. **Layer 2 (sensitive tables only, DB-enforced): PostgreSQL RLS with FORCE.** Bound **surgically**: only routes marked `@TenantTransaction()` open a transaction and set the tenant GUC, so RLS enforces isolation and writes are atomic. The 70%+ of traffic that never touches a sensitive table pays nothing.

The headline result: **surgical binding runs at ~96% of the no-RLS ceiling**, while wrapping every request in a transaction (the obvious approach) taxes all traffic for no reason. See the bake-off below.

## Stack (all latest stable, verified by build)

| Component | Version |
|-----------|---------|
| Prisma (client + CLI + `@prisma/adapter-pg`) | 7.8.0 |
| NestJS | 11.1.27 |
| nestjs-cls | 6.2.1 |
| PostgreSQL | 16 (Docker) |
| Node | 24.13 |
| pgBouncer | latest (transaction mode) |

## Quickstart

```bash
# 1. infra: Postgres + pgBouncer, with app_owner / app_restricted / postgres roles
docker compose up -d --wait postgres
docker compose up -d pgbouncer

cd app
source ../set-env.sh        # exports DATABASE_URL_* (standard .env names are bind-locked in the dev sandbox)
pnpm install
pnpm prisma generate

# 2. migrations: init (generated DDL) + add_rls (hand-written policies) + add_customer
pnpm prisma migrate dev

# 3. correctness + benchmarks (39 tests)
pnpm test

# 4. NestJS HTTP e2e (both paths: app-layer + @TenantTransaction)
pnpm nest:e2e

# 5. HTTP load test (sweep concurrency past the pool)
POOL_SIZE=10 bash load-test.sh
```

## The evidence

### Bake-off: surgical wins (realistic 70/30 mixed workload, `test/bakeoff.test.ts`)

| Binding | C=20 | C=50 |
|---------|------|------|
| App-layer only (no RLS, the ceiling) | 1883 req/s | 2989 req/s |
| Per-request (transaction on every request) | 1217 req/s | 1617 req/s |
| **Surgical (transaction only on sensitive routes)** | **1813 req/s** | **2161 req/s** |

Surgical is ~50% faster than per-request and within ~4% of the no-RLS ceiling, because the majority of requests skip the transaction entirely.

### HTTP load test (`load-test.sh`, matched 50-row payloads, pool=10)

| Path | c=10 | c=50 | c=100 |
|------|------|------|-------|
| App-layer `/customers` | 3086 req/s, p99 7ms | 3706, p99 18ms | 3583, p99 37ms |
| RLS-tx `/orders` | 1881 req/s, p99 9ms | 2035, p99 34ms | 1991, p99 60ms |

Both scale to 10x the pool size with **zero errors and zero timeouts**; throughput is CPU-bound (flat across concurrency) and latency grows gracefully. Short transactions multiplex fine on a small pool.

### Negative controls (the failures, reproduced)

- **FORCE footgun:** with `ENABLE` but not `FORCE`, the table owner reads every tenant's rows, no error (`db/init` + raw proof).
- **Dataloader leak:** connection-bound binding under 400 same-tick cross-tenant `findUnique`s = 204/400 wrong, 107 real leaks (`test/dataloader-naive.test.ts`); the transaction binding = 0/400 (`test/dataloader.test.ts`).
- **Lost updates:** the per-query extension can't do atomic read-modify-write, 30 concurrent increments land on 1 (`test/locking.test.ts`); `SELECT FOR UPDATE` inside a transaction lands on 30.

## Non-negotiable gotchas (each is a proven footgun)

| Rule | If you skip it |
|------|----------------|
| `FORCE ROW LEVEL SECURITY`, not just `ENABLE` | The table owner (the role Prisma migrates as) bypasses the policy. |
| App connects as a NON-superuser role | Superusers and `BYPASSRLS` roles ignore all policies. |
| `set_config(..., true)` (transaction-local), never bare `SET` | Session scope leaks onto the next request on that pooled connection. |
| `NULLIF(current_setting(...), '')::int` (or `::uuid`) | Post-ROLLBACK `SET LOCAL` leaves `''`; a bare cast throws. NULLIF keeps it fail-closed. Both Int and UUID proven. |
| pgBouncer transaction mode | Statement mode splits set_config from the query across backends. |
| Never hold the tx across slow non-DB I/O | A transaction pins a connection; in-handler latency collapses throughput (94 vs 250 req/s). |
| CI coverage guard for new tables | Prisma generates no RLS; a new tenant table can silently ship unprotected. `test/rls-coverage.test.ts` fails the build if it does. |

## Type-safe client split

`prisma.app` exposes only non-sensitive model delegates; `prisma.tx` exposes only sensitive ones. Using the wrong client is a compile error, verified by `tsc` against `src/nest/guardrails.type-test.ts`:

```ts
prisma.app.customer.findMany() // ok
prisma.tx.order.findMany()     // ok
prisma.app.order.findMany()    // compile error: sensitive table not on the app client
prisma.tx.customer.findMany()  // compile error: non-sensitive table not on the tx client
```

The dangerous direction (sensitive table via the app client) also fails closed at runtime: no GUC means RLS returns zero rows, not a leak.

## Migrations: how RLS fits the Prisma workflow

Prisma cannot express RLS in `schema.prisma`. Two migrations:

- `init` / `add_customer` — generated by `prisma migrate dev`, never hand-edited.
- `add_rls` — scaffolded with `prisma migrate dev --create-only`, then the policy SQL is written into it (the sanctioned manual-SQL exception: a separate, atomic migration with a header comment explaining why).

## File map

```
docker-compose.yml          Postgres (55432) + pgBouncer (56432, transaction mode)
db/init/01-roles.sql        app_owner (owns tables), app_restricted (non-owner), superuser
set-env.sh                  DATABASE_URL_* connection strings
app/
  prisma/
    schema.prisma           Tenant + Customer (non-sensitive) + Order + OrderItem (sensitive)
    migrations/             init + add_rls + add_customer
  src/
    db.ts                   Prisma 7 client + pg adapter factory
    tenant-context.ts       AsyncLocalStorage tenant context (what nestjs-cls wraps)
    tenant-where.ts         Layer 1: app-layer WHERE-injection extension
    rls-per-request.ts      surgical binding helper (runInTenantTx)
    rls.ts                  per-query binding extension (alternative)
    rls-naive.ts            connection-bound binding (negative control, deliberately broken)
    sensitive-tables.ts     the sensitive/non-sensitive partition + typed client split
    nest/
      prisma.service.ts     app (Layer 1) + tx (Layer 2) typed getters
      tenant-transaction.decorator.ts   @TenantTransaction()
      tenant-tx.interceptor.ts          surgical interceptor (opens tx only when needed)
      order.controller.ts               sensitive route (prisma.tx)
      customer.controller.ts            non-sensitive route (prisma.app)
      main.ts                           HTTP server for the e2e/load test
  test/                     15 suites: rls, advanced, pgbouncer, perf, dataloader (+ negative
                            control), locking, per-request, bench, bench-latency, uuid,
                            rls-coverage, combined, bakeoff
  test-nest-http.sh         NestJS HTTP e2e (swc-node + curl)
  load-test.sh              autocannon HTTP load test
```

## Caveats

- The NestJS e2e and load test run via `@swc-node/register` + a real server, not vitest. vitest 4 / vite 8 use the Oxc transformer, which does not emit the decorator metadata NestJS DI needs on Node 24.
- Benchmarks are single-box and synthetic; size your pool and load-test against real traffic before trusting at scale.
- The dataloader-safety of the transaction binding rests on "transactions are not batched," true in Prisma 7.8.0 but not a documented contract; re-run `test/dataloader.test.ts` on any Prisma upgrade.
