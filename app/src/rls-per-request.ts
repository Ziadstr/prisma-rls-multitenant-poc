import type { PrismaClient } from './generated/prisma/client.js'

// The transaction-scoped client Prisma hands to a $transaction callback.
export type TxClient = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

/**
 * Per-REQUEST binding (the better one).
 *
 * Open ONE transaction, set the tenant GUC once, run all the request's work on the transaction
 * client. Because everything is one transaction on one connection:
 *   - RLS is enforced (GUC set, FORCE policy applies)
 *   - the dataloader works WITHIN the request (all same-tenant, safe to batch)
 *   - atomic read-modify-write and SELECT FOR UPDATE work naturally (no escape hatch)
 *   - raw SQL ($queryRaw) is scoped, not blocked
 *   - set_config runs once per request, not once per query
 *
 * Cost: holds a pooled connection for the duration of fn. Keep request handlers free of slow
 * non-DB I/O while the transaction is open. In NestJS this is an interceptor that stores `tx`
 * in nestjs-cls; services read it from CLS.
 */
export function runInTenantTx<T>(
  base: PrismaClient,
  tenantId: number,
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  return base.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`
      return fn(tx)
    },
    { timeout: 15000 },
  )
}
