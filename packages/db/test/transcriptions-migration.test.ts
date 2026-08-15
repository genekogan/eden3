import { existsSync, readFileSync } from 'node:fs';

import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { transcriptionChunks, transcriptionSessions } from '../src/schema';

const migrationUrl = new URL('../migrations/0046_resilient_transcriptions.sql', import.meta.url);

describe('resilient transcriptions migration', () => {
  it('creates owner-scoped sessions and numbered immutable chunks', () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const sql = readFileSync(migrationUrl, 'utf8');
    const sessions = getTableConfig(transcriptionSessions);
    const chunks = getTableConfig(transcriptionChunks);

    expect(sessions.name).toBe('transcription_sessions');
    expect(chunks.name).toBe('transcription_chunks');
    expect(chunks.primaryKeys).toHaveLength(1);
    expect(sql).toContain('transcription_sessions_owner_create_key_uq');
    expect(sql).toContain('transcription_chunks_sha_check');
    expect(sql).toContain('transcription_sessions_duration_check');
    expect(sql).toContain('transcription_sessions_checkpoint_check');
    expect(sql).toContain("v_usage.event_type NOT IN ('studio_generation','chat_media','speech_transcription')");
    expect(sql).toContain("v_key IS DISTINCT FROM 'transcription:'||v_usage.turn_id::text");
    expect(sql).toContain("v_usage.status='pending' AND s.status IN ('reserving','queued','processing')");
    expect(sql).toContain("v_usage.status='refund_pending' AND s.status IN ('failed','deleted','expired')");
    expect(sql).toContain("IF v_usage.event_type='speech_transcription' THEN");
    expect(sql).toContain('UPDATE public.usage_events SET manna=0,cost_usd=NULL');
    expect(sql).toContain('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE');
    expect(sql).toContain('TO eden3_erasure_operator');
  });
});
