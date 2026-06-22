import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module.js'

// Real HTTP server for the e2e. Run with:
//   node --import @swc-node/register/esm-register src/nest/main.ts
// swc-node emits the decorator metadata NestJS DI needs (Node 24 + ESM), which
// vitest's Oxc/esbuild transform does not.
const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] })
await app.listen(4099)
console.log('RLS_POC_NEST_READY on :4099')
