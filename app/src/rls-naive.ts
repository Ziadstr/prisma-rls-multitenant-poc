import type { PrismaClient } from './generated/prisma/client.js'
import { getTenantStore } from './tenant-context.js'

/**
 * DELIBERATELY BROKEN. Binds the tenant to the CONNECTION via a session-level set_config with
 * NO per-query transaction, mimicking the "driver adapter sets the GUC on the connection" style.
 *
 * Prisma's dataloader compacts same-tick findUnique() calls across tenants into one batched query
 * on one connection. With the tenant on the connection, the batch sees a single GUC value, so
 * every other tenant in the batch gets a wrong-null (its row filtered out) or a leak. This is the
 * failure a colleague measured (~350/400). Kept only as a negative control for dataloader.test.
 */
export function withRlsNaive(base: PrismaClient) {
  return base.$extends({
    name: 'rls-naive',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const store = getTenantStore()
          if (!store || store.tenantId == null) throw new Error('no tenant context')
          // is_local = false (session scope), and the bare query below is NOT pinned to this
          // connection, so the dataloader is free to batch it elsewhere.
          await base.$executeRawUnsafe(
            `SELECT set_config('app.tenant_id', '${Number(store.tenantId)}', false)`,
          )
          return query(args)
        },
      },
    },
  })
}
