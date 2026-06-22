import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

// Reproduces the failure mode a colleague found with the ADAPTER-binds-connection approach:
// Prisma's dataloader compacts same-tick findUnique() calls into ONE batched query on ONE
// connection. If the tenant lives on the connection (GUC set by adapter, no per-query txn),
// a cross-tenant batch collapses onto one GUC -> wrong-nulls / leaks (~350/400 reported).
//
// This POC binds the tenant via a per-query $transaction in the extension instead. Separate
// transactions use separate connections, so the dataloader cannot merge across tenants. This
// test asserts that claim against the exact scenario.

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRls(base)

let t1: number
let t2: number
let o1: number // t1
let o3: number // t2

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  o1 = (await root.order.create({ data: { tenantId: t1, title: 'a1' } })).id
  await root.order.create({ data: { tenantId: t1, title: 'a2' } })
  o3 = (await root.order.create({ data: { tenantId: t2, title: 'g1' } })).id
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

describe('dataloader: same-tick cross-tenant findUnique', () => {
  it('400 interleaved findUnique calls in one tick, zero leaks and zero wrong-nulls', async () => {
    const ops: Promise<{ label: string; ok: boolean }>[] = []
    for (let i = 0; i < 100; i++) {
      // own lookups MUST return the row (no wrong-null)
      ops.push(
        runWithTenant({ tenantId: t1 }, async () => {
          const r = await db.order.findUnique({ where: { id: o1 } })
          return { label: 't1->own', ok: r?.id === o1 }
        }),
      )
      ops.push(
        runWithTenant({ tenantId: t2 }, async () => {
          const r = await db.order.findUnique({ where: { id: o3 } })
          return { label: 't2->own', ok: r?.id === o3 }
        }),
      )
      // foreign lookups MUST return null (no leak)
      ops.push(
        runWithTenant({ tenantId: t1 }, async () => {
          const r = await db.order.findUnique({ where: { id: o3 } })
          return { label: 't1->foreign', ok: r === null }
        }),
      )
      ops.push(
        runWithTenant({ tenantId: t2 }, async () => {
          const r = await db.order.findUnique({ where: { id: o1 } })
          return { label: 't2->foreign', ok: r === null }
        }),
      )
    }
    const results = await Promise.all(ops)
    const bad = results.filter((r) => !r.ok)
    if (bad.length) {
      const counts: Record<string, number> = {}
      for (const b of bad) counts[b.label] = (counts[b.label] ?? 0) + 1
      console.log(`[dataloader] ${bad.length}/${results.length} BAD:`, counts)
    }
    expect(bad).toHaveLength(0)
  }, 60000)
})
