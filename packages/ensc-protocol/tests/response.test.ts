/**
 * ENSC-RESP-V2: a sealed response bound to the request it answers, and
 * ENSC-V2, the request signature that covers the response nonce.
 *
 * The vectors below are fixed inputs with the exact bytes both versions
 * produce for them. They were computed twice: by this package and by a
 * separate implementation written against RFC 9180 and RFC 8032 with another
 * library, and the two agree. An implementation in another language can check
 * itself against them. The keys are test values and protect nothing.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalString,
  canonicalQuery,
  isResponseNonce,
  RESPONSE_NONCE_HEADER,
  sha256Hex,
} from '../src/canonical.js';
import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes } from '../src/encoding.js';
import {
  deriveKeyPair,
  HpkeError,
  openResponse,
  parseSealedEnvelope,
  type SealedEnvelope,
  sealResponse,
} from '../src/hpke.js';
import {
  buildResponseCanonicalV2,
  buildResponseInfoV2,
  openResponseV2,
  parseSealedEnvelopeV2,
  type ResponseBinding,
  type SealedEnvelopeV2,
  sealResponseV2,
} from '../src/response.js';
import { signRequest } from '../src/sign.js';
import { verifyRequest } from '../src/verify.js';

const QUERY_HASH = '4d7ef8f5ed84d000ea0f019c83126d42775a0c02cca4dbff6a5f1626a4e98551';

/** Shared by the two vectors. Seeds are bytes 00..1f, 20..3f, 40..5f and 60..7f. */
const V = {
  /** The merchant's Ed25519 signing key: the recipient of the response, the signer of the write. */
  merchantSeed: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  merchantPublicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  /** The host's Ed25519 response-signing key. */
  hostSeed: 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8',
  hostPublicKey: 'Kay64UG8yvCyLhqU000LxzYeUm0L_hLIl5S8kyKWbdc',
  /** Input of RFC 9180 DeriveKeyPair for the sender's ephemeral key. */
  ephemeralIkm: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
  responseNonce: 'YGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn8',
  requestId: 'req_01HZXVECTOR0000000000000001',
  timestamp: 1790000000,
  /** Who the response is for: the merchant, and the id of the signing key it is sealed to. */
  merchantId: 'mrc_01HZXVECTOR000000000000000',
  recipientKeyId: 'sig_01HZXVECTOR000000000000000',
};

/** A read: `GET /v1/conversions?status=succeeded&limit=2` and its sealed answer. */
const READ = {
  binding: {
    method: 'GET',
    path: '/v1/conversions',
    query: { status: 'succeeded', limit: '2' },
    responseNonce: V.responseNonce,
    merchantId: V.merchantId,
    recipientKeyId: V.recipientKeyId,
  } satisfies ResponseBinding,
  plaintext: '{"data":[],"pagination":{"nextCursor":null,"hasMore":false}}',
  info: [
    'ENSC-RESP-V2',
    V.requestId,
    'GET',
    '/v1/conversions',
    QUERY_HASH,
    V.responseNonce,
    V.merchantId,
    V.recipientKeyId,
  ].join('\n'),
  body:
    '{"v":2,"enc":"sln27pLcugERhQsTs_bczIJ3JvmwgjWrYpIraz8_Khk","ciphertext":' +
    '"X9Vj6XgM7GGMqBeKMDc4JNyH5ocjfp6sKLvjfhmt5zzIsCwhqeo1IkJCZ1MJIXmljCxepnPObCYCp2EYms4D2Ne3bZfcw0QIxNeImw"}',
  signed: [
    'ENSC-RESP-V2',
    V.requestId,
    '1790000000',
    'GET',
    '/v1/conversions',
    QUERY_HASH,
    V.responseNonce,
    V.merchantId,
    V.recipientKeyId,
    '6fc363dfe69ef0ec8013482d5dca662d866d63b513cca90d98d8a7f760e32627',
  ].join('\n'),
  signature:
    'ed25519=kSJXv--ifeosd1fmwXPPqnPHusxqhaIRbewqbia1mqIFT0t99w3Qb8y6DsHBe_aAQxsOGemwAKjkYUZP10GUAg',
};

/** A write: a signed `POST /v1/conversions` that carries the response nonce. */
const WRITE = {
  request: {
    method: 'POST',
    path: '/v1/conversions',
    query: undefined,
    body: '{"v":1,"encKeyId":"enc_01HZXVECTOR000000000000000","iv":"AAAAAAAAAAAAAAAA","ciphertext":"AAAA","tag":"AAAAAAAAAAAAAAAAAAAAAA"}',
    timestamp: V.timestamp,
    nonce: 'bm9uY2UtdmVjdG9yLTAwMDAwMDAx',
    merchantId: V.merchantId,
    idempotencyKey: 'idm_vector_0001',
  },
  /** The first eight lines after the version line are the same in ENSC-V1 and ENSC-V2. */
  lines: [
    'POST',
    '/v1/conversions',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '766b4f825d129359eba52a066f27ac01a88b117f04897501822de85369da2aac',
    '1790000000',
    'bm9uY2UtdmVjdG9yLTAwMDAwMDAx',
    'mrc_01HZXVECTOR000000000000000',
    'idm_vector_0001',
  ],
  signature:
    'ed25519=0cZeWnpqBaZuyiXaxN3bAcp5Y_hbr3Jj1nbsbLASAFxJ0B_gq1cVWs4erfPUOQGYkuusGKdRnPUkOLwUnqrVCQ',
};

const verifies = (signature: string, signed: string, publicKey: string): boolean =>
  ed25519.verify(
    base64UrlToBytes(signature.replace(/^ed25519=/, '')),
    utf8ToBytes(signed),
    base64UrlToBytes(publicKey),
  );

describe('ENSC-RESP-V2 vector (a sealed read)', () => {
  it('the keys are the ones the seeds give', () => {
    expect(bytesToBase64Url(ed25519.getPublicKey(base64UrlToBytes(V.merchantSeed)))).toBe(
      V.merchantPublicKey,
    );
    expect(bytesToBase64Url(ed25519.getPublicKey(base64UrlToBytes(V.hostSeed)))).toBe(
      V.hostPublicKey,
    );
    expect(isResponseNonce(V.responseNonce)).toBe(true);
  });

  it('the info names the request id, the request, the nonce, the merchant and the key id', () => {
    expect(sha256Hex('limit=2&status=succeeded')).toBe(QUERY_HASH);
    expect(bytesToUtf8(buildResponseInfoV2(V.requestId, READ.binding))).toBe(READ.info);
  });

  it('seal reproduces the body byte for byte', () => {
    const sealed = sealResponseV2({
      recipientEd25519PublicKey: V.merchantPublicKey,
      requestId: V.requestId,
      binding: READ.binding,
      body: READ.plaintext,
      ephemeral: deriveKeyPair(hexToBytes(V.ephemeralIkm)),
    });
    expect(JSON.stringify(sealed)).toBe(READ.body);
  });

  it('the signed string and the signature are reproduced, and the signature verifies', () => {
    const signed = buildResponseCanonicalV2({
      requestId: V.requestId,
      timestamp: V.timestamp,
      binding: READ.binding,
      body: READ.body,
    });
    expect(signed).toBe(READ.signed);
    // Ed25519 is deterministic: the same key and string give the same signature.
    const signature = ed25519.sign(utf8ToBytes(signed), base64UrlToBytes(V.hostSeed));
    expect(`ed25519=${bytesToBase64Url(signature)}`).toBe(READ.signature);
    expect(verifies(READ.signature, READ.signed, V.hostPublicKey)).toBe(true);
  });

  it('the timestamp is signed as the header spells it, number or text', () => {
    expect(
      buildResponseCanonicalV2({
        requestId: V.requestId,
        timestamp: '1790000000',
        binding: READ.binding,
        body: READ.body,
      }),
    ).toBe(READ.signed);
  });

  it('open recovers the plaintext from the body', () => {
    const envelope = parseSealedEnvelopeV2(JSON.parse(READ.body));
    expect(envelope).not.toBeNull();
    expect(
      openResponseV2({
        recipientEd25519PrivateKey: V.merchantSeed,
        requestId: V.requestId,
        binding: READ.binding,
        envelope: envelope as SealedEnvelopeV2,
      }),
    ).toBe(READ.plaintext);
  });
});

/**
 * The canonical query: what both signed strings hash. Pairs are decoded
 * (`+` and `%20` are both a space), sorted by key and then by value, and
 * written back as application/x-www-form-urlencoded: a space is `+`, the
 * characters A-Z a-z 0-9 * - . _ stay as they are, every other byte is %XX in
 * upper-case hex. A repeated key keeps every one of its values.
 */
const QUERY_VECTORS: Array<{ raw: string; canonical: string; sha256: string }> = [
  {
    raw: '',
    canonical: '',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  },
  { raw: 'status=succeeded&limit=2', canonical: 'limit=2&status=succeeded', sha256: QUERY_HASH },
  {
    // A value with a space and a colon, spelled two ways on the wire.
    raw: 'q=a%20b%3Ac&limit=2',
    canonical: 'limit=2&q=a+b%3Ac',
    sha256: '80905aac7dee9d5ffc921c53271169736e4ba4a748a6ee161b4d981a61f7db57',
  },
  {
    raw: 'q=a+b:c&limit=2',
    canonical: 'limit=2&q=a+b%3Ac',
    sha256: '80905aac7dee9d5ffc921c53271169736e4ba4a748a6ee161b4d981a61f7db57',
  },
  {
    raw: 'tag=b&tag=a&tag=b',
    canonical: 'tag=a&tag=b&tag=b',
    sha256: '20129cea9195cf6223ff40601d1316c144d844e2fbdcbfa8254eacb3045e4747',
  },
  {
    raw: 'name=%C3%A9~&flag',
    canonical: 'flag=&name=%C3%A9%7E',
    sha256: '1bcc76a18334a64104c9815e7eedca665a46d80ed600ab10585661fe73f94b78',
  },
  {
    raw: 'b=1&=x&a=%2f',
    canonical: '=x&a=%2F&b=1',
    sha256: '1e1a939bfa2eb3adb6170caffc6c5fb8a582f7c81dbc55dfd3bc8aa14b18d52a',
  },
];

describe('canonical query vectors', () => {
  it.each(QUERY_VECTORS)('"$raw" is "$canonical"', ({ raw, canonical, sha256 }) => {
    expect(canonicalQuery(raw)).toBe(canonical);
    expect(canonicalQuery(new URLSearchParams(raw))).toBe(canonical);
    expect(sha256Hex(canonicalQuery(raw))).toBe(sha256);
  });

  it('a record of unique keys gives the same string as the query it stands for', () => {
    expect(canonicalQuery({ q: 'a b:c', limit: '2' })).toBe('limit=2&q=a+b%3Ac');
  });

  it('a repeated key is part of what is bound: one more value is another request', () => {
    const base = { ...READ.binding, query: 'tag=a&tag=b' };
    const info = (query: string) =>
      bytesToUtf8(buildResponseInfoV2(V.requestId, { ...base, query }));
    expect(info('tag=b&tag=a')).toBe(info('tag=a&tag=b'));
    expect(info('tag=a')).not.toBe(info('tag=a&tag=b'));
    expect(info('tag=a&tag=c')).not.toBe(info('tag=a&tag=b'));
  });
});

describe('ENSC-V2 vector (a signed write that carries the response nonce)', () => {
  it('the string is the ENSC-V1 lines under the ENSC-V2 label, then the nonce', () => {
    const signed = signRequest({
      ...WRITE.request,
      responseNonce: V.responseNonce,
      privateKey: V.merchantSeed,
      keyId: 'sig_vector',
    });
    expect(signed.canonical).toBe(['ENSC-V2', ...WRITE.lines, V.responseNonce].join('\n'));
    expect(signed.headers['X-ENSC-Signature']).toBe(WRITE.signature);
    expect(signed.headers[RESPONSE_NONCE_HEADER]).toBe(V.responseNonce);
    expect(verifies(WRITE.signature, signed.canonical, V.merchantPublicKey)).toBe(true);
  });

  it('without the nonce the same request is ENSC-V1, byte for byte as before', () => {
    expect(buildCanonicalString(WRITE.request)).toBe(['ENSC-V1', ...WRITE.lines].join('\n'));
    const signed = signRequest({
      ...WRITE.request,
      privateKey: V.merchantSeed,
      keyId: 'sig_vector',
    });
    expect(Object.keys(signed.headers)).not.toContain(RESPONSE_NONCE_HEADER);
  });
});

describe('the response nonce is covered by the request signature', () => {
  const now = Math.floor(Date.now() / 1000);
  const request = { ...WRITE.request, timestamp: now };
  const signedV2 = signRequest({
    ...request,
    responseNonce: V.responseNonce,
    privateKey: V.merchantSeed,
    keyId: 'sig_vector',
  });
  const signedV1 = signRequest({ ...request, privateKey: V.merchantSeed, keyId: 'sig_vector' });
  const check = (signatureHeader: string, responseNonce?: string) =>
    verifyRequest({
      ...request,
      ...(responseNonce !== undefined ? { responseNonce } : {}),
      publicKey: V.merchantPublicKey,
      signatureHeader,
    });

  it('verifies with the nonce that was signed', () => {
    expect(check(signedV2.headers['X-ENSC-Signature'], V.responseNonce)).toEqual({ ok: true });
  });

  it('does not verify with another nonce', () => {
    const other = bytesToBase64Url(randomBytes(32));
    expect(check(signedV2.headers['X-ENSC-Signature'], other)).toEqual({
      ok: false,
      error: 'INVALID_SIGNATURE',
    });
  });

  it('does not verify with the nonce taken away: an ENSC-V2 signature is not an ENSC-V1 one', () => {
    expect(check(signedV2.headers['X-ENSC-Signature'])).toEqual({
      ok: false,
      error: 'INVALID_SIGNATURE',
    });
  });

  it('does not verify with a nonce added: an ENSC-V1 signature is not an ENSC-V2 one', () => {
    expect(check(signedV1.headers['X-ENSC-Signature'])).toEqual({ ok: true });
    expect(check(signedV1.headers['X-ENSC-Signature'], V.responseNonce)).toEqual({
      ok: false,
      error: 'INVALID_SIGNATURE',
    });
  });

  it('a value that is not a response nonce is never signed or verified', () => {
    for (const bad of ['', 'short', `${V.responseNonce}A`, `${V.responseNonce.slice(0, 42)}=`]) {
      expect(isResponseNonce(bad), bad).toBe(false);
      expect(() => buildCanonicalString({ ...request, responseNonce: bad }), bad).toThrow(
        'Invalid response nonce',
      );
      expect(check(signedV2.headers['X-ENSC-Signature'], bad), bad).toEqual({
        ok: false,
        error: 'BAD_SIGNATURE_FORMAT',
      });
    }
    // One line only: a value with a line break cannot add a signed line.
    expect(isResponseNonce(`${V.responseNonce.slice(0, 21)}\n${V.responseNonce.slice(22)}`)).toBe(
      false,
    );
    expect(isResponseNonce(undefined)).toBe(false);
    expect(isResponseNonce(123)).toBe(false);
  });
});

describe('an ENSC-RESP-V2 response answers one request only', () => {
  const seed = randomBytes(32);
  const sk = bytesToBase64Url(seed);
  const pk = bytesToBase64Url(ed25519.getPublicKey(seed));
  const binding: ResponseBinding = {
    method: 'GET',
    path: '/v1/balance',
    query: { account: 'a', chain: 'celo' },
    responseNonce: bytesToBase64Url(randomBytes(32)),
    merchantId: 'mrc_A',
    recipientKeyId: 'sig_A1',
  };
  const seal = (b: ResponseBinding = binding, requestId = 'req_1') =>
    sealResponseV2({ recipientEd25519PublicKey: pk, requestId, binding: b, body: '{"ok":true}' });
  const open = (envelope: SealedEnvelopeV2, b: ResponseBinding, requestId = 'req_1') =>
    openResponseV2({ recipientEd25519PrivateKey: sk, requestId, binding: b, envelope });

  /** Every way another request differs from this one. */
  const others: Array<[string, ResponseBinding]> = [
    ['another nonce', { ...binding, responseNonce: bytesToBase64Url(randomBytes(32)) }],
    ['another method', { ...binding, method: 'POST' }],
    ['another path', { ...binding, path: '/v1/banks' }],
    ['another query value', { ...binding, query: { account: 'b', chain: 'celo' } }],
    ['one more query parameter', { ...binding, query: { account: 'a', chain: 'celo', x: '1' } }],
    ['no query', { ...binding, query: undefined }],
    ['a repeated key with another value', { ...binding, query: 'account=a&chain=celo&chain=x' }],
    ['another merchant', { ...binding, merchantId: 'mrc_B' }],
    ['another key of the same merchant', { ...binding, recipientKeyId: 'sig_A2' }],
  ];

  it('round-trips for the request it was made for', () => {
    const sealed = seal();
    expect(sealed.v).toBe(2);
    expect(parseSealedEnvelopeV2(sealed)).toEqual(sealed);
    expect(open(sealed, binding)).toBe('{"ok":true}');
  });

  it('the query is compared in canonical form: order and spelling of the method do not matter', () => {
    const sealed = seal();
    expect(open(sealed, { ...binding, query: 'chain=celo&account=a' })).toBe('{"ok":true}');
    expect(open(sealed, { ...binding, method: 'get' })).toBe('{"ok":true}');
  });

  it.each(others)('does not open for %s', (_name, other) => {
    expect(() => open(seal(), other)).toThrow(HpkeError);
    expect(() => open(seal(other), binding)).toThrow(HpkeError);
  });

  it.each(others)('is not signed for %s', (_name, other) => {
    const body = JSON.stringify(seal());
    const of = (b: ResponseBinding) =>
      buildResponseCanonicalV2({ requestId: 'req_1', timestamp: 1, binding: b, body });
    expect(of(other)).not.toBe(of(binding));
  });

  it('does not open under another request id', () => {
    expect(() => open(seal(), binding, 'req_2')).toThrow(HpkeError);
  });

  it('cannot be opened by another merchant key', () => {
    expect(() =>
      openResponseV2({
        recipientEd25519PrivateKey: bytesToBase64Url(randomBytes(32)),
        requestId: 'req_1',
        binding,
        envelope: seal(),
      }),
    ).toThrow(HpkeError);
  });

  it('uses a fresh ephemeral key per seal', () => {
    const a = seal();
    const b = seal();
    expect(a.enc).not.toBe(b.enc);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('refuses a malformed response nonce on both sides', () => {
    const bad = { ...binding, responseNonce: 'not-a-nonce' };
    expect(() => seal(bad)).toThrow(HpkeError);
    expect(() => open(seal(), bad)).toThrow(HpkeError);
    expect(() => buildResponseInfoV2('req_1', bad)).toThrow('Invalid response nonce');
    expect(() =>
      buildResponseCanonicalV2({ requestId: 'req_1', timestamp: 1, binding: bad, body: '{}' }),
    ).toThrow('Invalid response nonce');
  });

  it('every line of the binding is one line: empty text or a line break is refused', () => {
    const bads: ResponseBinding[] = [
      { ...binding, merchantId: '' },
      { ...binding, merchantId: 'mrc_A\nsig_A1' },
      { ...binding, recipientKeyId: '' },
      { ...binding, recipientKeyId: 'sig_A1\r' },
      { ...binding, path: '/v1/x\n/v1/y' },
      { ...binding, method: '' },
    ];
    for (const bad of bads) {
      expect(() => seal(bad), JSON.stringify(bad)).toThrow(HpkeError);
      expect(() => open(seal(), bad), JSON.stringify(bad)).toThrow(HpkeError);
      expect(() => buildResponseInfoV2('req_1', bad), JSON.stringify(bad)).toThrow(/^Invalid /);
      expect(
        () =>
          buildResponseCanonicalV2({ requestId: 'req_1', timestamp: 1, binding: bad, body: '{}' }),
        JSON.stringify(bad),
      ).toThrow(/^Invalid /);
    }
  });

  it('the same key under two merchants: an answer for one is not an answer for the other', () => {
    // A public key is not exclusive to one merchant. Both hold the same key
    // here; only the merchant id and the key id tell their answers apart.
    const theirs: ResponseBinding = { ...binding, merchantId: 'mrc_B', recipientKeyId: 'sig_B1' };
    const sealedForThem = seal(theirs);
    expect(open(sealedForThem, theirs)).toBe('{"ok":true}');
    expect(() => open(sealedForThem, binding)).toThrow(HpkeError);
    const body = JSON.stringify(sealedForThem);
    expect(
      buildResponseCanonicalV2({ requestId: 'req_1', timestamp: 1, binding: theirs, body }),
    ).not.toBe(buildResponseCanonicalV2({ requestId: 'req_1', timestamp: 1, binding, body }));
  });
});

describe('the two response versions are not interchangeable', () => {
  const seed = randomBytes(32);
  const sk = bytesToBase64Url(seed);
  const pk = bytesToBase64Url(ed25519.getPublicKey(seed));
  const binding: ResponseBinding = {
    method: 'GET',
    path: '/v1/x',
    query: undefined,
    responseNonce: bytesToBase64Url(randomBytes(32)),
    merchantId: 'mrc_A',
    recipientKeyId: 'sig_A1',
  };

  it('each parser accepts its own version and no other', () => {
    const v1 = sealResponse({ recipientEd25519PublicKey: pk, requestId: 'req_1', body: '{}' });
    const v2 = sealResponseV2({
      recipientEd25519PublicKey: pk,
      requestId: 'req_1',
      binding,
      body: '{}',
    });
    expect(parseSealedEnvelopeV2(v1)).toBeNull();
    expect(parseSealedEnvelope(v2)).toBeNull();
    expect(parseSealedEnvelopeV2(null)).toBeNull();
    expect(parseSealedEnvelopeV2({ ...v2, extra: 1 })).toBeNull();
    expect(parseSealedEnvelopeV2({ ...v2, enc: 'short' })).toBeNull();
    expect(parseSealedEnvelopeV2({ ...v2, ciphertext: '' })).toBeNull();
  });

  it('a V1 body relabelled as V2 does not open, nor a V2 body relabelled as V1', () => {
    const v1 = sealResponse({ recipientEd25519PublicKey: pk, requestId: 'req_1', body: '{}' });
    const v2 = sealResponseV2({
      recipientEd25519PublicKey: pk,
      requestId: 'req_1',
      binding,
      body: '{}',
    });
    expect(() =>
      openResponseV2({
        recipientEd25519PrivateKey: sk,
        requestId: 'req_1',
        binding,
        envelope: { ...v1, v: 2 },
      }),
    ).toThrow(HpkeError);
    expect(() =>
      openResponse({
        recipientEd25519PrivateKey: sk,
        requestId: 'req_1',
        envelope: { ...v2, v: 1 } as SealedEnvelope,
      }),
    ).toThrow(HpkeError);
  });

  it('the signed strings of the two versions never coincide', () => {
    const body = '{"v":2,"enc":"x","ciphertext":"y"}';
    const v2 = buildResponseCanonicalV2({ requestId: 'req_1', timestamp: 1, binding, body });
    expect(v2.startsWith('ENSC-RESP-V2\n')).toBe(true);
    expect(v2).not.toBe(`ENSC-RESP-V1\nreq_1\n1\n${sha256Hex(body)}`);
    expect(v2.split('\n')).toHaveLength(10);
  });
});
