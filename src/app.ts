import Fastify, { type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { WebSocket } from 'ws';
import { Store, json } from './store.js';
import { DomainError, Proposal, atoms, positiveAtoms, idSchema, eventCursor } from './domain.js';
import { exportEvidence } from './evidence.js';
import { approveCostBasis } from './cost-basis.js';
import { cycleEconomics } from './economics.js';
import type { PaperFaultController } from './paper-faults.js';
import { dashboardHtml, dashboardCss } from './dashboard-page.js';
import { readFile } from 'node:fs/promises';
import { viewerSnapshot, viewerProof } from './viewer.js';

export function tokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function createApp(
  store: Store,
  options: { faults?: PaperFaultController | undefined } = {},
) {
  const c = store.config;
  const app = Fastify({
    logger: {
      level: c.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          '*.privateKey',
          '*.apiKey',
          '*.evidenceCiphertext',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 65536,
    trustProxy: false,
  });
  await app.register(cors, {
    origin: c.CORS_ORIGINS,
    methods: ['GET', 'POST'],
    credentials: false,
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 16384 } });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'SymbioChain Backend',
        version: '0.1.0',
        description:
          'PAPER results are simulated. LIVE mode requires independently verified integrations.',
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: 'INVALID_INPUT',
        issues: error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    if (error instanceof DomainError)
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    req.log.error({ err: error }, 'Request failed');
    const suppliedStatus =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : null;
    const status =
      typeof suppliedStatus === 'number' && suppliedStatus >= 400 && suppliedStatus < 500
        ? suppliedStatus
        : 500;
    return reply
      .code(status)
      .send({ error: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST' });
  });
  const read = async (req: FastifyRequest) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (!tokenEquals(token, c.READ_TOKEN) && !tokenEquals(token, c.ADMIN_TOKEN))
      throw new DomainError('UNAUTHORIZED', 'Read token required', 401);
  };
  const admin = async (req: FastifyRequest) => {
    if (!tokenEquals(req.headers.authorization?.replace(/^Bearer /, ''), c.ADMIN_TOKEN))
      throw new DomainError('UNAUTHORIZED', 'Admin token required', 401);
  };
  const secured = { preHandler: read, schema: { security: [{ bearerAuth: [] }] } };
  const privileged = { preHandler: admin, schema: { security: [{ bearerAuth: [] }] } };
  app.get('/api/viewer/snapshot', secured, async (_req, reply) => {
    reply.header('cache-control', 'private, no-store');
    return viewerSnapshot(store);
  });
  app.get('/api/viewer/proof', secured, async (req, reply) => {
    const { hash } = z
      .object({ hash: z.string().regex(/^[a-f0-9]{64}$/i) })
      .strict()
      .parse(req.query);
    reply.header('cache-control', 'private, no-store');
    return viewerProof(store, hash.toLowerCase());
  });

  app.get('/', async (_req, reply) => reply.redirect('/dashboard'));
  app.get('/dashboard', async (_req, reply) =>
    reply
      .header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      )
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(dashboardHtml),
  );
  app.get('/dashboard.css', async (_req, reply) => reply.type('text/css').send(dashboardCss));
  app.get('/dashboard.js', async (_req, reply) =>
    reply
      .type('application/javascript')
      .send(await readFile(new URL('./dashboard-client.js', import.meta.url), 'utf8')),
  );
  app.get('/api/capabilities', secured, async (req) => ({
    mode: store.mode,
    admin: tokenEquals(req.headers.authorization?.replace(/^Bearer /, ''), c.ADMIN_TOKEN),
    crashDemoEnabled: store.mode === 'PAPER' && c.ENABLE_CHAOS_DEMO && !!options.faults,
    requestedShareBps: c.NFT_SHARE_BPS,
    computePurchaseImplemented: false,
  }));

  app.get('/healthz', async () => ({ status: 'ok', service: 'symbiochain-api' }));
  app.get('/readyz', async (_req, reply) => {
    try {
      await store.db.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.get('/api/health', secured, async () => store.snapshot());
  app.get('/api/swarm', secured, async () => store.snapshot());
  app.get('/api/policy', secured, async () =>
    store.db.policy.findUniqueOrThrow({ where: { mode: store.mode } }),
  );
  app.get('/api/cycles', secured, async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(25),
        cursor: idSchema.optional(),
      })
      .parse(req.query);
    if (q.cursor) await store.getCycle(q.cursor);
    return store.db.cycle.findMany({
      where: { mode: store.mode },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        mode: true,
        state: true,
        strategy: true,
        rejection: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });
  app.post(
    '/api/cycles',
    {
      ...privileged,
      schema: { ...privileged.schema, body: z.toJSONSchema(Proposal, { target: 'draft-7' }) },
    },
    async (req, reply) => {
      const key = z.string().min(8).max(128).parse(req.headers['idempotency-key']);
      const result = await store.createCycle(req.body, key);
      return reply.code(result.created ? 201 : 200).send({
        id: result.cycle.id,
        state: result.cycle.state,
        mode: store.mode,
        created: result.created,
      });
    },
  );
  app.get('/api/cycles/:id', secured, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const cycle = await store.getCycle(id);
    const [decisions, transactions, proofs, jobs, inference, legs, costBasis] = await Promise.all([
      store.db.decision.findMany({ where: { cycleId: id }, orderBy: { createdAt: 'asc' } }),
      store.db.chainTransaction.findMany({ where: { cycleId: id }, orderBy: { createdAt: 'asc' } }),
      store.db.proof.findMany({
        where: { cycleId: id },
        select: { id: true, kind: true, status: true, publicDetails: true, verifiedAt: true },
      }),
      store.db.job.findMany({
        where: { cycleId: id },
        select: {
          id: true,
          lane: true,
          attempts: true,
          lastError: true,
          availableAt: true,
          doneAt: true,
          leaseUntil: true,
        },
      }),
      store.db.inferenceAttempt.findUnique({
        where: { cycleId: id },
        select: { status: true, billingRequestId: true, updatedAt: true },
      }),
      store.db.liveLeg.findMany({
        where: { cycleId: id },
        select: {
          id: true,
          leg: true,
          status: true,
          txHash: true,
          updatedAt: true,
          broadcastAttempts: true,
          lastBroadcastAt: true,
          lastBroadcastError: true,
        },
      }),
      store.db.costBasis.findUnique({ where: { cycleId: id } }),
    ]);
    const { submission: _submission, ...safe } = cycle;
    return { ...safe, decisions, transactions, proofs, jobs, inference, legs, costBasis };
  });
  app.get('/api/cycles/:id/economics', secured, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    return cycleEconomics(store, id);
  });
  app.post('/api/admin/demo/crash-worker', privileged, async (req) => {
    if (store.mode !== 'PAPER' || !c.ENABLE_CHAOS_DEMO || !options.faults)
      throw new DomainError(
        'DEMO_DISABLED',
        'Crash demonstrations require explicitly enabled colocated PAPER workers',
        403,
      );
    const { cycleId, role } = z
      .object({ cycleId: idSchema, role: z.enum(['SCOUT', 'BRAIN', 'HAND']) })
      .strict()
      .parse(req.body);
    return options.faults.arm(store, cycleId, role);
  });
  app.post('/api/admin/demo/cancel-crash', privileged, async () => {
    if (store.mode !== 'PAPER' || !c.ENABLE_CHAOS_DEMO || !options.faults)
      throw new DomainError(
        'DEMO_DISABLED',
        'Crash controls require explicitly enabled colocated PAPER workers',
        403,
      );
    return options.faults.cancel(store);
  });
  app.get('/api/proofs/:id', secured, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const proof = await store.db.proof.findFirst({
      where: { id, cycle: { mode: store.mode } },
      select: {
        id: true,
        cycleId: true,
        kind: true,
        status: true,
        model: true,
        requestHash: true,
        responseHash: true,
        signer: true,
        measurement: true,
        publicDetails: true,
        verifiedAt: true,
        createdAt: true,
      },
    });
    if (!proof) throw new DomainError('NOT_FOUND', 'Proof not found', 404);
    return proof;
  });
  app.get('/api/events', secured, async (req) => {
    const q = z
      .object({
        after: eventCursor.default('0'),
        limit: z.coerce.number().int().min(1).max(250).default(100),
      })
      .parse(req.query);
    const rows = await store.db.outboxEvent.findMany({
      where: { mode: store.mode, seq: { gt: BigInt(q.after) } },
      orderBy: { seq: 'asc' },
      take: q.limit,
    });
    return {
      events: rows.map((e) => ({ ...e, seq: e.seq.toString() })),
      cursor: rows.at(-1)?.seq.toString() ?? q.after,
    };
  });
  app.post('/api/admin/cycles/:id/cost-basis', privileged, async (req) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    await store.getCycle(id);
    return approveCostBasis(store, id, req.body);
  });
  app.get('/api/verify-tee', secured, async (req) => {
    const { hash } = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.query);
    const proof = await store.db.proof.findFirst({
      where: {
        cycle: { mode: store.mode },
        kind: 'NEAR_AI',
        OR: [{ requestHash: hash }, { responseHash: hash }],
      },
      select: {
        id: true,
        status: true,
        verifiedAt: true,
        requestHash: true,
        responseHash: true,
        measurement: true,
        signer: true,
        publicDetails: true,
      },
    });
    if (!proof)
      throw new DomainError('NOT_FOUND', 'No verified inference record matches this hash', 404);
    return { ...proof, scope: 'RECORDED_VERIFICATION', freshAttestationPerformed: false };
  });
  app.get('/api/cycles/:id/evidence', privileged, async (req, reply) => {
    const { id } = z.object({ id: idSchema }).parse(req.params);
    reply.header('cache-control', 'no-store');
    return exportEvidence(store, id);
  });
  app.post('/api/admin/fund', privileged, async (req) => {
    const body = z
      .object({ amountAtoms: positiveAtoms, reference: z.string().min(8).max(128) })
      .strict()
      .parse(req.body);
    await store.fundPaper(BigInt(body.amountAtoms), body.reference);
    return store.snapshot();
  });
  app.post('/api/admin/policy', privileged, async (req) => {
    const body = z
      .object({
        expectedRevision: z.number().int().positive(),
        maxTradeAtoms: positiveAtoms.optional(),
        maxDailySpendAtoms: positiveAtoms.optional(),
        minReserveAtoms: atoms.optional(),
        minNetProfitAtoms: atoms.optional(),
        maxSlippageBps: z.number().int().min(0).max(1000).optional(),
        allowedAssets: z.array(z.string().min(1).max(200)).min(1).max(16).optional(),
        allowedChains: z.array(z.string().min(1).max(80)).min(1).max(8).optional(),
        allowedRecipients: z.array(z.string().min(2).max(128)).min(1).max(16).optional(),
      })
      .strict()
      .parse(req.body);
    const { expectedRevision, ...changes } = body;
    if (!Object.keys(changes).length)
      throw new DomainError('EMPTY_POLICY', 'No policy changes supplied', 400);
    return store.atomic(async (tx) => {
      const current = await tx.policy.findUniqueOrThrow({ where: { mode: store.mode } });
      if (current.revision !== expectedRevision)
        throw new DomainError('POLICY_CONFLICT', 'Reload the current policy revision');
      const trade = BigInt(changes.maxTradeAtoms ?? current.maxTradeAtoms.toFixed(0)),
        daily = BigInt(changes.maxDailySpendAtoms ?? current.maxDailySpendAtoms.toFixed(0));
      if (daily < trade)
        throw new DomainError('POLICY_LIMITS', 'Daily cap must cover the per-trade cap', 400);
      const updated = await tx.policy.update({
        where: { mode: store.mode, revision: expectedRevision },
        data: {
          revision: { increment: 1 },
          ...(changes.maxTradeAtoms !== undefined ? { maxTradeAtoms: changes.maxTradeAtoms } : {}),
          ...(changes.maxDailySpendAtoms !== undefined
            ? { maxDailySpendAtoms: changes.maxDailySpendAtoms }
            : {}),
          ...(changes.minReserveAtoms !== undefined
            ? { minReserveAtoms: changes.minReserveAtoms }
            : {}),
          ...(changes.minNetProfitAtoms !== undefined
            ? { minNetProfitAtoms: changes.minNetProfitAtoms }
            : {}),
          ...(changes.maxSlippageBps !== undefined
            ? { maxSlippageBps: changes.maxSlippageBps }
            : {}),
          ...(changes.allowedAssets !== undefined ? { allowedAssets: changes.allowedAssets } : {}),
          ...(changes.allowedChains !== undefined ? { allowedChains: changes.allowedChains } : {}),
          ...(changes.allowedRecipients !== undefined
            ? { allowedRecipients: changes.allowedRecipients }
            : {}),
        },
      });
      await store.event(tx, 'treasury.policy', { revision: updated.revision, changes });
      return updated;
    });
  });
  for (const action of ['pause', 'resume'] as const)
    app.post(`/api/admin/${action}`, privileged, async () => {
      await store.atomic(async (tx) => {
        await tx.policy.update({
          where: { mode: store.mode },
          data: { paused: action === 'pause', revision: { increment: 1 } },
        });
        await store.event(tx, 'treasury.control', { action });
      });
      return { paused: action === 'pause' };
    });
  app.post('/api/admin/agents/:role/:action', privileged, async (req) => {
    const { role, action } = z
      .object({ role: z.enum(['SCOUT', 'BRAIN', 'HAND']), action: z.enum(['pause', 'resume']) })
      .parse(req.params);
    await store.atomic(async (tx) => {
      await tx.workerControl.update({ where: { role }, data: { paused: action === 'pause' } });
      await store.event(tx, 'worker.control', { role, action });
    });
    return { role, paused: action === 'pause' };
  });

  const clients = new Set<WebSocket>();
  app.get('/ws', { websocket: true }, (socket, req) => {
    clients.add(socket);
    let authenticated = false,
      pumping = false,
      cursor = 0n;
    const send = (v: unknown) => {
      if (socket.readyState === 1 && socket.bufferedAmount < 1024 * 1024)
        socket.send(JSON.stringify(v));
      else socket.close(1013, 'Client too slow');
    };
    const authTimer = setTimeout(() => {
      if (!authenticated) socket.close(1008, 'Authentication required');
    }, 5000);
    const pump = async () => {
      if (!authenticated || pumping || socket.readyState !== 1) return;
      pumping = true;
      try {
        const events = await store.db.outboxEvent.findMany({
          where: { mode: store.mode, seq: { gt: cursor } },
          orderBy: { seq: 'asc' },
          take: 100,
        });
        for (const e of events) {
          send({
            type: 'event',
            seq: e.seq.toString(),
            mode: e.mode,
            topic: e.topic,
            cycleId: e.cycleId,
            payload: e.payload,
            timestamp: e.createdAt,
          });
          cursor = e.seq;
        }
      } catch {
        socket.close(1011, 'Event stream unavailable');
      } finally {
        pumping = false;
      }
    };
    socket.on('message', (data) => {
      try {
        const message = z
          .object({
            type: z.literal('subscribe'),
            token: z.string().max(512),
            after: eventCursor.default('0'),
          })
          .strict()
          .parse(JSON.parse(data.toString()));
        if (!tokenEquals(message.token, c.READ_TOKEN) && !tokenEquals(message.token, c.ADMIN_TOKEN))
          return socket.close(1008, 'Invalid token');
        if (authenticated) return socket.close(1008, 'Already subscribed');
        authenticated = true;
        cursor = BigInt(message.after);
        clearTimeout(authTimer);
        send({ type: 'ready', mode: store.mode, cursor: cursor.toString() });
        void pump();
      } catch {
        socket.close(1008, 'Invalid subscribe message');
      }
    });
    const timer = setInterval(() => {
      void pump();
    }, 250);
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.ping();
    }, 20000);
    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(timer);
      clearInterval(ping);
      clients.delete(socket);
    });
    socket.on('error', (error) => req.log.debug({ message: error.message }, 'WebSocket closed'));
  });
  app.addHook('onClose', async () => {
    for (const socket of clients) socket.close(1001, 'Server shutting down');
  });
  app.get('/openapi.json', secured, async () => app.swagger());
  return app;
}
