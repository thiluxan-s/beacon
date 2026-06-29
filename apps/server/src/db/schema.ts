import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
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

export type Service = typeof services.$inferSelect;
export type NewService = typeof services.$inferInsert;
export type ServiceCheck = typeof serviceChecks.$inferSelect;
export type NewServiceCheck = typeof serviceChecks.$inferInsert;
