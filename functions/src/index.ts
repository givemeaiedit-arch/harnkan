import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { aiModelOptions, classifyMessageForReply, parseCommand, runAgentWorkflow, runClassifierReply } from "./agents";
import { chatTargetFromEvent, fetchLineProfile, hashId, replyToLine, verifyLineSignature } from "./line";
import {
  claimLineEvent,
  ensureLineIdentity,
  aiUsageSummary,
  detailedPublicMemories,
  getAiRuntimeConfig,
  getGroupBotEnabled,
  getGroupContext,
  groupMemoriesForAdmin,
  isReplyToKnownBotMessage,
  lineDashboardAnalytics,
  recordConversationMessage,
  recentPublicMemories,
  recentLineEvents,
  recordBotReplyMessages,
  recordAudit,
  saveMemory,
  setGroupBotEnabled,
  setAiRuntimeModel,
} from "./repository";
import type { AuditEvent, CostEstimate, LineEvent, LineWebhookBody, MemberMemory, TokenUsage } from "./types";

const lineChannelSecret = defineSecret("LINE_CHANNEL_SECRET");
const lineChannelAccessToken = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const defaultOpenAiModel = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const classifierModel = process.env.CLASSIFIER_MODEL || "gpt-4.1-nano";
const adminApiKey = process.env.AI_ADMIN_KEY || "";
const creatorUserIdHash = "733b9dbc996a";

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
      activation: "วิมล / @วิมล / AI / reply ข้อความของวิมล / วิมล ปิดระบบ / วิมล เปิดระบบ",
      aiModel: aiConfig.model,
      aiModelLabel: aiConfig.modelLabel,
      classifierModel,
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

  const eventClaim = await claimLineEvent(target, event);
  if (eventClaim.duplicate) {
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      route: "general",
      agent: "DeduplicationGate",
      status: eventClaim.reason === "line_redelivery" ? "line_redelivery_skipped" : "duplicate_event_skipped",
      latencyMs: Date.now() - started,
      webhookEventId: String(event.webhookEventId || ""),
      messageId: String(event.message?.id || ""),
      isRedelivery: Boolean(event.deliveryContext?.isRedelivery),
    });
    return { ok: true, route: "general", agent: "DeduplicationGate", replied: false };
  }

  const profile = await fetchLineProfile(channelAccessToken, target.source);
  await ensureLineIdentity(target, profile);
  await recordConversationMessage(target, profile, event.message.text || "", event);
  const technicalCommand = parseTechnicalCommand(event.message.text || "");
  if (technicalCommand) {
    const replyToken = event.replyToken || "";
    const creator = isCreator(target.userId);
    const replyText = creator
      ? await executeTechnicalCommand(technicalCommand, target, defaultOpenAiModel)
      : "คำสั่งนี้ใช้ได้เฉพาะผู้สร้างวิมลเท่านั้นค่ะ";
    const response = replyToken ? await replyToLine(channelAccessToken, replyToken, replyText) : null;
    const lineReplyError = response && !response.ok ? await safeResponseText(response) : "";
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      trigger: "mention",
      route: "settings",
      agent: "SystemControlAgent",
      status: creator ? `technical_${technicalCommand.action}` : "technical_unauthorized",
      latencyMs: Date.now() - webhookStarted,
      errorCode: response && !response.ok ? `LINE_REPLY_${response.status}` : "",
      lineReplyStatus: response?.status || 0,
      lineReplyOk: Boolean(response?.ok),
      lineReplyError,
      intent: "technical_command",
      tasks: ["settings"],
      decisionReason: creator ? `creator_command:${technicalCommand.action}` : "non_creator_technical_command",
    });
    return { ok: Boolean(response?.ok ?? true), status: response?.status, route: "settings", agent: "SystemControlAgent", replied: Boolean(response) };
  }

  const botEnabled = await getGroupBotEnabled(target);
  if (!botEnabled) {
    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      route: "settings",
      agent: "SystemControlAgent",
      status: "bot_off_ignored",
      latencyMs: Date.now() - started,
    });
    return { ok: true, route: "settings", agent: "SystemControlAgent", replied: false };
  }

  const invokedByReply = await isReplyToKnownBotMessage(target, event);
  const command = parseCommand(event.message.text || "", { invokedByReply });

  if (!command.invoked) {
    const gate = cheapAiGate(event.message.text || "");
    if (!gate.shouldRun) {
      await safeRecordAudit({
        chatId: target.chatId,
        chatType: target.chatType,
        userIdHash: hashId(target.userId),
        eventType: "message",
        messagePreview,
        route: "general",
        agent: "RuleGate",
        status: "rule_gate_skipped",
        latencyMs: Date.now() - started,
        classifierReason: gate.reason,
      });
      return { ok: true, route: "general", agent: "RuleGate", replied: false };
    }

    const classifierResult = await maybeRunClassifierReply(event.message.text || "", target, openaiKey);
    const savedMemoryCount = classifierResult?.classification?.memories?.length
      ? await saveClassificationMemories(target, classifierResult.classification.memories)
      : 0;
    if (classifierResult?.agentResult) {
      const replyToken = event.replyToken || "";
      const response = replyToken ? await replyToLine(channelAccessToken, replyToken, classifierResult.agentResult.reply) : null;
      if (response?.ok) await recordBotReplyMessages(target, await sentMessageIds(response));
      const lineReplyError = response && !response.ok ? await safeResponseText(response) : "";
      const usage = mergeUsage(classifierResult.classification.usage, classifierResult.agentResult.usage);
      const cost = mergeCost(classifierResult.classification.cost, classifierResult.agentResult.cost);
      await safeRecordAudit({
        chatId: target.chatId,
        chatType: target.chatType,
        userIdHash: hashId(target.userId),
        eventType: "message",
        messagePreview,
        route: "general",
        agent: classifierResult.agentResult.agent,
        status: response?.ok ? "classifier_reply" : "classifier_reply_failed",
        latencyMs: Date.now() - webhookStarted,
        errorCode: response && !response.ok ? `LINE_REPLY_${response.status}` : "",
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        openAiCalls: usage.openAiCalls,
        savedMemoryCount,
        estimatedUsd: cost.estimatedUsd,
        estimatedThb: cost.estimatedThb,
        lineReplyStatus: response?.status || 0,
        lineReplyOk: Boolean(response?.ok),
        lineReplyError,
        classifierReason: classifierResult.classification.reason,
        classifierConfidence: classifierResult.classification.confidence,
        personalityMode: classifierResult.classification.personalityMode,
        intent: classifierResult.agentResult.intent || classifierResult.classification.intent || "",
        tasks: classifierResult.agentResult.tasks || classifierResult.classification.tasks || [],
        decisionReason: classifierResult.agentResult.decisionReason || classifierResult.classification.decisionReason || classifierResult.classification.reason,
        memoryUsedCount: classifierResult.agentResult.memoryUsedCount || 0,
        contextUsedCount: classifierResult.agentResult.contextUsedCount || 0,
      });
      return { ok: Boolean(response?.ok), status: response?.status, route: classifierResult.agentResult.route, agent: classifierResult.agentResult.agent, replied: Boolean(response) };
    }

    if (classifierResult?.classification) {
      const usage = classifierResult.classification.usage || emptyUsage(classifierModel);
      const cost = classifierResult.classification.cost || emptyCost(classifierModel);
      await safeRecordAudit({
        chatId: target.chatId,
        chatType: target.chatType,
        userIdHash: hashId(target.userId),
        eventType: "message",
        messagePreview,
        route: "general",
        agent: "MessageClassifier",
        status: "classifier_no_reply",
        latencyMs: Date.now() - started,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        openAiCalls: usage.openAiCalls,
        savedMemoryCount,
        estimatedUsd: cost.estimatedUsd,
        estimatedThb: cost.estimatedThb,
        classifierReason: classifierResult.classification.reason,
        classifierConfidence: classifierResult.classification.confidence,
        personalityMode: classifierResult.classification.personalityMode,
        intent: classifierResult.classification.intent || "",
        tasks: classifierResult.classification.tasks || [],
        decisionReason: classifierResult.classification.decisionReason || classifierResult.classification.reason,
      });
      return { ok: true, route: "general", agent: "MessageClassifier", replied: false };
    }

    await safeRecordAudit({
      chatId: target.chatId,
      chatType: target.chatType,
      userIdHash: hashId(target.userId),
      eventType: "message",
      messagePreview,
      route: "general",
      agent: "RuleGate",
      status: "classifier_unavailable",
      latencyMs: Date.now() - started,
      classifierReason: gate.reason,
    });
    return { ok: true, replied: false };
  }

  try {
    const contextLimit = command.trigger === "reply" ? 20 : 12;
    const context = await getGroupContext(target, { focusText: event.message.text || "", recentMessagesLimit: contextLimit });
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
        trigger: command.trigger,
        contextMessageCount: context.recentMessages.length,
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
      trigger: command.trigger,
      contextMessageCount: context.recentMessages.length,
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
      intent: agentResult.intent || "",
      tasks: agentResult.tasks || [],
      decisionReason: agentResult.decisionReason || "",
      memoryUsedCount: agentResult.memoryUsedCount || 0,
      contextUsedCount: agentResult.contextUsedCount || context.recentMessages.length,
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
      trigger: command.trigger,
      route: command.route,
      agent: "TriageAgent",
      status: "error",
      latencyMs: Date.now() - started,
      errorCode: errorName(error),
      intent: "error",
      tasks: ["chat"],
      decisionReason: "Agent workflow failed before response",
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

async function maybeRunClassifierReply(text: string, target: NonNullable<ReturnType<typeof chatTargetFromEvent>>, openaiKey: string) {
  try {
    const context = await getGroupContext(target, { focusText: text, recentMessagesLimit: 10 });
    const classification = await classifyMessageForReply({
      text,
      context,
      openaiApiKey: openaiKey,
      model: classifierModel,
    });
    if (!classification.shouldReply) return { classification };
    const aiConfig = await getAiRuntimeConfig(defaultOpenAiModel, aiModelOptions);
    const agentResult = await runClassifierReply({
      currentText: text,
      classification,
      context,
      target,
      openaiApiKey: openaiKey,
      model: aiConfig.model,
    });
    return { classification, agentResult };
  } catch (error) {
    console.error("Classifier reply failed", {
      chatIdHash: hashId(target.chatId),
      userIdHash: hashId(target.userId),
      errorCode: errorName(error),
    });
    return null;
  }
}

async function sentMessageIds(response: Response): Promise<string[]> {
  try {
    const data = (await response.clone().json()) as { sentMessages?: Array<{ id?: string }> };
    return (data.sentMessages || []).map((message) => String(message.id || "")).filter(Boolean);
  } catch {
    return [];
  }
}

type TechnicalCommand =
  | { action: "help" }
  | { action: "status" }
  | { action: "cost" }
  | { action: "model"; model?: string }
  | { action: "enable"; enabled: boolean };

function isCreator(userId: string): boolean {
  return hashId(userId) === creatorUserIdHash;
}

function parseTechnicalCommand(text: string): TechnicalCommand | null {
  const clean = String(text || "").trim().toLowerCase();
  const hasWakeWord = /(^|\s)(@?วิมล|ai)(\s|$)/i.test(clean);
  if (!hasWakeWord) return null;
  if (/(เปิดระบบ|เปิด\s*ai|เปิด\s*วิมล|start|enable)/i.test(clean)) return { action: "enable", enabled: true };
  if (/(ปิดระบบ|ปิด\s*ai|ปิด\s*วิมล|stop|disable)/i.test(clean)) return { action: "enable", enabled: false };
  if (!/(system|ซิสเต็ม|ระบบ|เทคนิค|admin)/i.test(clean)) return null;
  if (/(help|คำสั่ง|ช่วย|คู่มือ)/i.test(clean)) return { action: "help" };
  if (/(cost|usage|ค่าใช้|token|โทเคน)/i.test(clean)) return { action: "cost" };
  const modelMatch = clean.match(/(?:model|โมเดล)\s+([a-z0-9._-]+)/i);
  if (modelMatch) return { action: "model", model: modelMatch[1] };
  if (/(model|โมเดล)/i.test(clean)) return { action: "model" };
  if (/(status|สถานะ|info|ข้อมูล)/i.test(clean)) return { action: "status" };
  return { action: "status" };
}

async function executeTechnicalCommand(command: TechnicalCommand, target: NonNullable<ReturnType<typeof chatTargetFromEvent>>, defaultModel: string): Promise<string> {
  if (command.action === "enable") {
    await setGroupBotEnabled(target, command.enabled);
    return command.enabled
      ? "เปิดระบบวิมลแล้วค่ะ ต่อจากนี้วิมลจะกลับมาตอบและจดจำบริบทในกลุ่มนี้นะคะ"
      : "ปิดระบบวิมลแล้วค่ะ วิมลจะหยุดตอบและหยุดสกัดความจำใหม่ในกลุ่มนี้ จนกว่าผู้สร้างจะพิมพ์ว่า “วิมล เปิดระบบ”";
  }
  if (command.action === "model") {
    if (!command.model) {
      const config = await getAiRuntimeConfig(defaultModel, aiModelOptions);
      return `โมเดลปัจจุบัน: ${config.modelLabel}\nเปลี่ยนได้ด้วย: วิมล System model gpt-5.4-mini หรือ gpt-4.1-mini`;
    }
    const config = await setAiRuntimeModel(command.model, aiModelOptions);
    return `เปลี่ยนโมเดลวิมลเป็น ${config.modelLabel} แล้วค่ะ`;
  }
  if (command.action === "cost") {
    const usage = await aiUsageSummary(5000);
    return [
      "รายงานค่าใช้จ่ายวิมล",
      `Calls: ${formatInteger(Number(usage.openAiCalls || 0))}`,
      `Tokens: ${formatInteger(Number(usage.totalTokens || 0))}`,
      `Cost: $${Number(usage.estimatedUsd || 0).toFixed(6)} / ฿${Number(usage.estimatedThb || 0).toFixed(4)}`,
    ].join("\n");
  }
  if (command.action === "help") {
    return [
      "คำสั่งเทคนิคของวิมลสำหรับผู้สร้าง",
      "วิมล System status - ดูสถานะระบบ",
      "วิมล System cost - ดูค่าใช้จ่าย/Token",
      "วิมล System model - ดูโมเดลปัจจุบัน",
      "วิมล System model gpt-5.4-mini - เปลี่ยนโมเดล",
      "วิมล เปิดระบบ / วิมล ปิดระบบ - เปิดปิดการตอบในกลุ่ม",
    ].join("\n");
  }
  const [botEnabled, config, usage] = await Promise.all([
    getGroupBotEnabled(target),
    getAiRuntimeConfig(defaultModel, aiModelOptions),
    aiUsageSummary(1000),
  ]);
  return [
    "System วิมล",
    `ผู้สร้าง: Notzio PK (${creatorUserIdHash})`,
    `สถานะกลุ่ม: ${botEnabled ? "เปิดระบบ" : "ปิดระบบ"}`,
    `โมเดล: ${config.modelLabel}`,
    `AI calls ล่าสุด: ${formatInteger(Number(usage.openAiCalls || 0))}`,
    `Token ล่าสุด: ${formatInteger(Number(usage.totalTokens || 0))}`,
    `ค่าใช้จ่ายล่าสุด: $${Number(usage.estimatedUsd || 0).toFixed(6)} / ฿${Number(usage.estimatedThb || 0).toFixed(4)}`,
  ].join("\n");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(Number(value || 0)));
}

function cheapAiGate(text: string): { shouldRun: boolean; reason: string } {
  const clean = String(text || "").trim();
  if (!clean) return { shouldRun: false, reason: "empty" };
  if (looksSensitiveForGate(clean)) return { shouldRun: false, reason: "sensitive" };
  const patterns = [
    { reason: "memory_keyword", pattern: /(จำว่า|จำไว้|ชื่อ|เรียกว่า|เกิด|วันเกิด|ชอบ|ไม่ชอบ|ไม่กิน|แพ้|แฟน|ทำงาน|อยู่ที่|นิสัย|สไตล์|หาร|โอน|จ่าย|บาท|ไม่ต้องหาร|ออกค่า|รับผิดชอบ|มาแค่|มาช้า|กลับก่อน|ช่วงหลัง|ช่วงแรก)/i },
    { reason: "help_or_question", pattern: /(ช่วย|สรุป|วิเคราะห์|คิดว่า|ทำไม|ยังไง|ดีไหม|ได้ไหม|ไหม|\?)/i },
    { reason: "emotion_or_joke", pattern: /(555|ฮา|ขำ|เศร้า|เครียด|ดีใจ|โกรธ|งง|แปลก|สุด|มากกก|!!!)/i },
  ];
  const matched = patterns.find((item) => item.pattern.test(clean));
  if (matched) return { shouldRun: true, reason: matched.reason };
  if (looksLikeUsefulDeclaration(clean)) return { shouldRun: true, reason: "useful_declaration" };
  if (clean.length >= 80) return { shouldRun: true, reason: "long_context" };
  return { shouldRun: false, reason: "ordinary_chat_zero_token" };
}

function looksSensitiveForGate(text: string): boolean {
  return /(รหัสผ่าน|password|api\s*key|token|secret|channel\s*secret|access\s*token|เลขบัตร|บัตรประชาชน|เลขบัญชี|account\s*number|sk-[A-Za-z0-9_-]+)/i.test(text);
}

function looksLikeUsefulDeclaration(text: string): boolean {
  const clean = String(text || "").trim();
  if (clean.length < 14) return false;
  if (/^(โอเค|เค|ok|ครับ|ค่ะ|จ้า|อืม|อือ|ได้|ไม่|ใช่|เออ|555+|ฮ่า+|ขอบคุณ)$/i.test(clean)) return false;
  return /(เป็น|อยู่|มี|เคย|กำลัง|จะ|ต้อง|ไป|มา|กิน|ทำ|เรียน|ชอบ|ไม่)/i.test(clean);
}

async function saveClassificationMemories(target: NonNullable<ReturnType<typeof chatTargetFromEvent>>, memories: Array<Omit<MemberMemory, "id" | "createdAt">>): Promise<number> {
  const strongMemories = memories.filter((memory) => memory.confidence >= 0.72).slice(0, 3);
  if (!strongMemories.length) return 0;
  await Promise.all(strongMemories.map((memory) => saveMemory(target, memory)));
  return strongMemories.length;
}

function mergeUsage(first: TokenUsage | undefined, second: TokenUsage | undefined): TokenUsage {
  const safeFirst = first || emptyUsage("");
  const safeSecond = second || emptyUsage("");
  return {
    model: [safeFirst.model, safeSecond.model].filter(Boolean).join("+") || defaultOpenAiModel,
    inputTokens: safeFirst.inputTokens + safeSecond.inputTokens,
    outputTokens: safeFirst.outputTokens + safeSecond.outputTokens,
    totalTokens: safeFirst.totalTokens + safeSecond.totalTokens,
    openAiCalls: safeFirst.openAiCalls + safeSecond.openAiCalls,
  };
}

function mergeCost(first: CostEstimate | undefined, second: CostEstimate | undefined): CostEstimate {
  const safeFirst = first || emptyCost("");
  const safeSecond = second || emptyCost("");
  return {
    model: [safeFirst.model, safeSecond.model].filter(Boolean).join("+") || defaultOpenAiModel,
    inputUsdPerMillion: safeSecond.inputUsdPerMillion || safeFirst.inputUsdPerMillion,
    outputUsdPerMillion: safeSecond.outputUsdPerMillion || safeFirst.outputUsdPerMillion,
    usdToThb: safeSecond.usdToThb || safeFirst.usdToThb,
    estimatedUsd: safeFirst.estimatedUsd + safeSecond.estimatedUsd,
    estimatedThb: safeFirst.estimatedThb + safeSecond.estimatedThb,
  };
}

function emptyUsage(model: string): TokenUsage {
  return { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, openAiCalls: 0 };
}

function emptyCost(model: string): CostEstimate {
  return { model, inputUsdPerMillion: 0, outputUsdPerMillion: 0, usdToThb: 0, estimatedUsd: 0, estimatedThb: 0 };
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
