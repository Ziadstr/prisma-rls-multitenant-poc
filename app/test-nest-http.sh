#!/usr/bin/env bash
# Reproducible NestJS HTTP e2e for the RLS POC.
# vitest 4 / vite 8 use Oxc, which does not emit the decorator metadata NestJS DI needs,
# so we boot a real server via @swc-node/register and curl it instead.
set -uo pipefail
cd "$(dirname "$0")"
source ../set-env.sh

echo "== seed =="
docker exec rls-poc-pg psql -U postgres -d rls_poc -tAc \
  "TRUNCATE \"OrderItem\",\"Order\",\"Tenant\" RESTART IDENTITY CASCADE; INSERT INTO \"Tenant\"(name) VALUES ('Acme'),('Globex'); INSERT INTO \"Order\"(\"tenantId\",title) VALUES (1,'a1'),(1,'a2'),(2,'g1');" >/dev/null

node --import @swc-node/register/esm-register src/nest/main.ts > nest.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
fail=0

t1=$(curl -s --retry 40 --retry-connrefused --retry-delay 1 -H "x-tenant-id: 1" http://localhost:4099/orders)
if echo "$t1" | grep -q '"tenantId":2' || [ "$(echo "$t1" | grep -o '"id"' | wc -l)" -ne 2 ]; then echo "FAIL t1 isolation: $t1"; fail=1; else echo "PASS t1 sees only its 2 orders"; fi

t2=$(curl -s -H "x-tenant-id: 2" http://localhost:4099/orders)
if echo "$t2" | grep -q '"tenantId":1' || [ "$(echo "$t2" | grep -o '"id"' | wc -l)" -ne 1 ]; then echo "FAIL t2 isolation: $t2"; fail=1; else echo "PASS t2 sees only its 1 order"; fi

code=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:4099/orders)
[ "$code" -ge 400 ] && echo "PASS no-context fails closed ($code)" || { echo "FAIL no-context should 5xx, got $code"; fail=1; }

code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-tenant-id: 1" -H "content-type: application/json" -d '{"title":"x","tenantId":2}' http://localhost:4099/orders)
[ "$code" -ge 400 ] && echo "PASS cross-tenant write blocked ($code)" || { echo "FAIL cross-write should 5xx, got $code"; fail=1; }

code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "x-tenant-id: 1" -H "content-type: application/json" -d '{"title":"legit","tenantId":1}' http://localhost:4099/orders)
[ "$code" -ge 200 ] && [ "$code" -lt 300 ] && echo "PASS legit write allowed ($code)" || { echo "FAIL legit write should 2xx, got $code"; fail=1; }

[ "$fail" -eq 0 ] && echo "ALL NEST HTTP CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit $fail
