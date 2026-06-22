import type { PrismaClient } from './generated/prisma/client.js'
import { getTenantStore, type TenantStore } from './tenant-context.js'

// Layer 1: app-layer tenant isolation. Injects tenantId into the WHERE of reads/bulk-writes and
// stamps it on creates. Batch-safe for free (the tenant lives in the query, not the connection),
// zero transaction overhead. This is the primary guard on EVERY table.
//
// Known limits (why RLS backstops the sensitive tables):
//  - update/delete by unique id cannot carry tenantId in `where` (Prisma where is unique-only).
//  - $queryRaw is not intercepted by a query extension at all.
// findUnique is handled by post-filtering the result so it cannot leak.

const WHERE_OPS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
])

// resolveTenant defaults to the standalone AsyncLocalStorage (used by tests). NestJS passes a
// resolver backed by nestjs-cls so the extension reads the same context the framework populates.
export function withTenantWhere(
  base: PrismaClient,
  resolveTenant: () => TenantStore | undefined = getTenantStore,
) {
  return base.$extends({
    name: 'tenant-where',
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          const store = resolveTenant()
          if (store?.bypassRls) return query(args) // super-admin: no filter
          if (!store || store.tenantId == null) {
            throw new Error('tenant-where: no tenant context (fail closed)')
          }
          const tid = store.tenantId
          const a = args as Record<string, unknown>

          if (WHERE_OPS.has(operation)) {
            a.where = { ...((a.where as object) ?? {}), tenantId: tid }
            return query(args)
          }
          if (operation === 'create') {
            a.data = { ...((a.data as object) ?? {}), tenantId: tid }
            return query(args)
          }
          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const d = a.data
            a.data = (Array.isArray(d) ? d : [d]).map((x) => ({ ...(x as object), tenantId: tid }))
            return query(args)
          }
          if (operation === 'upsert') {
            a.create = { ...((a.create as object) ?? {}), tenantId: tid }
            return query(args) // update branch + where rely on RLS for sensitive tables
          }
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            // where is unique-only, so we cannot inject tenantId. Post-filter the result.
            const row = (await query(args)) as { tenantId?: number } | null
            if (row && row.tenantId !== tid) {
              if (operation === 'findUniqueOrThrow') throw new Error('No record found (cross-tenant)')
              return null
            }
            return row
          }
          // update/delete by unique id: app layer cannot scope these; RLS backstops sensitive tables.
          return query(args)
        },
      },
    },
  })
}
