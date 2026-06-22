import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withTenantWhere } from '../src/tenant-where.js'
import { runWithTenant } from '../src/tenant-context.js'

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const appDb = withTenantWhere(base) // Layer-1 app-layer client

let t1: number
let t2: number
let foreignCustomer: number

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Customer","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.customer.createMany({ data: [{ tenantId: t1, name: 'a1' }, { tenantId: t1, name: 'a2' }] })
  foreignCustomer = (await root.customer.create({ data: { tenantId: t2, name: 'g1' } })).id
  await root.order.createMany({ data: [{ tenantId: t1, title: 'o1' }, { tenantId: t2, title: 'o2' }] })
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

describe('combined layering (app-layer Customer + RLS Order)', () => {
  it('app-layer isolates non-RLS Customer by tenant', async () => {
    const c = await runWithTenant({ tenantId: t1 }, async () => await appDb.customer.findMany())
    expect(c).toHaveLength(2)
    expect(c.every((x) => x.tenantId === t1)).toBe(true)
  })

  it('app-layer findUnique post-filter blocks a cross-tenant Customer read', async () => {
    const r = await runWithTenant({ tenantId: t1 }, async () => await appDb.customer.findUnique({ where: { id: foreignCustomer } }))
    expect(r).toBeNull()
  })

  it('app-layer create stamps tenantId automatically', async () => {
    const created = await runWithTenant({ tenantId: t1 }, async () => await appDb.customer.create({ data: { name: 'new' } as never }))
    expect(created.tenantId).toBe(t1)
  })

  it('surgical: Customer via app-layer (no tx) + Order via RLS tx, both isolated', async () => {
    const result = await runWithTenant({ tenantId: t1 }, async () => {
      const customers = await appDb.customer.findMany()
      const orders = await base.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`
        return tx.order.findMany()
      })
      return { customers, orders }
    })
    expect(result.customers.every((c) => c.tenantId === t1)).toBe(true)
    expect(result.orders.every((o) => o.tenantId === t1)).toBe(true)
    expect(result.orders).toHaveLength(1)
  })

  it('probe: does $extends work on a $transaction client?', async () => {
    const supported = await base.$transaction(async (tx) => {
      try {
        const ext = (tx as { $extends?: (x: unknown) => unknown }).$extends
        return typeof ext === 'function'
      } catch {
        return false
      }
    })
    console.log('[combined] tx client supports $extends:', supported)
    expect(typeof supported).toBe('boolean')
  })
})
