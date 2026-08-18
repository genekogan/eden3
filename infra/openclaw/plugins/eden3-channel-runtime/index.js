import { createEdenChannelRuntimeBridge } from './bridge.js';
import { createChannelRuntimeClient } from './runtime-client.js';
import { createMediaAuthorizationBridge } from './media-authorization.js';
import { createMediaRuntimeClient } from './media-runtime-client.js';
import { createDurablePairingCallbackOutbox } from './pairing-callback-outbox.js';

export default {
  id: 'eden3-channel-runtime',
  name: 'Eden Hosted Channel Runtime',
  description: 'Meters and mirrors Eden-hosted Discord and Telegram turns.',
  register(api) {
    const bridge = createEdenChannelRuntimeBridge({
      api,
      client: createChannelRuntimeClient(),
      pairingCallbackOutbox: createDurablePairingCallbackOutbox(),
    });
    const media = createMediaAuthorizationBridge({ client: createMediaRuntimeClient() });

    api.on('message_received', bridge.onMessageReceived, { priority: 100 });
    api.on('before_model_resolve', bridge.onBeforeModelResolve, { priority: 100 });
    api.on('before_prompt_build', bridge.onBeforePromptBuild, { priority: 100 });
    api.on('before_tool_call', bridge.onBeforeToolCall, { priority: 100 });
    api.on('before_tool_call', media.onBeforeToolCall, { priority: 90, timeoutMs: 25_000 });
    api.on('after_tool_call', media.onAfterToolCall, { priority: 90, timeoutMs: 25_000 });
    api.on('before_agent_run', bridge.onBeforeAgentRun, { priority: 100 });
    api.on('llm_output', bridge.onLlmOutput, { priority: 100 });
    api.on('agent_end', bridge.onAgentEnd, { priority: 100 });
    api.on('reply_payload_sending', bridge.onReplyPayloadSending, {
      priority: 100,
      // This hook can make settle, session-sync, and compensation requests in
      // sequence. Its outer deadline must exceed their combined HTTP budgets
      // so OpenClaw cannot fail open while Eden is still fencing delivery.
      // Settlement (20s), optional voice generation (30s), assistant sync and
      // bounded compensation are sequential custody phases. Keep the host
      // hook outside their combined deadline so it never cancels a legitimate
      // provider result while Eden is committing its terminal state.
      timeoutMs: 90_000,
    });
    api.on('channel_pairing_requested', bridge.onPairingRequested, { priority: 100 });
    api.on('message_sent', bridge.onMessageSent, { priority: 100 });
    api.on('gateway_start', bridge.onGatewayStart, { priority: 100 });
    api.on('gateway_stop', bridge.onGatewayStop, { priority: 100 });
  },
};
