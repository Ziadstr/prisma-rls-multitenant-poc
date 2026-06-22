import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withRls } from '../src/rls.js'
import { runWithTenant } from '../src/tenant-context.js'

const OWNER = process.env.DATABASE_URL_OWNER
const SUPER = process.env.DATABASE_URL_SUPER
if (!OWNER || !SUPER) throw new Error('source ../set-env.sh before running tests')

// superuser client: bypasses RLS, used only to seed/reset
const root = makeClient(SUPER)
// app role (owns the tables -> bound by FORCE RLS), wrapped with the tenant extension
const base = makeClient(OWNER)
const db = withRls(base)

let t1: number
let t2: number

beforeAll(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  const acme = await root.tenant.create({ data: { name: 'Acme' } })
  const globex = await root.tenant.create({ data: { name: 'Globex' } })
  t1 = acme.id
  t2 = globex.id
  await root.order.createMany({
    data: [
      { tenantId: t1, title: 'acme-1' },
      { tenantId: t1, title: 'acme-2' },
      { tenantId: t2, title: 'globex-1' },
    ],
  })
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

// NOTE: the callbacks await INSIDE runWithTenant. The Prisma promise is lazy, so the
// extension reads AsyncLocalStorage at execution time. The await must happen within the
// ALS scope, which is exactly how a real request runs inside nestjs-cls (whole handler
// inside cls.run). Returning an un-awaited promise loses the context.
describe('RLS through the Prisma extension', () => {
  it('fails CLOSED when there is no tenant context', async () => {
    await expect(db.order.findMany()).rejects.toThrow(/no tenant context/)
  })

  it('tenant 1 sees only tenant 1 rows', async () => {
    const orders = await runWithTenant({ tenantId: t1 }, async () => await db.order.findMany())
    expect(orders).toHaveLength(2)
    expect(orders.every((o) => o.tenantId === t1)).toBe(true)
  })

  it('tenant 2 sees only tenant 2 rows', async () => {
    const orders = await runWithTenant({ tenantId: t2 }, async () => await db.order.findMany())
    expect(orders).toHaveLength(1)
    expect(orders[0]!.tenantId).toBe(t2)
  })

  it('blocks cross-tenant WRITES via WITH CHECK', async () => {
    // context = tenant 1, but we try to insert a row owned by tenant 2
    await expect(
      runWithTenant({ tenantId: t1 }, async () =>
        await db.order.create({ data: { tenantId: t2, title: 'cross-tenant-write' } }),
      ),
    ).rejects.toThrow()
  })

  it('super-admin bypass sees every tenant', async () => {
    const orders = await runWithTenant({ tenantId: null, bypassRls: true }, async () =>
      await db.order.findMany(),
    )
    expect(orders).toHaveLength(3)
  })

  it('a count() (different operation) is also scoped', async () => {
    const n = await runWithTenant({ tenantId: t2 }, async () => await db.order.count())
    expect(n).toBe(1)
  })
})
