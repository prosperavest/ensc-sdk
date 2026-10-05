/**
 * Chain identifiers.
 *
 * The ENSC API treats `chain` as a plain string at the request boundary and
 * resolves it at runtime. `KNOWN_CHAINS` lists every chain the API can serve;
 * which of them a deployment has switched on is decided at the API, and a
 * chain that is not switched on comes back as an `ENSC_INVALID_CHAIN` error,
 * as an unknown one does. `ChainSlug` is a convenience union for editor
 * autocomplete, not a promise that a chain is available. Any `string` is
 * accepted by the request methods.
 *
 * Conversions run on the converter chains: `celo` for live keys and
 * `celo-sepolia` for test keys. The environment of the API key selects the
 * chain family; a live key cannot name a testnet and vice versa.
 *
 * The SDK carries chain slugs only, never contract addresses.
 */

/** Mainnet chains the API can serve (with a live key). */
export const MAINNET_CHAINS = [
  'celo',
  'base',
  'polygon',
  'optimism',
  'arbitrum',
  'bsc',
  'mode',
  'plume',
] as const;

/** Testnet chains the API can serve (with a test key). */
export const TESTNET_CHAINS = [
  'celo-sepolia',
  'base-sepolia',
  'polygon-amoy',
  'optimism-sepolia',
  'arbitrum-sepolia',
  'bsc-testnet',
  'mode-sepolia',
  'plume-testnet',
] as const;

/** Every chain slug the SDK knows about at build time. */
export const KNOWN_CHAINS = [...MAINNET_CHAINS, ...TESTNET_CHAINS] as const;

/** Chains that carry the ENSC converter (conversions, quotes). */
export const CONVERTER_CHAINS = { live: 'celo', test: 'celo-sepolia' } as const;

/** A chain slug the SDK knows about. Request methods also accept any `string`. */
export type ChainSlug = (typeof KNOWN_CHAINS)[number];

/** Accepted by request methods: a known slug, or any string for forward-compat. */
export type ChainInput = ChainSlug | (string & {});

/** True when `slug` is a chain the SDK was built with knowledge of. */
export function isKnownChain(slug: string): slug is ChainSlug {
  return (KNOWN_CHAINS as readonly string[]).includes(slug);
}

/** Assets a merchant can name: the stablecoin and the pair tokens. */
export const ASSETS = ['ENSC', 'USDC', 'USDT', 'CELO'] as const;
export type Asset = (typeof ASSETS)[number];

/** Pair tokens for crypto legs of a conversion. */
export const PAIRS = ['USDC', 'USDT', 'CELO'] as const;
export type Pair = (typeof PAIRS)[number];
