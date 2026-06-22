import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRlsNaive } from '../src/rls-naive.js'
import { runWithTenant } from '../src/tenant-context.js'

// NEGATIVE CONTROL. Same 400-op scenario as dataloader.test.ts, but using the connection-bound
// (no per-query transaction) approach. This is expected to FAIL with many wrong-nulls/leaks,
// which (a) proves the dataloader really batches in this harness and (b) reproduces the colleague's
// finding. If this ever shows 0 bad, the test has lost its teeth and dataloader.test.ts is suspect.

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRlsNaive(base)

let t1: number
let t2: number
let o1: number
let o3: number

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

describe('dataloader NEGATIVE CONTROL: connection-bound binding breaks under same-tick findUnique', () => {
  it('reproduces wrong-nulls/leaks (expected to FAIL isolation)', async () => {
    const ops: Promise<{ label: string; ok: boolean }>[] = []
    for (let i = 0; i < 100; i++) {
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
      ops.push(
        runWithTenant({ tenantId: t1 }, async () => {
          const r = await db.order.findUnique({ where: { id: o3 } })
          return { label: 't1->foreign(leak?)', ok: r === null }
        }),
      )
      ops.push(
        runWithTenant({ tenantId: t2 }, async () => {
          const r = await db.order.findUnique({ where: { id: o1 } })
          return { label: 't2->foreign(leak?)', ok: r === null }
        }),
      )
    }
    const results = await Promise.all(ops)
    const bad = results.filter((r) => !r.ok)
    const counts: Record<string, number> = {}
    for (const b of bad) counts[b.label] = (counts[b.label] ?? 0) + 1
    console.log(`[naive] ${bad.length}/${results.length} BAD (wrong-null or leak):`, counts)
    // The whole point: the connection-bound approach is NOT safe under same-tick findUnique.
    expect(bad.length).toBeGreaterThan(0)
  }, 60000)
})
