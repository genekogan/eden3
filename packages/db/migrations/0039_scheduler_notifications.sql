-- Fail before replacing the reviewed 0034 policy when an operator or another
-- migration changed any named constraint/index out of band. PostgreSQL
-- canonicalizes the two expected CHECK expressions on a temporary table.
DO $$
DECLARE
	actual_kind text;
	actual_target text;
	expected_kind text;
	expected_target text;
	actual_index text;
	index_valid boolean;
	index_ready boolean;
	index_unique boolean;
BEGIN
	SELECT
		max(pg_get_expr(c.conbin, c.conrelid, true)) FILTER (WHERE c.conname = 'app_notifications_kind_check'),
		max(pg_get_expr(c.conbin, c.conrelid, true)) FILTER (WHERE c.conname = 'app_notifications_target_path_check')
	INTO actual_kind, actual_target
	FROM pg_constraint c
	JOIN pg_class r ON r.oid = c.conrelid
	JOIN pg_namespace n ON n.oid = r.relnamespace
	WHERE n.nspname = 'public'
		AND r.relname = 'app_notifications'
		AND c.contype = 'c'
		AND c.convalidated
		AND NOT c.connoinherit;

	CREATE TEMP TABLE eden3_expected_app_notifications_policy (
		kind text,
		target_path text
	) ON COMMIT DROP;
	ALTER TABLE pg_temp.eden3_expected_app_notifications_policy
		ADD CONSTRAINT eden3_expected_app_notifications_kind CHECK (
			kind in ('agent_build_ready', 'agent_build_failed')
		),
		ADD CONSTRAINT eden3_expected_app_notifications_target CHECK (
			target_path is null or target_path ~ '^/agents/[a-z0-9][a-z0-9_-]{2,31}$'
		);

	SELECT
		max(pg_get_expr(c.conbin, c.conrelid, true)) FILTER (WHERE c.conname = 'eden3_expected_app_notifications_kind'),
		max(pg_get_expr(c.conbin, c.conrelid, true)) FILTER (WHERE c.conname = 'eden3_expected_app_notifications_target')
	INTO expected_kind, expected_target
	FROM pg_constraint c
	JOIN pg_class r ON r.oid = c.conrelid
	WHERE r.relnamespace = pg_my_temp_schema()
		AND r.relname = 'eden3_expected_app_notifications_policy';

	SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready, i.indisunique
	INTO actual_index, index_valid, index_ready, index_unique
	FROM pg_index i
	JOIN pg_class x ON x.oid = i.indexrelid
	JOIN pg_class r ON r.oid = i.indrelid
	JOIN pg_namespace n ON n.oid = r.relnamespace
	WHERE n.nspname = 'public'
		AND r.relname = 'app_notifications'
		AND x.relname = 'app_notifications_build_once_uq';

	DROP TABLE pg_temp.eden3_expected_app_notifications_policy;
	IF actual_kind IS DISTINCT FROM expected_kind
		OR actual_target IS DISTINCT FROM expected_target
		OR actual_index IS DISTINCT FROM 'CREATE UNIQUE INDEX app_notifications_build_once_uq ON public.app_notifications USING btree (account_id, kind, source_agent_id)'
		OR index_valid IS DISTINCT FROM true
		OR index_ready IS DISTINCT FROM true
		OR index_unique IS DISTINCT FROM true THEN
		RAISE EXCEPTION 'app_notifications policy drifted before 0039'
			USING ERRCODE = '23514';
	END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "app_notifications" DROP CONSTRAINT "app_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "app_notifications" DROP CONSTRAINT "app_notifications_target_path_check";--> statement-breakpoint
DROP INDEX "app_notifications_build_once_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "app_notifications_build_once_uq" ON "app_notifications" USING btree ("account_id","kind","source_agent_id") WHERE "app_notifications"."kind" in ('agent_build_ready', 'agent_build_failed');--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_kind_check" CHECK ("app_notifications"."kind" in ('agent_build_ready', 'agent_build_failed', 'scheduled_task_completed'));--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_target_path_check" CHECK ("app_notifications"."target_path" is null or "app_notifications"."target_path" ~ '^/(agents/[a-z0-9][a-z0-9_-]{2,31}|sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$');
