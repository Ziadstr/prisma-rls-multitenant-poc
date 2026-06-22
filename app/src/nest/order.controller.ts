import { Body, Controller, Get, Post } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'
import { TenantTransaction } from './tenant-transaction.decorator.js'

// Order is a SENSITIVE (RLS) table. The decorator opens the GUC transaction per request, so
// reads/writes are DB-enforced and atomic. Queries use prisma.tx (the transaction client).
@Controller('orders')
@TenantTransaction()
export class OrderController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.tx.order.findMany({ take: 50 })
  }

  @Post()
  create(@Body() body: { title: string; tenantId: number }) {
    return this.prisma.tx.order.create({
      data: { title: body.title, tenantId: body.tenantId },
    })
  }
}
