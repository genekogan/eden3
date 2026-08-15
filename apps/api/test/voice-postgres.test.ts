import { randomUUID } from 'node:crypto';

import { db, pg } from '@eden3/db';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { VoiceKernel } from '../src/services/voice-kernel';
import type { VoiceAudioProcessor } from '../src/services/voice-audio';
import type { VoiceProviderClient } from '../src/services/voice-provider';

const marker = `voicepg_${randomUUID().slice(0, 8)}`;

afterAll(async () => {
  await pg`delete from voice_clone_clips where clone_id in (
    select id from voice_clones where owner_account_id in (
      select id from accounts where username like ${`${marker}%`}
    )
  )`;
  await pg`delete from voice_clones where owner_account_id in (
    select id from accounts where username like ${`${marker}%`}
  )`;
  await pg`delete from storage_objects where owner_account_id in (
    select id from accounts where username like ${`${marker}%`}
  )`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
});

async function fixture() {
  const [owner] = await pg<{ id: string }[]>`
    insert into accounts (type,username) values ('user',${`${marker}_${randomUUID().slice(0, 8)}`}) returning id
  `;
  if (!owner) throw new Error('owner fixture failed');
  const objectId = randomUUID();
  const sha256 = 'a'.repeat(64);
  await pg`
    insert into storage_objects (
      id,owner_account_id,purpose,display_name,declared_mime,declared_size_bytes,declared_sha256,
      verified_mime,verified_size_bytes,verified_sha256,state,backing_store,backing_key,available_at
    ) values (
      ${objectId},${owner.id},'voice-clip','sample.wav','audio/wav',64000,${sha256},
      'audio/wav',64000,${sha256},'available','local',${`objects/${objectId.slice(0, 2)}/${objectId}`},now()
    )
  `;
  const insertClone = async (position: number) => {
    const id = randomUUID();
    await pg`
      insert into voice_clones (
        id,owner_account_id,name,provider,status,consent_version,consent_attested_at,
        clip_manifest_sha256,request_sha256,idempotency_key
      ) values (
        ${id},${owner.id},${`clone ${position}`},'cartesia','cloning','voice-clone-consent-v1',now(),
        ${String(position).padStart(64, 'b')},${String(position).padStart(64, 'c')},${`clone-key-${position}-${randomUUID()}`}
      )
    `;
    await pg`
      insert into voice_clone_clips (clone_id,object_id,position,sha256,mime,size_bytes,duration_ms)
      values (${id},${objectId},0,${sha256},'audio/wav',64000,2000)
    `;
    await pg`
      update voice_clones set status='ready',provider_voice_id=${`provider-${id}`},provider_request_id=${`request-${id}`}
      where id=${id}
    `;
    return id;
  };
  return { ownerId: owner.id, objectId, first: await insertClone(1), second: await insertClone(2) };
}

describe('Postgres voice clone custody', () => {
  it('preserves shared clips, retains retry locators on cleanup failure, and removes the final private sample', async () => {
    const data = await fixture();
    const deletedProviderVoices: string[] = [];
    let failCleanup = false;
    const deletePrivateClip = vi.fn(async () => {
      if (failCleanup) throw new Error('injected cleanup failure');
    });
    const provider: VoiceProviderClient = {
      provider: 'cartesia',
      synthesize: async () => { throw new Error('not used'); },
      deleteClone: async (providerVoiceId) => { deletedProviderVoices.push(providerVoiceId); },
    };
    const audio: VoiceAudioProcessor = {
      inspectClip: async () => ({ durationMs: 2_000 }),
      combineCloneClips: async () => ({ bytes: Buffer.alloc(1), mime: 'audio/wav', durationMs: 5_000 }),
      process: async () => { throw new Error('not used'); },
    };
    const kernel = new VoiceKernel({
      db,
      mediaStore: { put: async () => { throw new Error('not used'); } },
      audio,
      providers: { cartesia: provider },
      cleanupArtifact: async () => undefined,
      deletePrivateClip,
    });

    await kernel.deleteClone(data.ownerId, data.first);
    expect(deletePrivateClip).not.toHaveBeenCalled();
    expect(await pg`select id from storage_objects where id=${data.objectId}`).toHaveLength(1);
    expect(await pg`select clone_id from voice_clone_clips where object_id=${data.objectId}`).toEqual([{ clone_id: data.second }]);

    failCleanup = true;
    await expect(kernel.deleteClone(data.ownerId, data.second)).rejects.toMatchObject({
      statusCode: 503,
      code: 'clone_clip_cleanup_pending',
    });
    expect(await pg`select id from storage_objects where id=${data.objectId}`).toHaveLength(1);
    expect(await pg`select clone_id from voice_clone_clips where object_id=${data.objectId}`).toEqual([{ clone_id: data.second }]);
    expect(await pg`select status from voice_clones where id=${data.second}`).toEqual([{ status: 'provider_delete_pending' }]);

    failCleanup = false;
    await expect(kernel.deleteClone(data.ownerId, data.second)).resolves.toMatchObject({ status: 'deleted' });
    expect(deletePrivateClip).toHaveBeenCalledTimes(2);
    expect(await pg`select id from storage_objects where id=${data.objectId}`).toHaveLength(0);
    expect(await pg`select clone_id from voice_clone_clips where object_id=${data.objectId}`).toHaveLength(0);
    expect(deletedProviderVoices).toHaveLength(3);
  });
});
