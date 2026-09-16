/**
 * The API contract version this codebase implements. Single source of truth for
 * the `X-ENSC-API-Version` header the Worker echoes, the `apiVersion` stamped
 * on webhook events, the OpenAPI `info.version`, and the SDK's default pin.
 *
 * Bump deliberately, with a changelog entry, when the wire contract changes.
 * 2026-09-15 introduced mandatory request encryption (ENSC-ENC-V1), sealed and
 * signed responses (ENSC-RESP-V1), mandatory IP allowlists on live keys and
 * 24-hour key rotation overlaps.
 */
export const CURRENT_API_VERSION = '2026-09-15' as const;
