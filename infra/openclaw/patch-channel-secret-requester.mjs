import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { bindEdenChannelRequesterRefs } from './channel-secret-requester-origin.mjs';

// OpenClaw 2026.7.1 normally gives exec providers only an id list. Preserve
// the active credential's exact config origin and unique channel→agent binding
// for Eden's provider. Exact anchors make an upstream bundle drift fail the
// derivative-image build rather than silently dropping requester identity.
const distDir = process.env.OPENCLAW_DIST_DIR ?? '/app/dist';
const candidates = (await readdir(distDir))
  .filter((name) => /^[A-Za-z0-9_.-]+\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const assignmentAnchor =
  'const resolved = await resolveSecretRefValues(context.assignments.map((assignment) => assignment.ref), {';
const assignmentReplacement = `${bindEdenChannelRequesterRefs.toString()}
	const refs = bindEdenChannelRequesterRefs(context.assignments, sourceConfig);
	const resolved = await resolveSecretRefValues(refs, {`;

const requestAnchor = `const requestPayload = {
		protocolVersion: 1,
		provider: params.providerName,
		ids
	};`;
const requestReplacement = `${requestAnchor}
	if (params.providerName === "eden-channel-vault") {
		const requestersById = new Map();
		for (const ref of params.refs) {
			const requester = ref.__edenRequester;
			if (!requester || requester.id !== ref.id || requestersById.has(ref.id)) throw new Error("Eden channel SecretRef requester binding is missing or ambiguous.");
			requestersById.set(ref.id, requester);
		}
		requestPayload.requesters = ids.map((id) => {
			const requester = requestersById.get(id);
			if (!requester) throw new Error("Eden channel SecretRef requester binding is missing.");
			return requester;
		});
	}`;

const replacements = [
  { label: 'assignment', anchor: assignmentAnchor, replacement: assignmentReplacement },
  { label: 'request', anchor: requestAnchor, replacement: requestReplacement },
];

for (const replacement of replacements) {
  let patched = 0;
  for (const file of candidates) {
    const source = await readFile(file, 'utf8');
    const count = source.split(replacement.anchor).length - 1;
    if (count === 0) continue;
    if (count !== 1) {
      throw new Error(
        `OpenClaw channel secret ${replacement.label} patch anchors changed in ${path.basename(file)} (${count})`,
      );
    }
    await writeFile(file, source.replace(replacement.anchor, replacement.replacement), 'utf8');
    patched += 1;
  }
  if (patched !== 1) {
    throw new Error(
      `Expected one OpenClaw channel secret ${replacement.label} bundle to patch, found ${patched}`,
    );
  }
}
