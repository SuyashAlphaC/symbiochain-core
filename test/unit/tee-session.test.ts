import { beforeAll, afterAll, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import { TlsGatewaySession } from '../../src/providers/tee-session.js';

let directory: string, key: Buffer, cert: Buffer;
const servers: Server[] = [];
const sessions: TlsGatewaySession[] = [];
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'symbio-tls-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(directory, 'key.pem'));
  cert = readFileSync(join(directory, 'cert.pem'));
});
afterAll(async () => {
  for (const s of sessions) s.close();
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
  rmSync(directory, { recursive: true, force: true });
});
async function fixture(closeAfterReport = false) {
  let paid = 0;
  const sockets: unknown[] = [];
  const server = createServer({ key, cert }, (req, res) => {
    sockets.push(req.socket);
    if (req.method === 'POST') paid++;
    req.resume();
    req.on('end', () => {
      if (closeAfterReport) res.setHeader('connection', 'close');
      res.setHeader('content-type', 'application/json');
      res.end('{"fixture":true}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const origin = `https://localhost:${address.port}`;
  const session = new TlsGatewaySession(origin, cert);
  sessions.push(session);
  return { origin, session, sockets, paid: () => paid };
}
it('sends attestation and completion on one CA-authenticated TLS socket', async () => {
  const f = await fixture();
  expect((await f.session.fetch(f.origin + '/v1/attestation/report')).status).toBe(200);
  expect(f.session.peerSpkiSha256).toMatch(/^[a-f0-9]{64}$/);
  f.session.approve();
  await f.session.fetch(f.origin + '/v1/chat/completions', {
    method: 'POST',
    body: '{"model":"fixture"}',
  });
  expect(f.paid()).toBe(1);
  expect(f.sockets).toHaveLength(2);
  expect(f.sockets[0]).toBe(f.sockets[1]);
  await expect(
    f.session.fetch(f.origin + '/v1/chat/completions', { method: 'POST', body: '{}' }),
  ).rejects.toThrow('fresh verified session');
});
it('refuses inference before verification and forbids changing origins', async () => {
  const f = await fixture();
  await expect(
    f.session.fetch(f.origin + '/v1/chat/completions', { method: 'POST', body: '{}' }),
  ).rejects.toThrow('fresh verified session');
  await expect(f.session.fetch('https://untrusted.example/v1/attestation/report')).rejects.toThrow(
    'origin changed',
  );
  expect(f.paid()).toBe(0);
  expect(f.sockets).toHaveLength(0);
});
it('refuses a replacement connection before sending a paid request', async () => {
  const f = await fixture(true);
  await f.session.fetch(f.origin + '/v1/attestation/report');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(() => f.session.approve()).toThrow('no longer available');
  await expect(
    f.session.fetch(f.origin + '/v1/chat/completions', { method: 'POST', body: '{}' }),
  ).rejects.toThrow('closed');
  expect(f.paid()).toBe(0);
});
it('keeps normal certificate validation enabled', async () => {
  const f = await fixture();
  const session = new TlsGatewaySession(f.origin);
  sessions.push(session);
  await expect(session.fetch(f.origin + '/v1/attestation/report')).rejects.toThrow();
  expect(f.sockets).toHaveLength(0);
});
