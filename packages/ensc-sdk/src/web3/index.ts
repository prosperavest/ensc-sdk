/**
 * `@ensc/sdk/web3`: optional signing + broadcast helper.
 *
 * The core SDK returns calldata (`unsignedTransaction`, or a voucher's
 * `approvalTransaction` and `transaction`) and stops there: ENSC never signs
 * or broadcasts. This module is the opt-in convenience for consumers who do
 * not want to wire up a chain library themselves.
 *
 * Two things to understand about keys:
 *
 *   1. `viem` is a peer/optional dependency. It is imported lazily, only when a
 *      function here is actually called; core consumers never load it.
 *   2. The `walletPrivateKey` passed here is your on-chain EOA key. It is a
 *      separate secret from the ENSC API credentials, it never touches the
 *      ENSC API, and it is never stored: it is passed per call and used only to
 *      sign locally. Do not put it in `EnscClient` config. The wallet must be
 *      the `wallet` named on the conversion, because the voucher binds to it.
 *
 * Gas, fees and nonce are filled from the RPC at send time.
 */

import type * as api from '@ensc/api-schemas';
import { EnscError } from '@ensc/protocol';

/** The calldata shape the API returns: `{ to, data, value: '0', chainId }`. */
export type UnsignedTransaction = api.UnsignedTransaction;

/** A hex-encoded private key, `0x`-prefixed. */
export type HexPrivateKey = `0x${string}`;

export interface BroadcastOptions {
  /** JSON-RPC endpoint for the transaction's chain. */
  rpcUrl: string;
  /** Wait for the receipt before returning. Default true. */
  waitForReceipt?: boolean;
}

export interface BroadcastResult {
  txHash: `0x${string}`;
  /** Present when `waitForReceipt` was not disabled. */
  status?: 'success' | 'reverted';
  blockNumber?: bigint;
}

function assertViemAvailable(err: unknown): never {
  throw new EnscError(
    'ENSC_NOT_IMPLEMENTED',
    "The '@ensc/sdk/web3' helper requires the optional peer dependency 'viem'. " +
      'Install it with: npm install viem',
    { cause: err instanceof Error ? err.message : String(err) },
  );
}

async function loadViem() {
  try {
    const [core, accounts] = await Promise.all([import('viem'), import('viem/accounts')]);
    return { core, accounts };
  } catch (err) {
    assertViemAvailable(err);
  }
}

function assertTx(tx: UnsignedTransaction): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to) || !/^0x[0-9a-fA-F]*$/.test(tx.data) || tx.value !== '0') {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'unsignedTransaction is malformed');
  }
  if (!Number.isInteger(tx.chainId) || tx.chainId <= 0) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'unsignedTransaction.chainId is required');
  }
}

/**
 * Sign an ENSC `unsignedTransaction` with a wallet key and broadcast it
 * through the given RPC endpoint. The chain id in the calldata must match the
 * endpoint; viem refuses otherwise. Returns the transaction hash and, by
 * default, the receipt status.
 *
 *   const c = await ensc.conversions.create({ ... });
 *   if (c.voucher?.approvalTransaction) await signAndBroadcast(c.voucher.approvalTransaction, key, { rpcUrl });
 *   const { txHash } = await signAndBroadcast(c.voucher!.transaction, key, { rpcUrl });
 *   await ensc.conversions.events.confirmed(c.reference, txHash);
 */
export async function signAndBroadcast(
  unsignedTransaction: UnsignedTransaction,
  walletPrivateKey: HexPrivateKey,
  options: BroadcastOptions,
): Promise<BroadcastResult> {
  if (!options?.rpcUrl) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'options.rpcUrl is required to broadcast');
  }
  assertTx(unsignedTransaction);
  const { core, accounts } = await loadViem();
  const account = accounts.privateKeyToAccount(walletPrivateKey);
  const chain = core.defineChain({
    id: unsignedTransaction.chainId,
    name: `chain-${unsignedTransaction.chainId}`,
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const transport = core.http(options.rpcUrl);
  const wallet = core.createWalletClient({ account, chain, transport });
  let txHash: `0x${string}`;
  try {
    txHash = await wallet.sendTransaction({
      to: unsignedTransaction.to as `0x${string}`,
      data: unsignedTransaction.data as `0x${string}`,
      value: 0n,
    });
  } catch (err) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Failed to broadcast transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (options.waitForReceipt === false) return { txHash };
  const publicClient = core.createPublicClient({ chain, transport });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash, status: receipt.status, blockNumber: receipt.blockNumber };
}

/**
 * Execute an issued voucher: the approval first (when the API returned one),
 * then the converter call. Returns both hashes; report `transaction.txHash`
 * to `conversions.events.confirmed`.
 */
export async function executeVoucher(
  voucher: api.IssuedVoucher,
  walletPrivateKey: HexPrivateKey,
  options: BroadcastOptions,
): Promise<{ approval: BroadcastResult | null; transaction: BroadcastResult }> {
  if (Number(voucher.voucher.deadline) * 1000 <= Date.now()) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'The voucher has expired; request a new one');
  }
  let approval: BroadcastResult | null = null;
  if (voucher.approvalTransaction) {
    approval = await signAndBroadcast(voucher.approvalTransaction, walletPrivateKey, {
      ...options,
      waitForReceipt: true,
    });
    if (approval.status === 'reverted') {
      throw new EnscError('ENSC_UPSTREAM_FAILED', 'The approval transaction reverted');
    }
  }
  const transaction = await signAndBroadcast(voucher.transaction, walletPrivateKey, options);
  return { approval, transaction };
}
