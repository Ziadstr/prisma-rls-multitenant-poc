import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRls(base)
let t1: number

beforeAll(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  const t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  // 1000 rows per tenant so RLS actually filters a meaningful set
  await root.order.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ tenantId: t1, title: 'a' + i })) })
  await root.order.createMany({ data: Array.from({ length: 1000 }, (_, i) => ({ tenantId: t2, title: 'g' + i })) })
}, 60000)

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

async function timeit(label: string, n: number, fn: () => Promise<unknown>): Promise<number> {
  for (let i = 0; i < 10; i++) await fn() // warmup
  const start = performance.now()
  for (let i = 0; i < n; i++) await fn()
  const avg = (performance.now() - start) / n
  console.log(`[perf] ${label}: avg ${avg.toFixed(2)} ms/query over ${n}`)
  return avg
}

describe('performance: RLS transaction-wrapping overhead', () => {
  it('app-level WHERE vs RLS extension (single-connection, serial)', async () => {
    const N = 300
    const baseAvg = await timeit('app-level WHERE filter (no RLS, no txn wrap)', N, () =>
      root.order.findMany({ where: { tenantId: t1 } }),
    )
    const rlsAvg = await timeit('RLS extension (BEGIN+set_config+SELECT+COMMIT)', N, () =>
      runWithTenant({ tenantId: t1 }, async () => await db.order.findMany()),
    )
    console.log(
      `[perf] RLS overhead: +${(rlsAvg - baseAvg).toFixed(2)} ms/query (${(rlsAvg / baseAvg).toFixed(1)}x the baseline)`,
    )
    expect(baseAvg).toBeGreaterThan(0)
    expect(rlsAvg).toBeGreaterThan(0)
  }, 60000)
})
