import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ForbiddenException,
} from '@nestjs/common'
import { ClsService } from 'nestjs-cls'
import { Observable, from, lastValueFrom } from 'rxjs'
import { PrismaService } from './prisma.service.js'

/**
 * Per-request binding. Opens ONE transaction per request, sets the tenant GUC once, stashes the
 * transaction client in CLS, then runs the whole handler inside it. Fail-closed: no tenant -> 403.
 *
 * This is the recommended binding (vs per-query): baseline throughput, and atomic RMW / dataloader
 * / scoped raw SQL all work for free. The handler must not do slow non-DB I/O while the
 * transaction is open, and the pool must be sized to peak concurrency.
 */
@Injectable()
export class TenantTxInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
  ) {}

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId = this.cls.get<number>('tenantId')
    if (tenantId == null) throw new ForbiddenException('no tenant context')
    return from(
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`
          this.cls.set('tx', tx)
          return lastValueFrom(next.handle())
        },
        { timeout: 15000 },
      ),
    )
  }
}
