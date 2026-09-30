CREATE TABLE "auth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_attempts_key_idx" ON "auth_attempts" USING btree ("key_hash","at");--> statement-breakpoint
CREATE INDEX "auth_attempts_at_idx" ON "auth_attempts" USING btree ("at");