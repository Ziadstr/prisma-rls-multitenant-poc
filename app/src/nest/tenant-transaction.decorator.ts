import { SetMetadata } from '@nestjs/common'

// Mark a route/controller that touches RLS-protected (sensitive) tables. The TenantTxInterceptor
// opens ONE transaction per request with the tenant GUC set, so RLS is enforced and writes are
// atomic. Routes WITHOUT this decorator run with no transaction (app-layer isolation only),
// which is the fast path for the majority of non-sensitive traffic.
export const TENANT_TX = 'tenant_tx'
export const TenantTransaction = () => SetMetadata(TENANT_TX, true)
