import type { CheckStatus } from '@beacon/shared';

export type ClassifyInput =
  | { outcome: 'response'; statusCode: number; responseTimeMs: number; expectedStatusCodes: number[] }
  | { outcome: 'timeout'; responseTimeMs: number }
  | { outcome: 'error'; errorMessage: string };

export type ClassifyResult = {
  status: CheckStatus;
  statusCode: number | null;
  responseTimeMs: number | null;
  errorMessage: string | null;
  serviceStatus: 'up' | 'down';
};

export function classifyCheck(input: ClassifyInput): ClassifyResult {
  if (input.outcome === 'timeout') {
    return { status: 'timeout', statusCode: null, responseTimeMs: input.responseTimeMs, errorMessage: null, serviceStatus: 'down' };
  }
  if (input.outcome === 'error') {
    return { status: 'error', statusCode: null, responseTimeMs: null, errorMessage: input.errorMessage, serviceStatus: 'down' };
  }
  const ok = input.expectedStatusCodes.includes(input.statusCode);
  return {
    status: ok ? 'success' : 'failure',
    statusCode: input.statusCode,
    responseTimeMs: input.responseTimeMs,
    errorMessage: null,
    serviceStatus: ok ? 'up' : 'down',
  };
}
