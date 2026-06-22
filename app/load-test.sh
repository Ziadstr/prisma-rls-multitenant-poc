#!/usr/bin/env bash
# Real HTTP load test against the running Nest server. Compares the app-layer fast path
# (/customers, no transaction) vs the RLS transaction path (/orders, @TenantTransaction),
# swept past the connection-pool size to observe saturation. Set POOL_SIZE to vary the pool.
set -uo pipefail
cd "$(dirname "$0")"
source /home/ziadstr/work/cargenie/rls-poc/set-env.sh

docker exec rls-poc-pg psql -U postgres -d rls_poc -tAc \
  "TRUNCATE \"OrderItem\",\"Order\",\"Customer\",\"Tenant\" RESTART IDENTITY CASCADE; \
   INSERT INTO \"Tenant\"(name) VALUES ('Acme'); \
   INSERT INTO \"Customer\"(\"tenantId\",name) SELECT 1,'c'||g FROM generate_series(1,500) g; \
   INSERT INTO \"Order\"(\"tenantId\",title) SELECT 1,'o'||g FROM generate_series(1,200) g;" >/dev/null

POOL=${POOL_SIZE:-10}
POOL_SIZE=$POOL node --import @swc-node/register/esm-register src/nest/main.ts > load.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
curl -s --retry 40 --retry-connrefused --retry-delay 1 -H "x-tenant-id: 1" http://localhost:4099/customers > /dev/null

echo "================ POOL_SIZE=$POOL ================"
bench() { # endpoint conns
  node_modules/.bin/autocannon -c "$2" -d 6 -H "x-tenant-id: 1" "http://localhost:4099/$1" 2>&1 \
    | grep -E "Req/Sec|Latency|requests in|2xx|non-2xx|timeout" | sed 's/^/    /'
}
for C in 10 50 100; do
  echo ">>> /customers  app-layer fast path   c=$C"
  bench customers "$C"
  echo ">>> /orders     RLS transaction path  c=$C"
  bench orders "$C"
done
