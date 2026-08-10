import { describe, expect, it } from 'vitest';

import { notificationRowToDto } from '../src/services/app-notifications';

const row = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: 'agent_build_ready' as const,
  target_path: '/agents/ready-agent',
  read_at: null,
  created_at: '2026-08-09 16:00:00.123456+00',
  source_id: '44444444-4444-4444-8444-444444444444',
  source_type: 'agent' as const,
  source_username: 'ready-agent',
  source_image: null,
};

describe('app notification raw-row mapping', () => {
  it('preserves raw Postgres timestamp precision and nullable read state', () => {
    expect(notificationRowToDto(row)).toEqual({
      id: row.id,
      kind: row.kind,
      sourceAgent: {
        id: row.source_id,
        type: row.source_type,
        username: row.source_username,
        userImage: null,
      },
      targetPath: row.target_path,
      readAt: null,
      createdAt: '2026-08-09T16:00:00.123456+00:00',
    });
  });

  it('retains Date compatibility while normalizing raw read timestamps', () => {
    expect(notificationRowToDto({
      ...row,
      read_at: '2026-08-09 16:01:02.654321+00',
      created_at: new Date('2026-08-09T16:00:00.123Z'),
    })).toMatchObject({
      readAt: '2026-08-09T16:01:02.654321+00:00',
      createdAt: '2026-08-09T16:00:00.123Z',
    });
  });
});
