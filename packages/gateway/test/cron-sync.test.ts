import { describe, expect, it } from 'vitest';

import {
  CronSync,
  CronSyncError,
  apschedulerDowToCron,
  cronJobName,
  scheduleToCron,
  type SyncTriggerParams,
} from '../src/cron-sync';
import type { CliExecOptions, OpenClawCliLike, OpenClawCliResult } from '../src/docker';

// ---------------------------------------------------------------------------
// scheduleToCron / apschedulerDowToCron
// ---------------------------------------------------------------------------

describe('apschedulerDowToCron', () => {
  it('maps apscheduler weekday numbers (0=Mon) to cron (0=Sun)', () => {
    expect(apschedulerDowToCron(0)).toBe('1'); // Monday
    expect(apschedulerDowToCron(4)).toBe('5'); // Friday
    expect(apschedulerDowToCron(6)).toBe('0'); // Sunday
    expect(apschedulerDowToCron('6')).toBe('0');
    expect(apschedulerDowToCron('0')).toBe('1');
  });

  it('passes through "*" and day names, maps lists/ranges digit-wise', () => {
    expect(apschedulerDowToCron('*')).toBe('*');
    expect(apschedulerDowToCron('mon')).toBe('mon');
    expect(apschedulerDowToCron('mon-fri')).toBe('mon-fri');
    expect(apschedulerDowToCron('0,2,4')).toBe('1,3,5');
    expect(apschedulerDowToCron('0-4')).toBe('1-5');
  });

  it('rejects out-of-range or malformed values', () => {
    expect(() => apschedulerDowToCron(7)).toThrow(CronSyncError);
    expect(() => apschedulerDowToCron(-1)).toThrow(CronSyncError);
    expect(() => apschedulerDowToCron('7')).toThrow(CronSyncError);
    expect(() => apschedulerDowToCron('funday')).toThrow(CronSyncError);
  });
});

describe('scheduleToCron', () => {
  it('converts observed eden dicts (daily at hh:mm with tz)', () => {
    expect(scheduleToCron({ hour: 18, minute: 34, timezone: 'America/New_York' })).toEqual({
      cron: '34 18 * * *',
      tz: 'America/New_York',
    });
  });

  it('converts weekly dicts with apscheduler day_of_week', () => {
    expect(
      scheduleToCron({ hour: 9, minute: 0, day_of_week: '6', timezone: 'UTC' }),
    ).toEqual({ cron: '0 9 * * 0', tz: 'UTC' }); // aps Sunday → cron Sunday
    expect(scheduleToCron({ hour: 9, minute: 0, day_of_week: 0 })).toEqual({
      cron: '0 9 * * 1',
    });
  });

  it('supports numeric strings, "*", day/month, and ignores extra keys', () => {
    expect(
      scheduleToCron({
        hour: '*',
        minute: '30',
        day: 15,
        month: '6',
        second: 0,
        year: '2026',
        start_date: 'ignored',
        timezone: 'Europe/Berlin',
      }),
    ).toEqual({ cron: '30 * 15 6 *', tz: 'Europe/Berlin' });
  });

  it('omits tz when timezone is missing or empty', () => {
    expect(scheduleToCron({ hour: 1, minute: 2 })).toEqual({ cron: '2 1 * * *' });
    expect(scheduleToCron({ hour: 1, minute: 2, timezone: '' })).toEqual({ cron: '2 1 * * *' });
  });

  it('requires hour and minute; validates ranges', () => {
    expect(() => scheduleToCron({ minute: 5 })).toThrow(/hour is required/);
    expect(() => scheduleToCron({ hour: 5 })).toThrow(/minute is required/);
    expect(() => scheduleToCron({ hour: 24, minute: 0 })).toThrow(/out of range/);
    expect(() => scheduleToCron({ hour: 1, minute: 60 })).toThrow(/out of range/);
    expect(() => scheduleToCron({ hour: 1, minute: 'abc' })).toThrow(CronSyncError);
    expect(() => scheduleToCron({ hour: 1, minute: 0, day: 32 })).toThrow(/out of range/);
  });
});

describe('cronJobName', () => {
  it('prefixes with eden3: and rejects whitespace ids', () => {
    expect(cronJobName('4a1f')).toBe('eden3:4a1f');
    expect(() => cronJobName('has space')).toThrow(CronSyncError);
    expect(() => cronJobName('')).toThrow(CronSyncError);
  });
});

// ---------------------------------------------------------------------------
// CronSync.syncTrigger
// ---------------------------------------------------------------------------

type CliCall = { args: readonly string[]; options?: CliExecOptions };

class FakeCronCli implements OpenClawCliLike {
  calls: CliCall[] = [];
  jobs: Record<string, unknown>[] = [];
  addResult: unknown = { id: 'job-new' };

  async exec(args: readonly string[], options?: CliExecOptions): Promise<OpenClawCliResult> {
    this.calls.push({ args, ...(options !== undefined ? { options } : {}) });
    if (args[0] === 'cron' && args[1] === 'rm') {
      const id = args[2];
      this.jobs = this.jobs.filter((j) => j.id !== id);
      return { stdout: '{"ok":true}', stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }

  async execJson<T = unknown>(args: readonly string[], options?: CliExecOptions): Promise<T> {
    this.calls.push({ args, ...(options !== undefined ? { options } : {}) });
    if (args[0] === 'cron' && args[1] === 'list') return { jobs: this.jobs } as T;
    if (args[0] === 'cron' && args[1] === 'add') return this.addResult as T;
    throw new Error(`FakeCronCli: unexpected ${args.join(' ')}`);
  }

  callsFor(sub: string): CliCall[] {
    return this.calls.filter((c) => c.args[0] === 'cron' && c.args[1] === sub);
  }
}

const TRIGGER: SyncTriggerParams = {
  triggerId: 'trig-1',
  openclawAgentId: 'banny',
  cronExpr: '0 9 * * 1',
  tz: 'America/New_York',
  prompt: 'Paint the morning.',
  enabled: true,
};

/** A gateway job matching TRIGGER (flat-field shape). */
function matchingJob(): Record<string, unknown> {
  return {
    id: 'job-1',
    name: 'eden3:trig-1',
    cron: '0 9 * * 1',
    tz: 'America/New_York',
    message: 'Paint the morning.',
    agentId: 'banny',
    enabled: true,
  };
}

describe('CronSync.syncTrigger', () => {
  it('creates a job when absent (with token auth and --no-deliver)', async () => {
    const cli = new FakeCronCli();
    const sync = new CronSync({ cli });
    const result = await sync.syncTrigger(TRIGGER);
    expect(result).toEqual({ name: 'eden3:trig-1', action: 'created', jobId: 'job-new' });

    const add = cli.callsFor('add')[0]!;
    expect(add.args).toEqual([
      'cron',
      'add',
      '--name',
      'eden3:trig-1',
      '--agent',
      'banny',
      '--cron',
      '0 9 * * 1',
      '--message',
      'Paint the morning.',
      '--no-deliver',
      '--tz',
      'America/New_York',
    ]);
    expect(add.options?.gatewayToken).toBe(true);
    expect(cli.callsFor('list')[0]!.options?.gatewayToken).toBe(true);
  });

  it('is a no-op when a matching job exists', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [matchingJob()];
    const result = await new CronSync({ cli }).syncTrigger(TRIGGER);
    expect(result).toEqual({ name: 'eden3:trig-1', action: 'unchanged', jobId: 'job-1' });
    expect(cli.callsFor('add')).toHaveLength(0);
    expect(cli.callsFor('rm')).toHaveLength(0);
  });

  it('matches nested schedule/payload job shapes too', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [
      {
        id: 'job-1',
        name: 'eden3:trig-1',
        schedule: { cron: '0 9 * * 1', tz: 'America/New_York' },
        payload: { message: 'Paint the morning.', agentId: 'banny' },
      },
    ];
    const result = await new CronSync({ cli }).syncTrigger(TRIGGER);
    expect(result.action).toBe('unchanged');
  });

  it('replaces a drifted job (rm then add)', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [{ ...matchingJob(), cron: '0 8 * * 1' }];
    const result = await new CronSync({ cli }).syncTrigger(TRIGGER);
    expect(result.action).toBe('replaced');
    expect(result.jobId).toBe('job-new');
    expect(cli.callsFor('rm')[0]!.args).toEqual(['cron', 'rm', 'job-1', '--json']);
    expect(cli.callsFor('add')).toHaveLength(1);
  });

  it('treats disabled or shape-unreadable jobs as drift', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [{ ...matchingJob(), enabled: false }];
    expect((await new CronSync({ cli }).syncTrigger(TRIGGER)).action).toBe('replaced');

    const cli2 = new FakeCronCli();
    cli2.jobs = [{ id: 'job-1', name: 'eden3:trig-1' }]; // no comparable fields
    expect((await new CronSync({ cli: cli2 }).syncTrigger(TRIGGER)).action).toBe('replaced');
  });

  it('removes all duplicates before re-adding', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [matchingJob(), { ...matchingJob(), id: 'job-2' }];
    const result = await new CronSync({ cli }).syncTrigger(TRIGGER);
    expect(result.action).toBe('replaced');
    expect(cli.callsFor('rm').map((c) => c.args[2])).toEqual(['job-1', 'job-2']);
  });

  it('enabled:false removes the job / reports absent when missing', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [matchingJob()];
    const sync = new CronSync({ cli });
    expect(await sync.syncTrigger({ ...TRIGGER, enabled: false })).toEqual({
      name: 'eden3:trig-1',
      action: 'removed',
    });
    expect(await sync.syncTrigger({ ...TRIGGER, enabled: false })).toEqual({
      name: 'eden3:trig-1',
      action: 'absent',
    });
    expect(cli.callsFor('add')).toHaveLength(0);
  });

  it('never touches foreign (non-eden3 or other-trigger) jobs', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [
      { id: 'foreign-1', name: 'ops:nightly', cron: '0 9 * * 1' },
      { id: 'other-eden', name: 'eden3:trig-2', cron: '0 9 * * 1' },
    ];
    await new CronSync({ cli }).syncTrigger({ ...TRIGGER, enabled: false });
    expect(cli.callsFor('rm')).toHaveLength(0);
  });

  it('omits --tz when tz is not set', async () => {
    const cli = new FakeCronCli();
    const { tz: _unused, ...noTz } = TRIGGER;
    await new CronSync({ cli }).syncTrigger(noTz);
    expect(cli.callsFor('add')[0]!.args).not.toContain('--tz');
  });

  it('listEdenJobs filters by the eden3: prefix', async () => {
    const cli = new FakeCronCli();
    cli.jobs = [
      { id: 'a', name: 'eden3:x' },
      { id: 'b', name: 'ops:y' },
      { id: 'c' },
    ];
    const jobs = await new CronSync({ cli }).listEdenJobs();
    expect(jobs.map((j) => j.id)).toEqual(['a']);
  });
});
