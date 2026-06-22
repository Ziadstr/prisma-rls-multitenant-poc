# RLS POC: PostgreSQL Row-Level Security with Prisma 7 + NestJS

**Verdict: it works, it is solid, and it is the right call for a shared-DB multi-tenant SaaS.** Every isolation property is proven empirically below, including the failure modes. The one hard requirement people miss (`FORCE ROW LEVEL SECURITY`) is demonstrated as a real, silent data leak when omitted.

Audience: backend engineers deciding how to enforce tenant isolation. Date: 2026-06-22.

**Recommended binding: per-request** (one transaction per request, GUC set once), not per-query. Measured at baseline throughput (474 vs 475 req/s no-RLS), and it fixes atomic read-modify-write, scoped `$queryRaw`, and the dataloader. The helper is `app/src/rls-per-request.ts` and the NestJS wiring is `app/src/nest/tenant-tx.interceptor.ts`. Per-query binding (`app/src/rls.ts`) works but is strictly worse (270 req/s, loses updates on RMW, `$queryRaw` returns 0).

## Stack (all latest stable, verified by build)

| Component | Version |
|-----------|---------|
| Prisma (client + CLI + `@prisma/adapter-pg`) | 7.8.0 |
| NestJS | 11.1.27 |
| nestjs-cls | 6.2.1 |
| PostgreSQL | 16 (Docker) |
| Node | 24.13 |
| pgBouncer | latest (transaction mode) |

## The one idea everything hangs on

RLS policies read a Postgres session variable (`current_setting('app.tenant_id')`). Prisma pools connections, so you must set that variable in a way that is pinned to the exact connection running the query and torn down after. The mechanism:

> Open a transaction (pins one pooled connection) → `set_config('app.tenant_id', <id>, true)` where `true` = transaction-local (auto-reset on commit) → run the query on that connection.

A Prisma `$extends` query extension does this automatically for every query. The tenant id comes from `nestjs-cls` (AsyncLocalStorage). See `app/src/rls.ts` (standalone) and `app/src/nest/prisma.service.ts` (NestJS).

## How to run

```bash
# 1. infra (Postgres + pgBouncer, with app_owner / app_restricted / postgres roles)
docker compose up -d --wait postgres
docker compose up -d pgbouncer

cd app
source ../set-env.sh                 # exports DATABASE_URL_* (the standard .env names are bind-locked here)
pnpm install
pnpm prisma generate

# 2. migrations: init (generated DDL) + add_rls (hand-written policy DDL)
pnpm prisma migrate dev

# 3. the suite (33 tests: isolation, FORCE, fail-closed, bypass, nested, concurrency,
#    pgBouncer, dataloader + negative control, locking, per-request binding, UUID, benchmarks, coverage)
pnpm test

# 4. NestJS HTTP e2e (real request -> CLS -> extension -> RLS)
pnpm nest:e2e
```

## What is proven (and where)

| Property | Test | Result |
|----------|------|--------|
| Tenant sees only its rows | `test/rls.test.ts` | pass |
| Fails CLOSED with no context (0 rows, not all) | `test/rls.test.ts` | pass |
| Cross-tenant WRITE blocked (`WITH CHECK`) | `test/rls.test.ts` | pass |
| Super-admin bypass via 2nd GUC | `test/rls.test.ts` | pass |
| RLS covers NESTED writes the app-filter misses | `test/advanced.test.ts` | pass |
| 50 interleaved tenants, no leak (Prisma pool) | `test/advanced.test.ts` | pass |
| Multi-write atomicity escape hatch (#23583) | `test/advanced.test.ts` | pass |
| 100 interleaved tenants through pgBouncer (pool=5) | `test/pgbouncer.test.ts` | pass |
| RLS overhead vs app-level filter | `test/perf.test.ts` | +1.12 ms/query (1.5x) |
| Full HTTP path in NestJS | `test-nest-http.sh` | pass |

Raw-SQL proof of the role/ownership matrix (run during build) showed: owner with no context = 0 rows, owner with `NO FORCE` = **all 3 tenants leaked**, owner with `FORCE` restored = 0, superuser = always bypasses.

## Binding choice: per-request wins (measured)

Both bindings enforce isolation; the difference is cost and ergonomics. Measured at 200 requests x 5 queries, concurrency 20, pool 10:

| Binding | Throughput | Atomic RMW | `$queryRaw` scoped | Dataloader |
|---------|-----------|-----------|--------------------|------------|
| App-level only (no RLS) | 475 req/s | n/a | yes | yes |
| Per-query RLS | 270 req/s | no (loses updates) | no (returns 0) | disabled |
| **Per-request RLS (recommended)** | **474 req/s** | **yes** | **yes** | **yes** |

Per-request binds the tenant GUC once inside a single per-request transaction, so it runs at baseline throughput and atomic read-modify-write, scoped raw SQL, and the dataloader all work for free. Its only cost: it holds a pooled connection for the request, so size the pool to peak concurrency and do no slow non-DB I/O inside the transaction (with 100ms of in-scope work, per-request drops to 94 req/s while per-query stays at 250). The dataloader hazard that breaks connection-bound RLS (same-tick cross-tenant `findUnique` batching) is reproduced as a negative control in `test/dataloader-naive.test.ts`: 204/400 wrong connection-bound, 0/400 with the transaction binding.

## Non-negotiable gotchas (each is a real footgun)

1. **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** The table owner (the role Prisma migrates as) bypasses `ENABLE`-only RLS. Without `FORCE` the policies look active and enforce nothing on the app's own connection. Proven: flip `FORCE` off and the owner reads every tenant's rows, no error.
2. **Connect as a non-superuser.** Superusers (and `BYPASSRLS` roles) ignore all policies. "Works in dev as postgres" means nothing.
3. **`set_config(..., true)` (transaction-local), never bare `SET`.** Session scope leaks onto the next request that reuses the connection from the pool.
4. **pgBouncer must be transaction mode** (statement mode splits `set_config` and the query across backends). Transaction mode proven safe here.
5. **`NULLIF(current_setting('app.tenant_id', true), '')::int`** in the policy. After a ROLLBACK, `SET LOCAL` leaves `''`, and `''::int` throws; `NULLIF` coerces both unset and empty to NULL, keeping fail-closed.
6. **Multi-write atomicity:** do NOT run an interactive `$transaction` on the per-query RLS-extended client (Prisma #23583 nests transactions and breaks row locks; proven, a concurrent increment loses 29 of 30 updates). The per-request binding avoids this entirely, everything is already one transaction. See `test/locking.test.ts` and `test/per-request.test.ts`.

## Migrations: how RLS fits the Prisma workflow

Prisma cannot express RLS in `schema.prisma`. The workflow is two migrations:

- `migrations/<ts>_init/` — generated by `prisma migrate dev`, table DDL, never hand-edited.
- `migrations/<ts>_add_rls/` — scaffolded with `prisma migrate dev --create-only`, then the policy SQL is written into it (a sanctioned manual-SQL exception: separate migration, atomic, with a header comment explaining why). Applied with `prisma migrate dev`.

## Known caveat

The NestJS e2e runs via `@swc-node/register` + a real HTTP server (`test-nest-http.sh`), not vitest. vitest 4 / vite 8 switched to the Oxc transformer, which does not emit the decorator metadata NestJS DI needs on Node 24, so `NestFactory` crashes under vitest. `test/nest.e2e.ts` + `vitest.nest.config.ts` are kept as reference for when unplugin-swc supports Oxc.

## File map

```
docker-compose.yml          Postgres (55432) + pgBouncer (56432, txn mode)
db/init/01-roles.sql         app_owner (owns tables), app_restricted (non-owner), superuser
set-env.sh                   DATABASE_URL_* connection strings
app/
  prisma/schema.prisma       Tenant (global), Order + OrderItem (tenant-scoped)
  prisma/migrations/         init + add_rls (RLS policies)
  src/db.ts                  Prisma 7 client + pg adapter factory
  src/tenant-context.ts      AsyncLocalStorage tenant context
  src/rls-per-request.ts     per-request binding (recommended)
  src/rls.ts                 per-query binding extension
  src/rls-naive.ts           connection-bound binding (negative control, deliberately broken)
  src/nest/                  PrismaService + ClsModule + per-request interceptor + controller
  test/                      13 suites (see "How to run")
  test-nest-http.sh          NestJS HTTP e2e (swc-node + curl)
```
