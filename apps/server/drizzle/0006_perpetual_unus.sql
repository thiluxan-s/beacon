ALTER TABLE "domains" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;