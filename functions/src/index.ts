import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { aiModelOptions, parseCommand, rememberSilentlyFromMessage, runAgentWorkflow, runSpontaneousComment } from "./agents";
import { chatTargetFromEvent, fetchLineProfile, hashId, replyToLine, verifyLineSignature } from "./line";
import {
  ensureLineIdentity,
  aiUsageSummary,
  detailedPublicMemories,
  getAiRuntimeConfig,
  getGroupContext,
  groupMemoriesForAdmin,
  isReplyToKnownBotMessage,
  lineDashboardAnalytics,
  recentGroupMessageContext,
  recentPublicMemories,
  recentLineEvents,
  recordBotReplyMessages,
  recordAudit,
  setAiRuntimeModel,
} from "./repository";
import type { AuditEvent, LineEvent, LineWebhookBody } from "./types";

const lineChannelSecret = defineSecret("LINE_CHANNEL_SECRET");
const lineChannelAccessToken = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const defaultOpenAiModel = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const adminApiKey = process.env.AI_ADMIN_KEY || "";
const spontaneousReplyMinProbability = 0.1;
const spontaneousReplyMaxProbability = 0.3;

type EventResult = {
  ok: boolean;
  status?: number;
  route?: string;
  agent?: string;
  replied?: boolean;
  error?: string;
};

export const lineWebhook = onRequest(
  {
    region: "asia-southeast1",
    secrets: [lineChannelSecret, lineChannelAccessToken, openaiApiKey],
    timeoutSeconds: 60,
    invoker: "public",
  },
  async (req, res) => {
    const started = Date.now();
    console.info("LINE webhook request", {
      method: req.method,
      hasSignature: Boolean(req.get("x-line-signature")),
    });

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = req.get("x-line-signature");
    const channelSecret = secretValue(lineChannelSecret.value());
    const channelAccessToken = secretValue(lineChannelAccessToken.value());
    const openaiKey = secretValue(openaiApiKey.value());

    if (!verifyLineSignature(rawBody, signature, channelSecret)) {
      console.warn("LINE signature verification failed", { hasSignature: Boolean(signature) });
      await safeRecordAudit({
        chatId: "invalid-signature",
        chatType: "user",
        userIdHash: "",
        eventType: "webhook",
        messagePreview: "ไม่แสดงข้อความ เพราะ LINE signature ไม่ผ่าน",
        status: "signature_failed",
        latencyMs: Date.now() - started,
        errorCode: "LINE_SIGNATURE_INVALID",
      });
      res.status(401).json({ ok: false, error: "Invalid LINE signature" });
      return;
    }

    const body = req.body as LineWebhookBody;
    const events = Array.isArray(body.events) ? body.events : [];
    console.info("LINE webhook verified", {
      eventCount: events.length,
      eventTypes: events.map((event) => event.type).filter(Boolean),
    });

    const results = await Promise.all(events.map((event) => handleLineEvent(event, started, channelAccessToken, openaiKey)));
    res.status(200).json({ ok: true, eventCount: events.length, results });
  },
);

export const lineConfig = onRequest(
  {
    region: "asia-southeast1",
    secrets: [lineChannelSecret, lineChannelAccessToken, openaiApiKey],
    invoker: "public",
  },
  async (req, res) => {
    if (req.method === "POST") {
      try {
        const body = req.body || {};
        const model = String(body.aiModel || body.model || "");
        if (!model) {
          res.status(400).json({ ok: false, error: "aiModel required" });
          return;
        }
        const config = await setAiRuntimeModel(model, aiModelOptions);
        res.status(200).json({ ok: true, config, modelOptions: aiModelOptions });
      } catch (error) {
        res.status(400).json({ ok: false, error: errorName(error) });
      }
      return;
    }

    const aiConfig = await getAiRuntimeConfig(defaultOpenAiModel, aiModelOptions);
    res.status(200).json({
      ok: true,
      webhookPath: "/line/webhook",
      channelSecretConfigured: Boolean(secretValue(lineChannelSecret.value())),
      channelAccessTokenConfigured: Boolean(secretValue(lineChannelAccessToken.value())),
      openaiApiKeyConfigured: Boolean(secretValue(openaiApiKey.value())),
      aiReplyEnabled: true,
      memoryBackend: "firestore",
      activation: "วิมล / @วิมล / AI / reply ข้อความของวิมล / สุ่มแทรกจากบริบท 10-30%",
      aiModel: aiConfig.model,
      aiModelLabel: aiConfig.modelLabel,
      modelOptions: aiModelOptions,
    });
  },
);

export const lineEvents = onRequest(
  {
    region: "asia-southeast1",
    invoker: "public",
  },
  async (_req, res) => {
    try {
      const [events, usageSummary, memories, memoryDetails, analytics] = await Promise.all([
        recentLineEvents(),
        aiUsageSummary(),
        recentPublicMemories(),
        detailedPublicMemories(),
        lineDashboardAnalytics(),
      ]);
      res.status(200).json({
        ok: true,
        events,
        usageSummary,
        memories,
        memoryDetails,
        analytics,
      });
    } catch (error) {
      console.error("Read line events failed", { errorCode: errorName(error) });
      res.status(500).json({ ok: false, error: "Cannot read line events" });
    }
  },
);

export const aiGroupMemory = onRequest(
  {
    region: "asia-southeast1",
    invoker: "public",
  },
  async (req, res) => {
    if (!adminApiKey || req.get("x-admin-key") !== adminApiKey) {
      res.status(403).json({ ok: false, error: "Admin key required" });
      return;
    }

    const match = req.path.match(/^\/api\/ai\/groups\/([^/]+)\/memory\/?$/);
    const groupId = match?.[1] ? decodeURIComponent(match[1]) : String(req.query.groupId || "");
    if (!groupId) {
      res.status(400).json({ ok: false, error: "groupId required" });
      return;
    }

    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    res.status(200).json({ ok: true, memories: await groupMemoriesForAdmin(groupId) });
  },
);

async function handleLineEvent(event: LineEvent, webhookStarted: number, channelAccessToken: string, openaiKey: string): Promise<EventResult> {
  const started = Date.now();
  const target = chatTargetFromEvent(event);
  const messagePreview = previewLineMessage(event.message?.text || "");
  if (!target || event.type !== "message" || event.message?.type !== "text") {
    await safeRecordAudit({
      chatId: target?.chatId || "unknown",
      chatType: target?.chatType || "user",
      userIdHash: hashId(target?.userId),
      eventType: event.type || "unknown",
      messagePreview,
      status: "ignored_non_text",
      latencyMs: Date.now() - started,
    });
    return { ok: true, replied: false };
  }

  const profile = await fetchLineProfile(channelAccessToken, target.source);
  await ensureLineIdentity(target, profile);
  const invokedByReply = await isReplyToKnownBotMessage(target, event);
  const command = parseCommand(event.message.text || "", { invokedByReply });

  if (!command.invoked) {
    const silentMemory = await rememberSilently(event.message.text || "", target, openaiKey);
    const spontaneousResult = await maybeRunSpontaneousComment(event.message.text || "", target, openaiKey);
    if (spontaneousResult) {
      const replyToken = event.replyToken || "";
      const response = replyToken ? await replyToLine(channelAccessToken, replyToken, spontaneousResult.reply) : null;
      if (response?.ok) await recordBotReplyMessages(target, await sentMessageIds(response));
      const lineReplyError = response && !response.ok ? await safeResponseText(response) : "";
      await safeRecordAudit({
        chatId: target.chatId,
        chatType: target.chatType,
        userIdHash: hashId(target.userId),
        eventType: "message",
        messagePreview,
        route: "general",
        agent: spontaneousResult.agent,
        status: response?.ok ? "spontaneous_reply" : "spontaneous_reply_failed",
        latencyMs: Date.now() - webhookStarted,
        errorCode: response && !response.ok ? `LINE_REPLY_${response.status}` : "",
        model: spontaneousResult.usage?.model,
        inputTokens: spontaneousResult.usage?.inputTokens || 0,
        outputTokens: spontaneousResult.usage?.outputTokens || 0,
        totalTokens: spontaneousResult.usage?.totalTokens || 0,
        openAiCalls: spontaneousResult.usage?.openAiCalls || 0,
        savedMemoryCount: silentMemory.savedMemoryCount,
        estimatedUsd: spontaneousResult.cost?.estimatedUsd || 0,
        estimatedThb: spontaneousResult.cost?.estimatedThb || 0,
        lineReplyStatus: response?.status || 0,
        lineReplyOk: Boolean(response?.ok),
        lineReplyError,
      });
      return { ok: Boolean(response?.ok), status: response?.status, route: spontaneousResult.route, agent: spontaneousResult.agent, replied: Boolean(response) };
    }

    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      route: "memory",
      agent: "SilentMemoryAgent",
      status: silentMemoryStatus(silentMemory.status),
      latencyMs: Date.now() - started,
      model: silentMemory.usage.model,
      inputTokens: silentMemory.usage.inputTokens,
      outputTokens: silentMemory.usage.outputTokens,
      totalTokens: silentMemory.usage.totalTokens,
      openAiCalls: silentMemory.usage.openAiCalls,
      savedMemoryCount: silentMemory.savedMemoryCount,
      estimatedUsd: silentMemory.cost.estimatedUsd,
      estimatedThb: silentMemory.cost.estimatedThb,
    });
    return { ok: true, replied: false };
  }

  try {
    const context = await getGroupContext(target);
    const aiConfig = await getAiRuntimeConfig(defaultOpenAiModel, aiModelOptions);
    const agentResult = await runAgentWorkflow({
      command,
      context,
      target,
      openaiApiKey: openaiKey,
      model: aiConfig.model,
    });

    const replyToken = event.replyToken || "";
    if (!replyToken) {
      await safeRecordAudit({
        chatId: target.chatId,
        chatType: target.chatType,
        userIdHash: hashId(target.userId),
        eventType: "message",
        messagePreview,
        route: agentResult.route,
        agent: agentResult.agent,
        status: "missing_reply_token",
        latencyMs: Date.now() - started,
      });
      return { ok: false, route: agentResult.route, agent: agentResult.agent, error: "missing_reply_token" };
    }

    const response = await replyToLine(channelAccessToken, replyToken, agentResult.reply);
    if (response.ok) await recordBotReplyMessages(target, await sentMessageIds(response));
    const lineReplyError = response.ok ? "" : await safeResponseText(response);
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      route: agentResult.route,
      agent: agentResult.agent,
      status: response.ok ? agentResult.status : "reply_failed",
      latencyMs: Date.now() - webhookStarted,
      errorCode: response.ok ? "" : `LINE_REPLY_${response.status}`,
      model: agentResult.usage?.model,
      inputTokens: agentResult.usage?.inputTokens || 0,
      outputTokens: agentResult.usage?.outputTokens || 0,
      totalTokens: agentResult.usage?.totalTokens || 0,
      openAiCalls: agentResult.usage?.openAiCalls || 0,
      estimatedUsd: agentResult.cost?.estimatedUsd || 0,
      estimatedThb: agentResult.cost?.estimatedThb || 0,
      lineReplyStatus: response.status,
      lineReplyOk: response.ok,
      lineReplyError,
    });
    console.info("LINE agent reply", {
      chatIdHash: hashId(target.chatId),
      userIdHash: hashId(target.userId),
      route: agentResult.route,
      agent: agentResult.agent,
      status: response.status,
      ok: response.ok,
    });
    return { ok: response.ok, status: response.status, route: agentResult.route, agent: agentResult.agent, replied: true };
  } catch (error) {
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      route: command.route,
      agent: "TriageAgent",
      status: "error",
      latencyMs: Date.now() - started,
      errorCode: errorName(error),
    });
    console.error("LINE event handling failed", {
      chatIdHash: hashId(target.chatId),
      userIdHash: hashId(target.userId),
      route: command.route,
      errorCode: errorName(error),
    });
    return { ok: false, route: command.route, agent: "TriageAgent", error: errorName(error) };
  }
}

async function maybeRunSpontaneousComment(text: string, target: NonNullable<ReturnType<typeof chatTargetFromEvent>>, openaiKey: string) {
  if (!shouldAttemptSpontaneous(text)) return null;
  try {
    const recentMessages = await recentGroupMessageContext(target.chatId, 10);
    if (recentMessages.length < 3) return null;
    const context = await getGroupContext(target);
    const aiConfig = await getAiRuntimeConfig(defaultOpenAiModel, aiModelOptions);
    return await runSpontaneousComment({
      currentText: text,
      recentMessages,
      context,
      target,
      openaiApiKey: openaiKey,
      model: aiConfig.model,
    });
  } catch (error) {
    console.error("Spontaneous comment failed", {
      chatIdHash: hashId(target.chatId),
      userIdHash: hashId(target.userId),
      errorCode: errorName(error),
    });
    return null;
  }
}

function shouldAttemptSpontaneous(text: string): boolean {
  const clean = String(text || "").trim();
  if (clean.length < 4) return false;
  if (previewLineMessage(clean) === "[masked sensitive message]") return false;
  const threshold = spontaneousReplyMinProbability + Math.random() * (spontaneousReplyMaxProbability - spontaneousReplyMinProbability);
  return Math.random() < threshold;
}

async function sentMessageIds(response: Response): Promise<string[]> {
  try {
    const data = (await response.clone().json()) as { sentMessages?: Array<{ id?: string }> };
    return (data.sentMessages || []).map((message) => String(message.id || "")).filter(Boolean);
  } catch {
    return [];
  }
}

function silentMemoryStatus(status: string): string {
  if (status === "saved") return "silent_memory_saved";
  if (status === "skipped_sensitive") return "silent_memory_skipped_sensitive";
  if (status === "skipped") return "silent_memory_skipped";
  if (status === "error") return "silent_memory_error";
  return "silent_memory_scanned";
}

async function safeRecordAudit(event: AuditEvent): Promise<void> {
  try {
    await recordAudit(event);
  } catch (error) {
    console.error("Record audit failed", { errorCode: errorName(error), chatIdHash: hashId(event.chatId) });
  }
}

async function rememberSilently(text: string, target: NonNullable<ReturnType<typeof chatTargetFromEvent>>, openaiKey: string) {
  try {
    const context = await getGroupContext(target);
    const aiConfig = await getAiRuntimeConfig(defaultOpenAiModel, aiModelOptions);
    return await rememberSilentlyFromMessage({
      text,
      context,
      target,
      openaiApiKey: openaiKey,
      model: aiConfig.model,
    });
  } catch (error) {
    console.error("Silent memory failed", {
      chatIdHash: hashId(target.chatId),
      userIdHash: hashId(target.userId),
      errorCode: errorName(error),
    });
    return {
      status: "error" as const,
      savedMemoryCount: 0,
      usage: { model: defaultOpenAiModel, inputTokens: 0, outputTokens: 0, totalTokens: 0, openAiCalls: 0 },
      cost: { model: defaultOpenAiModel, inputUsdPerMillion: 0, outputUsdPerMillion: 0, usdToThb: 0, estimatedUsd: 0, estimatedThb: 0 },
    };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "UnknownError";
}

function secretValue(value: string): string {
  return String(value || "").trim();
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function previewLineMessage(text: string): string {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (/(รหัสผ่าน|password|api\s*key|token|secret|channel\s*secret|access\s*token|เลขบัตร|บัตรประชาชน|sk-[A-Za-z0-9_-]+)/i.test(normalized)) {
    return "[masked sensitive message]";
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
