import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRls(base)

let t1: number
let t2: number
let o3: number // belongs to t2

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.order.create({ data: { tenantId: t1, title: 'a1' } })
  await root.order.create({ data: { tenantId: t1, title: 'a2' } })
  o3 = (await root.order.create({ data: { tenantId: t2, title: 'g1' } })).id
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

describe('edge cases: the untested surface', () => {
  it('aggregate() is scoped', async () => {
    const agg = await runWithTenant({ tenantId: t1 }, async () => await db.order.aggregate({ _count: { _all: true } }))
    expect(agg._count._all).toBe(2)
  })

  it('groupBy() is scoped', async () => {
    const g = await runWithTenant({ tenantId: t2 }, async () =>
      await db.order.groupBy({ by: ['tenantId'], _count: { _all: true } }),
    )
    expect(g).toHaveLength(1)
    expect(g[0]!.tenantId).toBe(t2)
  })

  it('findUniqueOrThrow on a foreign id throws (does not leak)', async () => {
    await expect(
      runWithTenant({ tenantId: t1 }, async () => await db.order.findUniqueOrThrow({ where: { id: o3 } })),
    ).rejects.toThrow()
  })

  it('INTERACTIVE $transaction on the extended client: capture behavior (#23583)', async () => {
    let outcome: Record<string, unknown>
    try {
      const r = await runWithTenant({ tenantId: t1 }, async () =>
        await db.$transaction(async (tx) => await tx.order.findMany()),
      )
      outcome = { ok: true, len: r.length, tenants: [...new Set(r.map((o) => o.tenantId))] }
    } catch (e) {
      outcome = { ok: false, err: String(e).slice(0, 160) }
    }
    console.log('[edge] interactive $transaction on EXTENDED client:', JSON.stringify(outcome))
    // The only thing we MUST guarantee: it never leaks another tenant's rows.
    if (outcome.ok) expect(outcome.tenants).toEqual([t1])
  })

  it('$queryRaw through the extended client: does it get the tenant GUC?', async () => {
    let outcome: Record<string, unknown>
    try {
      const r = await runWithTenant({ tenantId: t1 }, async () =>
        await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM "Order"`,
      )
      outcome = { ok: true, count: r[0]?.n }
    } catch (e) {
      outcome = { ok: false, err: String(e).slice(0, 160) }
    }
    console.log('[edge] $queryRaw through extended client (expect 2 if scoped, 0 if it bypasses the GUC):', JSON.stringify(outcome))
    // documents behavior; raw queries are NOT intercepted by a query extension.
  })
})
