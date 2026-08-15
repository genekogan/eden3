ALTER TABLE "voice_clone_clips" DROP CONSTRAINT "voice_clone_clips_size_chk";
--> statement-breakpoint
ALTER TABLE "voice_clone_clips" ADD CONSTRAINT "voice_clone_clips_size_chk" CHECK ("size_bytes" between 1 and 20971520);
--> statement-breakpoint
ALTER TABLE "voice_clone_clips" DROP CONSTRAINT "voice_clone_clips_duration_chk";
--> statement-breakpoint
ALTER TABLE "voice_clone_clips" ADD CONSTRAINT "voice_clone_clips_duration_chk" CHECK ("duration_ms" between 100 and 30000);
