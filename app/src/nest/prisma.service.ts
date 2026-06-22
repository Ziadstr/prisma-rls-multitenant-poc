import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client.js'
import type { TxClient } from '../rls-per-request.js'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly cls: ClsService) {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL_OWNER! }) })
  }

  async onModuleInit(): Promise<void> {
    await this.$connect()
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect()
  }

  /**
   * The per-request transaction client, opened by TenantTxInterceptor with the tenant GUC
   * already set. Services use this for all queries. Isolation is enforced by RLS at the DB;
   * the dataloader, atomic read-modify-write, and scoped raw SQL all work because the whole
   * request is one transaction on one connection. Benchmarked at baseline throughput.
   */
  get client(): TxClient {
    const tx = this.cls.get<TxClient>('tx')
    if (!tx) throw new Error('No per-request transaction in CLS. Is TenantTxInterceptor registered?')
    return tx
  }
}
