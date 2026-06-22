-- Runs once as the postgres superuser on first container init.
-- Three roles, on purpose, to make the FORCE / ownership lesson empirical:
--
--   postgres        superuser  -> bypasses ALL rls (even FORCE). The classic "works in dev" trap.
--   app_owner       owns the schema + tables (Prisma migrates as this role, the common
--                   app-owns-its-tables setup). A table owner bypasses ENABLE-only RLS;
--                   only FORCE ROW LEVEL SECURITY binds the owner.
--   app_restricted  non-owner, DML-only. ENABLE alone already binds it (not the owner),
--                   which is the safer production pattern.
--
-- CREATEDB on app_owner is needed so `prisma migrate dev` can spin its shadow database.

CREATE ROLE app_owner      WITH LOGIN PASSWORD 'app_owner_dev_pw'      CREATEDB;
CREATE ROLE app_restricted WITH LOGIN PASSWORD 'app_restricted_dev_pw';

CREATE DATABASE rls_poc OWNER app_owner;

-- Let the restricted role connect; table-level DML grants come after the tables exist
-- (see db/02-grants.sql, run by the test harness post-migration).
GRANT CONNECT ON DATABASE rls_poc TO app_restricted;
