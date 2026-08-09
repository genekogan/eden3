import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  new URL('../src/services/memory-dreaming.ts', import.meta.url),
  'utf8',
);

const SENSITIVE_CALLS = [
  'promoteAgent',
  'recordMemoryRevision',
  'mkdir',
  'writeFile',
] as const;

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

function callName(node: ts.CallExpression): string | null {
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

function deepFenceErrors(input: string): string[] {
  const file = ts.createSourceFile('memory-dreaming.ts', input, ts.ScriptTarget.Latest, true);
  const runner = file.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'EdenMemoryDreamAgentRunner');
  const run = runner?.members.find((node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'run');
  if (!run?.body) return ['missing-run'];
  const deepBranch = descendants(run, (node): node is ts.IfStatement =>
    ts.isIfStatement(node) && node.expression.getText(file) === "checkpoint.phase === 'seed_done'")[0];
  if (!deepBranch) return ['missing-deep-branch'];
  const fences = descendants(deepBranch, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'withAgentMemoryPublicationFence');
  if (fences.length !== 1) return [`fence-count=${fences.length}`];
  const callback = fences[0]!.arguments[1];
  if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
    return ['missing-callback'];
  }
  const errors: string[] = [];
  const allCalls = descendants(deepBranch, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && SENSITIVE_CALLS.includes(callName(node) as never));
  const fencedCalls = descendants(callback, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && SENSITIVE_CALLS.includes(callName(node) as never));
  for (const name of SENSITIVE_CALLS) {
    const all = allCalls.filter((call) => callName(call) === name).length;
    const fenced = fencedCalls.filter((call) => callName(call) === name).length;
    if (all < 1 || all !== fenced) errors.push(`${name}:all=${all}:fenced=${fenced}`);
  }
  const deepDone = descendants(callback, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'saveCheckpoint' &&
    node.arguments.some((argument) => /checkpoint/.test(argument.getText(file))));
  if (deepDone.length !== 1) errors.push(`deep-done=${deepDone.length}`);
  const revision = fencedCalls.find((call) => callName(call) === 'recordMemoryRevision');
  if (!revision || revision.arguments[1]?.getText(file) !== 'tx') errors.push('revision-tx');
  return errors;
}

function relocateCall(input: string, name: string): string {
  const file = ts.createSourceFile('memory-dreaming.ts', input, ts.ScriptTarget.Latest, true);
  const fence = descendants(file, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'withAgentMemoryPublicationFence')[0]!;
  const callback = fence.arguments[1]!;
  const call = descendants(callback, (node): node is ts.CallExpression =>
    ts.isCallExpression(node) && callName(node) === name)[0]!;
  let statement: ts.Node = call;
  while (statement.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
  if (!statement.parent || !ts.isBlock(statement.parent)) throw new Error('missing statement');
  return `${input.slice(0, fence.getFullStart())}${statement.getText(file)};\n${input.slice(
    fence.getFullStart(),
    statement.getFullStart(),
  )}${input.slice(statement.getEnd())}`;
}

describe('memory dream deep-promotion erasure fence', () => {
  it('keeps native promotion, revision, report, and deep checkpoint in one owner fence', () => {
    expect(deepFenceErrors(source)).toEqual([]);
    expect(source).toContain('agentAccountId: candidate.agentAccountId');
    expect(source).toContain('openclawId: candidate.openclawId');
    expect(source).toContain('workspacePath: candidate.workspacePath');
    for (const name of ['promoteAgent', 'recordMemoryRevision', 'writeFile']) {
      expect(deepFenceErrors(relocateCall(source, name))).not.toEqual([]);
    }
    expect(
      deepFenceErrors(source.replace('recordMemoryRevision({', 'recordMemoryRevision({').replace('}, tx);', '});')),
    ).not.toEqual([]);
  });
});
