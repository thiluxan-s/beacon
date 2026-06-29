CREATE TYPE "public"."check_status" AS ENUM('success', 'failure', 'timeout', 'error');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('pending', 'up', 'degraded', 'down', 'paused');--> statement-breakpoint
CREATE TABLE "service_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "check_status" NOT NULL,
	"status_code" integer,
	"response_time_ms" integer,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_url" text NOT NULL,
	"health_check_path" text DEFAULT '/' NOT NULL,
	"expected_status_codes" integer[] DEFAULT '{200}' NOT NULL,
	"check_interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_seconds" integer DEFAULT 10 NOT NULL,
	"current_status" "service_status" DEFAULT 'pending' NOT NULL,
	"current_status_since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_check_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"paused" boolean DEFAULT false NOT NULL,
	"alerts_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_checks" ADD CONSTRAINT "service_checks_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_checks_service_checked_idx" ON "service_checks" USING btree ("service_id","checked_at");--> statement-breakpoint
CREATE INDEX "services_user_status_idx" ON "services" USING btree ("user_id","current_status");--> statement-breakpoint
CREATE INDEX "services_next_check_idx" ON "services" USING btree ("next_check_at");