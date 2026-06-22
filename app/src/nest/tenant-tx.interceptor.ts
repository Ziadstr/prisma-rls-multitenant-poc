import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ForbiddenException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ClsService } from 'nestjs-cls'
import { Observable, from, lastValueFrom } from 'rxjs'
import { PrismaService } from './prisma.service.js'
import { TENANT_TX } from './tenant-transaction.decorator.js'

/**
 * Surgical binding. Requires a tenant on every route (fail-closed: no tenant -> 403). Only routes
 * marked @TenantTransaction() open a transaction (GUC set, stashed as prisma.tx). Everything else
 * runs with no transaction and uses the app-layer client. This is the bake-off winner: the
 * majority of (non-sensitive) traffic skips the transaction entirely.
 */
@Injectable()
export class TenantTxInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tenantId = this.cls.get<number>('tenantId')
    if (tenantId == null) throw new ForbiddenException('no tenant context')

    const needsTx = this.reflector.getAllAndOverride<boolean>(TENANT_TX, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (!needsTx) return next.handle() // app-layer only, no transaction

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
