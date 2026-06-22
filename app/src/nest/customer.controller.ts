import { Body, Controller, Get, Post } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

// Customer is a NON-sensitive (RLS-free) table. No @TenantTransaction, so no transaction is
// opened. Isolation comes from the app-layer client (WHERE-injection / create-stamp). This is
// the fast path that the bake-off showed runs near the no-RLS ceiling.
@Controller('customers')
export class CustomerController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.app.customer.findMany({ take: 50 })
  }

  @Post()
  create(@Body() body: { name: string }) {
    return this.prisma.app.customer.create({ data: { name: body.name } as never })
  }
}
