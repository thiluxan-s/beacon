import { z } from 'zod';

export const ServiceStatusSchema = z.enum(['pending', 'up', 'degraded', 'down', 'paused']);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const CheckStatusSchema = z.enum(['success', 'failure', 'timeout', 'error']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

const statusCode = z.number().int().min(100).max(599);

export const ServiceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  baseUrl: z.string().url(),
  healthCheckPath: z.string().min(1).default('/'),
  expectedStatusCodes: z.array(statusCode).min(1).default([200]),
  checkIntervalSeconds: z.number().int().min(10).max(86_400).default(60),
  timeoutSeconds: z.number().int().min(1).max(120).default(10),
});
export type ServiceCreateInput = z.infer<typeof ServiceCreateSchema>;

export const ServiceUpdateSchema = ServiceCreateSchema.partial().extend({
  paused: z.boolean().optional(),
  alertsEnabled: z.boolean().optional(),
});
export type ServiceUpdateInput = z.infer<typeof ServiceUpdateSchema>;
