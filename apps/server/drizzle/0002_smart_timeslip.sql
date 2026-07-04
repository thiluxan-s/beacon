CREATE TABLE "service_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"integration_id" text NOT NULL,
	"config" jsonb NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_snapshot" jsonb,
	"last_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_integrations" ADD CONSTRAINT "service_integrations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_integrations_service_integration_idx" ON "service_integrations" USING btree ("service_id","integration_id");--> statement-breakpoint
CREATE INDEX "service_integrations_due_idx" ON "service_integrations" USING btree ("enabled","last_fetched_at");