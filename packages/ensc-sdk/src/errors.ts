/**
 * Error handling for the ENSC SDK.
 *
 * The SDK throws `EnscError` (re-exported from `@ensc/protocol`) for every failure
 * the API reports - same class, same `code` taxonomy, same `status` map the API
 * itself uses. There is exactly one error type to catch.
 *
 *   import { EnscError, isEnscError } from '@ensc/sdk';
 *
 *   try {
 *     await ensc.mint.create({ ... });
 *   } catch (err) {
 *     if (isEnscError(err) && err.code === 'ENSC_MINT_LIMIT_EXCEEDED') {
 *       // handle the specific case
 *     }
 *   }
 *
 * Network-level failures (DNS, connection reset, timeout) that never produced an
 * HTTP response are thrown as `EnscError` with code `ENSC_UPSTREAM_FAILED` so
 * callers still only ever deal with one error class.
 */

import { EnscError, type EnscErrorCode, isEnscErrorResponse } from '@ensc/protocol';

export type { EnscErrorCode };
export { EnscError, isEnscErrorResponse };

/** Type guard: is this thrown value an EnscError? */
export function isEnscError(err: unknown): err is EnscError {
  return err instanceof EnscError;
}

/**
 * Type guard for a specific error code. Narrows both the type and the `.code`.
 *
 *   if (isEnscErrorCode(err, 'ENSC_RATE_LIMITED')) { ... }
 */
export function isEnscErrorCode<C extends EnscErrorCode>(
  err: unknown,
  code: C,
): err is EnscError & { code: C } {
  return err instanceof EnscError && err.code === code;
}

/** True when the error is a 4xx (caller's fault - retrying as-is will not help). */
export function isClientError(err: unknown): err is EnscError {
  return err instanceof EnscError && err.status >= 400 && err.status < 500;
}

/** True when the error is a 5xx (server-side - a retry may succeed). */
export function isServerError(err: unknown): err is EnscError {
  return err instanceof EnscError && err.status >= 500;
}
