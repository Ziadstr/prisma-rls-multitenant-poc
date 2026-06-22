import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRls(base)

let t1: number
let t2: number

// RESTART IDENTITY makes tenant ids deterministic (1, 2) on every reset.
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
  await base.$disconnect()
})

describe('nested writes (RLS covers what the app-level filter misses)', () => {
  it('allows a valid nested create', async () => {
    const order = await runWithTenant({ tenantId: t1 }, async () =>
      await db.order.create({
        data: { tenantId: t1, title: 'nested', items: { create: [{ tenantId: t1, sku: 'X' }] } },
        include: { items: true },
      }),
    )
    expect(order.items).toHaveLength(1)
  })

  it('BLOCKS a cross-tenant nested write and rolls back fully', async () => {
    // Order is t1, but the nested OrderItem is stamped t2. An app-level WHERE filter
    // does not inject into nested writes, so it would let this through. RLS WITH CHECK
    // on OrderItem rejects it at the database.
    await expect(
      runWithTenant({ tenantId: t1 }, async () =>
        await db.order.create({
          data: { tenantId: t1, title: 'sneaky', items: { create: [{ tenantId: t2, sku: 'EVIL' }] } },
        }),
      ),
    ).rejects.toThrow()
    const cnt = await runWithTenant({ tenantId: t1 }, async () => await db.order.count())
    expect(cnt).toBe(2) // the partial order did not persist
  })
})

describe('concurrency safety under the connection pool', () => {
  it('50 interleaved tenant requests never leak across connections', async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => {
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

describe('multi-write atomicity (the #23583 escape hatch)', () => {
  it('base client + manual SET LOCAL keeps both RLS and atomicity', async () => {
    await base.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`
      await tx.order.create({ data: { tenantId: t1, title: 'atomic-1' } })
      await tx.order.create({ data: { tenantId: t1, title: 'atomic-2' } })
    })
    const cnt = await runWithTenant({ tenantId: t1 }, async () => await db.order.count())
    expect(cnt).toBe(4)
  })

  it('rolls the whole atomic tx back on a cross-tenant violation', async () => {
    await expect(
      base.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`
        await tx.order.create({ data: { tenantId: t1, title: 'ok' } })
        await tx.order.create({ data: { tenantId: t2, title: 'bad' } }) // WITH CHECK fails
      }),
    ).rejects.toThrow()
    const cnt = await runWithTenant({ tenantId: t1 }, async () => await db.order.count())
    expect(cnt).toBe(2) // nothing from the failed tx persisted
  })
})
