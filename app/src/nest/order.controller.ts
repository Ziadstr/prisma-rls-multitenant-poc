import { Body, Controller, Get, Post } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

@Controller('orders')
export class OrderController {
  constructor(private readonly prisma: PrismaService) {}

  // Note: NO explicit where: { tenantId } here. Isolation is enforced by RLS at the DB.
  @Get()
  list() {
    return this.prisma.client.order.findMany()
  }

  @Post()
  create(@Body() body: { title: string; tenantId: number }) {
    return this.prisma.client.order.create({
      data: { title: body.title, tenantId: body.tenantId },
    })
  }
}
