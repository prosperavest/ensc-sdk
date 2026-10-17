import { describe, expect, it, vi } from 'vitest';

// Mock viem + viem/accounts BEFORE importing the web3 helper, since the helper
// lazy-imports them. The mock simulates a wallet client that prepares and signs
// the tx (a local account) or sends it (a JSON-RPC account), and a public client
// that answers the chain id, the gas estimate, the send, the lookup of a hash
// and the receipt.
const WALLET = `0x${'1'.repeat(40)}` as const;
const SIGNED = '0x02signed' as const;
const sendTransaction = vi.fn(async () => '0xtxhash' as const);
const prepareTransactionRequest = vi.fn(async (r: Record<string, unknown>) => ({ ...r, nonce: 7 }));
const signTransaction = vi.fn(async () => SIGNED);
const sendRawTransaction = vi.fn(async () => '0xtxhash' as const);
/** eth_getTransactionByHash: null unless a test says the node holds it. */
const request = vi.fn(async (): Promise<unknown> => null);
const keccak256 = vi.fn(() => '0xtxhash' as const);
const waitForTransactionReceipt = vi.fn(async () => ({
  status: 'success' as const,
  blockNumber: 42n,
}));
const getChainId = vi.fn(async () => 42220);
const estimateGas = vi.fn(async () => 100_000n);
const defineChain = vi.fn((c: unknown) => c);

vi.mock('viem', () => ({
  createWalletClient: vi.fn(() => ({
    sendTransaction,
    prepareTransactionRequest,
    signTransaction,
  })),
  createPublicClient: vi.fn(() => ({
    waitForTransactionReceipt,
    getChainId,
    estimateGas,
    sendRawTransaction,
    request,
  })),
  defineChain,
  http: vi.fn(() => ({})),
  keccak256,
}));
vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({ address: WALLET, type: 'local', signTransaction: vi.fn() })),
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
    prepareTransactionRequest.mockClear();
    sendRawTransaction.mockClear();
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
    expect(prepareTransactionRequest).toHaveBeenCalledWith({
      to: unsignedTx.to,
      data: '0xdeadbeef',
      value: 0n,
      gas: 130_000n,
    });
    // Signed here, its hash taken from the signed bytes, sent once.
    expect(keccak256).toHaveBeenCalledWith(SIGNED);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledWith({ serializedTransaction: SIGNED });
    expect(defineChain).toHaveBeenCalledWith(expect.objectContaining({ id: 42220 }));
  });

  it('an explicit gas limit skips estimation; the margin is configurable', async () => {
    prepareTransactionRequest.mockClear();
    estimateGas.mockClear();
    await signAndBroadcast(unsignedTx, walletKey, { rpcUrl, gas: 250_000n });
    expect(estimateGas).not.toHaveBeenCalled();
    expect(prepareTransactionRequest.mock.calls[0]?.[0]).toMatchObject({ gas: 250_000n });

    prepareTransactionRequest.mockClear();
    await signAndBroadcast(unsignedTx, walletKey, { rpcUrl, gasMarginPercent: 0 });
    expect(prepareTransactionRequest.mock.calls[0]?.[0]).toMatchObject({ gas: 100_000n });

    await expect(
      signAndBroadcast(unsignedTx, walletKey, { rpcUrl, gas: 0n }),
    ).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
    });
  });

  it('a failed simulation is reported with the node reason and nothing is broadcast', async () => {
    sendRawTransaction.mockClear();
    estimateGas.mockRejectedValueOnce(
      Object.assign(new Error('long\nmulti-line'), {
        shortMessage: 'Execution reverted with reason: transfer value exceeded balance of sender.',
      }),
    );
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      message: expect.stringContaining('transfer value exceeded balance of sender'),
    });
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses an RPC endpoint on another chain', async () => {
    getChainId.mockResolvedValueOnce(1);
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_VALIDATION_FAILED',
      message: expect.stringContaining('chain 1'),
    });
  });

  it('never puts the RPC URL, which usually carries an access key, into an error message', async () => {
    const keyedUrl = 'https://rpc.example.com/v2/ACCESSKEY0123456789';
    // The chain library's request errors carry the full URL in their message
    // and a one-line summary beside it.
    const libraryError = (shortMessage: string) =>
      Object.assign(new Error(`${shortMessage}\n\nURL: ${keyedUrl}\nRequest body: {}`), {
        shortMessage,
      });

    getChainId.mockRejectedValueOnce(libraryError('HTTP request failed.'));
    const unreachable = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl: keyedUrl }).catch(
      (e: unknown) => e as Error,
    );
    expect(unreachable).toMatchObject({ code: 'ENSC_UPSTREAM_FAILED' });
    expect(unreachable.message).toContain('The RPC endpoint did not answer: HTTP request failed.');
    expect(unreachable.message).not.toContain('ACCESSKEY');
    expect(unreachable.message).not.toContain('rpc.example.com');

    // An error without a summary (not the chain library's own): the URL is
    // taken out of whatever text it carries, on every path of the helper.
    getChainId.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${keyedUrl}`));
    const plain = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl: keyedUrl }).catch(
      (e: unknown) => e as Error,
    );
    expect(plain.message).toContain('connect ECONNREFUSED [rpc url]');
    expect(plain.message).not.toContain('ACCESSKEY');

    estimateGas.mockRejectedValueOnce(new Error(`fetch failed for ${keyedUrl}`));
    const estimate = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl: keyedUrl }).catch(
      (e: unknown) => e as Error,
    );
    expect(estimate.message).toContain('The transaction would fail');
    expect(estimate.message).not.toContain('ACCESSKEY');

    sendRawTransaction.mockRejectedValueOnce(new Error(`socket hang up ${keyedUrl}`));
    const send = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl: keyedUrl }).catch(
      (e: unknown) => e as Error,
    );
    expect(send.message).toContain('Failed to broadcast transaction');
    expect(send.message).not.toContain('ACCESSKEY');

    waitForTransactionReceipt.mockRejectedValueOnce(new Error(`timeout ${keyedUrl}`));
    const receipt = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl: keyedUrl }).catch(
      (e: unknown) => e as Error,
    );
    expect(receipt).toMatchObject({ details: { txHash: '0xtxhash' } });
    expect(receipt.message).not.toContain('ACCESSKEY');
  });

  it('a send whose answer is lost is never sent again: the error carries the hash to follow', async () => {
    sendRawTransaction.mockClear();
    request.mockClear();
    sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { shortMessage: 'The request took too long to respond.' }),
    );
    const err = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl }).catch(
      (e: unknown) => e as Error,
    );
    expect(err).toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      details: { txHash: '0xtxhash' },
      message: expect.stringContaining('Failed to broadcast transaction'),
    });
    expect(err.message).toContain('do not send again');
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    // The hash was looked up before the failure was answered.
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getTransactionByHash',
      params: ['0xtxhash'],
    });
  });

  it('a send the node took although its answer was lost is answered as sent', async () => {
    sendRawTransaction.mockClear();
    sendRawTransaction.mockRejectedValueOnce(new Error('socket hang up'));
    request.mockResolvedValueOnce({ hash: '0xtxhash', blockNumber: null });
    const res = await signAndBroadcast(unsignedTx, walletKey, { rpcUrl });
    expect(res).toEqual({ txHash: '0xtxhash', status: 'success', blockNumber: 42n });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('a node that refuses the transaction in so many words, shown nowhere, sent nothing: no hash', async () => {
    sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error('Missing or invalid parameters.'), {
        code: -32000,
        shortMessage: 'Missing or invalid parameters.',
        details: 'insufficient funds for gas * price + value',
      }),
    );
    const err = (await signAndBroadcast(unsignedTx, walletKey, { rpcUrl }).catch(
      (e: unknown) => e,
    )) as { code: string; details?: unknown };
    expect(err.code).toBe('ENSC_UPSTREAM_FAILED');
    expect(err.details).toBeUndefined();
  });

  it('a node that says it already holds the transaction is not taken at its word, nor is it a refusal: the hash to follow', async () => {
    sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error('Missing or invalid parameters.'), {
        code: -32000,
        shortMessage: 'Missing or invalid parameters.',
        details: 'already known',
      }),
    );
    await expect(signAndBroadcast(unsignedTx, walletKey, { rpcUrl })).rejects.toMatchObject({
      code: 'ENSC_UPSTREAM_FAILED',
      details: { txHash: '0xtxhash' },
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
    prepareTransactionRequest.mockClear();
    sendRawTransaction.mockClear();
    const voucher = {
      voucher: { deadline: String(Math.floor(Date.now() / 1000) + 300), wallet: WALLET },
      approvalTransaction: { ...unsignedTx, to: `0x${'2'.repeat(40)}` },
      transaction: unsignedTx,
    } as never;
    const res = await executeVoucher(voucher, walletKey, { rpcUrl });
    expect(res.approval?.txHash).toBe('0xtxhash');
    expect(res.transaction.txHash).toBe('0xtxhash');
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(prepareTransactionRequest.mock.calls[0]?.[0]).toMatchObject({
      to: `0x${'2'.repeat(40)}`,
    });

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
