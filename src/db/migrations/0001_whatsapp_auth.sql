CREATE TABLE "wa_auth_creds" (
	"session" text PRIMARY KEY NOT NULL,
	"creds" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_auth_keys" (
	"session" text NOT NULL,
	"type" text NOT NULL,
	"key_id" text NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wa_auth_keys_pk" ON "wa_auth_keys" USING btree ("session","type","key_id");