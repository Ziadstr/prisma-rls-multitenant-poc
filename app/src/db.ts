import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.js'

export type BaseClient = PrismaClient

// Prisma 7: the connection lives in the driver adapter passed to the constructor,
// not in schema.prisma. One adapter == one node-postgres pool.
export function makeClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}
