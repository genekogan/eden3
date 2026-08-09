import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  assertChatAgentVisible,
  ensureChattableAgent,
  selectChatAgentForInvocation,
} from '../src/routes/chat';

const owner = { accountId: '11111111-1111-4111-8111-111111111111', isAdmin: false };
const stranger = { accountId: '22222222-2222-4222-8222-222222222222', isAdmin: false };
const admin = { accountId: '33333333-3333-4333-8333-333333333333', isAdmin: true };
const agentAccount = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'private-agent',
};
const privateAgent = { ownerId: owner.accountId, public: false };

describe('chat agent visibility boundary', () => {
  it('admits public agents and private owners/admins/agent-self, but hides private agents from strangers', () => {
    expect(() => assertChatAgentVisible(stranger, agentAccount, { ...privateAgent, public: true }))
      .not.toThrow();
    expect(() => assertChatAgentVisible(owner, agentAccount, privateAgent)).not.toThrow();
    expect(() => assertChatAgentVisible(admin, agentAccount, privateAgent)).not.toThrow();
    expect(() => assertChatAgentVisible(
      { accountId: agentAccount.id, isAdmin: false },
      agentAccount,
      privateAgent,
    )).not.toThrow();
    expect(() => assertChatAgentVisible(stranger, agentAccount, privateAgent)).toThrowError(
      expect.objectContaining({ statusCode: 404, code: 'agent_not_found' }),
    );
  });

  it('fails before a private agent can touch gateway provisioning or model runtime', async () => {
    let poisonReads = 0;
    const poisonGateway = new Proxy({}, {
      get() {
        poisonReads += 1;
        throw new Error('gateway poison was reached');
      },
    });
    const resolved = {
      account: agentAccount,
      agent: {
        ...privateAgent,
        openclawId: 'private-agent-runtime',
        provisionStatus: 'ready',
      },
    };

    await expect(ensureChattableAgent(
      stranger,
      resolved as Parameters<typeof ensureChattableAgent>[1],
      poisonGateway as Parameters<typeof ensureChattableAgent>[2],
    )).rejects.toMatchObject({ statusCode: 404, code: 'agent_not_found' });
    expect(poisonReads).toBe(0);
  });

  it('rechecks current visibility when selecting an existing-session agent', () => {
    const privateRow = {
      accountId: agentAccount.id,
      ownerId: owner.accountId,
      public: false,
      username: agentAccount.username,
      openclawId: 'private-agent-runtime',
      model: 'anthropic/claude-haiku-4-5',
      thinkingLevel: 'balanced',
    };
    expect(() => selectChatAgentForInvocation([privateRow], stranger)).toThrowError(
      expect.objectContaining({ statusCode: 404, code: 'agent_not_found' }),
    );
    expect(selectChatAgentForInvocation([privateRow], owner)).toBe(privateRow);
    expect(selectChatAgentForInvocation([{ ...privateRow, public: true }], stranger))
      .toMatchObject({ accountId: agentAccount.id });
  });

  it('mutation-pins all three pre-side-effect checks and the existing-row public projection', async () => {
    const source = await readFile(new URL('../src/routes/chat.ts', import.meta.url), 'utf8');
    const assertBoundary = (candidate: string) => {
      expect(candidate).toContain(
        'return agent.public || viewer.isAdmin || viewer.accountId === agent.ownerId || viewer.accountId === account.id;',
      );

      const newStart = candidate.indexOf("if (req.params.idOrNew === 'new')");
      const newEnd = candidate.indexOf('} else {', newStart);
      const newPath = candidate.slice(newStart, newEnd);
      const newAuth = newPath.indexOf('assertChatAgentVisible(account, preResolved.account, preResolved.agent);');
      expect(newAuth).toBeGreaterThanOrEqual(0);
      expect(newAuth).toBeLessThan(newPath.indexOf('assertTurnAdmissible('));
      expect(newAuth).toBeLessThan(newPath.indexOf('createSession('));

      const ensureStart = candidate.indexOf('export async function ensureChattableAgent(');
      const ensureEnd = candidate.indexOf('\nasync function createSession(', ensureStart);
      const ensurePath = candidate.slice(ensureStart, ensureEnd);
      const ensureAuth = ensurePath.indexOf('assertChatAgentVisible(viewer, account, agent);');
      expect(ensureAuth).toBeGreaterThanOrEqual(0);
      expect(ensureAuth).toBeLessThan(ensurePath.indexOf('if (agent.openclawId'));

      expect(candidate).toContain('public: agents.public,');
      const existingStart = candidate.indexOf('async function resolveExisting(');
      const existingEnd = candidate.indexOf('\nfunction openSseSink(', existingStart);
      const existingPath = candidate.slice(existingStart, existingEnd);
      const selectAt = existingPath.indexOf('selectChatAgentForInvocation(rows, account)');
      expect(selectAt).toBeGreaterThanOrEqual(0);
      expect(selectAt).toBeLessThan(existingPath.indexOf('ensureChattableAgent('));
      expect(selectAt).toBeLessThan(existingPath.indexOf('modelRuntime.getRuntime('));
    };

    assertBoundary(source);
    const newCheck = 'assertChatAgentVisible(account, preResolved.account, preResolved.agent);';
    const createCall = 'target = await createSession(account, preResolved, body.content, app.gatewayGlue);';
    const movedNewCheck = source
      .replace(newCheck, '// new-session visibility moved')
      .replace(createCall, `${createCall}\n        ${newCheck}`);
    const provisioningCheck = 'assertChatAgentVisible(viewer, account, agent);';
    const provisioningBranch = "if (agent.openclawId && agent.provisionStatus === 'ready') {";
    const movedProvisioningCheck = source
      .replace(provisioningCheck, '// provisioning visibility moved')
      .replace(provisioningBranch, `${provisioningBranch}\n    ${provisioningCheck}`);

    for (const mutant of [
      source.replace(
        newCheck,
        '// new-session visibility removed',
      ),
      source.replace(
        provisioningCheck,
        '// provisioning visibility removed',
      ),
      movedNewCheck,
      movedProvisioningCheck,
      source.replace(
        'selectChatAgentForInvocation(rows, account)',
        'rows.find((row) => row.openclawId !== null) ?? rows[0] ?? null',
      ),
      source.replace('public: agents.public,', 'public: true,'),
      source.replace('viewer.accountId === agent.ownerId', 'false'),
      source.replace('viewer.accountId === account.id', 'false'),
    ]) {
      expect(mutant).not.toBe(source);
      expect(() => assertBoundary(mutant)).toThrow();
    }
  });
});
