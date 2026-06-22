import type { PrismaClient } from './generated/prisma/client.js'

// The single source of truth for which tables are RLS-protected (sensitive). Keep this in sync
// with the add_rls migration; the rls-coverage guard enforces that every sensitive table has a
// FORCE policy and that nothing else carrying tenantId is left unprotected.
export const SENSITIVE_TABLES = ['Order', 'OrderItem'] as const

// Prisma model-delegate keys (camelCase) for the compile-time client split.
export type SensitiveModel = 'order' | 'orderItem'
export type NonSensitiveModel = 'customer' | 'tenant'

// prisma.app exposes ONLY non-sensitive delegates; prisma.tx exposes ONLY sensitive ones.
// Using the wrong client for a table is then a compile error, not a runtime footgun.
export type AppClient = Pick<PrismaClient, NonSensitiveModel>
export type TxScopedClient = Pick<PrismaClient, SensitiveModel>
