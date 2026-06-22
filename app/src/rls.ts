import type { PrismaClient } from './generated/prisma/client.js'
import { getTenantStore } from './tenant-context.js'

/**
 * The RLS extension.
 *
 * Every model query becomes:  BEGIN; set_config(GUC, value, is_local=true); <query>; COMMIT.
 *
 * Why a transaction: an interactive/batch $transaction pins ONE pooled connection for
 * the whole unit, so the set_config and the query are guaranteed to hit the same backend.
 * Why is_local=true: the GUC is reset at COMMIT, so nothing leaks onto the next request
 * that reuses this connection from the pool. This is the single correctness mechanism.
 *
 * Fail-closed: no tenant context -> throw, never run an unscoped query.
 */
export function withRls(base: PrismaClient) {
  return base.$extends({
    name: 'rls',
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const store = getTenantStore()

          // super-admin: flip the bypass GUC for this transaction only
          if (store?.bypassRls) {
            const [, result] = await base.$transaction([
              base.$queryRaw`SELECT set_config('app.bypass_rls', 'on', true)`,
              query(args),
            ])
            return result
          }

          if (!store || store.tenantId == null) {
            throw new Error(
              'RLS: no tenant context. Wrap the call in runWithTenant({ tenantId }), ' +
                'or runWithTenant({ tenantId: null, bypassRls: true }) for super-admin.',
            )
          }

          const tenantId = String(store.tenantId)
          const [, result] = await base.$transaction([
            base.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
            query(args),
          ])
          return result
        },
      },
    },
  })
}
