import { afterAll, describe, it, expect } from 'vitest'
import { makeClient } from '../src/db.js'

// CI GUARD against the "new table silently ships with no RLS" rot. Any table in `public` that
// carries a tenantId column MUST have ENABLE + FORCE row security and at least one policy.
// Add a new tenant-scoped table without its RLS migration and this fails the build.

const root = makeClient(process.env.DATABASE_URL_SUPER!)

afterAll(async () => {
  await root.$disconnect()
})

describe('RLS coverage guard', () => {
  it('every tenantId-bearing public table is FORCE-RLS protected with a policy', async () => {
    const rows = await root.$queryRawUnsafe<
      { relname: string; enabled: boolean; forced: boolean; policies: number }[]
    >(`
      SELECT c.relname,
             c.relrowsecurity        AS enabled,
             c.relforcerowsecurity   AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='public' AND p.tablename = c.relname) AS policies
      FROM pg_class c
      WHERE c.relkind = 'r'
        AND c.relnamespace = 'public'::regnamespace
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
        )
    `)

    const unprotected = rows.filter((r) => !(r.enabled && r.forced && r.policies > 0))
    if (unprotected.length) console.log('[coverage] UNPROTECTED tenant tables:', unprotected)
    expect(rows.length).toBeGreaterThan(0) // sanity: we actually found tenant tables
    expect(unprotected).toHaveLength(0)
  })
})
