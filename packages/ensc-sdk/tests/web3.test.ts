import { describe, expect, it, vi } from 'vitest';

// Mock viem + viem/accounts BEFORE importing the web3 helper, since the helper
// lazy-imports them. The mock simulates a wallet client that accepts the tx and
// a public client that answers the chain id, the gas estimate and the receipt.
const WALLET = `0x${'1'.repeat(40)}` as const;
const sendTransaction = vi.fn(async () => '0xtxhash' as const);
const waitForTransactionReceipt = vi.fn(async () => ({
  status: 'success' as const,
  blockNumber: 42n,
}));
const getChainId = vi.fn(async () => 42220);
const estimateGas = vi.fn(async () => 100_000n);
const defineChain = vi.fn((c: unknown) => c);

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({ sendTransaction })),
  createPublicClient: vi.fn(() => ({ waitForTransactionReceipt, getChainId, estimateGas })),
  defineChain,
  http: vi.fn(() => ({})),
}));
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({ address: WALLET })),
}));

const { signAndBroadcast, executeVoucher } = await import('../src/web3/index.js');

const unsignedTx = {
  from: WALLET,
  to: `0x${'1'.repeat(40)}`,
  data: '0xdeadbeef',
  value: '0' as const,
  chainId: 42220,
};

const walletKey = `0x${'a'.repeat(64)}` as `0x${string}`;
const rpcUrl = 'https://rpc.example.com';

describe('web3 helper', () => {
  it('estimates gas without fee fields, then sends with the estimate plus 30 percent', async () => {
    sendTransaction.mockClear();
    estimateGas.mockClear();
    const res = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl });
    expect(res).toEqual({ txHash: '0xtxhash', status: 'success', blockNumber: 42n });
    // The account is passed as an address (no fee fields are attached to the estimate).
    expect(estimateGas).toHaveBeenCalledWith({
      account: WALLET,
      to: unsignedTx.to,
      data: '0xdeadbeef',
      value: 0n,
    });
    expect(sendTransaction).toHaveBeenCalledWith({
      to: unsignedTx.to,
      data: '0xdeadbeef',
      value: 0n,
      gas: 130_000n,
    });
    expect(defineChain).toHaveBeenCalledWith(expect.objectContaining({ id: 42220 }));
  });

  it('an explicit gas limit skips estimation; the margin is configurable', async () => {
    sendTransaction.mockClear();
    estimateGas.mockClear();
    await signAndBroadcast(unsignedTx, walletKey, { rpcUrl, gas: 250_000n });
    expect(estimateGas).not.toHaveBeenCalled();
    expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({ gas: 250_000n });

    sendTransaction.mockClear();
    await signAndBroadcast(unsignedTx, walletKey, { rpcUrl, gasMarginPercent: 0 });
    expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({ gas: 100_000n });

    await expect(
      signAndBroadcast(unsignedTx, walletKey, { rpcUrl, gas: 0n }),
    ).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
  });

  it('a failed simulation is reported with the node reason and nothing is broadcast', async () => {
    sendTransaction.mockClear();
    estimateGas.mockRejectedValueOnce(
      Object.assign(new Error('long\nmulti-line'), {
        shortMessage: 'Execution reverted with reason: transfer value exceeded balance of sender.',
      }),
    );
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      message: expect.stringContaining('transfer value exceeded balance of sender'),
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses an RPC endpoint on another chain', async () => {
    getChainId.mockResolvedValueOnce(1);
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
      message: expect.stringContaining('chain 1'),
    });
  });

  it('refuses a key that is not the wallet named in `from`', async () => {
    await expect(
      signAndBroadcast({ ...unsignedTx, from: `0x${'2'.repeat(40)}` }, walletKey, { rpcUrl }),
    ).rejects.toMatchObject({ code: 'ENSC_VALIDATION_FAILED' });
  });

  it('can return as soon as the hash is known', async () => {
    waitForTransactionReceipt.mockClear();
    const res = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl, waitForReceipt: false });
    expect(res).toEqual({ txHash: '0xtxhash' });
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('throws ENSC_VALIDATION_FAILED when rpcUrl is missing or the calldata is malformed', async () => {
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl: '' })).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
    await expect(
      signAndBroadcast({ ...unsignedTx, value: '1' as never }, walletKey, { rpcUrl }),
    ).rejects.toMatchObject({ code: 'ENSC_VALIDATION_FAILED' });
    await expect(
      signAndBroadcast({ ...unsignedTx, from: '0x12' }, walletKey, { rpcUrl }),
    ).rejects.toMatchObject({ code: 'ENSC_VALIDATION_FAILED' });
  });

  it('executeVoucher sends the approval first, then the converter call, and refuses an expired voucher', async () => {
    sendTransaction.mockClear();
    const voucher = {
      voucher: { deadline: String(Math.floor(Date.now() / 1000) + 300), wallet: WALLET },
      approvalTransaction: { ...unsignedTx, to: `0x${'2'.repeat(40)}` },
      transaction: unsignedTx,
    } as never;
    const res = await executeVoucher(voucher, walletKey, { rpcUrl });
    expect(res.approval?.txHash).toBe('0xtxhash');
    expect(res.transaction.txHash).toBe('0xtxhash');
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({ to: `0x${'2'.repeat(40)}` });

    const expired = { ...(voucher as { voucher: object }), voucher: { deadline: '1' } } as never;
    await expect(executeVoucher(expired, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
  });

  it('accepts a viem account object as the signer (custody, KMS or connected wallet)', async () => {
    sendTransaction.mockClear();
    const account = { address: WALLET, type: 'json-rpc' as const };
    const res = await signAndBroadcast(unsignedTx, account, { rpcUrl });
    expect(res.txHash).toBe('0xtxhash');
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    await expect(
      signAndBroadcast(unsignedTx, { address: `0x${'9'.repeat(40)}`, type: 'local' }, { rpcUrl }),
    ).rejects.toMatchObject({ code: 'ENSC_VALIDATION_FAILED' });
  });

  it('a reverted converter call is an error carrying the hash, never a result to report as confirmed', async () => {
    waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted' as const,
      blockNumber: 43n,
    });
    const voucher = {
      voucher: { deadline: String(Math.floor(Date.now() / 1000) + 300), wallet: WALLET },
      approvalTransaction: null,
      transaction: unsignedTx,
    } as never;
    await expect(executeVoucher(voucher, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      details: { txHash: '0xtxhash' },
    });
  });

  it('a receipt that cannot be read is an EnscError carrying the hash', async () => {
    waitForTransactionReceipt.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { shortMessage: 'Timed out while waiting for transaction' }),
    );
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      details: { txHash: '0xtxhash' },
      message: expect.stringContaining('Timed out'),
    });
  });

  it('executeVoucher refuses a voucher whose wallet is not the transaction signer', async () => {
    const voucher = {
      voucher: {
        deadline: String(Math.floor(Date.now() / 1000) + 300),
        wallet: `0x${'3'.repeat(40)}`,
      },
      approvalTransaction: null,
      transaction: unsignedTx,
    } as never;
    await expect(executeVoucher(voucher, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
  });
});
