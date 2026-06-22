import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

// seed via a DIRECT superuser connection (55432); run the actual queries THROUGH pgbouncer (56432)
const root = makeClient(process.env.DATABASE_URL_SUPER!)
const basePgb = makeClient(process.env.DATABASE_URL_PGBOUNCER!)
const db = withRls(basePgb)

let t1: number
let t2: number

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.order.createMany({
    data: [
      { tenantId: t1, title: 'a1' },
      { tenantId: t1, title: 'a2' },
      { tenantId: t2, title: 'g1' },
    ],
  })
})

afterAll(async () => {
  await root.$disconnect()
  await basePgb.$disconnect()
})

describe('RLS through pgBouncer (transaction pooling mode)', () => {
  it('isolates a tenant through the pooler', async () => {
    const orders = await runWithTenant({ tenantId: t1 }, async () => await db.order.findMany())
    expect(orders).toHaveLength(2)
    expect(orders.every((o) => o.tenantId === t1)).toBe(true)
  })

  it('100 interleaved tenants over a pool of 5 never leak', async () => {
    const tasks = Array.from({ length: 100 }, (_, i) => {
      const tid = i % 2 === 0 ? t1 : t2
      const expected = i % 2 === 0 ? 2 : 1
      return runWithTenant({ tenantId: tid }, async () => {
        const orders = await db.order.findMany()
        return orders.length === expected && orders.every((o) => o.tenantId === tid)
      })
    })
    const results = await Promise.all(tasks)
    expect(results.every(Boolean)).toBe(true)
  })
})
