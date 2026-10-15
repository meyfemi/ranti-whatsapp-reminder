ALTER TABLE "groups" ALTER COLUMN "digest_enabled" SET DEFAULT true;--> statement-breakpoint
-- Opt in every existing group (the digest had not shipped yet, so none chose "off").
UPDATE "groups" SET "digest_enabled" = true;
