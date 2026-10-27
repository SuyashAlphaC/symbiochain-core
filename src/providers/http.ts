import { DomainError } from '../domain.js';
export type Fetch = typeof globalThis.fetch;
export async function boundedFetch(
  url: string | URL,
  init: RequestInit = {},
  transport: Fetch = fetch,
  maxBytes = 2_000_000,
): Promise<{ response: Response; bytes: Buffer }> {
  const response = await transport(url, {
    ...init,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new DomainError('UPSTREAM_HTTP', `Provider returned HTTP ${response.status}`, 502);
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes)
    throw new DomainError('UPSTREAM_SIZE', 'Provider response exceeds limit', 502);
  const reader = response.body?.getReader();
  if (!reader) return { response, bytes: Buffer.alloc(0) };
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > maxBytes)
        throw new DomainError('UPSTREAM_SIZE', 'Provider response exceeds limit', 502);
      chunks.push(item.value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  } finally {
    reader.releaseLock();
  }
  return { response, bytes: Buffer.concat(chunks) };
}
export async function httpJson(
  url: string | URL,
  init: RequestInit = {},
  transport: Fetch = fetch,
): Promise<unknown> {
  const { bytes } = await boundedFetch(url, init, transport);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DomainError('UPSTREAM_JSON', 'Provider returned invalid JSON', 502);
  }
}
