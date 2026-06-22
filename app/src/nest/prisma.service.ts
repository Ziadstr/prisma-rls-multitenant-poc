import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import type { TxClient } from '../rls-per-request.js'
import { withTenantWhere } from '../tenant-where.js'
import type { AppClient, TxScopedClient } from '../sensitive-tables.js'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private appClient?: ReturnType<typeof withTenantWhere>

  constructor(private readonly cls: ClsService) {
    super({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL_OWNER!,
        max: Number(process.env.POOL_SIZE ?? 10), // tunable for load tests
      }),
    })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }

  /**
   * Layer 1: app-layer client for NON-sensitive (RLS-free) tables. Works on every route with no
   * transaction. Injects tenantId into WHERE / stamps creates / post-filters findUnique. Reads the
   * tenant from CLS at query time, so a single instance is correct.
   */
  get app(): AppClient {
    return (this.appClient ??= withTenantWhere(this as unknown as PrismaClient, () => {
      const tenantId = this.cls.get<number>('tenantId')
      return tenantId == null ? undefined : { tenantId }
    })) as unknown as AppClient
  }

  /**
   * Layer 2: the per-request transaction client (GUC set, RLS enforced, writes atomic) for
   * SENSITIVE tables. Only valid inside a @TenantTransaction() route; throws otherwise.
   */
  get tx(): TxScopedClient {
    const tx = this.cls.get<TxClient>('tx')
    if (!tx) {
      throw new Error('prisma.tx requires a @TenantTransaction() route (no active tenant transaction)')
    }
    return tx as unknown as TxScopedClient
  }
}
