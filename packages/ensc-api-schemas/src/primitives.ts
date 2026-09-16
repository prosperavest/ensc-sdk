/**
 * Shared Zod primitives, re-exported by `index.ts`. Kept in their own module so
 * the bundler initialises them before any schema that references them at
 * module-load time.
 *
 * Keep this file tiny. Anything bigger than a primitive Zod schema belongs in
 * a feature-specific module.
 */

import { z } from 'zod';

/** EVM address: must be 0x-prefixed, 40 hex chars. Normalised to lowercase. */
export const evmAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a 0x-prefixed 40-char hex address')
  .transform((v) => v.toLowerCase() as `0x${string}`);

/** Decimal amount as string (e.g. "100", "0.001"). Validated, not converted here. */
export const decimalAmountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'Must be a decimal string with no commas or signs');

export const chainSlugSchema = z.string().min(2).max(40);

/** Whitelisted asset symbols. ENSC is the stablecoin; the rest are converter pairs. */
export const assetSymbolSchema = z.enum(['ENSC', 'USDC', 'USDT', 'CELO']);
export const pairSymbolSchema = z.enum(['USDC', 'USDT', 'CELO']);

/** uint256 as a decimal string. */
export const uintStringSchema = z.string().regex(/^\d{1,78}$/);

export const bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** Nigerian bank code as the payment provider lists it (2 to 10 digits). */
export const bankCodeSchema = z.string().regex(/^\d{2,10}$/);

/** NUBAN account number: 10 digits. */
export const accountNumberSchema = z.string().regex(/^\d{10}$/);

export const envSchema = z.enum(['test', 'live']);

/** Idempotency key: UUID, ULID, or any opaque <=64 chars */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * IPv4 or IPv6 address with an optional CIDR prefix. Matches the check the
 * API applies at request time (api-key-auth ipInCidrs). Single addresses are
 * treated as /32 or /128.
 */
const IPV4_CIDR_RE =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const IPV6_CIDR_RE =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(([0-9a-fA-F]{1,4}:){1,7}|:):(([0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4})?|::)(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/;
export const cidrSchema = z
  .string()
  .max(64)
  .refine(
    (v) => IPV4_CIDR_RE.test(v) || IPV6_CIDR_RE.test(v),
    'Must be an IPv4/IPv6 address or CIDR',
  );

/** Per-key IP allowlist. Mandatory (min 1) for live keys; the API enforces that rule. */
export const ipAllowlistSchema = z.array(cidrSchema).min(1).max(32);

/**
 * Merchant webhook endpoint URL. HTTPS only, a real hostname (no IP literal,
 * no localhost, no single-label host), no credentials in the URL. The
 * deliverer POSTs to it from ENSC's network, so this is also the SSRF
 * guard for the platform.
 */
export const webhookUrlSchema = z
  .url()
  .max(2048)
  .refine((v) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
      return false;
    if (!host.includes('.')) return false;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    if (host.startsWith('[') || host.includes(':')) return false;
    return true;
  }, 'Webhook URL must be https:// with a public hostname');
