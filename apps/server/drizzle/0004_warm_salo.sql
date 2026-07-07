CREATE TYPE "public"."alert_channel" AS ENUM('email');--> statement-breakpoint
CREATE TYPE "public"."alert_kind" AS ENUM('opened', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "alerts_sent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"channel" "alert_channel" NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"status" "alert_status" NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"alerts_enabled" boolean DEFAULT true NOT NULL,
	"alert_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_settings_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "alerts_sent" ADD CONSTRAINT "alerts_sent_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_sent_incident_idx" ON "alerts_sent" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_sent_one_per_kind_idx" ON "alerts_sent" USING btree ("incident_id","channel","kind") WHERE status = 'sent';