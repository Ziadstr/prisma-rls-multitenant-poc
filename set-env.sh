# Source this before prisma/test commands: `source set-env.sh`
# The standard .env names are bind-locked placeholders in this sandbox, hence a script.

# app_owner OWNS the tables (mirrors the real footgun: owner bypasses ENABLE-only RLS)
export DATABASE_URL_OWNER="postgresql://app_owner:app_owner_dev_pw@localhost:55432/rls_poc"
# app_restricted is a non-owner DML role (ENABLE alone binds it)
export DATABASE_URL_RESTRICTED="postgresql://app_restricted:app_restricted_dev_pw@localhost:55432/rls_poc"
# superuser bypasses ALL rls, even FORCE
export DATABASE_URL_SUPER="postgresql://postgres:postgres@localhost:55432/rls_poc"
# same app_owner creds but THROUGH pgbouncer (transaction mode) to prove pooled SET LOCAL is safe
export DATABASE_URL_PGBOUNCER="postgresql://app_owner:app_owner_dev_pw@localhost:56432/rls_poc"

# Prisma CLI + app default
export DATABASE_URL="$DATABASE_URL_OWNER"

# Prisma 7 refuses destructive ops under Claude Code without this consent var
export PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION="1"
