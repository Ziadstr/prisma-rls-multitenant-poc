import type { PrismaClient } from './generated/prisma/client.js'
import { getTenantStore, type TenantStore } from './tenant-context.js'

// Layer 1: app-layer tenant isolation. Injects tenantId into the WHERE of reads/bulk-writes,
// stamps it on creates, post-filters findUnique, and ownership-checks by-id writes. Batch-safe
// for free (the tenant lives in the query, not the connection), zero transaction overhead.
//
// The by-id-write guard (update/delete/upsert) closes the cross-tenant write hole: `where` only
// accepts unique fields, so we cannot inject tenantId there. Instead we read the target's tenantId
// first (unscoped) and fail closed if it belongs to another tenant. Costs one extra read per
// by-id write. On RLS tables this is redundant with the DB policy; on non-RLS tables it is the
// only thing standing between tenant A and tenant B's row.

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

// Models with no tenantId column (global registries). The extension leaves these untouched.
const GLOBAL_MODELS = new Set(['Tenant'])

export function withTenantWhere(
  base: PrismaClient,
  resolveTenant: () => TenantStore | undefined = getTenantStore,
) {
  // delegate on the UN-extended base client (no re-entry into this extension)
  const delegateFor = (model: string) =>
    (base as unknown as Record<string, { findUnique: (a: unknown) => Promise<{ tenantId?: number } | null> }>)[
      model.charAt(0).toLowerCase() + model.slice(1)
    ]

  return base.$extends({
    name: 'tenant-where',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (GLOBAL_MODELS.has(model)) return query(args)

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
          if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
            // where is unique-only, so we cannot inject tenantId. Post-filter the result.
            const row = (await query(args)) as { tenantId?: number } | null
            if (row && row.tenantId !== tid) {
              if (operation === 'findUniqueOrThrow') throw new Error('No record found (cross-tenant)')
              return null
            }
            return row
          }
          if (operation === 'update' || operation === 'delete' || operation === 'upsert') {
            if (operation === 'upsert') {
              a.create = { ...((a.create as object) ?? {}), tenantId: tid }
            }
            // ownership pre-check: read the target's tenantId (unscoped) and fail closed if foreign.
            const existing = await delegateFor(model).findUnique({
              where: a.where,
              select: { tenantId: true },
            })
            if (existing && existing.tenantId !== tid) {
              throw new Error(`tenant-where: cross-tenant ${operation} blocked (fail closed)`)
            }
            return query(args)
          }
          return query(args)
        },
      },
    },
  })
}
