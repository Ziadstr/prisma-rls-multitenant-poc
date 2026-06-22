import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'

// THE BAKE-OFF. Realistic mixed workload: 70% non-sensitive Customer browsing (no RLS),
// 30% touching the RLS-protected Order table. Question: wrap EVERY request in a transaction
// (per-request) or only the requests that touch sensitive tables (surgical)?

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
let TID: number

beforeAll(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Customer","Tenant" RESTART IDENTITY CASCADE')
  TID = (await root.tenant.create({ data: { name: 'Acme' } })).id
  const t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.customer.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ tenantId: TID, name: 'c' + i })) })
  await root.customer.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ tenantId: t2, name: 'g' + i })) })
  await root.order.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ tenantId: TID, title: 'o' + i })) })
  await root.order.createMany({ data: Array.from({ length: 200 }, (_, i) => ({ tenantId: t2, title: 'x' + i })) })
}, 120000)

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

const setGuc = (tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }) =>
  tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(TID)}, true)`

const isOrderReq = (i: number) => i % 10 >= 7 // 30% touch the sensitive table

// every request is one transaction (GUC set once), browse queries included
async function perRequest(i: number) {
  await base.$transaction(async (tx) => {
    await setGuc(tx)
    for (let k = 0; k < 5; k++) await tx.customer.findMany({ where: { tenantId: TID }, take: 10 })
    if (isOrderReq(i)) for (let k = 0; k < 3; k++) await tx.order.findMany({ take: 10 })
  })
}

// browse runs with no transaction; only order-touching requests open one
async function surgical(i: number) {
  for (let k = 0; k < 5; k++) await base.customer.findMany({ where: { tenantId: TID }, take: 10 })
  if (isOrderReq(i)) {
    await base.$transaction(async (tx) => {
      await setGuc(tx)
      for (let k = 0; k < 3; k++) await tx.order.findMany({ take: 10 })
    })
  }
}

// ceiling: pure non-sensitive traffic, no transaction at all (the "no RLS cost" reference)
async function appCeiling() {
  for (let k = 0; k < 5; k++) await base.customer.findMany({ where: { tenantId: TID }, take: 10 })
}

async function bakeoff(label: string, requests: number, concurrency: number, doReq: (i: number) => Promise<void>) {
  const lat: number[] = new Array(requests)
  let next = 0
  let failures = 0
  const start = performance.now()
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      let i
      while ((i = next++) < requests) {
        const t = performance.now()
        try {
          await doReq(i)
        } catch {
          failures++
        }
        lat[i] = performance.now() - t
      }
    }),
  )
  const wall = performance.now() - start
  const s = lat.filter((x) => x != null).sort((a, b) => a - b)
  const pc = (q: number) => s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1)
  console.log(
    `[bakeoff] ${label.padEnd(22)} C=${concurrency}: ${(requests / (wall / 1000)).toFixed(0)} req/s | p50=${pc(0.5)} p95=${pc(0.95)} p99=${pc(0.99)} ms | ${failures} fail`,
  )
}

describe('bake-off: per-request vs surgical (70/30 mixed workload)', () => {
  it('sweeps concurrency 20 and 50', async () => {
    const R = 400
    for (const C of [20, 50]) {
      await bakeoff('app-ceiling (no RLS)', R, C, appCeiling)
      await bakeoff('per-request (always tx)', R, C, perRequest)
      await bakeoff('surgical (tx on demand)', R, C, surgical)
    }
    expect(true).toBe(true)
  }, 300000)
})
