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

export const WsEventSchema = z.discriminatedUnion('type', [ServiceStatusChangedSchema]);
export type WsEvent = z.infer<typeof WsEventSchema>;

export const WsClientMessageSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  topic: z.string().min(1),
});
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;
