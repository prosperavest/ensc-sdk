/**
 * The API contract version this codebase implements. Single source of truth for
 * the `X-ENSC-API-Version` header the API echoes, the `apiVersion` stamped on
 * webhook events, and the SDK's default pin.
 *
 * Bump deliberately, with a changelog entry, when the wire contract changes.
 * 2026-09-15 introduced mandatory request encryption (ENSC-ENC-V1), sealed and
 * signed responses (ENSC-RESP-V1), mandatory IP allowlists on live keys and
 * 24-hour key rotation overlaps.
 */
export const CURRENT_API_VERSION = '2026-09-15' as const;

/**
 * Every `X-ENSC-API-Version` the API serves. A request that names another one
 * is refused with ENSC_UNSUPPORTED_API_VERSION (400), never served as the
 * current version. A request that names none is served as
 * CURRENT_API_VERSION. Add a date here only with the behaviour that version
 * pins.
 */
export const SUPPORTED_API_VERSIONS: readonly string[] = Object.freeze([CURRENT_API_VERSION]);

/** When a version is retired. Both times are unix seconds. */
export interface ApiVersionRetirement {
  /**
   * When the version is (or was) deprecated: still served, no longer
   * recommended. Sent as `Deprecation: @<unix seconds>` (RFC 9745).
   */
  deprecatedAt?: number;
  /**
   * When the version stops being served. Sent as `Sunset: <HTTP date>`
   * (RFC 8594). Never earlier than `deprecatedAt`.
   */
  sunsetAt?: number;
}

/**
 * The retirement schedule, by version. Every answer served by a version listed
 * here carries the `Deprecation` and `Sunset` headers its entry gives, until
 * the version leaves SUPPORTED_API_VERSIONS. A version that is not listed is
 * not scheduled for retirement and its answers carry neither header.
 *
 * No version is scheduled today.
 */
export const API_VERSION_RETIREMENTS: Readonly<Record<string, ApiVersionRetirement>> =
  Object.freeze({});
