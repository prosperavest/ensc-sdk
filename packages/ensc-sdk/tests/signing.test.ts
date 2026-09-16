import { describe, expect, it } from 'vitest';
import { ok, testServer } from './_server.js';

describe('mutation signing (encrypt-then-sign)', () => {
  it('attaches all X-ENSC-* signing headers to a mutation', async () => {
    const srv = testServer(ok({ unsignedTransaction: {} }));
    await srv.client.transfer.create({
      from: `0x${'a'.repeat(40)}`,
      recipient: `0x${'b'.repeat(40)}`,
      amount: '100',
      chain: 'celo',
    });

    const headers = srv.calls[0]?.headers ?? {};
    expect(headers['x-ensc-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-ensc-nonce']).toBeDefined();
    expect(headers['x-ensc-key-id']).toBe(srv.fx.signingKeyId);
    expect(headers['x-ensc-signature']).toMatch(/^ed25519=/);
    expect(headers['x-ensc-idempotency-key']).toBeDefined();
  });

  it('produces a signature over the encrypted envelope that verifies with @ensc/protocol', async () => {
    const srv = testServer(ok({}));
    await srv.client.transfer.create({
      from: `0x${'a'.repeat(40)}`,
      recipient: `0x${'c'.repeat(40)}`,
      amount: '5',
      chain: 'celo',
    });
    expect(srv.calls[0]?.signatureOk).toBe(true);
  });

  it('sends the key id on reads too, so the API knows which key to seal to', async () => {
    const srv = testServer(ok({ account: '0xabc', balance: '0', formatted: '0', decimals: 18 }));
    await srv.client.balance.get({ account: '0xabc', chain: 'celo', asset: 'ENSC' });
    const headers = srv.calls[0]?.headers ?? {};
    expect(headers['x-ensc-key-id']).toBe(srv.fx.signingKeyId);
    expect(headers['x-ensc-signature']).toBeUndefined();
  });

  it('re-signs each retry with a fresh nonce but a stable idempotency key and body', async () => {
    let n = 0;
    const srv = testServer(
      () =>
        n++ === 0
          ? { status: 503, body: { error: { code: 'ENSC_DB_UNAVAILABLE', message: 'down' } } }
          : { status: 200, body: { unsignedTransaction: {} } },
      { config: { maxRetries: 1 } },
    );
    await srv.client.transfer.create({
      from: `0x${'d'.repeat(40)}`,
      recipient: `0x${'e'.repeat(40)}`,
      amount: '1',
      chain: 'celo',
    });

    expect(srv.calls).toHaveLength(2);
    const [a, b] = srv.calls;
    expect(a?.headers['x-ensc-nonce']).not.toBe(b?.headers['x-ensc-nonce']);
    expect(a?.headers['x-ensc-idempotency-key']).toBe(b?.headers['x-ensc-idempotency-key']);
    // The envelope is built once per logical request and re-signed per attempt
    // (timestamp and nonce must be fresh; the ciphertext need not be).
    expect(a?.wireBody).toBe(b?.wireBody);
    expect(a?.plaintext).toBe(b?.plaintext);
    expect(a?.signatureOk && b?.signatureOk).toBe(true);
  });

  it('honors a caller-supplied idempotency key', async () => {
    const srv = testServer(ok({}));
    await srv.client.transfer.create({
      from: `0x${'a'.repeat(40)}`,
      recipient: `0x${'f'.repeat(40)}`,
      amount: '1',
      chain: 'celo',
      idempotencyKey: 'my-own-key-123',
    });
    expect(srv.calls[0]?.headers['x-ensc-idempotency-key']).toBe('my-own-key-123');
  });
});
