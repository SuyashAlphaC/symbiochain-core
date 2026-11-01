import { Agent, request as httpsRequest } from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket, SecureContextOptions } from 'node:tls';
import { DomainError, sha256 } from '../domain.js';
import type { Fetch } from './http.js';

export interface GatewaySession {
  readonly fetch: Fetch;
  readonly peerSpkiSha256: string;
  approve(): void;
  close(): void;
}

/** One attestation GET and one completion POST on the identical authenticated TLS socket. */
export class TlsGatewaySession implements GatewaySession {
  private readonly agent: Agent;
  private socket?: TLSSocket;
  private fingerprint = '';
  private attested = false;
  private approved = false;
  private sent = false;
  private started = false;
  private closed = false;
  constructor(
    private readonly origin: string,
    ca?: SecureContextOptions['ca'],
  ) {
    if (new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin)
      throw new DomainError('TEE_TLS_ORIGIN', 'TEE transport requires an HTTPS origin');
    this.agent = new Agent({
      keepAlive: true,
      maxSockets: 1,
      maxFreeSockets: 1,
      ...(ca ? { ca } : {}),
      rejectUnauthorized: true,
    });
  }
  get peerSpkiSha256() {
    if (!this.fingerprint)
      throw new DomainError('TEE_TLS_PEER', 'No authenticated TLS peer observed');
    return this.fingerprint;
  }
  approve() {
    if (!this.attested || !this.socket || this.socket.destroyed || this.closed)
      throw new DomainError('TEE_TLS_LOST', 'Attestation connection is no longer available');
    this.approved = true;
  }
  close() {
    this.closed = true;
    this.agent.destroy();
  }
  readonly fetch: Fetch = async (input, init = {}) => {
    if (input instanceof Request)
      throw new DomainError('TEE_TLS_REQUEST', 'Explicit URL and request bytes required');
    const url = new URL(input);
    if (url.origin !== this.origin || url.username || url.password || url.hash)
      throw new DomainError('TEE_TLS_ORIGIN', 'TEE request origin changed');
    const method = init.method ?? 'GET';
    const preflight = method === 'GET' && url.pathname === '/v1/attestation/report';
    if (this.closed || (this.socket && this.socket.destroyed))
      throw new DomainError(
        'TEE_TLS_LOST',
        'Attestation connection was closed; fresh evidence is required',
      );
    if (preflight) {
      if (this.started)
        throw new DomainError('TEE_TLS_REUSE', 'Session already requested attestation');
      this.started = true;
    } else {
      if (
        method !== 'POST' ||
        url.pathname !== '/v1/chat/completions' ||
        !this.approved ||
        this.sent
      )
        throw new DomainError(
          'TEE_TLS_UNAPPROVED',
          'A fresh verified session is required before completion',
        );
      this.sent = true;
    }
    if (init.signal?.aborted) throw new DomainError('TEE_TLS_ABORTED', 'TEE request was aborted');
    if (
      init.body !== undefined &&
      typeof init.body !== 'string' &&
      !(init.body instanceof Uint8Array)
    )
      throw new DomainError('TEE_TLS_REQUEST', 'Exact string or byte request body required');
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    headers['accept-encoding'] = 'identity';
    return new Promise<Response>((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, response?: Response) => {
        if (finished) return;
        finished = true;
        init.signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(response!);
      };
      const req = httpsRequest(url, { method, headers, agent: this.agent }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        if ((res.statusCode ?? 500) >= 300 && (res.statusCode ?? 500) < 400) {
          res.destroy();
          finish(new DomainError('TEE_TLS_REDIRECT', 'TEE redirects are forbidden'));
          return;
        }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
          res.destroy();
          finish(
            new DomainError('TEE_TLS_ENCODING', 'TEE response must preserve exact identity bytes'),
          );
          return;
        }
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000) {
            res.destroy();
            finish(new DomainError('UPSTREAM_SIZE', 'TEE response exceeds limit'));
          } else chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () =>
          finish(new DomainError('TEE_TLS_LOST', 'TEE response was interrupted')),
        );
        res.on('end', () => {
          if (preflight && (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300)
            this.attested = true;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined)
              responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          finish(
            undefined,
            new Response(
              [204, 205, 304].includes(res.statusCode ?? 200) ? null : Buffer.concat(chunks),
              { status: res.statusCode ?? 502, headers: responseHeaders },
            ),
          );
        });
      });
      const abort = () =>
        req.destroy(new DomainError('TEE_TLS_ABORTED', 'TEE request was aborted'));
      init.signal?.addEventListener('abort', abort, { once: true });
      req.on('error', (error) => finish(error));
      req.setTimeout(30000, () =>
        req.destroy(new DomainError('TEE_TLS_TIMEOUT', 'TEE request timed out')),
      );
      req.once('socket', (socket) => {
        const peer = socket as TLSSocket;
        const ready = () => {
          if (this.socket && peer !== this.socket) {
            req.destroy(
              new DomainError(
                'TEE_TLS_RECONNECTED',
                'Replacement TLS connection requires new attestation',
              ),
            );
            return;
          }
          if (!peer.authorized) {
            req.destroy(
              new DomainError('TEE_TLS_CERTIFICATE', 'TLS certificate is not authenticated'),
            );
            return;
          }
          try {
            const certificate = peer.getPeerCertificate().raw;
            if (!certificate) throw new Error('Missing peer certificate');
            const spki = new X509Certificate(certificate).publicKey.export({
              type: 'spki',
              format: 'der',
            });
            const fingerprint = sha256(spki);
            if (this.fingerprint && this.fingerprint !== fingerprint)
              throw new Error('Peer changed');
            this.socket = peer;
            this.fingerprint = fingerprint;
            // Headers and the paid body are sent only after authenticating this exact socket.
            req.end(init.body as string | Uint8Array | undefined);
          } catch {
            req.destroy(new DomainError('TEE_TLS_PEER', 'Unable to authenticate the TLS peer'));
          }
        };
        if (peer.connecting) peer.once('secureConnect', ready);
        else ready();
      });
    });
  };
}
