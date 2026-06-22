// Compile-time proof that the client split prevents misuse. Verified by `tsc --noEmit`.
// This is NOT a vitest test (no .test.ts suffix); it only needs to type-check.
import type { PrismaService } from './prisma.service.js'

declare const prisma: PrismaService

// Correct usage compiles:
void prisma.app.customer.findMany()
void prisma.tx.order.findMany()

// @ts-expect-error a SENSITIVE table is not reachable via the app-layer client
void prisma.app.order.findMany()

// @ts-expect-error a NON-sensitive table is not reachable via the transaction client
void prisma.tx.customer.findMany()
