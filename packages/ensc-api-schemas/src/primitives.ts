/**
 * Shared Zod primitives, re-exported by `index.ts`. Kept in their own module so
 * they are initialised before any schema that references them at module-load
 * time.
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

/**
 * An amount in major units, as a decimal string (e.g. "100", "0.001"), in
 * canonical decimal form only: digits, at most one point, no sign, exponent,
 * hex, comma, whitespace or leading zero ("1e2", "0x10", "+5", "007", " 5" are
 * refused), at most 18 digits either side of the point. The amount is parsed
 * exactly (BigInt, never a float); what each asset can hold is checked with
 * `amountWithinAsset` where the request names the asset.
 */
export const decimalAmountSchema = z
  .string()
  .max(40, 'Amount is too long')
  .regex(
    /^(0|[1-9]\d{0,17})(\.\d{1,18})?$/,
    'Must be a plain decimal number: digits and at most one point, no leading zero, sign or exponent',
  );

/**
 * What an amount of each asset may be written as: whole digits (above that it
 * is no amount this system will ever hold) and decimal places (the asset's
 * own; more would be rounded away when the amount is converted to base units,
 * so they are refused instead). NGN is the fiat legs' amount (kobo).
 */
export const ASSET_AMOUNT_LIMITS = Object.freeze({
  ENSC: { maxWholeDigits: 15, decimals: 18 },
  NGN: { maxWholeDigits: 15, decimals: 2 },
  USDC: { maxWholeDigits: 12, decimals: 6 },
  USDT: { maxWholeDigits: 12, decimals: 6 },
  CELO: { maxWholeDigits: 12, decimals: 18 },
} as const);
export type AmountAsset = keyof typeof ASSET_AMOUNT_LIMITS;

/** Null when `amount` (already canonical) fits `asset`, else the reason. */
export function amountWithinAsset(amount: string, asset: AmountAsset): string | null {
  const limits = ASSET_AMOUNT_LIMITS[asset];
  const [whole = '', frac = ''] = amount.split('.');
  if (whole.length > limits.maxWholeDigits) {
    return `Amount is above the largest ${asset} amount accepted (${limits.maxWholeDigits} whole digits)`;
  }
  if (frac.length > limits.decimals) {
    return `${asset} has ${limits.decimals} decimal places; the amount has ${frac.length}`;
  }
  return null;
}

/**
 * A whole number written as text, in canonical decimal form only: plain
 * digits, no sign, exponent, hex, point, space, leading zero or trailing
 * text, at most 16 digits. "1e2", "0x10", "+5", "007", " 5", "5.0" and
 * "5abc" do not match, where JavaScript coercion or a lenient parser would
 * read them as numbers.
 */
export const CANONICAL_WHOLE_NUMBER_RE = /^(0|[1-9]\d{0,15})$/;

/**
 * A whole number from a query string (a page size, a unix time), in canonical
 * decimal form only (CANONICAL_WHOLE_NUMBER_RE): "1e2", "0x10", "+5", "007",
 * " 5" and "5.0" are refused, where JavaScript coercion would read them as
 * numbers. A number (a value built in code) is taken as it is. Bounded by
 * `min`..`max`.
 */
export function queryIntSchema(min: number, max: number) {
  const bounded = z.number().int().min(min).max(max);
  return z.union([
    bounded,
    z
      .string()
      .regex(CANONICAL_WHOLE_NUMBER_RE, 'A whole number in plain decimal digits')
      .transform(Number)
      .pipe(bounded),
  ]);
}

/** The latest unix time (seconds) a query may name: 9999-12-31T23:59:59Z. */
export const MAX_UNIX_SECONDS = 253_402_300_799;

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
 * API applies at request time. Single addresses are treated as /32 or /128.
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
  )
  .refine((v) => {
    // An allowlist entry must allow a list, not the whole internet: at
    // least /8 for IPv4 and /32 for IPv6.
    const slash = v.indexOf('/');
    if (slash < 0) return true;
    const prefix = Number(v.slice(slash + 1));
    return v.includes(':') ? prefix >= 32 : prefix >= 8;
  }, 'A CIDR block must be /8 or narrower (IPv4) or /32 or narrower (IPv6)');

/** Per-key IP allowlist. Mandatory (min 1) for live keys; the API enforces that rule. */
export const ipAllowlistSchema = z.array(cidrSchema).min(1).max(32);

/**
 * Host names that never denote a public host: the special-use names
 * (localhost, local, internal, home.arpa) and the ones private networks
 * commonly use. A webhook host that is one of them, or under one, is refused.
 */
export const WEBHOOK_PRIVATE_NAME_SUFFIXES: readonly string[] = [
  'localhost',
  'local',
  'internal',
  'home.arpa',
  'lan',
  'home',
  'corp',
];

/** The platform's own domain: a webhook is never sent to a host under it. */
export const WEBHOOK_OWN_DOMAINS: readonly string[] = ['prosperavest.com'];

/** The longest webhook endpoint URL accepted. */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

/**
 * Why `rawUrl` cannot be a webhook endpoint, in words for the caller, or null
 * when it can. The rule: https only, no credentials in the URL, the default
 * port only, a public host name written without a trailing dot (no address in
 * any notation, no single-label or private name), and nothing under the
 * platform's own domain. The same rule is applied again each time an event is
 * sent, so a URL refused here would never have received a delivery.
 */
export function webhookUrlProblem(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Webhook URL must be a valid https:// URL';
  }
  if (url.protocol !== 'https:') return 'Webhook URL must be https://';
  if (url.username || url.password) return 'Webhook URL must not carry a username or password';
  if (url.port !== '') return 'Webhook URL must use the default https port (443)';
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.')) return 'Webhook URL host name must not end in a dot';
  // The URL parser has already put every numeric spelling of an address into
  // its plain form, so one check covers them all.
  if (host.startsWith('[') || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return 'Webhook URL host must be a host name, not an IP address';
  }
  const under = (suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  if (!host.includes('.') || WEBHOOK_PRIVATE_NAME_SUFFIXES.some(under)) {
    return 'Webhook URL host must be a public host name';
  }
  if (WEBHOOK_OWN_DOMAINS.some(under)) return 'Webhook URL must not point at this platform';
  return null;
}

/**
 * Merchant webhook endpoint URL: what `webhookUrlProblem` accepts, at most
 * WEBHOOK_URL_MAX_LENGTH characters. A URL that could never receive a
 * delivery is refused when it is registered, with the reason.
 */
export const webhookUrlSchema = z
  .url()
  .max(WEBHOOK_URL_MAX_LENGTH)
  .superRefine((v, ctx) => {
    const problem = webhookUrlProblem(v);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
  });
