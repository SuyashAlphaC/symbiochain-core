import { fileURLToPath } from 'node:url';

/** Supabase connections always verify the server certificate and hostname. */
export function databaseConnectionUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Database URL is invalid; percent-encode special characters in its password');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Database connection must use a PostgreSQL URL');
  const supabase = url.hostname.endsWith('.supabase.co') || url.hostname.endsWith('.supabase.com');
  if (!supabase) return value;
  if (url.port === '6543')
    throw new Error(
      'Use the Supabase session pooler on port 5432 for these persistent processes and migrations',
    );
  url.searchParams.set('sslmode', 'verify-full');
  if (!url.searchParams.has('sslrootcert'))
    url.searchParams.set(
      'sslrootcert',
      fileURLToPath(new URL('../certs/supabase-root.crt', import.meta.url)),
    );
  return url.toString();
}
