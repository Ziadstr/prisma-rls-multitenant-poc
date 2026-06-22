import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'
import { runInTenantTx } from '../src/rls-per-request.js'

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRls(base)

let t1: number

beforeAll(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  const t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.order.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ tenantId: t1, title: 'a' + i })) })
  await root.order.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ tenantId: t2, title: 'g' + i })) })
}, 60000)

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

// bounded-concurrency runner: at most `concurrency` requests in flight
async function pool(count: number, concurrency: number, worker: () => Promise<void>): Promise<number> {
  let next = 0
  let failures = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (next < count) {
      next++
      try {
        await worker()
      } catch {
        failures++
      }
    }
  })
  await Promise.all(runners)
  return failures
}

async function bench(label: string, requests: number, concurrency: number, doReq: () => Promise<void>) {
  await pool(20, 5, doReq).catch(() => {}) // warmup
  const start = performance.now()
  const failures = await pool(requests, concurrency, doReq)
  const ms = performance.now() - start
  const rps = (requests / (ms / 1000)).toFixed(0)
  console.log(
    `[bench] ${label}: ${requests} reqs @ C=${concurrency}, ${5} queries/req -> ${ms.toFixed(0)}ms, ${rps} req/s, ${failures} failures`,
  )
  return failures
}

const QPR = 5

describe('binding benchmark (5 queries per request)', () => {
  it('app-level vs per-query vs per-request at C=20 (pool default 10)', async () => {
    const R = 200
    const C = 20
    await bench('app-level (no RLS)  ', R, C, async () => {
      for (let q = 0; q < QPR; q++) await root.order.findMany({ where: { tenantId: t1 } })
    })
    await bench('per-query RLS       ', R, C, async () => {
      await runWithTenant({ tenantId: t1 }, async () => {
        for (let q = 0; q < QPR; q++) await db.order.findMany()
      })
    })
    const f = await bench('per-request RLS     ', R, C, async () => {
      await runInTenantTx(base, t1, async (tx) => {
        for (let q = 0; q < QPR; q++) await tx.order.findMany()
      })
    })
    // surface whether per-request saturates the pool (timeouts) at C > pool size
    console.log(`[bench] per-request failures at C=${C}, pool=10: ${f}`)
    expect(true).toBe(true)
  }, 180000)
})
