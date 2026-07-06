CREATE TYPE "public"."incident_event_type" AS ENUM('opened', 'observed', 'resolved', 'note');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('degraded', 'down');--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"event_type" "incident_event_type" NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"duration_seconds" integer,
	"severity" "incident_severity" NOT NULL,
	"trigger_check_id" uuid,
	"resolution_check_id" uuid,
	"notification_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "consecutive_successes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_trigger_check_id_service_checks_id_fk" FOREIGN KEY ("trigger_check_id") REFERENCES "public"."service_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolution_check_id_service_checks_id_fk" FOREIGN KEY ("resolution_check_id") REFERENCES "public"."service_checks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_events_incident_occurred_idx" ON "incident_events" USING btree ("incident_id","occurred_at");--> statement-breakpoint
CREATE INDEX "incidents_service_started_idx" ON "incidents" USING btree ("service_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_open_per_service_idx" ON "incidents" USING btree ("service_id") WHERE resolved_at IS NULL;