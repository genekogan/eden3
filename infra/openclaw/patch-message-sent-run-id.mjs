import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// OpenClaw 2026.7.1 exposes the opaque agent run id to
// reply_payload_sending, but its normal durable Telegram path and its
// provider-specific fallback both drop that identity before message_sent.
// Carry the id as private channelData only after the Eden delivery gate has
// approved the payload, then consume it at both success emitters. The pinned
// bundle is patched with exact anchors so an upstream layout change fails the
// image build instead of silently weakening billing correlation.
const distDir = '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

async function patchExactlyOne(label, replacements) {
  let patchedFiles = 0;
  for (const file of candidates) {
    const source = await readFile(file, 'utf8');
    const counts = replacements.map(({ anchor }) => source.split(anchor).length - 1);
    if (counts.every((count) => count === 0)) continue;
    const invalid = counts.findIndex(
      (count, index) => count !== replacements[index].expectedCount,
    );
    if (invalid !== -1) {
      throw new Error(
        `OpenClaw ${label} patch anchors changed in ${path.basename(file)} ` +
          `(${counts.join(',')})`,
      );
    }
    let next = source;
    for (const { anchor, replacement } of replacements) {
      next = next.split(anchor).join(replacement);
    }
    await writeFile(file, next, 'utf8');
    patchedFiles += 1;
  }
  if (patchedFiles !== 1) {
    throw new Error(`Expected one OpenClaw ${label} bundle to patch, found ${patchedFiles}`);
  }
}

await patchExactlyOne('reply payload run-id marker', [
  {
    expectedCount: 1,
    anchor:
      'return hookedPayload && hasOutboundReplyContent(hookedPayload) ? hookedPayload : null;',
    replacement:
      'if (!hookedPayload || !hasOutboundReplyContent(hookedPayload)) return null;\n' +
      '\t\treturn copyReplyPayloadMetadata(hookedPayload, {\n' +
      '\t\t\t...hookedPayload,\n' +
      '\t\t\tchannelData: {\n' +
      '\t\t\t\t...(hookedPayload.channelData ?? {}),\n' +
      '\t\t\t\teden3RunId: runId\n' +
      '\t\t\t}\n' +
      '\t\t});',
  },
]);

await patchExactlyOne('generic message_sent run-id', [
  {
    expectedCount: 1,
    anchor:
      'channelId: params.channel,\n\t\t\taccountId: params.accountId ?? void 0,\n' +
      '\t\t\tconversationId: params.to,\n\t\t\tsessionKey: params.sessionKeyForInternalHooks,',
    replacement:
      'channelId: params.channel,\n\t\t\taccountId: params.accountId ?? void 0,\n' +
      '\t\t\trunId: params.runId,\n\t\t\tconversationId: params.to,\n' +
      '\t\t\tsessionKey: params.sessionKeyForInternalHooks,',
  },
  {
    expectedCount: 1,
    anchor: 'accountId,\n\t\tsessionKeyForInternalHooks,',
    replacement:
      'accountId,\n' +
      '\t\trunId: params.payloads?.length > 0 && ' +
      'typeof params.payloads[0]?.channelData?.eden3RunId === "string" ' +
      '&& params.payloads.every((payload) => ' +
      'payload.channelData?.eden3RunId === params.payloads[0].channelData.eden3RunId) ' +
      '? params.payloads[0].channelData.eden3RunId : ' +
      'params.replyPayloadSendingHook?.runId,\n' +
      '\t\tsessionKeyForInternalHooks,',
  },
]);

await patchExactlyOne('Telegram fallback message_sent run-id', [
  {
    expectedCount: 1,
    anchor:
      'accountId: params.accountId,\n\t\tconversationId: params.chatId,\n' +
      '\t\tmessageId: typeof params.messageId === "number" ? String(params.messageId) : void 0,',
    replacement:
      'accountId: params.accountId,\n\t\trunId: params.runId,\n' +
      '\t\tconversationId: params.chatId,\n' +
      '\t\tmessageId: typeof params.messageId === "number" ? String(params.messageId) : void 0,',
  },
  {
    expectedCount: 2,
    anchor:
      'accountId: params.accountId,\n\t\t\t\tcontent: contentForSentHook,',
    replacement:
      'accountId: params.accountId,\n' +
      '\t\t\t\trunId: typeof reply.channelData?.eden3RunId === "string" ' +
      '? reply.channelData.eden3RunId : void 0,\n' +
      '\t\t\t\tcontent: contentForSentHook,',
  },
]);
