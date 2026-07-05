import type { IntegrationDefinition } from './types';
import { githubIntegration } from './github';
import { vercelIntegration } from './vercel';

// Add new integrations here — one import + one entry. That is the whole point.
export const IntegrationRegistry: Map<string, IntegrationDefinition> = new Map([
  [vercelIntegration.id, vercelIntegration as IntegrationDefinition],
  [githubIntegration.id, githubIntegration as IntegrationDefinition],
]);
