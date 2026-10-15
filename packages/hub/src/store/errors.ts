import type { ApiError, ErrorCode } from '@agent-link/protocol';

/**
 * HTTP_STATUS maps each ErrorCode to the HTTP status a route answers with when
 * no override is given; quarantined is a 403.
 */
const HTTP_STATUS: Record<ErrorCode, number> = {
  hub_unavailable: 503,
  not_registered: 401,
  session_required: 400,
  workspace_required: 400,
  peer_not_found: 404,
  not_participant: 403,
  invalid_message: 400,
  unauthorized: 401,
  not_found: 404,
  quarantined: 403,
};

/**
 * HubErrorOptions carries the optional hint, extra fields and a status override
 * for a HubError.
 */
export interface HubErrorOptions {
  hint?: string;
  extra?: Record<string, unknown>;
  status?: number;
}

/**
 * HubError is the one error type the hub raises for expected failures: a
 * protocol ErrorCode, a human message, an optional hint and loose extra fields,
 * plus the HTTP status the route layer should answer with. Unexpected failures
 * stay plain Errors and become 500s.
 */
export class HubError extends Error {
  /**
   * code is the protocol ErrorCode the client receives as the error field of
   * the ApiError body; it also selects the default HTTP status through
   * HTTP_STATUS when the constructor is given none.
   */
  readonly code: ErrorCode;
  /**
   * status is the HTTP status code the route layer answers with for this error:
   * the constructor's status override when one was given, otherwise the default
   * HTTP_STATUS maps the code to (503 for hub_unavailable, 401 for
   * not_registered and unauthorized, 403 for not_participant and quarantined, 404 for
   * peer_not_found and not_found, 400 for the rest). It never reaches the
   * ApiError body.
   */
  readonly status: number;
  /**
   * hint is the optional human-readable advice the constructor received in its
   * options; toBody adds it to the ApiError body as the hint field only when it
   * is defined, so an undefined hint leaves the body without one.
   */
  readonly hint: string | undefined;
  /**
   * extra holds the additional fields toBody spreads into the ApiError body
   * ahead of error, message and hint, such as the missing and online lists of a
   * peer_not_found; it is an empty object when the constructor received none.
   */
  readonly extra: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: HubErrorOptions = {}) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.status = options.status ?? HTTP_STATUS[code];
    this.hint = options.hint;
    this.extra = options.extra ?? {};
  }

  /**
   * toBody renders the error as the ApiError JSON body: extra fields first,
   * then error, message and hint.
   */
  toBody(): ApiError {
    const body: ApiError = { ...this.extra, error: this.code, message: this.message };
    if (this.hint !== undefined) body.hint = this.hint;
    return body;
  }
}
