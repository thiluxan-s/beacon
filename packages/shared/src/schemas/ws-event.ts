import { z } from 'zod';
import { ServiceStatusSchema } from './service';

export const ServiceStatusChangedSchema = z.object({
  type: z.literal('service.status_changed'),
  serviceId: z.string().min(1),
  userId: z.string().min(1),
  status: ServiceStatusSchema,
  previousStatus: ServiceStatusSchema,
  occurredAt: z.string().datetime(),
});

export const IncidentOpenedSchema = z.object({
  type: z.literal('incident.opened'),
  incidentId: z.string().min(1),
  serviceId: z.string().min(1),
  userId: z.string().min(1),
  severity: z.literal('down'),
  startedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
});

export const IncidentResolvedSchema = z.object({
  type: z.literal('incident.resolved'),
  incidentId: z.string().min(1),
  serviceId: z.string().min(1),
  userId: z.string().min(1),
  durationSeconds: z.number().int().nonnegative(),
  resolvedAt: z.string().datetime(),
  occurredAt: z.string().datetime(),
});

export const WsEventSchema = z.discriminatedUnion('type', [
  ServiceStatusChangedSchema,
  IncidentOpenedSchema,
  IncidentResolvedSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export const WsClientMessageSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  topic: z.string().min(1),
});
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
