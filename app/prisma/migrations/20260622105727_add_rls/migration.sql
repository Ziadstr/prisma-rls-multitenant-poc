-- HAND-WRITTEN MIGRATION. Sanctioned exception per the prisma-migration-safe skill:
-- PostgreSQL Row-Level Security cannot be expressed in schema.prisma, so Prisma
-- generates no DDL for it. This lives in its OWN migration, separate from the
-- generated table DDL (which is never edited). The migrate engine wraps each
-- migration in a single transaction, so all statements below are atomic.

-- 1. Enable RLS on the tenant-scoped tables.
--    FORCE is mandatory. Without it the table OWNER (app_owner, the role Prisma
--    migrates as) bypasses every policy. ENABLE alone only binds NON-owner roles.
ALTER TABLE "Order"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order"     FORCE  ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrderItem" FORCE  ROW LEVEL SECURITY;

-- 2. Tenant isolation policy.
--    NULLIF(current_setting('app.tenant_id', TRUE), '')::int coerces BOTH an unset
--    GUC (NULL) and the post-ROLLBACK empty-string ('') to NULL. tenantId = NULL is
--    never true, so a missing tenant context matches ZERO rows (fail CLOSED) rather
--    than erroring on a bad ::int cast or leaking every row.
CREATE POLICY tenant_isolation ON "Order"
  USING      ("tenantId" = NULLIF(current_setting('app.tenant_id', TRUE), '')::int)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', TRUE), '')::int);

CREATE POLICY tenant_isolation ON "OrderItem"
  USING      ("tenantId" = NULLIF(current_setting('app.tenant_id', TRUE), '')::int)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', TRUE), '')::int);

-- 3. Super-admin escape hatch on a SECOND, independent GUC. Permissive policies are
--    OR-combined, so a row is visible if it matches the tenant OR app.bypass_rls = 'on'.
--    Default (unset) -> NULL = 'on' -> false -> bypass disabled.
CREATE POLICY admin_bypass ON "Order"
  USING      (current_setting('app.bypass_rls', TRUE) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', TRUE) = 'on');

CREATE POLICY admin_bypass ON "OrderItem"
  USING      (current_setting('app.bypass_rls', TRUE) = 'on')
  WITH CHECK (current_setting('app.bypass_rls', TRUE) = 'on');

-- 4. Grant the NON-owner DML role its privileges, so the test suite can prove that
--    ENABLE binds a non-owner even when FORCE is toggled off (the owner-bypass lesson).
GRANT USAGE ON SCHEMA public TO app_restricted;
GRANT SELECT, INSERT, UPDATE, DELETE ON "Tenant", "Order", "OrderItem" TO app_restricted;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_restricted;
