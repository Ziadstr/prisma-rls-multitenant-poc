import { beforeEach, afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'
import { withTenantWhere } from '../src/tenant-where.js'
import { runWithTenant } from '../src/tenant-context.js'

// The cross-tenant write hole on a NON-RLS table (Customer). update/delete/upsert by unique id
// cannot carry tenantId in `where`, so without a guard they hit another tenant's row and FAIL OPEN.
// These tests assert the SECURE behavior (must throw, must not mutate the foreign row).

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!)
const db = withTenantWhere(base)

let t1: number
let t2: number
let foreignId: number // a Customer owned by t2

beforeEach(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Customer","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.customer.create({ data: { tenantId: t1, name: 'acme-cust' } })
  foreignId = (await root.customer.create({ data: { tenantId: t2, name: 'globex-secret' } })).id
})

afterAll(async () => {
  await root.$disconnect()
  await base.$disconnect()
})

describe('Layer 1 cross-tenant write hole (non-RLS table)', () => {
  it('blocks cross-tenant UPDATE by id and leaves the foreign row untouched', async () => {
    await expect(
      runWithTenant({ tenantId: t1 }, async () =>
        await db.customer.update({ where: { id: foreignId }, data: { name: 'HACKED' } }),
      ),
    ).rejects.toThrow()
    const row = await root.customer.findUnique({ where: { id: foreignId } })
    expect(row?.name).toBe('globex-secret')
  })

  it('blocks cross-tenant DELETE by id', async () => {
    await expect(
      runWithTenant({ tenantId: t1 }, async () => await db.customer.delete({ where: { id: foreignId } })),
    ).rejects.toThrow()
    const row = await root.customer.findUnique({ where: { id: foreignId } })
    expect(row).not.toBeNull()
  })

  it('blocks cross-tenant UPSERT by id (update branch on a foreign row)', async () => {
    await expect(
      runWithTenant({ tenantId: t1 }, async () =>
        await db.customer.upsert({
          where: { id: foreignId },
          create: { name: 'x' } as never,
          update: { name: 'HACKED' },
        }),
      ),
    ).rejects.toThrow()
    const row = await root.customer.findUnique({ where: { id: foreignId } })
    expect(row?.name).toBe('globex-secret')
  })
})
