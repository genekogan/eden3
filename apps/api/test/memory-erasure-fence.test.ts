import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { withAgentMemoryPublicationFence } from '../src/services/memory-distillation';

const source = readFileSync(
  new URL('../src/services/memory-distillation.ts', import.meta.url),
  'utf8',
);

const identity = {
  agentAccountId: '11111111-1111-4111-8111-111111111111',
  openclawId: 'memory-fence-agent',
  workspacePath: '/tmp/eden3-memory-fence-agent',
};

type ProducerName = 'distillAgentMemory' | 'saveAgentMemory';
type SensitiveKind = 'mkdir' | 'writeFile' | 'perUser' | 'revision';

function callKind(node: ts.CallExpression): SensitiveKind | null {
  if (ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'fs') {
    if (node.expression.name.text === 'mkdir') return 'mkdir';
    if (node.expression.name.text === 'writeFile') return 'writeFile';
  }
  if (ts.isIdentifier(node.expression)) {
    if (node.expression.text === 'writePerUserNotes') return 'perUser';
    if (node.expression.text === 'recordMemoryRevision') return 'revision';
  }
  return null;
}

function functionNamed(file: ts.SourceFile, name: ProducerName): ts.FunctionDeclaration {
  const found = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!found?.body) throw new Error(`missing producer ${name}`);
  return found;
}

function descendants<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function fenceStructureErrors(input: string): string[] {
  const file = ts.createSourceFile('memory-distillation.ts', input, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const expected: Record<ProducerName, Record<SensitiveKind, number>> = {
    distillAgentMemory: { mkdir: 1, writeFile: 1, perUser: 1, revision: 1 },
    saveAgentMemory: { mkdir: 1, writeFile: 1, perUser: 0, revision: 1 },
  };
  for (const name of Object.keys(expected) as ProducerName[]) {
    const producer = functionNamed(file, name);
    const fenceCalls = descendants(producer, (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === 'withAgentMemoryPublicationFence');
    if (fenceCalls.length !== 1) {
      errors.push(`${name}:fence-count=${fenceCalls.length}`);
      continue;
    }
    const callback = fenceCalls[0]!.arguments[1];
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      errors.push(`${name}:missing-callback`);
      continue;
    }
    const allSensitive = descendants(producer, (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && callKind(node) !== null);
    const fencedSensitive = descendants(callback, (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && callKind(node) !== null);
    for (const kind of Object.keys(expected[name]) as SensitiveKind[]) {
      const total = allSensitive.filter((node) => callKind(node) === kind).length;
      const fenced = fencedSensitive.filter((node) => callKind(node) === kind).length;
      if (total !== expected[name][kind] || fenced !== total) {
        errors.push(`${name}:${kind}:total=${total}:fenced=${fenced}`);
      }
    }
    const terminalState = descendants(callback, (node): node is ts.TaggedTemplateExpression =>
      ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'tx' &&
      /(?:update|insert into) distill_state/.test(node.template.getText(file)));
    if (terminalState.length !== 1) errors.push(`${name}:terminal-state=${terminalState.length}`);
  }
  return errors;
}

function relocateSensitiveCall(
  input: string,
  producerName: ProducerName,
  kind: SensitiveKind,
): string {
  const file = ts.createSourceFile('memory-distillation.ts', input, ts.ScriptTarget.Latest, true);
  const producer = functionNamed(file, producerName);
  const fence = descendants(producer, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'withAgentMemoryPublicationFence')[0]!;
  const callback = fence.arguments[1]!;
  const call = descendants(callback, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && callKind(node) === kind)[0]!;
  let statement: ts.Node = call;
  while (statement.parent && !ts.isExpressionStatement(statement)) statement = statement.parent;
  if (!ts.isExpressionStatement(statement) || !producer.body) {
    throw new Error(`missing ${producerName} ${kind} statement`);
  }
  const bodyStart = producer.body.getStart(file) + 1;
  const statementStart = statement.getFullStart();
  const statementEnd = statement.getEnd();
  const moved = input.slice(statementStart, statementEnd).trim();
  return `${input.slice(0, bodyStart)}\n  ${moved}\n${input.slice(bodyStart, statementStart)}${input.slice(statementEnd)}`;
}

function fakeClient(options: { current?: boolean; erasing?: boolean } = {}) {
  const events: string[] = [];
  const transaction = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join(' ').replace(/\s+/g, ' ').trim();
    if (sql.includes('coalesce(ag.owner_id,ag.account_id)')) {
      events.push('owner-lock');
      return options.current === false ? [] : [{ owner_account_id: 'owner-account' }];
    }
    if (sql.includes('from account_erasure_jobs')) {
      events.push('erasure-check');
      return options.erasing ? [{ exists: 1 }] : [];
    }
    throw new Error(`unexpected memory fence query: ${sql}`);
  };
  const client = {
    begin: async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> => {
      events.push('begin');
      const result = await callback(transaction);
      events.push('commit');
      return result;
    },
  };
  return { client, events };
}

describe('agent memory publication erasure fence', () => {
  it('locks and revalidates the human owner before the first filesystem publication', async () => {
    const { client, events } = fakeClient();
    const publish = vi.fn(async () => {
      events.push('write');
      return 'published';
    });

    await expect(withAgentMemoryPublicationFence(identity, publish, client as never))
      .resolves.toBe('published');
    expect(events).toEqual(['begin', 'owner-lock', 'erasure-check', 'write', 'commit']);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps writer commit and erasure acquisition pending until publication and state finish', async () => {
    const { client, events } = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let writerSettled = false;
    const writer = withAgentMemoryPublicationFence(identity, async () => {
      events.push('write');
      await gate;
      events.push('state');
    }, client as never).finally(() => { writerSettled = true; });
    await vi.waitFor(() => expect(events).toContain('write'));
    expect(writerSettled).toBe(false);
    expect(events).not.toContain('commit');
    release();
    await writer;
    expect(events.slice(-3)).toEqual(['write', 'state', 'commit']);
  });

  it('refuses erasure-first and stale runtime identities before any write callback', async () => {
    for (const [options, code] of [
      [{ erasing: true }, 'account_erasure_active'],
      [{ current: false }, 'memory_unavailable'],
    ] as const) {
      const { client, events } = fakeClient(options);
      const publish = vi.fn();
      await expect(withAgentMemoryPublicationFence(identity, publish, client as never))
        .rejects.toMatchObject({ statusCode: 409, code });
      expect(publish).not.toHaveBeenCalled();
      expect(events).not.toContain('write');
    }
  });

  it('routes automatic/manual distillation, per-user notes, and owner correction through one fence', () => {
    expect(source).toContain('for key share of owner_account');
    expect(source).toContain('from account_erasure_jobs');
    expect(source).toContain('where ag.account_id=${params.agentAccountId}');
    expect(source).toContain('and ag.openclaw_id=${params.openclawId}');
    expect(source).toContain('and ag.workspace_path=${params.workspacePath}');
    expect(source).toContain('await withAgentMemoryPublicationFence(params, async (tx) =>');
    expect(source).toContain('await writePerUserNotes(params.workspacePath, sample)');

    expect(fenceStructureErrors(source)).toEqual([]);
    for (const mutant of [
      relocateSensitiveCall(source, 'distillAgentMemory', 'writeFile'),
      relocateSensitiveCall(source, 'distillAgentMemory', 'perUser'),
      relocateSensitiveCall(source, 'saveAgentMemory', 'writeFile'),
    ]) {
      expect(fenceStructureErrors(mutant)).not.toEqual([]);
    }
  });
});
