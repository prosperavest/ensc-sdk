/**
 * Zod schemas for every API endpoint.
 *
 * These are the single source of truth for request and response shapes. They are:
 *   - Imported by the server (Hono routes validate with them)
 *   - Imported by the SDK (request bodies typed, responses parsed)
 *   - Used to auto-generate the OpenAPI spec
 *
 * RULE: amount fields are STRINGS (decimal). The server parses with BigInt.
 *       This avoids JSON-number precision loss for 18-decimal tokens.
 */

import { z } from 'zod';

// =====================================================================================
// Primitives: defined in a sibling file so tsup's bundle initialises them
// before any consumer module references them at top-level scope.
// =====================================================================================
export {
  accountNumberSchema,
  assetSymbolSchema,
  bankCodeSchema,
  bytes32Schema,
  chainSlugSchema,
  cidrSchema,
  decimalAmountSchema,
  envSchema,
  evmAddressSchema,
  idempotencyKeySchema,
  ipAllowlistSchema,
  pairSymbolSchema,
  uintStringSchema,
  webhookUrlSchema,
} from './primitives.js';

import {
  accountNumberSchema,
  assetSymbolSchema,
  bankCodeSchema,
  bytes32Schema,
  chainSlugSchema,
  decimalAmountSchema,
  envSchema,
  evmAddressSchema,
  ipAllowlistSchema,
  pairSymbolSchema,
  uintStringSchema,
} from './primitives.js';

// =====================================================================================
// Pagination: shared shape for every list endpoint
// =====================================================================================

/**
 * Cursor-based pagination. Callers send `?limit=N&cursor=...`. Response always
 * includes `pagination.nextCursor` (null when there's no more data) and
 * `pagination.hasMore`. The cursor is opaque base64url.
 */
export const paginationSchema = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type Pagination = z.infer<typeof paginationSchema>;

// =====================================================================================
// Shared: unsigned transaction the merchant signs and broadcasts
// =====================================================================================

/**
 * ENSC never holds a wallet key. Every on-chain action is returned as calldata
 * for the merchant's own wallet (the one named in the request) to sign.
 * `gasLimit`/fees/nonce are the merchant's to fill (their signer knows the
 * account state); the API supplies the chain-independent part.
 */
export const unsignedTransactionSchema = z.object({
  to: evmAddressSchema,
  data: z.string().regex(/^0x[0-9a-fA-F]*$/),
  value: z.literal('0'),
  chainId: z.number().int().positive(),
});
export type UnsignedTransaction = z.infer<typeof unsignedTransactionSchema>;

// =====================================================================================
// Transfer (plain ERC-20 transfer of ENSC)
// =====================================================================================

export const transferRequestSchema = z.object({
  from: evmAddressSchema,
  recipient: evmAddressSchema,
  amount: decimalAmountSchema,
  asset: z.literal('ENSC').default('ENSC'),
  chain: chainSlugSchema,
  clientReference: z.string().max(128).optional(),
});

export const transferResponseSchema = z.object({
  unsignedTransaction: unsignedTransactionSchema,
  chain: chainSlugSchema,
  /** Base units moved. */
  amount: z.string(),
});

export type TransferRequest = z.infer<typeof transferRequestSchema>;
export type TransferResponse = z.infer<typeof transferResponseSchema>;

// =====================================================================================
// Balance
// =====================================================================================

export const balanceRequestSchema = z.object({
  account: evmAddressSchema,
  asset: assetSymbolSchema,
  chain: chainSlugSchema,
});

export const balanceResponseSchema = z.object({
  account: z.string(),
  asset: assetSymbolSchema,
  chain: chainSlugSchema,
  balance: z.string(), // base units, decimal string
  formatted: z.string(), // human-readable, e.g. "100.5"
  decimals: z.number().int().nonnegative(),
});

export type BalanceRequest = z.infer<typeof balanceRequestSchema>;
export type BalanceResponse = z.infer<typeof balanceResponseSchema>;

// =====================================================================================
// Banks and account resolution (payment provider, environment of the API key)
// =====================================================================================

export const bankSchema = z.object({
  code: z.string(),
  name: z.string(),
});

export const banksResponseSchema = z.object({
  country: z.literal('NG'),
  banks: z.array(bankSchema),
});

export const resolveAccountRequestSchema = z.object({
  bankCode: bankCodeSchema,
  accountNumber: accountNumberSchema,
});

export const resolveAccountResponseSchema = z.object({
  bankCode: z.string(),
  accountNumber: z.string(),
  accountName: z.string(),
});

export type BanksResponse = z.infer<typeof banksResponseSchema>;
export type ResolveAccountRequest = z.infer<typeof resolveAccountRequestSchema>;
export type ResolveAccountResponse = z.infer<typeof resolveAccountResponseSchema>;

// =====================================================================================
// Conversions (ENSCConverter: crypto-issue, crypto-redeem, fiat-issue, fiat-redeem)
// =====================================================================================

export const conversionTypeSchema = z.enum([
  'crypto-issue',
  'crypto-redeem',
  'fiat-issue',
  'fiat-redeem',
]);
export type ConversionType = z.infer<typeof conversionTypeSchema>;

export const conversionStatusSchema = z.enum([
  'created',
  'screening_hold',
  'awaiting_payment',
  'payment_confirmed',
  'voucher_issued',
  'onchain_submitted',
  'onchain_confirmed',
  'payout_pending',
  'payout_in_progress',
  'payout_confirmed',
  'succeeded',
  'failed',
  'requires_manual_review',
]);
export type ConversionStatus = z.infer<typeof conversionStatusSchema>;

/** Bank account the NGN payout of a fiat-redeem goes to. Resolved with the provider first. */
export const payoutDestinationSchema = z.object({
  bankCode: bankCodeSchema,
  accountNumber: accountNumberSchema,
  /** Must equal the provider's resolved account name (case and spacing folded). */
  accountName: z.string().min(2).max(128),
});
export type PayoutDestination = z.infer<typeof payoutDestinationSchema>;

/** Who is paying the NGN of a fiat-issue; the provider needs a contact for the collection. */
export const payerSchema = z.object({
  email: z.email().max(254),
  name: z.string().min(1).max(128).optional(),
  phone: z.string().min(6).max(32).optional(),
});

/** Counterparty details the merchant can supply for transaction screening. */
export const screeningCounterpartySchema = z.object({
  type: z.enum(['individual', 'company']).default('individual'),
  name: z.string().min(1).max(128).optional(),
  wallet: evmAddressSchema.optional(),
});

export const conversionMetadataSchema = z
  .record(z.string().min(1).max(40), z.string().max(200))
  .refine((m) => Object.keys(m).length <= 16, 'at most 16 metadata keys');

export const createConversionRequestSchema = z
  .object({
    type: conversionTypeSchema,
    chain: chainSlugSchema,
    /** The merchant wallet that will sign the converter call. The voucher binds to it. */
    wallet: evmAddressSchema,
    /**
     * Amount in major units as a decimal string.
     *   crypto-issue:  amount of the pair token paid in
     *   crypto-redeem: amount of ENSC redeemed
     *   fiat-issue:    NGN principal (2 dp); ENSC minted 1:1
     *   fiat-redeem:   ENSC redeemed (2 dp); NGN paid out 1:1
     */
    amount: decimalAmountSchema,
    /** Pair token for crypto legs. */
    pair: pairSymbolSchema.optional(),
    /** fiat-redeem only. */
    payout: payoutDestinationSchema.optional(),
    /** fiat-issue only. */
    payer: payerSchema.optional(),
    counterparty: screeningCounterpartySchema.optional(),
    /** Caller-supplied reference; when omitted the API mints `op:<type>:<hex>`. */
    reference: z
      .string()
      .regex(/^op:[a-z-]+:[0-9a-fA-F-]{8,64}$/, 'reference must be op:<type>:<hex>')
      .optional(),
    metadata: conversionMetadataSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const crypto = v.type === 'crypto-issue' || v.type === 'crypto-redeem';
    if (crypto && !v.pair) {
      ctx.addIssue({
        code: 'custom',
        path: ['pair'],
        message: 'pair is required for crypto legs',
      });
    }
    if (!crypto && v.pair) {
      ctx.addIssue({
        code: 'custom',
        path: ['pair'],
        message: 'pair is not used on fiat legs',
      });
    }
    if (v.type === 'fiat-redeem' && !v.payout) {
      ctx.addIssue({
        code: 'custom',
        path: ['payout'],
        message: 'payout is required for fiat-redeem',
      });
    }
    if (v.type !== 'fiat-redeem' && v.payout) {
      ctx.addIssue({
        code: 'custom',
        path: ['payout'],
        message: 'payout applies to fiat-redeem only',
      });
    }
    if (v.type === 'fiat-issue' && !v.payer) {
      ctx.addIssue({
        code: 'custom',
        path: ['payer'],
        message: 'payer is required for fiat-issue',
      });
    }
    if (v.type !== 'fiat-issue' && v.payer) {
      ctx.addIssue({
        code: 'custom',
        path: ['payer'],
        message: 'payer applies to fiat-issue only',
      });
    }
    if (
      (v.type === 'fiat-issue' || v.type === 'fiat-redeem') &&
      !/^\d+(\.\d{1,2})?$/.test(v.amount)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'fiat amounts take at most 2 decimals',
      });
    }
    if (v.reference && !v.reference.startsWith(`op:${v.type}:`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference'],
        message: `reference must start with op:${v.type}:`,
      });
    }
  });
export type CreateConversionRequest = z.infer<typeof createConversionRequestSchema>;

/** Voucher as returned to the merchant; every uint is a decimal string. */
export const voucherWireSchema = z.object({
  kind: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  wallet: evmAddressSchema,
  tokenIn: evmAddressSchema,
  amountIn: uintStringSchema,
  amountOut: uintStringSchema,
  deadline: uintStringSchema,
  nonce: uintStringSchema,
  opRef: bytes32Schema,
  payoutRef: bytes32Schema,
});

export const issuedVoucherSchema = z.object({
  voucher: voucherWireSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  signer: evmAddressSchema,
  domain: z.object({
    name: z.literal('ENSCConverter'),
    version: z.literal('1'),
    chainId: z.number().int().positive(),
    verifyingContract: evmAddressSchema,
  }),
  /** ISO-8601 of `voucher.deadline`. */
  expiresAt: z.string(),
  /** Token the wallet must have approved to the converter before the call, or null. */
  approvalToken: evmAddressSchema.nullable(),
  /** `approve(converter, amountIn)` calldata when an approval is needed. */
  approvalTransaction: unsignedTransactionSchema.nullable(),
  /** The converter call carrying the voucher and signature. */
  transaction: unsignedTransactionSchema,
});
export type IssuedVoucher = z.infer<typeof issuedVoucherSchema>;

/** Bank-transfer instructions for a fiat-issue: the payer transfers NGN here. */
export const paymentInstructionsSchema = z.object({
  method: z.literal('bank_transfer'),
  accountNumber: z.string(),
  bankName: z.string(),
  /** What to transfer (principal plus provider fee), NGN 2 dp. */
  transferAmount: z.string(),
  currency: z.literal('NGN'),
  expiresAt: z.string().nullable(),
  note: z.string().nullable(),
  /** The reference the payer may see on the provider's side. */
  providerReference: z.string(),
});
export type PaymentInstructions = z.infer<typeof paymentInstructionsSchema>;

export const conversionStageSchema = z.object({
  name: z.string(),
  ts: z.number().int(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const conversionSchema = z.object({
  id: z.string(),
  reference: z.string(),
  type: conversionTypeSchema,
  status: conversionStatusSchema,
  env: envSchema,
  chain: chainSlugSchema,
  chainId: z.number().int().positive(),
  wallet: evmAddressSchema,
  tokenIn: z.string(),
  tokenOut: z.string(),
  /** Base units, decimal strings. */
  amountIn: z.string(),
  amountOut: z.string(),
  /** Major units for display. */
  amountInFormatted: z.string(),
  amountOutFormatted: z.string(),
  fiatAmountNgn: z.string().nullable(),
  usdValueCents: z.number().int().nullable(),
  screening: z.object({
    status: z.enum(['APPROVED', 'IN_REVIEW', 'DECLINED', 'AWAITING_USER', 'SKIPPED']),
  }),
  voucher: issuedVoucherSchema.nullable(),
  paymentInstructions: paymentInstructionsSchema.nullable(),
  payout: z
    .object({
      bankCode: z.string(),
      accountLast4: z.string(),
      status: z.enum([
        'pending',
        'initiated',
        'in_progress',
        'successful',
        'failed',
        'requires_manual_review',
      ]),
      providerTransferId: z.string().nullable(),
    })
    .nullable(),
  txHash: z.string().nullable(),
  onchainVerifiedAt: z.number().int().nullable(),
  stages: z.array(conversionStageSchema),
  metadata: conversionMetadataSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Conversion = z.infer<typeof conversionSchema>;

export const listConversionsResponseSchema = z.object({
  conversions: z.array(conversionSchema),
  pagination: paginationSchema,
});
export type ListConversionsResponse = z.infer<typeof listConversionsResponseSchema>;

/** The merchant reports what happened to the transaction it signed. */
export const conversionEventRequestSchema = z
  .object({
    event: z.enum(['onchain_submitted', 'onchain_confirmed', 'failed']),
    txHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    error: z.string().max(512).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.event !== 'failed' && !v.txHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['txHash'],
        message: 'txHash is required',
      });
    }
  });
export type ConversionEventRequest = z.infer<typeof conversionEventRequestSchema>;

export const quoteRequestSchema = z.object({
  type: z.enum(['crypto-issue', 'crypto-redeem']),
  chain: chainSlugSchema,
  pair: pairSymbolSchema,
  amount: decimalAmountSchema,
});

export const quoteResponseSchema = z.object({
  type: z.enum(['crypto-issue', 'crypto-redeem']),
  chain: chainSlugSchema,
  pair: pairSymbolSchema,
  /** Base units, decimal strings. */
  amountIn: z.string(),
  amountOut: z.string(),
  amountInFormatted: z.string(),
  amountOutFormatted: z.string(),
  /** NGN per one pair token, 8 dp scaled integer as the oracle reports it. */
  oracleRate: z.string(),
  oracleUpdatedAt: z.number().int().nullable(),
  /** crypto-redeem: the most ENSC that can currently be redeemed into this pair, base units. */
  redeemCapacityIn: z.string().nullable(),
  /** Seconds the quote is expected to hold (the voucher deadline window). */
  validForSeconds: z.number().int(),
});
export type QuoteRequest = z.infer<typeof quoteRequestSchema>;
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

export const screeningStatusResponseSchema = z.object({
  reference: z.string(),
  status: z.enum(['APPROVED', 'IN_REVIEW', 'DECLINED', 'AWAITING_USER', 'SKIPPED']),
  updatedAt: z.number().int().nullable(),
});
export type ScreeningStatusResponse = z.infer<typeof screeningStatusResponseSchema>;

// =====================================================================================
// API Keys (CRUD via merchant dashboard, not via SDK)
// =====================================================================================

export const createApiKeyRequestSchema = z.object({
  env: envSchema,
  kind: z.enum(['pk', 'sk', 'rk']),
  name: z.string().min(1).max(64).optional(),
  scopes: z.array(z.string()),
  /** CIDR allowlist. Required (min 1) when env is live; optional for test. */
  ipAllowlist: ipAllowlistSchema.optional(),
  rateLimitPerMinute: z.number().int().positive().max(100_000).optional(),
  expiresAt: z.number().int().positive().optional(), // unix seconds
});

export const createApiKeyResponseSchema = z.object({
  id: z.string(),
  env: envSchema,
  kind: z.enum(['pk', 'sk', 'rk']),
  prefix: z.string(),
  scopes: z.array(z.string()),
  /** The key's CIDR allowlist at issuance (empty for an unrestricted test key). */
  ipAllowlist: z.array(z.string()),
  /** ONLY returned at creation. Never again. */
  plaintext: z.string(),
  createdAt: z.number(),
});

export const apiKeySummarySchema = z.object({
  id: z.string(),
  env: envSchema,
  kind: z.enum(['pk', 'sk', 'rk']),
  prefix: z.string(),
  name: z.string().nullable(),
  scopes: z.array(z.string()),
  /** Current CIDR allowlist; empty means any address (test keys only). */
  ipAllowlist: z.array(z.string()),
  status: z.enum(['active', 'rotated', 'revoked']),
  lastUsedAt: z.number().nullable(),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
});

export const listApiKeysResponseSchema = z.object({
  keys: z.array(apiKeySummarySchema),
  pagination: paginationSchema,
});

export const updateIpAllowlistRequestSchema = z.object({
  ipAllowlist: ipAllowlistSchema,
});

export const updateIpAllowlistResponseSchema = z.object({
  id: z.string(),
  ipAllowlist: ipAllowlistSchema,
});

export const rotateApiKeyResponseSchema = z.object({
  oldKeyId: z.string(),
  /** Unix seconds after which the old key stops working (24h overlap). */
  oldKeyExpiresAt: z.number(),
  newKey: createApiKeyResponseSchema,
});

export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponseSchema>;
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;
export type ListApiKeysResponse = z.infer<typeof listApiKeysResponseSchema>;
export type UpdateIpAllowlistRequest = z.infer<typeof updateIpAllowlistRequestSchema>;
export type UpdateIpAllowlistResponse = z.infer<typeof updateIpAllowlistResponseSchema>;
export type RotateApiKeyResponse = z.infer<typeof rotateApiKeyResponseSchema>;

// =====================================================================================
// Allowed origins (per-merchant CORS allowlist)
// =====================================================================================

export const createAllowedOriginRequestSchema = z.object({
  env: envSchema,
  /** Exact origin (https://example.com) or 'regex:^https://.*\\.example\\.com$' */
  origin: z.string().min(1).max(512),
});

export const createAllowedOriginResponseSchema = z.object({
  id: z.string(),
  env: envSchema,
  origin: z.string(),
  createdAt: z.number(),
});

export const listAllowedOriginsResponseSchema = z.object({
  origins: z.array(
    z.object({
      id: z.string(),
      env: envSchema,
      origin: z.string(),
      createdAt: z.number(),
    }),
  ),
  pagination: paginationSchema,
});

export type CreateAllowedOriginRequest = z.infer<typeof createAllowedOriginRequestSchema>;
export type CreateAllowedOriginResponse = z.infer<typeof createAllowedOriginResponseSchema>;
export type ListAllowedOriginsResponse = z.infer<typeof listAllowedOriginsResponseSchema>;

// =====================================================================================
// Signing keys (merchant Ed25519 public-key registration)
// =====================================================================================

export const registerSigningKeyRequestSchema = z.object({
  env: envSchema,
  publicKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43,44}$/, 'Must be base64url-encoded 32-byte Ed25519 public key'),
  name: z.string().max(64).optional(),
});

export const registerSigningKeyResponseSchema = z.object({
  id: z.string(),
  env: envSchema,
  publicKey: z.string(),
  status: z.enum(['active', 'rotated', 'revoked']),
  createdAt: z.number(),
});

export type RegisterSigningKeyRequest = z.infer<typeof registerSigningKeyRequestSchema>;
export type RegisterSigningKeyResponse = z.infer<typeof registerSigningKeyResponseSchema>;

// =====================================================================================
// Encryption keys (ENSC-ENC-V1 request envelope; dashboard-only issuance)
// =====================================================================================

export const encKeyIdSchema = z.string().regex(/^enc_[0-9A-Z]{26}$/);

export const createEncryptionKeyRequestSchema = z.object({
  env: envSchema,
  name: z.string().min(1).max(64).optional(),
});

export const createEncryptionKeyResponseSchema = z.object({
  id: encKeyIdSchema,
  env: envSchema,
  name: z.string().nullable(),
  status: z.literal('active'),
  /** Raw 32-byte AES-256 key, base64url. Returned ONCE at creation. */
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: z.number(),
});

export const encryptionKeySummarySchema = z.object({
  id: encKeyIdSchema,
  env: envSchema,
  name: z.string().nullable(),
  status: z.enum(['active', 'rotated', 'revoked']),
  expiresAt: z.number().nullable(),
  createdAt: z.number(),
});

export const listEncryptionKeysResponseSchema = z.object({
  keys: z.array(encryptionKeySummarySchema),
  pagination: paginationSchema,
});

export const rotateEncryptionKeyResponseSchema = z.object({
  oldKeyId: encKeyIdSchema,
  oldKeyExpiresAt: z.number(),
  newKey: createEncryptionKeyResponseSchema,
});

export type CreateEncryptionKeyRequest = z.infer<typeof createEncryptionKeyRequestSchema>;
export type CreateEncryptionKeyResponse = z.infer<typeof createEncryptionKeyResponseSchema>;
export type EncryptionKeySummary = z.infer<typeof encryptionKeySummarySchema>;
export type ListEncryptionKeysResponse = z.infer<typeof listEncryptionKeysResponseSchema>;
export type RotateEncryptionKeyResponse = z.infer<typeof rotateEncryptionKeyResponseSchema>;

// =====================================================================================
// Signing key rotation
// =====================================================================================

export const rotateSigningKeyResponseSchema = z.object({
  oldKeyId: z.string(),
  oldKeyExpiresAt: z.number(),
  newKey: registerSigningKeyResponseSchema,
});

export type RotateSigningKeyResponse = z.infer<typeof rotateSigningKeyResponseSchema>;

// =====================================================================================
// Wire envelopes
// =====================================================================================

/**
 * ENSC-ENC-V1: the body of every mutating merchant-key request. The plaintext
 * JSON (validated by the route schema after decryption) is AES-256-GCM
 * encrypted under the merchant's encryption key with request-bound AAD.
 */
export const encryptedRequestEnvelopeSchema = z
  .object({
    v: z.literal(1),
    encKeyId: encKeyIdSchema,
    /** 12-byte IV, base64url (16 chars). */
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{1,1398104}$/),
    /** 16-byte GCM tag, base64url (22 chars). */
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

/**
 * ENSC-RESP-V1: the body of every successful merchant-key response. HPKE
 * (RFC 9180, X25519 + HKDF-SHA256 + ChaCha20-Poly1305) sealed to the merchant's
 * registered public key. Signed by ENSC via X-ENSC-Signature.
 */
export const sealedResponseEnvelopeSchema = z
  .object({
    v: z.literal(1),
    /** Ephemeral X25519 public key, base64url (32 bytes, 43 chars). */
    enc: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    ciphertext: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
  })
  .strict();

export type EncryptedRequestEnvelope = z.infer<typeof encryptedRequestEnvelopeSchema>;
export type SealedResponseEnvelope = z.infer<typeof sealedResponseEnvelopeSchema>;

/** Published ENSC signing public keys (webhooks and sealed responses). */
export const publicKeysResponseSchema = z.object({
  keys: z.array(
    z.object({
      kid: z.string(),
      alg: z.literal('Ed25519'),
      /** 32-byte public key, base64url. */
      publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      use: z.array(z.enum(['webhooks', 'responses'])),
    }),
  ),
});
export type PublicKeysResponse = z.infer<typeof publicKeysResponseSchema>;
