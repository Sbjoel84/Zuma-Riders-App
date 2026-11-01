import type { ErrorCode } from "@zuma/contracts";

const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  DRIVER_NOT_ELIGIBLE: 403,
  DRIVER_NOT_VERIFIED: 403,
  DRIVER_SUSPENDED: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  OTP_ATTEMPTS_EXCEEDED: 429,
  PIN_ATTEMPTS_EXCEEDED: 429,
  ACTIVE_REQUEST_EXISTS: 409,
  REQUEST_CLOSED: 409,
  OFFER_EXPIRED: 409,
  DRIVER_NO_LONGER_AVAILABLE: 409,
  INVALID_STATE_TRANSITION: 409,
  RIDE_STATE_CHANGED: 409,
  ALREADY_RATED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  INTERNAL: 500,
};

/** The only error type services throw. The global filter turns it into the API error envelope. */
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
  get status(): number {
    return STATUS[this.code] ?? 422;
  }
}

export const fail = (code: ErrorCode, message: string, details?: unknown): never => {
  throw new DomainError(code, message, details);
};
