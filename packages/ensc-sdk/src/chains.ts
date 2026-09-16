/**
 * Chain identifiers.
 *
 * The ENSC API treats `chain` as a plain string at the request boundary and
 * resolves it at runtime: which chains are actually enabled is a per-deployment
 * operator decision the SDK cannot know statically. `ChainSlug` is a
 * convenience union for editor autocomplete, not an exhaustive guarantee. Any
 * `string` is accepted by the request methods; an unknown or disabled chain
 * comes back as an `ENSC_INVALID_CHAIN` error.
 *
 * Conversions run on the converter chains: `celo` for live keys and
 * `celo-sepolia` for test keys. The environment of the API key selects the
 * chain family; a live key cannot name a testnet and vice versa.
 *
 * `KNOWN_CHAINS` is kept in sync with the platform's chain registry by a test
 * that lives with the registry, outside this package; the SDK carries chain
 * slugs only, never contract addresses.
 */

/** Mainnet chains ENSC can be deployed to. */
export const MAINNET_CHAINS = ['celo', 'base', 'polygon', 'optimism', 'ethereum'] as const;

/** Testnet chains ENSC can be deployed to. */
export const TESTNET_CHAINS = [
  'celo-sepolia',
  'base-sepolia',
  'polygon-amoy',
  'optimism-sepolia',
  'sepolia',
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
