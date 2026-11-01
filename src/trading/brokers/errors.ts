/**
 * A broker call failed. `definite` is true only when the broker positively rejected the request
 * (so nothing happened). Timeouts, network errors and server errors are NOT definite: the order
 * may or may not exist, and must be reconciled before anything is retried.
 */
export class BrokerError extends Error {
  constructor(
    message: string,
    readonly definite: boolean,
    readonly kind: 'rejected' | 'auth' | 'timeout' | 'network' | 'server' | 'unknown' = definite ? 'rejected' : 'unknown',
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

export const isDefiniteRejection = (e: unknown) => e instanceof BrokerError && e.definite;
export const isAuthError = (e: unknown) => e instanceof BrokerError && e.kind === 'auth';
