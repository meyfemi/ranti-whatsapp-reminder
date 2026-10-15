CREATE TYPE "public"."date_format" AS ENUM('DMY', 'MDY');--> statement-breakpoint
ALTER TYPE "public"."interaction_kind" ADD VALUE 'bulk_import';--> statement-breakpoint
ALTER TYPE "public"."interaction_kind" ADD VALUE 'confirm_link';--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "date_format" date_format DEFAULT 'DMY' NOT NULL;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "subject_name" text;--> statement-breakpoint
ALTER TABLE "reminders" ADD COLUMN "birth_year" integer;