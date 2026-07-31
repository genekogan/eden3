import {
  GatewayHttpError,
  GatewayToolError,
  asyncToolDetailsSchema,
  scopedSessionKey,
  sessionsHistoryDetailsSchema,
  toolInvokeEnvelopeSchema,
  type GatewayClientOptions,
  type SessionsHistoryParams,
  type SessionsHistoryResult,
  type ToolInvokeEnvelope,
  type ToolInvokeParams,
  type ToolInvokeResult,
} from './types';

/**
 * Client for the OpenClaw gateway's `POST /tools/invoke` endpoint.
 *
 * Envelope: `{ok:true, result:{content:[{type:"text",text}], details:{...}}}`
 * or `{ok:false, error:{type,message}}`. Note that some tools report failures
 * INSIDE an ok:true envelope as `details:{status:"forbidden"|"error", error}` —
 * sessionsHistory() surfaces those as {@link GatewayToolError} too.
 *
 * ## sessions_history args shape
 *
 * Originally live-probed 2026-07-02 on OpenClaw 2026.6.10 and
 * source-reverified 2026-07-31 against OpenClaw 2026.7.1.
 *
 * Exact addressing discovered via the tool's own error messages:
 *
 *   args:{}                      → {ok:false,error:{type:"tool_error",
 *                                    message:"sessionKey required"}}
 *   args:{session:<key>}         → same error — the arg name IS `sessionKey`.
 *   args:{sessionKey:"eden3:s:<uuid>"} (plain key)
 *                                → details {status:"error",
 *                                    error:"No session found: eden3:s:<uuid>"}
 *                                  — keys are GLOBAL, `agent:<id>:<key>` form.
 *   args:{sessionKey:"agent:testbot:eden3:s:<uuid>"} (scoped), no context
 *                                → details {status:"forbidden", error:"Session
 *                                    history visibility is restricted to the
 *                                    current session tree
 *                                    (tools.sessions.visibility=tree)."}
 *   body {tool,args:{sessionKey:<scoped>,limit},agentId,
 *         sessionKey:<scoped>}   → SUCCESS. The TOP-LEVEL `sessionKey` sets
 *                                  the invocation's session context; the
 *                                  target session is then its own "current
 *                                  session tree", satisfying the default
 *                                  `tools.sessions.visibility=tree` policy
 *                                  without config changes.
 *   never-used scoped key, full shape (probed live 2026-07-03)
 *                                → SUCCESS with EMPTY history: details
 *                                  {sessionKey:<scoped>, messages:[], ...} —
 *                                  NOT a failure payload. "No session found"
 *                                  only fires for unscoped/miskeyed
 *                                  addressing, which this client never emits.
 *
 * Success details: `{sessionKey, messages:[{role, content:[{type:"text",
 * text}], timestamp, __openclaw:{id,recordTimestampMs,seq}, (assistant only:)
 * api, provider, model, stopReason, responseId, responseModel}], truncated,
 * droppedMessages, contentTruncated, contentRedacted, bytes}`.
 * `limit: N` returns the NEWEST N messages (limit:1 → latest assistant msg).
 */
export class OpenClawToolsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Invoke a tool and return the raw envelope (already schema-validated).
   * Throws {@link GatewayHttpError} on non-2xx responses.
   */
  async invokeRaw(params: ToolInvokeParams): Promise<ToolInvokeEnvelope> {
    const { tool, args, agentId, sessionKey, signal } = params;
    const body: Record<string, unknown> = { tool, args, agentId };
    // Top-level sessionKey = session context of the invocation. Async tool
    // completions (e.g. image_generate's completion agent) post text +
    // Attachment into THIS gateway session.
    if (sessionKey !== undefined) body.sessionKey = scopedSessionKey(agentId, sessionKey);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/tools/invoke`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new GatewayHttpError(0, `POST /tools/invoke failed: ${describeError(err)}`);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => undefined);
      throw new GatewayHttpError(
        res.status,
        `gateway responded ${res.status} to /tools/invoke (${tool})`,
        detail?.slice(0, 2000),
      );
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      throw new GatewayToolError(`non-JSON /tools/invoke response: ${describeError(err)}`, tool);
    }
    const parsed = toolInvokeEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GatewayToolError('malformed /tools/invoke envelope', tool, raw);
    }
    return parsed.data;
  }

  /**
   * Invoke a tool and parse the async-task fields out of `result.details`.
   * For async media tools (image_generate, …) this is `{async:true, taskId}`
   * with the file landing on disk ~10-120s later; sync tools yield
   * `{async:false}` with the payload still available in `details`.
   * Throws {@link GatewayToolError} when the envelope is `ok:false`.
   */
  async invokeTool(params: ToolInvokeParams): Promise<ToolInvokeResult> {
    const envelope = await this.invokeRaw(params);
    if (!envelope.ok) {
      throw new GatewayToolError(
        envelope.error?.message ?? `tool ${params.tool} invocation failed`,
        params.tool,
        envelope.error,
      );
    }
    const details = envelope.result?.details;
    const parsed = asyncToolDetailsSchema.safeParse(details);
    return {
      async: parsed.success && parsed.data.async === true,
      ...(parsed.success && parsed.data.taskId !== undefined
        ? { taskId: parsed.data.taskId }
        : {}),
      details,
    };
  }

  /**
   * Fetch the transcript of a gateway session via the `sessions_history` tool
   * (newest `limit` messages). This is the general inbound-sync primitive:
   * it also captures async tool completions and cron-triggered activity.
   * See the class docblock for the probed addressing rules.
   */
  async sessionsHistory(params: SessionsHistoryParams): Promise<SessionsHistoryResult> {
    const { sessionKey, agentId, limit, signal } = params;
    const scoped = scopedSessionKey(agentId, sessionKey);
    const args: Record<string, unknown> = { sessionKey: scoped };
    if (limit !== undefined) args.limit = limit;

    const envelope = await this.invokeRaw({
      tool: 'sessions_history',
      args,
      agentId,
      sessionKey: scoped,
      ...(signal ? { signal } : {}),
    });
    if (!envelope.ok) {
      throw new GatewayToolError(
        envelope.error?.message ?? 'sessions_history invocation failed',
        'sessions_history',
        envelope.error,
      );
    }

    const detailsRaw = envelope.result?.details;
    const parsed = sessionsHistoryDetailsSchema.safeParse(detailsRaw);
    if (!parsed.success) {
      throw new GatewayToolError('sessions_history returned unparseable details', 'sessions_history', detailsRaw);
    }
    const details = parsed.data;
    // Failure payloads arrive inside an ok:true envelope: {status, error}.
    if (details.status === 'forbidden' || details.status === 'error' || details.error !== undefined) {
      throw new GatewayToolError(
        `sessions_history ${details.status ?? 'error'}: ${details.error ?? 'unknown failure'}`,
        'sessions_history',
        details,
      );
    }
    return {
      sessionKey: details.sessionKey ?? scoped,
      messages: details.messages ?? [],
      truncated: details.truncated ?? false,
      contentTruncated: details.contentTruncated ?? false,
    };
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
