import { afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'

// Closes the "only Int tested" gap. Many production systems use UUIDv7 tenant ids, so the policy
// cast must be ::uuid (or text equality), not ::int. Proven here on a throwaway uuid-keyed table.

const root = makeClient(process.env.DATABASE_URL_SUPER!)
const base = makeClient(process.env.DATABASE_URL_OWNER!) // owns the table -> FORCE applies

afterAll(async () => {
  await base.$executeRawUnsafe('DROP TABLE IF EXISTS uuid_demo').catch(() => {})
  await root.$disconnect()
  await base.$disconnect()
})

describe('UUID tenant ids', () => {
  it('::uuid cast in the policy isolates and fails closed', async () => {
    await base.$executeRawUnsafe('DROP TABLE IF EXISTS uuid_demo')
    await base.$executeRawUnsafe('CREATE TABLE uuid_demo (id serial PRIMARY KEY, tenant_id uuid NOT NULL, label text)')
    await base.$executeRawUnsafe('ALTER TABLE uuid_demo ENABLE ROW LEVEL SECURITY')
    await base.$executeRawUnsafe('ALTER TABLE uuid_demo FORCE ROW LEVEL SECURITY')
    await base.$executeRawUnsafe(
      `CREATE POLICY tt ON uuid_demo USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)`,
    )

    const u1 = '11111111-1111-1111-1111-111111111111'
    const u2 = '22222222-2222-2222-2222-222222222222'
    // seed as superuser (bypasses RLS)
    await root.$executeRawUnsafe(`INSERT INTO uuid_demo (tenant_id, label) VALUES ('${u1}','a'),('${u1}','b'),('${u2}','c')`)

    // scoped to u1 -> sees 2
    const scoped = await base.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${u1}', true)`)
      return tx.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM uuid_demo')
    })
    expect(scoped[0]!.n).toBe(2)

    // no context -> NULLIF('','')::uuid = NULL -> fails closed (0), no cast error
    const noCtx = await base.$queryRawUnsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM uuid_demo')
    expect(noCtx[0]!.n).toBe(0)
  })
})
