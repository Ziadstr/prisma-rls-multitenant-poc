import 'reflect-metadata'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/nest/app.module.js'
import { makeClient } from '../src/db.js'

let app: INestApplication
let server: unknown
let t1: number
let t2: number
const root = makeClient(process.env.DATABASE_URL_SUPER!)

beforeAll(async () => {
  await root.$executeRawUnsafe('TRUNCATE "OrderItem","Order","Tenant" RESTART IDENTITY CASCADE')
  t1 = (await root.tenant.create({ data: { name: 'Acme' } })).id
  t2 = (await root.tenant.create({ data: { name: 'Globex' } })).id
  await root.order.createMany({
    data: [
      { tenantId: t1, title: 'a1' },
      { tenantId: t1, title: 'a2' },
      { tenantId: t2, title: 'g1' },
    ],
  })
  app = await NestFactory.create(AppModule, { logger: false })
  await app.init()
  server = app.getHttpServer()
}, 60000)

afterAll(async () => {
  await app?.close()
  await root.$disconnect()
})

describe('NestJS + nestjs-cls + RLS over the HTTP path', () => {
  it('tenant 1 header sees only tenant 1 orders', async () => {
    const res = await request(server).get('/orders').set('x-tenant-id', String(t1))
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    expect(res.body.every((o: { tenantId: number }) => o.tenantId === t1)).toBe(true)
  })

  it('tenant 2 header sees only tenant 2 orders', async () => {
    const res = await request(server).get('/orders').set('x-tenant-id', String(t2))
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('no tenant header fails CLOSED (500, not a leak)', async () => {
    const res = await request(server).get('/orders')
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it('cannot POST an order for another tenant (WITH CHECK)', async () => {
    const res = await request(server)
      .post('/orders')
      .set('x-tenant-id', String(t1))
      .send({ title: 'cross', tenantId: t2 })
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
