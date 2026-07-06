type ServiceStatus = 'pending' | 'up' | 'down' | 'degraded' | 'paused';

export const CONFIRM_THRESHOLD = 2;

export type TransitionInput = {
  currentStatus: ServiceStatus;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  rawStatus: 'up' | 'down';
};

export type TransitionResult = {
  nextStatus: ServiceStatus; // echoes currentStatus when unchanged; caller writes only if != currentStatus
  incidentAction: 'open' | 'resolve' | 'none';
};

export function decideTransition(input: TransitionInput): TransitionResult {
  const { currentStatus, consecutiveFailures, consecutiveSuccesses, rawStatus } = input;

  if (rawStatus === 'down') {
    const isConfirmedDown = currentStatus === 'down';
    if (!isConfirmedDown && consecutiveFailures >= CONFIRM_THRESHOLD) {
      return { nextStatus: 'down', incidentAction: 'open' };
    }
    return { nextStatus: currentStatus, incidentAction: 'none' };
  }

  // rawStatus === 'up'
  if (currentStatus === 'pending') {
    return { nextStatus: 'up', incidentAction: 'none' };
  }
  if (currentStatus === 'down' && consecutiveSuccesses >= CONFIRM_THRESHOLD) {
    return { nextStatus: 'up', incidentAction: 'resolve' };
  }
  return { nextStatus: currentStatus, incidentAction: 'none' };
}
