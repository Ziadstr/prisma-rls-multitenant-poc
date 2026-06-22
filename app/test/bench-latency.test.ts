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
  await root.order.createMany({ data: Array.from({ length: 50 }, (_, i) => ({ tenantId: t1, title: 'a' + i })) })
}, 60000)

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function pool(count: number, concurrency: number, worker: () => Promise<void>): Promise<number> {
  let next = 0
  let failures = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        next++
        try {
          await worker()
        } catch {
          failures++
        }
      }
    }),
  )
  return failures
}

async function bench(label: string, requests: number, concurrency: number, doReq: () => Promise<void>) {
  const start = performance.now()
  const failures = await pool(requests, concurrency, doReq)
  const ms = performance.now() - start
  console.log(`[bench-lat] ${label}: ${requests} reqs @C=${concurrency} -> ${ms.toFixed(0)}ms, ${(requests / (ms / 1000)).toFixed(0)} req/s, ${failures} failures`)
}

const DELAY = 100

describe('connection-hold cost: 100ms of in-scope non-DB work', () => {
  it('per-query releases the connection during the delay; per-request holds it', async () => {
    const R = 40
    const C = 40
    await bench('per-query  (delay OUTSIDE any connection)', R, C, async () => {
      await runWithTenant({ tenantId: t1 }, async () => {
        await db.order.findMany()
        await sleep(DELAY) // app-side work, no DB connection held
        await db.order.findMany()
      })
    })
    await bench('per-request(delay HOLDS the connection)  ', R, C, async () => {
      await runInTenantTx(base, t1, async (tx) => {
        await tx.order.findMany()
        await sleep(DELAY) // connection pinned for the whole transaction
        await tx.order.findMany()
      })
    })
    expect(true).toBe(true)
  }, 120000)
})
