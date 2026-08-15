import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { credit, debit, getBalance } from '@eden3/core';
import { db, pg } from '@eden3/db';
import { describe, expect, it, vi } from 'vitest';

import { VoiceKernel } from '../src/services/voice-kernel';
import type { VoiceAudioProcessor } from '../src/services/voice-audio';
import type { VoiceProviderClient } from '../src/services/voice-provider';

const marker = `voicepg_${randomUUID().slice(0, 8)}`;

function testKernel(voiceOutputRoot: string, afterDirectVoiceEligibilityLocked?: () => Promise<void>) {
  return new VoiceKernel({
    db,
    mediaStore: { put: async () => { throw new Error('not used'); } },
    audio: {} as VoiceAudioProcessor,
    providers: {},
    cleanupArtifact: async (sha256, mime) => {
      const extension = mime === 'audio/mpeg' ? 'mp3' : mime === 'audio/ogg' ? 'ogg' : 'bin';
      await unlink(path.join(voiceOutputRoot, `${sha256}.${extension}`)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
    voiceOutputRoot,
    afterDirectVoiceEligibilityLocked,
  });
}

async function expectPrivateNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    statusCode: 404,
    code: 'voice_output_not_found',
  });
}

async function insertCompletedExecution(input: {
  ownerId: string;
  purpose: 'preview' | 'chat';
  outputPath: string;
  outputUrl: string;
  sha256: string;
  sizeBytes: number;
  agentId?: string;
  sessionId?: string;
  messageId?: string;
}) {
  const id = randomUUID();
  await pg`
    insert into voice_executions (
      id,owner_account_id,agent_account_id,session_id,message_id,purpose,voice_id,text_sha256,request_sha256,
      idempotency_key,character_count,billed_character_count,provider,model,status,reserved_manna,
      reserved_subscription_manna,cost_usd,table_version,output_url,output_local_path,output_sha256,
      output_mime,output_size_bytes,output_duration_ms,completed_at
    ) values (
      ${id},${input.ownerId},${input.agentId ?? null},${input.sessionId ?? null},${input.messageId ?? null},${input.purpose},
      'deepinfra:kokoro:af_bella:v1',${'1'.repeat(64)},${'2'.repeat(64)},
      ${`voice-proof-${id}`},12,12,'deepinfra','hexgrad/Kokoro-82M','completed',0,0,0,
      'voice-pricing-v1',${input.outputUrl},${input.outputPath},${input.sha256},'audio/mpeg',
      ${input.sizeBytes},1000,now()
    )
  `;
  return id;
}

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

describe('Postgres private voice output authorization', () => {
  it('enforces preview ownership and exact readable chat attachment custody', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'eden3-voice-output-pg-')));
    const bytes = Buffer.from('private voice output proof');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const outputPath = path.join(root, `${sha256}.mp3`);
    await writeFile(outputPath, bytes, { mode: 0o600 });

    const account = async (suffix: string, type: 'user' | 'agent' = 'user') => {
      const [row] = await pg<{ id: string }[]>`
        insert into accounts (type,username) values (${type},${`${marker}_${suffix}_${randomUUID().slice(0, 8)}`})
        returning id
      `;
      if (!row) throw new Error(`account fixture failed: ${suffix}`);
      return row.id;
    };
    const ownerId = await account('output_owner');
    const memberId = await account('output_member');
    const outsiderId = await account('output_outsider');
    const agentOwnerId = await account('output_agent_owner');
    const agentId = await account('output_agent', 'agent');
    await pg`
      insert into agents (account_id,owner_id,name,public)
      values (${agentId},${agentOwnerId},${`${marker} output agent`},false)
    `;
    const [session] = await pg<{ id: string }[]>`
      insert into sessions (owner_id,title,visible,deleted)
      values (${ownerId},${`${marker} private voice session`},true,false) returning id
    `;
    if (!session) throw new Error('session fixture failed');
    await pg`insert into session_users (session_id,user_account_id) values (${session.id},${memberId})`;
    await pg`insert into session_agents (session_id,agent_account_id) values (${session.id},${agentId})`;
    const [message] = await pg<{ id: string }[]>`
      insert into messages (session_id,sender_id,role,content,attachments)
      values (${session.id},${agentId},'assistant','voice proof','[]'::jsonb) returning id
    `;
    if (!message) throw new Error('message fixture failed');

    const previewUrl = `/media/voice/${randomUUID()}`;
    const previewId = await insertCompletedExecution({
      ownerId,
      purpose: 'preview',
      outputPath,
      outputUrl: previewUrl,
      sha256,
      sizeBytes: bytes.length,
    });
    const chatUrl = `/media/voice/${randomUUID()}`;
    const chatId = await insertCompletedExecution({
      ownerId,
      agentId,
      purpose: 'chat',
      outputPath,
      outputUrl: chatUrl,
      sha256,
      sizeBytes: bytes.length,
      sessionId: session.id,
      messageId: message.id,
    });
    const unattachedChatId = await insertCompletedExecution({
      ownerId,
      purpose: 'chat',
      outputPath,
      outputUrl: `/media/voice/${randomUUID()}`,
      sha256,
      sizeBytes: bytes.length,
    });
    await pg`
      update messages set attachments=${JSON.stringify([{
        kind: 'audio',
        url: chatUrl,
        voiceExecutionId: chatId,
      }])}::jsonb where id=${message.id}
    `;

    const kernel = testKernel(root);
    try {
      await expect(kernel.ownerVoiceOutput(ownerId, previewId)).resolves.toMatchObject({
        bytes,
        mime: 'audio/mpeg',
        sizeBytes: bytes.length,
        sha256,
      });
      await expectPrivateNotFound(kernel.ownerVoiceOutput(memberId, previewId));

      await expect(kernel.ownerVoiceOutput(ownerId, chatId)).resolves.toMatchObject({ bytes, sha256 });
      await expect(kernel.ownerVoiceOutput(memberId, chatId)).resolves.toMatchObject({ bytes, sha256 });
      await expectPrivateNotFound(kernel.ownerVoiceOutput(outsiderId, chatId));
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, unattachedChatId));

      await pg`update messages set role='user' where id=${message.id}`;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await expectPrivateNotFound(kernel.ownerVoiceOutput(memberId, chatId));
      await pg`update messages set role='assistant',sender_id=${outsiderId} where id=${message.id}`;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await pg`update messages set sender_id=${agentId} where id=${message.id}`;

      await pg`
        update messages set attachments=${JSON.stringify([{
          kind: 'audio',
          url: chatUrl,
          voiceExecutionId: previewId,
        }])}::jsonb where id=${message.id}
      `;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await pg`
        update messages set attachments=${JSON.stringify([{
          kind: 'audio',
          url: '/media/voice/wrong',
          voiceExecutionId: chatId,
        }])}::jsonb where id=${message.id}
      `;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await pg`
        update messages set attachments=${JSON.stringify([{
          kind: 'audio',
          url: chatUrl,
          voiceExecutionId: chatId,
        }])}::jsonb where id=${message.id}
      `;

      await pg`update sessions set visible=false where id=${session.id}`;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await pg`update sessions set visible=true,deleted=true where id=${session.id}`;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await pg`update sessions set deleted=false where id=${session.id}`;

      const prepareSettlement = async (name: string, attachments: unknown, targetSessionId = session.id) => {
        const messageId = randomUUID();
        const executionId = randomUUID();
        const outputUrl = `/media/voice/${executionId}`;
        const text = `settle ${name}`;
        const textSha256 = createHash('sha256').update(text).digest('hex');
        const settlementBytes = Buffer.from(`private settlement output ${name} ${executionId}`);
        const settlementSha256 = createHash('sha256').update(settlementBytes).digest('hex');
        const settlementOutputPath = path.join(root, `${settlementSha256}.mp3`);
        await writeFile(settlementOutputPath, settlementBytes, { mode: 0o600 });
        let initialAttachments = attachments;
        if (initialAttachments === 'execution-bound') {
          initialAttachments = [{ voiceExecutionId: executionId, url: '/media/voice/wrong' }];
        } else if (initialAttachments === 'duplicate-execution-bound') {
          initialAttachments = [
            { voiceExecutionId: executionId, url: '/media/voice/wrong' },
            { voiceExecutionId: executionId, url: outputUrl, mime: 'audio/mpeg', durationMs: 1000 },
          ];
        }
        await pg`
          insert into messages (id,session_id,sender_id,role,content,attachments)
          values (${messageId},${targetSessionId},${agentId},'assistant',${text},
            ${initialAttachments === null ? null : JSON.stringify(initialAttachments)}::jsonb)
        `;
        await pg`
          insert into voice_executions (
            id,owner_account_id,agent_account_id,session_id,message_id,purpose,voice_id,text_sha256,
            request_sha256,idempotency_key,character_count,billed_character_count,provider,model,status,
            reserved_manna,reserved_subscription_manna,cost_usd,table_version,output_url,output_local_path,
            output_sha256,output_mime,output_size_bytes,output_duration_ms
          ) values (
            ${executionId},${ownerId},${agentId},${targetSessionId},${messageId},'chat',
            'deepinfra:kokoro:af_bella:v1',${textSha256},${'4'.repeat(64)},
            ${`voice-settle-${executionId}`},12,12,'deepinfra','hexgrad/Kokoro-82M','transcoding',
            0,0,0,'voice-pricing-v1',${outputUrl},${settlementOutputPath},${settlementSha256},'audio/mpeg',${settlementBytes.length},1000
          )
        `;
        await pg`
          insert into usage_events (event_type,status,user_id,agent_id,session_id,message_id,turn_id,provider,model,manna)
          values ('voice_generation','provider_admitted',${ownerId},${agentId},${targetSessionId},${messageId},
            ${executionId},'deepinfra','hexgrad/Kokoro-82M',0)
        `;
        await pg`
          insert into direct_voice_jobs (
            message_id,owner_account_id,session_id,agent_account_id,voice_id,text_sha256,mode,status,execution_id
          ) values (
            ${messageId},${ownerId},${targetSessionId},${agentId},'deepinfra:kokoro:af_bella:v1',
            ${textSha256},'on_demand','attachment_pending',${executionId}
          )
        `;
        return { messageId, executionId, outputUrl, outputPath: settlementOutputPath, text };
      };

      const settlementCases: Array<{ name: string; attachments: unknown }> = [
        { name: 'null', attachments: null },
        { name: 'object', attachments: { legacy: true } },
        { name: 'scalar', attachments: 'legacy' },
        { name: 'wrong-url', attachments: 'execution-bound' },
        { name: 'duplicates', attachments: 'duplicate-execution-bound' },
      ];
      for (const settlementCase of settlementCases) {
        const prepared = await prepareSettlement(settlementCase.name, settlementCase.attachments);
        await expect((kernel as unknown as {
          settleDirectVoiceAttachment(messageId: string): Promise<{ execution: { status: string } }>;
        }).settleDirectVoiceAttachment(prepared.messageId)).resolves.toMatchObject({ execution: { status: 'completed' } });
        const [settledMessage] = await pg<{ attachments: unknown[] }[]>`
          select attachments from messages where id=${prepared.messageId}
        `;
        expect(settledMessage?.attachments).toEqual([{
          url: prepared.outputUrl,
          mime: 'audio/mpeg',
          durationMs: 1000,
          voiceExecutionId: prepared.executionId,
        }]);
        expect(await pg`select status from usage_events where turn_id=${prepared.executionId}`).toEqual([{ status: 'completed' }]);
      }

      const expectSettlementRefused = async (
        prepared: Awaited<ReturnType<typeof prepareSettlement>>,
        mutate: () => Promise<unknown>,
        restore?: () => Promise<unknown>,
      ) => {
        await credit({ accountId: ownerId, amount: 1, type: 'credit:test' });
        const balanceBeforeReservation = await getBalance(ownerId);
        await debit({
          accountId: ownerId,
          amount: 1,
          type: 'spend:voice_chat',
          idempotencyKey: `voice:${prepared.executionId}`,
        });
        await pg`update voice_executions set reserved_manna=1 where id=${prepared.executionId}`;
        await pg`update usage_events set manna=1 where turn_id=${prepared.executionId}`;
        await mutate();
        await expect((kernel as unknown as {
          settleDirectVoiceAttachment(messageId: string): Promise<unknown>;
        }).settleDirectVoiceAttachment(prepared.messageId)).rejects.toMatchObject({
          code: 'voice_message_not_eligible',
        });
        expect(await pg`select status from usage_events where turn_id=${prepared.executionId}`).toEqual([{ status: 'error' }]);
        expect(await pg`select status from voice_executions where id=${prepared.executionId}`).toEqual([{ status: 'failed' }]);
        expect(await pg`select status from direct_voice_jobs where message_id=${prepared.messageId}`).toEqual([{ status: 'failed' }]);
        expect(await getBalance(ownerId)).toEqual(balanceBeforeReservation);
        expect(await pg`
          select refund.amount::float8 amount,refund.type,refund.idempotency_key
          from manna_transactions debit join manna_transactions refund on refund.refunds_transaction_id=debit.id
          where debit.idempotency_key=${`voice:${prepared.executionId}`}
        `).toEqual([{ amount: 1, type: 'refund:voice', idempotency_key: `refund:voice:${prepared.executionId}` }]);
        expect(await pg`
          select status,manna::float8 manna from usage_events where turn_id=${prepared.executionId}
        `).toEqual([{ status: 'error', manna: 0 }]);
        await expect(access(prepared.outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await restore?.();
        await expect((kernel as unknown as {
          settleDirectVoiceAttachment(messageId: string): Promise<unknown>;
        }).settleDirectVoiceAttachment(prepared.messageId)).rejects.toMatchObject({
          code: 'voice_execution_in_progress',
        });
        expect(await getBalance(ownerId)).toEqual(balanceBeforeReservation);
        expect(await pg`
          select count(*)::int count from manna_transactions refund
          join manna_transactions debit on debit.id=refund.refunds_transaction_id
          where debit.idempotency_key=${`voice:${prepared.executionId}`}
        `).toEqual([{ count: 1 }]);
      };

      const changedText = await prepareSettlement('changed-text', []);
      await expectSettlementRefused(
        changedText,
        async () => { await pg`update messages set content='changed after synthesis' where id=${changedText.messageId}`; },
        async () => { await pg`update messages set content=${changedText.text} where id=${changedText.messageId}`; },
      );
      const changedSender = await prepareSettlement('changed-sender', []);
      await expectSettlementRefused(
        changedSender,
        async () => { await pg`update messages set sender_id=${outsiderId} where id=${changedSender.messageId}`; },
        async () => { await pg`update messages set sender_id=${agentId} where id=${changedSender.messageId}`; },
      );
      const hiddenSession = await prepareSettlement('hidden-session', []);
      await expectSettlementRefused(
        hiddenSession,
        async () => { await pg`update sessions set visible=false where id=${session.id}`; },
        async () => { await pg`update sessions set visible=true where id=${session.id}`; },
      );
      const deletedSession = await prepareSettlement('deleted-session', []);
      await expectSettlementRefused(
        deletedSession,
        async () => { await pg`update sessions set deleted=true where id=${session.id}`; },
        async () => { await pg`update sessions set deleted=false where id=${session.id}`; },
      );

      const [memberSettlementSession] = await pg<{ id: string }[]>`
        insert into sessions (owner_id,title,visible,deleted)
        values (${outsiderId},${`${marker} member settlement session`},true,false) returning id
      `;
      if (!memberSettlementSession) throw new Error('member settlement session fixture failed');
      await pg`insert into session_users (session_id,user_account_id) values (${memberSettlementSession.id},${ownerId})`;
      await pg`insert into session_agents (session_id,agent_account_id) values (${memberSettlementSession.id},${agentId})`;
      const removedMember = await prepareSettlement('removed-member', [], memberSettlementSession.id);
      await expectSettlementRefused(
        removedMember,
        async () => { await pg`delete from session_users where session_id=${memberSettlementSession.id} and user_account_id=${ownerId}`; },
        async () => { await pg`insert into session_users (session_id,user_account_id) values (${memberSettlementSession.id},${ownerId})`; },
      );

      const lockedSettlement = await prepareSettlement('two-client-lock', []);
      let reportLocked!: () => void;
      let releaseEligibility!: () => void;
      const eligibilityLocked = new Promise<void>((resolve) => { reportLocked = resolve; });
      const release = new Promise<void>((resolve) => { releaseEligibility = resolve; });
      const lockProofKernel = testKernel(root, async () => {
        reportLocked();
        await release;
      });
      const settlementPromise = (lockProofKernel as unknown as {
        settleDirectVoiceAttachment(messageId: string): Promise<{ execution: { status: string } }>;
      }).settleDirectVoiceAttachment(lockedSettlement.messageId);
      await eligibilityLocked;
      const blockedMutation = pg.begin(async (tx) => {
        await tx.unsafe("set local lock_timeout='100ms'");
        await tx`
          update messages set content='concurrent mutation after eligibility lock'
          where id=${lockedSettlement.messageId}
        `;
      });
      await expect(blockedMutation).rejects.toMatchObject({ code: '55P03' });
      releaseEligibility();
      await expect(settlementPromise).resolves.toMatchObject({ execution: { status: 'completed' } });
      await expect(pg`
        update messages set content='concurrent mutation after eligibility lock'
        where id=${lockedSettlement.messageId}
      `).resolves.toHaveLength(0);
      expect(await pg`select content from messages where id=${lockedSettlement.messageId}`).toEqual([
        { content: 'concurrent mutation after eligibility lock' },
      ]);

      await writeFile(outputPath, Buffer.alloc(bytes.length, 0x78));
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, previewId));
      await writeFile(outputPath, bytes);

      const outsidePath = path.join(root, 'outside.mp3');
      await writeFile(outsidePath, bytes);
      await unlink(outputPath);
      await symlink(outsidePath, outputPath);
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, previewId));

      const erasingOwnerId = await account('erasing_output_owner');
      const erasingPreviewId = await insertCompletedExecution({
        ownerId: erasingOwnerId,
        purpose: 'preview',
        outputPath: outsidePath,
        outputUrl: `/media/voice/${randomUUID()}`,
        sha256,
        sizeBytes: bytes.length,
      });
      await pg`insert into account_erasure_jobs (account_id) values (${erasingOwnerId})`;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(erasingOwnerId, erasingPreviewId));

      await pg`insert into account_erasure_jobs (account_id) values (${agentOwnerId})`;
      await expectPrivateNotFound(kernel.ownerVoiceOutput(ownerId, chatId));
      await expectPrivateNotFound(kernel.ownerVoiceOutput(memberId, chatId));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
