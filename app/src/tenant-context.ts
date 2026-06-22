import { AsyncLocalStorage } from 'node:async_hooks'

// This is the primitive nestjs-cls wraps. Keeping it raw here proves the RLS
// mechanism with zero framework coupling; the NestJS layer swaps this for ClsService.
export interface TenantStore {
  tenantId: number | null
  /** super-admin path: set app.bypass_rls instead of a tenant id */
  bypassRls?: boolean
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>()

export function runWithTenant<T>(store: TenantStore, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run(store, fn)
}

export function getTenantStore(): TenantStore | undefined {
  return tenantStorage.getStore()
}
