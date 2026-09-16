import { describe, expect, it, vi } from 'vitest';

// Mock viem + viem/accounts BEFORE importing the web3 helper, since the helper
// lazy-imports them. The mock simulates a wallet client that accepts the tx and
// a public client that returns the receipt.
const sendTransaction = vi.fn(async () => '0xtxhash' as const);
const waitForTransactionReceipt = vi.fn(async () => ({
  status: 'success' as const,
  blockNumber: 42n,
}));
const defineChain = vi.fn((c: unknown) => c);

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({ sendTransaction })),
  createPublicClient: vi.fn(() => ({ waitForTransactionReceipt })),
  defineChain,
  http: vi.fn(() => ({})),
}));
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({ address: `0x${'1'.repeat(40)}` })),
}));

const { signAndBroadcast, executeVoucher } = await import('../src/web3/index.js');

const unsignedTx = {
  to: `0x${'1'.repeat(40)}`,
  data: '0xdeadbeef',
  value: '0' as const,
  chainId: 42220,
};

const walletKey = `0x${'a'.repeat(64)}` as `0x${string}`;

describe('web3 helper', () => {
  it('signAndBroadcast sends through a wallet client bound to the calldata chain id and waits for the receipt', async () => {
    const res = await signAndBroadcast(unsignedTx, walletKey, {
      rpcUrl: 'https://rpc.example.com',
    });
    expect(res).toEqual({ txHash: '0xtxhash', status: 'success', blockNumber: 42n });
    expect(sendTransaction).toHaveBeenCalledWith({
      to: unsignedTx.to,
      data: '0xdeadbeef',
      value: 0n,
    });
    expect(defineChain).toHaveBeenCalledWith(expect.objectContaining({ id: 42220 }));
  });

  it('can return as soon as the hash is known', async () => {
    waitForTransactionReceipt.mockClear();
    const res = await signAndBroadcast(unsignedTx, walletKey, {
      rpcUrl: 'https://rpc.example.com',
      waitForReceipt: false,
    });
    expect(res).toEqual({ txHash: '0xtxhash' });
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('throws ENSC_VALIDATION_FAILED when rpcUrl is missing or the calldata is malformed', async () => {
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl: '' })).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
    await expect(
      signAndBroadcast({ ...unsignedTx, value: '1' as never }, walletKey, {
        rpcUrl: 'https://rpc.example.com',
      }),
    ).rejects.toMatchObject({ code: 'ENSC_VALIDATION_FAILED' });
  });

  it('executeVoucher sends the approval first, then the converter call, and refuses an expired voucher', async () => {
    sendTransaction.mockClear();
    const voucher = {
      voucher: { deadline: String(Math.floor(Date.now() / 1000) + 300) },
      approvalTransaction: { ...unsignedTx, to: `0x${'2'.repeat(40)}` },
      transaction: unsignedTx,
    } as never;
    const res = await executeVoucher(voucher, walletKey, { rpcUrl: 'https://rpc.example.com' });
    expect(res.approval?.txHash).toBe('0xtxhash');
    expect(res.transaction.txHash).toBe('0xtxhash');
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({ to: `0x${'2'.repeat(40)}` });

    const expired = { ...(voucher as { voucher: object }), voucher: { deadline: '1' } } as never;
    await expect(
      executeVoucher(expired, walletKey, { rpcUrl: 'https://rpc.example.com' }),
    ).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
  });
});
