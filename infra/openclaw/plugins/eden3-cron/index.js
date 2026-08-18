import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';

import { requestAgentCron } from './bridge-client.js';

const recurringSchedule = Type.Object(
  {
    minute: Type.Union([Type.Integer({ minimum: 0, maximum: 59 }), Type.String({ maxLength: 100 })]),
    hour: Type.Union([Type.Integer({ minimum: 0, maximum: 23 }), Type.String({ maxLength: 100 })]),
    day: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 31 }), Type.String({ maxLength: 100 })])),
    month: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 12 }), Type.String({ maxLength: 100 })])),
    day_of_week: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 6 }), Type.String({ maxLength: 100 })])),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);
const schedule = Type.Union([
  Type.Object({ at: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false }),
  recurringSchedule,
]);
const parameters = Type.Union([
  Type.Object({ action: Type.Literal('list') }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal('create'),
      name: Type.String({ minLength: 1, maxLength: 200 }),
      prompt: Type.String({ minLength: 1, maxLength: 10_000 }),
      schedule,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal('update'),
      taskId: Type.String(),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
      schedule: Type.Optional(schedule),
      enabled: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal('delete'), taskId: Type.String() },
    { additionalProperties: false },
  ),
]);

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export default defineToolPlugin({
  id: 'eden3-cron',
  name: 'Eden Metered Cron',
  description: 'Agent-owned schedules backed by Eden tasks and normal manna metering.',
  configSchema: Type.Object({}, { additionalProperties: false }),
  tools: (tool) => [
    tool({
      name: 'eden_cron',
      label: 'Eden Cron',
      description:
        'List, create, pause/resume, edit, or delete your scheduled prompts. Jobs run through Eden as metered turns. You may keep at most 10 jobs enabled and 50 non-deleted self-created jobs retained. Use a one-time {at: ISO timestamp} schedule or a recurring {minute, hour, day?, month?, day_of_week?, timezone?} schedule (day_of_week 0=Monday).',
      parameters,
      optional: true,
      factory: ({ toolContext }) => {
        const agentId = toolContext.agentId;
        const sessionKey = toolContext.sessionKey;
        if (!agentId || !sessionKey) return null;
        return {
          name: 'eden_cron',
          label: 'Eden Cron',
          description: 'Manage this agent\'s metered Eden scheduled tasks.',
          parameters,
          execute: async (_toolCallId, raw, signal) => {
            const { action, ...args } = raw;
            const response = await requestAgentCron(
              { protocolVersion: 1, agentId, sessionKey, action, args },
              { signal },
            );
            if (!response?.ok) {
              throw new Error(response?.error?.message ?? 'Eden cron request failed');
            }
            return toolResult(response);
          },
        };
      },
    }),
  ],
});
