import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const serviceStatus = pgEnum('service_status', ['pending', 'up', 'degraded', 'down', 'paused']);
export const checkStatus = pgEnum('check_status', ['success', 'failure', 'timeout', 'error']);
export const incidentSeverity = pgEnum('incident_severity', ['degraded', 'down']);
export const incidentEventType = pgEnum('incident_event_type', ['opened', 'observed', 'resolved', 'note']);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    baseUrl: text('base_url').notNull(),
    healthCheckPath: text('health_check_path').notNull().default('/'),
    expectedStatusCodes: integer('expected_status_codes').array().notNull().default([200]),
    checkIntervalSeconds: integer('check_interval_seconds').notNull().default(60),
    timeoutSeconds: integer('timeout_seconds').notNull().default(10),
    currentStatus: serviceStatus('current_status').notNull().default('pending'),
    currentStatusSince: timestamp('current_status_since', { withTimezone: true }).notNull().defaultNow(),
    lastCheckAt: timestamp('last_check_at', { withTimezone: true }),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    paused: boolean('paused').notNull().default(false),
    alertsEnabled: boolean('alerts_enabled').notNull().default(true),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    consecutiveSuccesses: integer('consecutive_successes').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('services_user_status_idx').on(t.userId, t.currentStatus),
    index('services_next_check_idx').on(t.nextCheckAt),
  ],
);

export const serviceChecks = pgTable(
  'service_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    status: checkStatus('status').notNull(),
    statusCode: integer('status_code'),
    responseTimeMs: integer('response_time_ms'),
    errorMessage: text('error_message'),
  },
  (t) => [index('service_checks_service_checked_idx').on(t.serviceId, t.checkedAt)],
);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    severity: incidentSeverity('severity').notNull(),
    triggerCheckId: uuid('trigger_check_id').references(() => serviceChecks.id, { onDelete: 'set null' }),
    resolutionCheckId: uuid('resolution_check_id').references(() => serviceChecks.id, { onDelete: 'set null' }),
    notificationSent: boolean('notification_sent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incidents_service_started_idx').on(t.serviceId, t.startedAt.desc()),
    uniqueIndex('incidents_one_open_per_service_idx').on(t.serviceId).where(sql`resolved_at IS NULL`),
  ],
);

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    eventType: incidentEventType('event_type').notNull(),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('incident_events_incident_occurred_idx').on(t.incidentId, t.occurredAt)],
);

export type Incident = typeof incidents.$inferSelect;
export type NewIncident = typeof incidents.$inferInsert;
export type IncidentEvent = typeof incidentEvents.$inferSelect;
export type NewIncidentEvent = typeof incidentEvents.$inferInsert;

export const serviceIntegrations = pgTable(
  'service_integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    integrationId: text('integration_id').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
    lastSnapshot: jsonb('last_snapshot').$type<Record<string, unknown>>(),
    lastError: text('last_error'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_integrations_service_integration_idx').on(t.serviceId, t.integrationId),
    index('service_integrations_due_idx').on(t.enabled, t.lastFetchedAt),
  ],
);

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type ServiceCheck = typeof serviceChecks.$inferSelect;
export type NewServiceCheck = typeof serviceChecks.$inferInsert;
export type ServiceIntegration = typeof serviceIntegrations.$inferSelect;
export type NewServiceIntegration = typeof serviceIntegrations.$inferInsert;
