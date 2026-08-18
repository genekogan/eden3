import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// OpenClaw 2026.7.1's message_received mapper drops the provider-admitted
// WasMentioned and SenderIsBot bits from FinalizedMsgContext. Eden's group
// authorization and durable bot-loop breaker must consume those trusted bits;
// synthesizing them in a plugin would weaken both gates. Patch the pinned
// mapper with exact anchors so an upstream bundle change fails the image build.
const distDir = process.env.OPENCLAW_DIST_DIR ?? '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const replacements = [
  {
    expectedCount: 1,
    anchor:
      '\t\tsenderUsername: ctx.SenderUsername,\n' +
      '\t\tsenderE164: ctx.SenderE164,\n' +
      '\t\treplyToId: ctx.ReplyToId,',
    replacement:
      '\t\tsenderUsername: ctx.SenderUsername,\n' +
      '\t\tsenderE164: ctx.SenderE164,\n' +
      '\t\twasMentioned: ctx.WasMentioned === true,\n' +
      '\t\tsenderIsBot: ctx.SenderIsBot === true,\n' +
      '\t\treplyToId: ctx.ReplyToId,',
  },
  {
    expectedCount: 1,
    anchor:
      '\t\t\tsenderName: canonical.senderName,\n' +
      '\t\t\tsenderUsername: canonical.senderUsername,\n' +
      '\t\t\tsenderE164: canonical.senderE164,\n' +
      '\t\t\treplyToId: canonical.replyToId,',
    replacement:
      '\t\t\tsenderName: canonical.senderName,\n' +
      '\t\t\tsenderUsername: canonical.senderUsername,\n' +
      '\t\t\tsenderE164: canonical.senderE164,\n' +
      '\t\t\twasMentioned: canonical.wasMentioned,\n' +
      '\t\t\tsenderIsBot: canonical.senderIsBot,\n' +
      '\t\t\treplyToId: canonical.replyToId,',
  },
];

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
      `OpenClaw channel inbound trust patch anchors changed in ${path.basename(file)} ` +
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
  throw new Error(
    `Expected one OpenClaw channel inbound trust bundle to patch, found ${patchedFiles}`,
  );
}
