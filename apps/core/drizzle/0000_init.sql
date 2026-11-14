CREATE TYPE "public"."room_mode" AS ENUM('text', 'voice', 'video');--> statement-breakpoint
CREATE TYPE "public"."room_type" AS ENUM('public', 'private', 'match');--> statement-breakpoint
CREATE TABLE "anonymous_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	"reputation" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "anonymous_sessions_session_hash_key" UNIQUE("session_hash")
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	"room_id" uuid,
	"action" varchar(32) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	"nickname" varchar(128) NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(32) NOT NULL,
	"type" "room_type" NOT NULL,
	"mode" "room_mode" DEFAULT 'text' NOT NULL,
	"invite_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "rooms_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anonymous_sessions_expires_idx" ON "anonymous_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_events_expires_idx" ON "moderation_events" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "room_members_room_idx" ON "room_members" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "room_members_session_idx" ON "room_members" USING btree ("session_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "room_members_room_session_uidx" ON "room_members" USING btree ("room_id","session_hash");--> statement-breakpoint
CREATE INDEX "rooms_type_idx" ON "rooms" USING btree ("type");--> statement-breakpoint
CREATE INDEX "rooms_mode_idx" ON "rooms" USING btree ("mode");--> statement-breakpoint
CREATE INDEX "rooms_expires_idx" ON "rooms" USING btree ("expires_at");