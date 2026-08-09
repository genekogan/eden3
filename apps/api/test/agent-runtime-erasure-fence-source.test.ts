import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import { withAgentRuntimePublicationFence } from '../src/services/agent-runtime-sync';

const source = readFileSync(
  new URL('../src/services/agent-runtime-sync.ts', import.meta.url),
  'utf8',
);

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

function fakeClient(options: { current?: boolean; erasing?: boolean } = {}) {
  const events: string[] = [];
  const transaction = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join(' ').replace(/\s+/g, ' ').trim();
    if (sql.includes('coalesce(ag.owner_id,ag.account_id)')) {
      events.push('owner-lock');
      return options.current === false ? [] : [{ owner_account_id: 'human-owner' }];
    }
    if (sql.includes('from account_erasure_jobs')) {
      events.push('erasure-check');
      return options.erasing ? [{ exists: 1 }] : [];
    }
    throw new Error(`unexpected runtime publication fence query: ${sql}`);
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

const SENSITIVE_CALLS = [
  'claimAgentRuntimeSync',
  'updateAgentPersona',
  'provisionAgent',
  'projectApprovedAgentSkills',
  'syncAgentToolGroups',
  'finishRuntimeSync',
  'failRuntimeSync',
] as const;

function calledName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function runtimeFenceErrors(input: string): string[] {
  const file = ts.createSourceFile('agent-runtime-sync.ts', input, ts.ScriptTarget.Latest, true);
  const reconcile = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'reconcileAgentRuntime');
  if (!reconcile?.body) return ['missing-reconcile'];
  const fenceCalls = descendants(reconcile, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'withAgentRuntimePublicationFence');
  if (fenceCalls.length !== 1) return [`fence-count=${fenceCalls.length}`];
  const callback = fenceCalls[0]!.arguments[1];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return ['missing-fence-callback'];
  }
  const allCalls = descendants(reconcile, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && SENSITIVE_CALLS.includes(calledName(node) as never));
  const fencedCalls = descendants(callback, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && SENSITIVE_CALLS.includes(calledName(node) as never));
  const errors: string[] = [];
  for (const name of SENSITIVE_CALLS) {
    const all = allCalls.filter((call) => calledName(call) === name).length;
    const fenced = fencedCalls.filter((call) => calledName(call) === name).length;
    if (all < 1 || all !== fenced) errors.push(`${name}:all=${all}:fenced=${fenced}`);
  }
  return errors;
}

function runtimeFenceSqlErrors(input: string): string[] {
  const required = [
    'join accounts owner_account on owner_account.id=coalesce(ag.owner_id,ag.account_id)',
    'for key share of owner_account',
    "where account_id=${current.owner_account_id} and state<>'succeeded'",
    'and coalesce(g.owner_id,g.account_id) = ${ownerAccountId}',
  ];
  return required.filter((snippet) => !input.includes(snippet));
}

function moveCallBeforeFence(input: string, callName: string): string {
  const file = ts.createSourceFile('agent-runtime-sync.ts', input, ts.ScriptTarget.Latest, true);
  const reconcile = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'reconcileAgentRuntime')!;
  const fence = descendants(reconcile, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'withAgentRuntimePublicationFence')[0]!;
  const callback = fence.arguments[1]!;
  const call = descendants(callback, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && calledName(node) === callName)[0]!;
  let statement: ts.Node = call;
  while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
  if (!statement.parent || !ts.isBlock(statement.parent) || !reconcile.body) {
    throw new Error('missing call statement');
  }
  const statementText = statement.getText(file);
  const bodyStart = reconcile.body.getStart(file) + 1;
  return `${input.slice(0, bodyStart)}\n  ${statementText}\n${input.slice(bodyStart, statement.getFullStart())}${input.slice(statement.getEnd())}`;
}

describe('agent runtime publication erasure fence', () => {
  it('locks and revalidates the human owner before entering runtime mutation work', async () => {
    const { client, events } = fakeClient();
    const publish = vi.fn(async (ownerAccountId: string) => {
      events.push(`publish:${ownerAccountId}`);
      return 'synced';
    });
    await expect(withAgentRuntimePublicationFence(AGENT_ID, publish, client as never))
      .resolves.toBe('synced');
    expect(events).toEqual([
      'begin',
      'owner-lock',
      'erasure-check',
      'publish:human-owner',
      'commit',
    ]);
  });

  it('keeps the owner transaction open until external work and settlement finish', async () => {
    const { client, events } = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const writer = withAgentRuntimePublicationFence(AGENT_ID, async () => {
      events.push('runtime-write');
      await gate;
      events.push('settlement');
    }, client as never).finally(() => { settled = true; });
    await vi.waitFor(() => expect(events).toContain('runtime-write'));
    expect(settled).toBe(false);
    expect(events).not.toContain('commit');
    release();
    await writer;
    expect(events.slice(-3)).toEqual(['runtime-write', 'settlement', 'commit']);
  });

  it('refuses erasure-first or a stale agent before any runtime mutation', async () => {
    for (const [options, code] of [
      [{ erasing: true }, 'account_erasure_active'],
      [{ current: false }, 'runtime_unavailable'],
    ] as const) {
      const { client, events } = fakeClient(options);
      const publish = vi.fn();
      await expect(withAgentRuntimePublicationFence(AGENT_ID, publish, client as never))
        .rejects.toMatchObject({ statusCode: 409, code });
      expect(publish).not.toHaveBeenCalled();
      expect(events).not.toContain('runtime-write');
    }
  });

  it('keeps claim, every external mutation, and success/failure settlement under the fence', () => {
    expect(source).toContain('for key share of owner_account');
    expect(source).toContain('coalesce(ag.owner_id,ag.account_id)');
    expect(source).toContain('from account_erasure_jobs');
    expect(runtimeFenceErrors(source)).toEqual([]);
    expect(runtimeFenceSqlErrors(source)).toEqual([]);
    for (const name of ['updateAgentPersona', 'projectApprovedAgentSkills', 'finishRuntimeSync']) {
      expect(runtimeFenceErrors(moveCallBeforeFence(source, name))).not.toEqual([]);
    }
    for (const mutant of [
      source.replace('for key share of owner_account', ''),
      source.replace(
        'join accounts owner_account on owner_account.id=coalesce(ag.owner_id,ag.account_id)',
        'join accounts owner_account on owner_account.id=ag.account_id',
      ),
      source.replace("where account_id=${current.owner_account_id} and state<>'succeeded'", 'where false'),
      source.replace('and coalesce(g.owner_id,g.account_id) = ${ownerAccountId}', ''),
    ]) {
      expect(runtimeFenceSqlErrors(mutant)).not.toEqual([]);
    }
  });
});
