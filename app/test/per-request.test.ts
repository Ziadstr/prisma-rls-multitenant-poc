import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { runInTenantTx } from '../src/rls-per-request.js'

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)

let t1: number
let t2: number
let counter: number // t1 row used for RMW

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  counter = (await root.order.create({ data: { tenantId: t1, title: 'counter', amount: 0 } })).id
  await root.order.create({ data: { tenantId: t1, title: 'a2' } })
  await root.order.create({ data: { tenantId: t2, title: 'g1' } })
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

describe('per-request transaction binding', () => {
  it('isolates each tenant', async () => {
    const a = await runInTenantTx(base, t1, async (tx) => await tx.order.findMany())
    const b = await runInTenantTx(base, t2, async (tx) => await tx.order.findMany())
    expect(a).toHaveLength(2)
    expect(a.every((o) => o.tenantId === t1)).toBe(true)
    expect(b).toHaveLength(1)
  })

  it('50 interleaved requests never leak', async () => {
    const tasks = Array.from({ length: 50 }, (_, i) => {
      const tid = i % 2 === 0 ? t1 : t2
      const expected = i % 2 === 0 ? 2 : 1
      return runInTenantTx(base, tid, async (tx) => {
        const o = await tx.order.findMany()
        return o.length === expected && o.every((x) => x.tenantId === tid)
      })
    })
    expect((await Promise.all(tasks)).every(Boolean)).toBe(true)
  })

  it('$queryRaw IS scoped here (fixes the per-query footgun: 2, not 0)', async () => {
    const r = await runInTenantTx(
      base,
      t1,
      async (tx) => await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Order"`,
    )
    expect(r[0]!.n).toBe(2)
  })

  it('atomic read-modify-write works naturally (no escape hatch needed)', async () => {
    const N = 30
    await Promise.all(
      Array.from({ length: N }, () =>
        runInTenantTx(base, t1, async (tx) => {
          await tx.$queryRaw`SELECT amount FROM "Order" WHERE id = ${counter} FOR UPDATE`
          await tx.$executeRaw`UPDATE "Order" SET amount = amount + 1 WHERE id = ${counter}`
        }),
      ),
    )
    const final = (await root.order.findUniqueOrThrow({ where: { id: counter } })).amount
    expect(final).toBe(N)
  })

  it('cross-tenant write still blocked by WITH CHECK', async () => {
    await expect(
      runInTenantTx(base, t1, async (tx) => await tx.order.create({ data: { tenantId: t2, title: 'x' } })),
    ).rejects.toThrow()
  })
})
