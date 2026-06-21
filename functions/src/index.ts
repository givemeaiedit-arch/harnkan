import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { parseCommand, runAgentWorkflow } from "./agents";
import { chatTargetFromEvent, fetchLineProfile, hashId, replyToLine, verifyLineSignature } from "./line";
import {
  ensureLineIdentity,
  getGroupContext,
  groupMemoriesForAdmin,
  recentLineEvents,
  recordAudit,
} from "./repository";
import type { AuditEvent, LineEvent, LineWebhookBody } from "./types";

const lineChannelSecret = defineSecret("LINE_CHANNEL_SECRET");
const lineChannelAccessToken = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";
const adminApiKey = process.env.AI_ADMIN_KEY || "";

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
  (_req, res) => {
    res.status(200).json({
      ok: true,
      webhookPath: "/line/webhook",
      channelSecretConfigured: Boolean(secretValue(lineChannelSecret.value())),
      channelAccessTokenConfigured: Boolean(secretValue(lineChannelAccessToken.value())),
      openaiApiKeyConfigured: Boolean(secretValue(openaiApiKey.value())),
      aiReplyEnabled: true,
      memoryBackend: "firestore",
      activation: "@หารกัน / /ai / /ดูดวง / /หาร / /วิเคราะห์ / /จำ / /ลืม",
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
      res.status(200).json({
        ok: true,
        events: await recentLineEvents(),
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
  if (!target || event.type !== "message" || event.message?.type !== "text") {
    await safeRecordAudit({
      chatId: target?.chatId || "unknown",
      chatType: target?.chatType || "user",
      userIdHash: hashId(target?.userId),
      eventType: event.type || "unknown",
      status: "ignored_non_text",
      latencyMs: Date.now() - started,
    });
    return { ok: true, replied: false };
  }

  const command = parseCommand(event.message.text || "");
  const profile = await fetchLineProfile(channelAccessToken, target.source);
  await ensureLineIdentity(target, profile);

  if (!command.invoked) {
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      status: "ignored_not_invoked",
      latencyMs: Date.now() - started,
    });
    return { ok: true, replied: false };
  }

  try {
    const context = await getGroupContext(target);
    const agentResult = await runAgentWorkflow({
      command,
      context,
      target,
      openaiApiKey: openaiKey,
      model: openaiModel,
    });

    const replyToken = event.replyToken || "";
    if (!replyToken) {
      await safeRecordAudit({
        chatId: target.chatId,
        chatType: target.chatType,
        userIdHash: hashId(target.userId),
        eventType: "message",
        route: agentResult.route,
        agent: agentResult.agent,
        status: "missing_reply_token",
        latencyMs: Date.now() - started,
      });
      return { ok: false, route: agentResult.route, agent: agentResult.agent, error: "missing_reply_token" };
    }

    const response = await replyToLine(channelAccessToken, replyToken, agentResult.reply);
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
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

async function safeRecordAudit(event: AuditEvent): Promise<void> {
  try {
    await recordAudit(event);
  } catch (error) {
    console.error("Record audit failed", { errorCode: errorName(error), chatIdHash: hashId(event.chatId) });
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "UnknownError";
}

function secretValue(value: string): string {
  return String(value || "").trim();
}
