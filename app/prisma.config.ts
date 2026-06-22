import { defineConfig, env } from 'prisma/config'

// Prisma 7 config. DATABASE_URL comes from `source ../set-env.sh`.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
