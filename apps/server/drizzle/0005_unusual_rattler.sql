CREATE TYPE "public"."domain_status" AS ENUM('pending', 'healthy', 'warning', 'expiring_soon', 'expired', 'unhealthy');--> statement-breakpoint
CREATE TABLE "domain_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dns_resolved" boolean NOT NULL,
	"dns_ip" text,
	"ssl_valid" boolean,
	"ssl_expires_at" timestamp with time zone,
	"ssl_days_until_expiry" integer,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"check_interval_seconds" integer DEFAULT 3600 NOT NULL,
	"current_status" "domain_status" DEFAULT 'pending' NOT NULL,
	"ssl_expires_at" timestamp with time zone,
	"domain_expires_at" timestamp with time zone,
	"ssl_issuer" text,
	"last_check_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain_checks" ADD CONSTRAINT "domain_checks_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "domain_checks_domain_checked_idx" ON "domain_checks" USING btree ("domain_id","checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_user_domain_idx" ON "domains" USING btree ("user_id","domain");--> statement-breakpoint
CREATE INDEX "domains_next_check_idx" ON "domains" USING btree ("next_check_at");