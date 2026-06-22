import { Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { ClsModule } from 'nestjs-cls'
import { PrismaService } from './prisma.service.js'
import { OrderController } from './order.controller.js'
import { CustomerController } from './customer.controller.js'
import { TenantTxInterceptor } from './tenant-tx.interceptor.js'

@Module({
  imports: [
    // ClsMiddleware mounts BEFORE guards/controllers, so the tenant context is set for the
    // whole request. In production `setup` reads the VERIFIED JWT 'tenantId' claim (decode-only
    // here, full verification in the auth guard). The x-tenant-id header stands in for that claim.
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        setup: (cls, req: { headers: Record<string, string | string[] | undefined> }) => {
          const raw = req.headers['x-tenant-id']
          cls.set('tenantId', raw != null ? Number(raw) : null)
        },
      },
    }),
  ],
  controllers: [OrderController, CustomerController],
  providers: [PrismaService, { provide: APP_INTERCEPTOR, useClass: TenantTxInterceptor }],
})
export class AppModule {}
