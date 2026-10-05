/**
 * What distinguishes one ProsperaVest SDK from another.
 *
 * The wire protocol is the same for every product: Bearer API key, pinned
 * date version, ENSC-ENC-V1 encrypted and ENSC-V1 signed writes, ENSC-RESP-V1
 * sealed responses, ENSC-WH-V1 signed webhooks, one error envelope. What
 * differs is which host answers, which key prefix the host issues, where its
 * public keys are served and how the SDK names itself in messages. An SDK is
 * one descriptor plus its resources.
 */

export interface SdkProduct {
  /** Short product name used in messages: "ENSC", "Vaults". */
  readonly name: string;
  /** The client class name, for construction-time messages. */
  readonly clientName: string;
  /** Production base URL of the product's API. */
  readonly defaultBaseUrl: string;
  /** Default `X-ENSC-API-Version` this SDK release pins. */
  readonly defaultApiVersion: string;
  /** Path of the well-known public-key document, e.g. `/v1/.well-known/ensc-public-keys.json`. */
  readonly publicKeysPath: string;
  /**
   * Name of the config field that pins the response-signing keys
   * (`enscPublicKeys`, `vaultsPublicKeys`); used in validation messages.
   */
  readonly publicKeysConfigField: string;
  /**
   * When set, `config.apiKey` must match it at construction, so a key issued
   * for another product fails before the first request instead of with a
   * 401 from the host.
   */
  readonly apiKeyPattern?: RegExp;
  /** Human description of the accepted key shape, for that message. */
  readonly apiKeyHint?: string;
}
