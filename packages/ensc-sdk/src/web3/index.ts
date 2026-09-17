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
 *   2. The `signer` passed here is either a raw wallet private key or any viem
 *      account (a local account, an HSM/KMS/custody account made with
 *      `toAccount`, or a JSON-RPC account from a connected wallet). It is a
 *      separate secret from the ENSC API credentials, it never touches the
 *      ENSC API, and it is never stored: it is passed per call and used only to
 *      sign locally. Do not put it in `EnscClient` config. The wallet must be
 *      the `wallet` named on the conversion, because the voucher binds to it.
 *      A browser wallet signs the same `{ from, to, data, value, chainId }`
 *      calldata directly; this helper is the backend convenience.
 *
 * Gas, fees and nonce are filled from the RPC at send time. Gas is estimated
 * first, without fee fields, and sent as an explicit limit with a margin.
 * Without an explicit limit some nodes estimate at the block gas limit and
 * charge that much gas up front from the wallet during the simulation; on
 * Celo the native balance is also the CELO ERC-20 balance, so a converter
 * call that pulls CELO then sees an almost empty wallet and reverts with
 * "transfer value exceeded balance of sender" unless the wallet holds several
 * CELO more than the amount.
 */

import type * as api from '@ensc/api-schemas';
import { EnscError } from '@ensc/protocol';

/** The calldata shape the API returns: `{ to, data, value: '0', chainId }`. */
export type UnsignedTransaction = api.UnsignedTransaction;

/** A hex-encoded private key, `0x`-prefixed. */
export type HexPrivateKey = `0x${string}`;

/**
 * Any viem account: a local account (`privateKeyToAccount`, `mnemonicToAccount`,
 * or `toAccount` around an HSM, KMS or custody signer) or a JSON-RPC account
 * backed by a wallet the user connected. The helper only needs `address` and
 * the ability to sign a transaction through a wallet client.
 */
export interface SignerAccount {
  address: `0x${string}`;
  type: 'local' | 'json-rpc';
}

/**
 * What signs the calldata: a raw private key (the simplest backend case), or
 * a viem account of any kind. ENSC never sees either.
 */
export type Signer = HexPrivateKey | SignerAccount;

export interface BroadcastOptions {
  /** JSON-RPC endpoint for the transaction's chain. */
  rpcUrl: string;
  /** Wait for the receipt before returning. Default true. */
  waitForReceipt?: boolean;
  /**
   * Gas limit to send with. Default: the node's estimate plus 30 percent.
   * Pass a value to skip estimation, for example when your node cannot
   * simulate the call.
   */
  gas?: bigint;
  /** Margin added to the estimate, in percent. Default 30. Ignored when `gas` is set. */
  gasMarginPercent?: number;
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

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function assertTx(tx: UnsignedTransaction): void {
  if (!ADDRESS_RE.test(tx.to) || !/^0x[0-9a-fA-F]*$/.test(tx.data) || tx.value !== '0') {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'unsignedTransaction is malformed');
  }
  if (tx.from !== undefined && !ADDRESS_RE.test(tx.from)) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'unsignedTransaction.from is malformed');
  }
  if (!Number.isInteger(tx.chainId) || tx.chainId <= 0) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'unsignedTransaction.chainId is required');
  }
}

function gasLimitFor(estimate: bigint, marginPercent: number | undefined): bigint {
  const margin = marginPercent === undefined ? 30 : marginPercent;
  if (!Number.isFinite(margin) || margin < 0 || margin > 1000) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'gasMarginPercent must be between 0 and 1000');
  }
  return estimate + (estimate * BigInt(Math.round(margin))) / 100n;
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
  signer: Signer,
  options: BroadcastOptions,
): Promise<BroadcastResult> {
  if (!options?.rpcUrl) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'options.rpcUrl is required to broadcast');
  }
  assertTx(unsignedTransaction);
  if (options.gas !== undefined && options.gas <= 0n) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'options.gas must be a positive gas limit');
  }
  const { core, accounts } = await loadViem();
  const account = typeof signer === 'string' ? accounts.privateKeyToAccount(signer) : signer;
  if (!ADDRESS_RE.test(account.address)) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'The signer has no valid address');
  }
  if (
    unsignedTransaction.from !== undefined &&
    unsignedTransaction.from.toLowerCase() !== account.address.toLowerCase()
  ) {
    throw new EnscError(
      'ENSC_VALIDATION_FAILED',
      `This transaction must be signed by ${unsignedTransaction.from}, not by ${account.address}`,
    );
  }
  const chain = core.defineChain({
    id: unsignedTransaction.chainId,
    name: `chain-${unsignedTransaction.chainId}`,
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const transport = core.http(options.rpcUrl);
  const publicClient = core.createPublicClient({ chain, transport });
  const to = unsignedTransaction.to as `0x${string}`;
  const data = unsignedTransaction.data as `0x${string}`;

  let rpcChainId: number;
  try {
    rpcChainId = await publicClient.getChainId();
  } catch (err) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `The RPC endpoint did not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (rpcChainId !== unsignedTransaction.chainId) {
    throw new EnscError(
      'ENSC_VALIDATION_FAILED',
      `options.rpcUrl serves chain ${rpcChainId}; the transaction is for chain ${unsignedTransaction.chainId}`,
    );
  }

  let gas = options.gas;
  if (gas === undefined) {
    try {
      // The account is passed as an address so no fee fields are attached to
      // the estimate; see the note at the top of this file.
      const estimate = await publicClient.estimateGas({
        account: account.address,
        to,
        data,
        value: 0n,
      });
      gas = gasLimitFor(estimate, options.gasMarginPercent);
    } catch (err) {
      if (err instanceof EnscError) throw err;
      throw new EnscError(
        'ENSC_UPSTREAM_FAILED',
        `The transaction would fail: ${describeRpcError(err)}`,
      );
    }
  }

  // A viem account of either kind is accepted by createWalletClient; the
  // structural SignerAccount type is what this module promises, so cast here.
  const wallet = core.createWalletClient({
    account: account as Parameters<typeof core.createWalletClient>[0]['account'],
    chain,
    transport,
  });
  let txHash: `0x${string}`;
  try {
    txHash = await wallet.sendTransaction({ to, data, value: 0n, gas } as Parameters<
      typeof wallet.sendTransaction
    >[0]);
  } catch (err) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Failed to broadcast transaction: ${describeRpcError(err)}`,
    );
  }
  if (options.waitForReceipt === false) return { txHash };
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, status: receipt.status, blockNumber: receipt.blockNumber };
  } catch (err) {
    throw new EnscError(
      'ENSC_UPSTREAM_FAILED',
      `Transaction ${txHash} was sent but its receipt could not be read: ${describeRpcError(err)}`,
      { txHash },
    );
  }
}

/** viem errors carry a one-line summary next to a long multi-line message. */
function describeRpcError(err: unknown): string {
  if (err && typeof err === 'object' && 'shortMessage' in err) {
    return String((err as { shortMessage: unknown }).shortMessage);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute an issued voucher: the approval first (when the API returned one),
 * then the converter call. Returns both hashes; report `transaction.txHash`
 * to `conversions.events.confirmed`.
 */
export async function executeVoucher(
  voucher: api.IssuedVoucher,
  signer: Signer,
  options: BroadcastOptions,
): Promise<{ approval: BroadcastResult | null; transaction: BroadcastResult }> {
  if (Number(voucher.voucher.deadline) * 1000 <= Date.now()) {
    throw new EnscError('ENSC_VALIDATION_FAILED', 'The voucher has expired; request a new one');
  }
  if (
    ADDRESS_RE.test(voucher.voucher.wallet) &&
    voucher.transaction.from !== undefined &&
    voucher.transaction.from.toLowerCase() !== voucher.voucher.wallet.toLowerCase()
  ) {
    throw new EnscError(
      'ENSC_VALIDATION_FAILED',
      'The voucher is bound to a different wallet than its transaction',
    );
  }
  let approval: BroadcastResult | null = null;
  if (voucher.approvalTransaction) {
    approval = await signAndBroadcast(voucher.approvalTransaction, signer, {
      ...options,
      waitForReceipt: true,
    });
    if (approval.status === 'reverted') {
      throw new EnscError('ENSC_UPSTREAM_FAILED', 'The approval transaction reverted', {
        txHash: approval.txHash,
      });
    }
  }
  const transaction = await signAndBroadcast(voucher.transaction, signer, options);
  if (transaction.status === 'reverted') {
    // Do not report this hash as confirmed; report the conversion failed.
    throw new EnscError('ENSC_UPSTREAM_FAILED', 'The converter call reverted', {
      txHash: transaction.txHash,
    });
  }
  return { approval, transaction };
}
