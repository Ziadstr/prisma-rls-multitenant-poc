import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

// #23583 settled empirically: can the RLS approach do an atomic read-modify-write under
// contention? N concurrent increments of one row's counter. Correct locking => final == N.
// Lost updates => final < N.

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withRls(base)

let t1: number
let oid: number
const N = 30

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  oid = (await root.order.create({ data: { tenantId: t1, title: 'counter', amount: 0 } })).id
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

describe('#23583: atomic read-modify-write under RLS', () => {
  it('NAIVE per-query extension LOSES updates (why you cannot use it for atomic RMW)', async () => {
    await Promise.all(
      Array.from({ length: N }, () =>
        runWithTenant({ tenantId: t1 }, async () => {
          const o = await db.order.findUniqueOrThrow({ where: { id: oid } })
          await new Promise((r) => setImmediate(r)) // widen the race window
          await db.order.update({ where: { id: oid }, data: { amount: o.amount + 1 } })
        }),
      ),
    )
    const final = (await root.order.findUniqueOrThrow({ where: { id: oid } })).amount
    console.log(`[locking] naive per-query final = ${final} (lost ${N - final} updates of ${N})`)
    expect(final).toBeLessThan(N)
  })

  it('ESCAPE HATCH (base client + manual set_config + SELECT FOR UPDATE) is CORRECT', async () => {
    await Promise.all(
      Array.from({ length: N }, () =>
        base.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`
          await tx.$queryRaw`SELECT amount FROM "Order" WHERE id = ${oid} FOR UPDATE`
          await tx.$executeRaw`UPDATE "Order" SET amount = amount + 1 WHERE id = ${oid}`
        }),
      ),
    )
    const final = (await root.order.findUniqueOrThrow({ where: { id: oid } })).amount
    console.log(`[locking] escape-hatch final = ${final} (expected ${N})`)
    expect(final).toBe(N)
  })

  it('ESCAPE HATCH still enforces isolation (FOR UPDATE on a foreign row sees nothing)', async () => {
    const t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
    const foreign = (await root.order.create({ data: { tenantId: t2, title: 'g' } })).id
    const locked = await base.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`
      return tx.$queryRaw<{ id: number }[]>`SELECT id FROM "Order" WHERE id = ${foreign} FOR UPDATE`
    })
    expect(locked).toHaveLength(0) // RLS hides the foreign row even from FOR UPDATE
  })
})
