import type {
  AgentResult,
  AiModelOption,
  ChatTarget,
  CostEstimate,
  GroupContext,
  MemberMemory,
  MessageClassification,
  ParsedCommand,
  ParsedSplitExpense,
  PersonalityMode,
  ReplyIntent,
  TokenUsage,
} from "./types";
import { createSplitExpense, deleteUserMemories, saveMemory } from "./repository";

const harnkanUrl = "https://harnkan-givemeai-gpt-hub.web.app";
const defaultUsdToThb = Number(process.env.USD_TO_THB_RATE || 32.9);
const femalePersona =
  "คุณคือ “วิมล” สมาชิกประจำกลุ่มเพื่อนใน LINE ไม่ใช่ผู้ช่วยทางการ บุคลิกกวน ฉลาด แซวไว อบอุ่น ไม่แรง เหมือนเพื่อนอีกคนในกลุ่ม พูดภาษาไทยแบบผู้หญิง แทนตัวเองว่าวิมล ใช้ค่ะ/นะคะได้อย่างเป็นธรรมชาติ ห้ามใช้คำว่า ผม หรือ ครับ ตอบสั้น 1-3 บรรทัด ห้ามด่ารุนแรง ห้ามล้อเรื่องอ่อนไหว ห้ามเปิดเผยข้อมูลส่วนตัว และใช้มุกจากความทรงจำกลุ่มได้เมื่อเหมาะ";

export const aiModelOptions: AiModelOption[] = [
  { label: "GPT 5.4 mini", value: "gpt-5.4-mini", inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 },
  { label: "GPT 4o1 mini", value: "gpt-4.1-mini", inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
];

type OpenAiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type MemoryExtraction = {
  memories: Array<{
    subjectName: string;
    category: MemberMemory["category"];
    text: string;
    confidence: number;
  }>;
};

type CostTracker = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  openAiCalls: number;
};

type ClassificationOutput = {
  shouldReply: boolean;
  reason: string;
  confidence: number;
  intent: string;
  tasks: string[];
  decisionReason: string;
  personalityMode: PersonalityMode;
  replyIntent: ReplyIntent;
  memories: Array<{
    subjectName: string;
    category: MemberMemory["category"];
    text: string;
    confidence: number;
  }>;
};

const wakeWords = ["@วิมล", "วิมล", "AI", "ai"];

export function parseCommand(rawText: string, options: { invokedByReply?: boolean } = {}): ParsedCommand {
  const text = rawText.trim();
  const matchedWake = wakeWords
    .map((word) => ({ word, index: text.toLowerCase().indexOf(word.toLowerCase()) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.word.length - left.word.length)[0];
  if (!matchedWake && !options.invokedByReply) return { invoked: false, route: "general", text, rawPrefix: "" };

  const body = matchedWake
    ? `${text.slice(0, matchedWake.index)} ${text.slice(matchedWake.index + matchedWake.word.length)}`.replace(/\s+/g, " ").trim()
    : text;
  const rawPrefix = matchedWake?.word || "reply";
  const trigger = options.invokedByReply ? "reply" : "mention";
  if (/^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)(?:\s|$)/i.test(body)) {
    return { invoked: true, route: "dynamic", text: body.replace(/^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\s*/i, ""), rawPrefix, trigger };
  }
  if (/^(ลืม|ล้างข้อมูล|ลบข้อมูล)(?:\s|$)/i.test(body)) {
    return { invoked: true, route: "memory_delete", text: body.replace(/^(ลืม|ล้างข้อมูล|ลบข้อมูล)\s*/i, ""), rawPrefix, trigger };
  }
  if (/^(ข้อมูลของฉัน|จำอะไรเกี่ยวกับฉัน|profile|memory)(?:\s|$)/i.test(body)) {
    return { invoked: true, route: "memory_show", text: body, rawPrefix, trigger };
  }
  return { invoked: true, route: "dynamic", text: body || "__WAKE_ONLY__", rawPrefix, trigger };
}

export async function runAgentWorkflow(input: {
  command: ParsedCommand;
  context: GroupContext;
  target: ChatTarget;
  openaiApiKey: string;
  model: string;
}): Promise<AgentResult> {
  const { command, context, target, openaiApiKey, model } = input;
  const started = Date.now();
  const tracker: CostTracker = { model, inputTokens: 0, outputTokens: 0, openAiCalls: 0 };

  try {
    let result: AgentResult;
    if (command.route === "dynamic" || command.route === "mixed") {
      result = await runDynamicWimolAgent(command.text, context, target, openaiApiKey, model, tracker);
    } else if (command.route === "memory") {
      result = await runMemoryAgent(command.text, context, target, openaiApiKey, model, tracker);
    } else if (command.route === "memory_show") {
      result = runMemoryShowAgent(context);
    } else if (command.route === "memory_delete") {
      result = await runMemoryDeleteAgent(command.text, target);
    } else if (command.route === "split") {
      result = await runSplitBillAgent(command.text, context, target, openaiApiKey, model, tracker);
    } else if (command.route === "horoscope") {
      result = await runHoroscopeAgent(command.text, context, openaiApiKey, model, tracker);
    } else if (command.route === "speech") {
      result = await runSpeechAnalysisAgent(command.text, context, openaiApiKey, model, tracker);
    } else {
      result = await runGeneralChatAgent(command.text, context, openaiApiKey, model, tracker);
    }

    if (!["memory", "memory_show", "memory_delete"].includes(result.route) && shouldExtractAutoMemory(command.text)) {
      await saveAutoMemories(command.text, context, target, openaiApiKey, model, tracker);
    }
    const usage = usageFromTracker(tracker);
    return { ...result, reply: safetyReview(result.reply), usage, cost: estimateCost(usage) };
  } catch (error) {
    console.error("Agent workflow failed", {
      route: command.route,
      elapsedMs: Date.now() - started,
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return {
      reply: "ขอโทษค่ะ ตอนนี้วิมลมีปัญหาชั่วคราว ลองพิมพ์ใหม่อีกครั้งได้เลยนะคะ",
      route: command.route,
      agent: "SafetyReviewAgent",
      status: "error",
      usage: usageFromTracker(tracker),
      cost: estimateCost(usageFromTracker(tracker)),
    };
  }
}

export async function classifyMessageForReply(input: {
  text: string;
  context: GroupContext;
  openaiApiKey: string;
  model: string;
}): Promise<MessageClassification> {
  const tracker: CostTracker = { model: input.model, inputTokens: 0, outputTokens: 0, openAiCalls: 0 };
  const fallback = (reason: string): MessageClassification => {
    const usage = usageFromTracker(tracker);
    return {
      shouldReply: false,
      reason,
      confidence: 0,
      intent: "none",
      tasks: ["chat"],
      decisionReason: reason,
      personalityMode: "neutral",
      replyIntent: "none",
      usage,
      cost: estimateCost(usage),
    };
  };

  const clean = input.text.trim();
  if (!clean || isSensitiveText(clean)) return fallback("empty_or_sensitive");

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      shouldReply: { type: "boolean" },
      reason: { type: "string" },
      confidence: { type: "number" },
      intent: { type: "string" },
      tasks: {
        type: "array",
        maxItems: 5,
        items: { type: "string", enum: ["chat", "memory", "split", "horoscope", "speech", "summary"] },
      },
      decisionReason: { type: "string" },
      personalityMode: {
        type: "string",
        enum: ["comedian", "reporter", "fortune_teller", "judge", "sports_commentator", "neutral"],
      },
      replyIntent: {
        type: "string",
        enum: ["joke", "comfort", "opinion", "summary", "question", "none"],
      },
      memories: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            subjectName: { type: "string" },
            category: { type: "string", enum: ["profile", "food", "birthday", "preference", "split", "note"] },
            text: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["subjectName", "category", "text", "confidence"],
        },
      },
    },
    required: ["shouldReply", "reason", "confidence", "intent", "tasks", "decisionReason", "personalityMode", "replyIntent", "memories"],
  };

  const result = await createJsonCompletion<ClassificationOutput>(input.openaiApiKey, input.model, schema, [
    {
      role: "system",
      content:
        "คุณคือ Combined Gate ของวิมลในกลุ่ม LINE ทำ 2 งานในครั้งเดียว: 1) ตัดสินว่าจะตอบหรือเงียบ 2) สกัด memory สำคัญรายบุคคลถ้ามี ถ้าไม่ได้มีจังหวะจริงให้ shouldReply=false บอทไม่ควรตอบทุกข้อความ ให้ตอบเฉพาะเมื่อข้อความตลก มีอารมณ์ชัด ถามความเห็น พูดถึงเรื่องที่วิมลมี memory เกี่ยวข้อง มี inside joke หรือมีจังหวะแซวที่สุภาพได้ สำหรับ memories ให้เก็บเฉพาะข้อมูลที่ควรจำระยะยาว เช่น ชื่อเล่น อาหารที่ไม่กิน วันเกิด ความชอบ นิสัย เงื่อนไขหารเงิน โดยใส่ subjectName ให้ตรงเจ้าของข้อมูล ห้ามเก็บรหัสผ่าน token secret เลขบัตร เลขบัญชี หรือข้อมูลสุขภาพละเอียด",
    },
    {
      role: "user",
      content:
        `${conversationContextSummary(input.context)}\n\n` +
        `ข้อความล่าสุด: ${clean}\n\n` +
        "ตัดสินใจแบบเข้มงวด ถ้า confidence ต่ำกว่า 0.62 ให้ shouldReply=false",
    },
  ], tracker);

  const usage = usageFromTracker(tracker);
  const confidence = clamp(Number(result?.confidence || 0), 0, 1);
  const shouldReply = Boolean(result?.shouldReply) && confidence >= 0.62;
  return {
    shouldReply,
    reason: String(result?.reason || (shouldReply ? "classifier_reply" : "classifier_no_reply")).slice(0, 180),
    confidence,
    intent: String(result?.intent || normalizeReplyIntent(result?.replyIntent)).slice(0, 80),
    tasks: normalizeDynamicTasks(result?.tasks),
    decisionReason: String(result?.decisionReason || result?.reason || "").slice(0, 180),
    personalityMode: normalizePersonalityMode(result?.personalityMode),
    replyIntent: normalizeReplyIntent(result?.replyIntent),
    memories: normalizeExtractedMemories(result?.memories, input.context),
    usage,
    cost: estimateCost(usage),
  };
}

export async function runClassifierReply(input: {
  currentText: string;
  classification: MessageClassification;
  context: GroupContext;
  target: ChatTarget;
  openaiApiKey: string;
  model: string;
}): Promise<AgentResult> {
  const tracker: CostTracker = { model: input.model, inputTokens: 0, outputTokens: 0, openAiCalls: 0 };
  const reply = await createTextCompletion(input.openaiApiKey, input.model, [
    {
      role: "system",
      content:
        `${femalePersona} ตอนนี้วิมลตอบเพราะ Message Classifier เห็นว่ามีจังหวะเหมาะ ไม่ใช่เพราะมีคนเรียกชื่อ จึงต้องตอบให้สั้น เป็นธรรมชาติ และไม่แย่งซีน โหมดบุคลิก: ${personalityModeInstruction(input.classification.personalityMode)} เจตนาคำตอบ: ${replyIntentInstruction(input.classification.replyIntent)}`,
    },
    {
      role: "user",
      content:
        `${conversationContextSummary(input.context)}\n\n` +
        `เหตุผลที่ควรตอบ: ${input.classification.reason}\n` +
        `ข้อความล่าสุด: ${input.currentText}\n\n` +
        "เขียนคำตอบภาษาไทย 1-3 บรรทัด แบบเพื่อนในกลุ่ม หลีกเลี่ยงมุกแรงและข้อมูลส่วนตัว",
    },
  ], tracker);
  const usage = usageFromTracker(tracker);
  return {
    reply: safetyReview(reply || "วิมลขอเสริมเบา ๆ ว่าจังหวะนี้น่าจะคุยกันให้ชัดขึ้นนิดนึงนะคะ"),
    route: input.classification.tasks && input.classification.tasks.length > 1 ? "mixed" : "dynamic",
    agent: "WimolDynamicAgent",
    status: "ok",
    intent: input.classification.intent || input.classification.replyIntent,
    tasks: input.classification.tasks?.length ? input.classification.tasks : [input.classification.replyIntent],
    decisionReason: input.classification.decisionReason || input.classification.reason,
    confidence: input.classification.confidence,
    memoryUsedCount: input.context.speakerMemories.length + input.context.relatedMemories.length + input.context.groupMemories.length,
    contextUsedCount: input.context.recentMessages.length,
    usage,
    cost: estimateCost(usage),
  };
}

async function runDynamicWimolAgent(
  text: string,
  context: GroupContext,
  target: ChatTarget,
  openaiApiKey: string,
  model: string,
  tracker: CostTracker,
): Promise<AgentResult> {
  const decision = inferDynamicDecision(text, context);
  let result: AgentResult;
  if (decision.primaryTask === "memory") {
    result = await runMemoryAgent(stripMemorySavePrefix(text), context, target, openaiApiKey, model, tracker);
  } else if (decision.primaryTask === "split") {
    result = await runSplitBillAgent(text, context, target, openaiApiKey, model, tracker);
  } else if (decision.primaryTask === "horoscope") {
    result = await runHoroscopeAgent(text, context, openaiApiKey, model, tracker);
  } else if (decision.primaryTask === "speech") {
    result = await runSpeechAnalysisAgent(text, context, openaiApiKey, model, tracker);
  } else {
    result = await runGeneralChatAgent(text, context, openaiApiKey, model, tracker);
  }

  return {
    ...result,
    route: decision.tasks.length > 1 ? "mixed" : "dynamic",
    agent: "WimolDynamicAgent",
    intent: decision.intent,
    tasks: decision.tasks,
    decisionReason: decision.reason,
    confidence: decision.confidence,
    memoryUsedCount: context.speakerMemories.length + context.relatedMemories.length + context.groupMemories.length,
    contextUsedCount: context.recentMessages.length,
  };
}

function inferDynamicDecision(text: string, context: GroupContext): {
  intent: string;
  tasks: string[];
  primaryTask: string;
  reason: string;
  confidence: number;
} {
  const clean = String(text || "").trim();
  const tasks = new Set<string>();
  if (isWakeOnlyText(clean)) {
    return {
      intent: "wake_only",
      tasks: ["chat"],
      primaryTask: "chat",
      reason: "ผู้ใช้เรียกชื่อวิมลเฉย ๆ ให้ตอบรับสั้นแบบธรรมชาติ ไม่ต้องแนะนำความสามารถซ้ำ",
      confidence: 0.9,
    };
  }
  if (isExplicitMemorySave(clean)) tasks.add("memory");
  if (isMemoryQuestion(clean)) tasks.add("chat");
  if (/(?:หาร|ค่าอาหาร|ค่าเบียร์|ค่าเหล้า|จ่าย|โอน|บาท|\d+\s*(?:บ\.|บาท))/i.test(clean)) tasks.add("split");
  if (/(?:ดูดวง|ดวง|ราศี|ไพ่|โชค)/i.test(clean)) tasks.add("horoscope");
  if (/(?:วิเคราะห์|ปรับคำพูด|โทน|สุภาพ|แรงไปไหม|ควรพูด)/i.test(clean)) tasks.add("speech");
  if (/(?:สรุป|เล่าให้ฟัง|จับประเด็น)/i.test(clean)) tasks.add("summary");
  if (!tasks.size) tasks.add("chat");

  const ordered = ["split", "memory", "speech", "horoscope", "summary", "chat"].filter((task) => tasks.has(task));
  const primaryTask = ordered.find((task) => ["split", "memory", "speech", "horoscope"].includes(task)) || "chat";
  const memoryCount = context.speakerMemories.length + context.relatedMemories.length + context.groupMemories.length;
  const intent = ordered.length > 1 ? "mixed_request" : `${primaryTask}_request`;
  const reason = [
    ordered.length > 1 ? "พบหลายงานในข้อความเดียว" : "เลือกจากข้อความและบริบทล่าสุด",
    `tasks=${ordered.join("+")}`,
    memoryCount ? `ใช้ memory ${memoryCount} รายการ` : "ไม่มี memory ที่เกี่ยวข้อง",
  ].join(" • ");
  return {
    intent,
    tasks: ordered,
    primaryTask,
    reason,
    confidence: ordered.includes("chat") && ordered.length === 1 ? 0.68 : 0.82,
  };
}

async function runGeneralChatAgent(text: string, context: GroupContext, openaiApiKey: string, model: string, tracker: CostTracker): Promise<AgentResult> {
  if (isWakeOnlyText(text)) {
    return {
      reply: wakeOnlyReply(context),
      route: "general",
      agent: "GeneralChatAgent",
      status: "ok",
    };
  }

  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        `${femalePersona} ตอบสั้น ชัดเจน ถ้าผู้ใช้ถามว่า “เราชื่ออะไร”, “จำได้ไหม”, “รู้ไหมเราเป็นใคร” ให้ตอบจาก memory/context เหมือนคุยปกติ ห้ามตอบว่า “จำให้แล้ว” เว้นแต่ผู้ใช้สั่งชัดว่า “จำว่า/จำไว้ว่า/บันทึกว่า” ถ้างานเกี่ยวกับหารเงิน ดูดวง วิเคราะห์คำพูด หรือความจำ ให้ช่วยต่อจากข้อความธรรมชาติได้ ไม่ต้องบังคับใช้คำสั่ง slash ห้ามตอบเป็นเมนูแนะนำความสามารถซ้ำ ๆ ถ้าผู้ใช้เรียกชื่อเฉย ๆ ให้ตอบรับแบบเพื่อนในกลุ่ม`,
    },
    {
      role: "user",
      content: `${conversationContextSummary(context)}\n\nข้อความ: ${text}`,
    },
  ], tracker);

  return {
    reply: reply || "ว่าไงคะ วิมลอยู่ตรงนี้ค่ะ",
    route: "general",
    agent: "GeneralChatAgent",
    status: "ok",
  };
}

function isWakeOnlyText(text: string): boolean {
  return String(text || "").trim() === "__WAKE_ONLY__";
}

function isExplicitMemorySave(text: string): boolean {
  return /^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\s+/i.test(String(text || "").trim());
}

function stripMemorySavePrefix(text: string): string {
  return String(text || "").trim().replace(/^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\s+/i, "").trim();
}

function isMemoryQuestion(text: string): boolean {
  return /(จำได้ไหม|จำ.*(?:อะไร|ไหม|มั้ย)|เรา(?:ชื่อ|คือ).*อะไร|ฉัน(?:ชื่อ|คือ).*อะไร|รู้ไหม.*(?:เรา|ฉัน))/i.test(String(text || ""));
}

function wakeOnlyReply(context: GroupContext): string {
  const lastContext = context.recentMessages
    .slice(-3)
    .map((line) => line.replace(/^.*?:\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(วิมล|@วิมล|ai)$/i.test(line));
  if (lastContext.length) {
    const variants = [
      "ว่าไงคะ วิมลฟังอยู่ค่ะ",
      "มาแล้วค่ะ คุยเรื่องเมื่อกี้ต่อได้เลย",
      "วิมลอยู่ค่ะ มีอะไรให้ช่วยต่อไหมคะ",
      "เรียกวิมลแล้วค่ะ ว่ามาได้เลย",
    ];
    return variants[lastContext.join("").length % variants.length];
  }
  const variants = [
    "ว่าไงคะ",
    "มาแล้วค่ะ",
    "วิมลอยู่ค่ะ ว่ามาได้เลย",
    "เรียกวิมลใช่ไหมคะ",
  ];
  return variants[new Date().getMinutes() % variants.length];
}

async function runMemoryAgent(
  text: string,
  context: GroupContext,
  target: ChatTarget,
  openaiApiKey: string,
  model: string,
  tracker: CostTracker,
): Promise<AgentResult> {
  if (isSensitiveText(text)) {
    return {
      reply: "ข้อมูลนี้ดูอ่อนไหว วิมลจะไม่บันทึกให้นะคะ",
      route: "memory",
      agent: "MemoryAgent",
      status: "blocked",
    };
  }

  const memories = await extractMemories(text, context, openaiApiKey, model, tracker);
  const usable = memories.length
    ? memories
    : [{ ownerUserId: target.userId, category: "note" as const, text, confidence: 0.7 }];

  await Promise.all(usable.map((memory) => saveMemory(target, memory)));
  return {
    reply: `วิมลจำให้แล้วค่ะ (${usable.length} รายการ)\n${usable.map((item) => `- ${item.text}`).join("\n")}`,
    route: "memory",
    agent: "MemoryAgent",
    status: "ok",
    savedMemoryCount: usable.length,
  };
}

function runMemoryShowAgent(context: GroupContext): AgentResult {
  const memories = context.speakerMemories;
  const related = context.relatedMemories;
  const groupMemories = context.groupMemories.slice(0, 8);
  if (!memories.length && !related.length && !groupMemories.length) {
    return {
      reply: "ตอนนี้วิมลยังไม่มีข้อมูลที่จำเกี่ยวกับคุณในกลุ่มนี้ค่ะ",
      route: "memory_show",
      agent: "MemoryAgent",
      status: "ok",
    };
  }
  return {
    reply:
      `ข้อมูลที่วิมลจำเกี่ยวกับคุณในกลุ่มนี้:\n${sectionLines(memories)}` +
      (related.length ? `\n\nข้อมูลของคนที่เกี่ยวข้องในบทสนทนาล่าสุด:\n${sectionLines(related)}` : "") +
      (groupMemories.length ? `\n\nบริบทกลุ่มที่เกี่ยวข้อง:\n${sectionLines(groupMemories)}` : ""),
    route: "memory_show",
    agent: "MemoryAgent",
    status: "ok",
  };
}

async function runMemoryDeleteAgent(text: string, target: ChatTarget): Promise<AgentResult> {
  const count = await deleteUserMemories(target, text || "ทั้งหมด");
  return {
    reply: count ? `ลบข้อมูลความจำของคุณแล้ว ${count} รายการค่ะ` : "ยังไม่พบข้อมูลของคุณที่ตรงกับคำขอลบค่ะ",
    route: "memory_delete",
    agent: "MemoryAgent",
    status: "ok",
  };
}

async function runSplitBillAgent(
  text: string,
  context: GroupContext,
  target: ChatTarget,
  openaiApiKey: string,
  model: string,
  tracker: CostTracker,
): Promise<AgentResult> {
  const parsed = await parseSplitExpense(text, context, openaiApiKey, model, tracker);
  const sessionId = await createSplitExpense(target, parsed);
  if (parsed.needsMoreInfo) {
    return {
      reply: parsed.question || "ขอข้อมูลเพิ่มนิดค่ะ รายการนี้จำนวนเงินเท่าไหร่ ใครจ่าย และหารใครบ้างคะ?",
      route: "split",
      agent: "SplitBillAgent",
      status: "needs_input",
      splitSessionId: sessionId,
    };
  }

  const participants = parsed.participants.length ? parsed.participants.join(", ") : "ทุกคนในกลุ่มที่รู้จัก";
  const excluded = parsed.excluded.length ? `\nไม่หาร: ${parsed.excluded.join(", ")}` : "";
  return {
    reply:
      `วิมลบันทึกร่างรายการหารให้แล้วค่ะ\n` +
      `รายการ: ${parsed.title}\n` +
      `ยอด: ${formatBaht(parsed.amount)} บาท\n` +
      `คนจ่าย: ${parsed.payerName || "ยังไม่ระบุ"}\n` +
      `หารกับ: ${participants}${excluded}\n` +
      `เปิดเว็บดู/แก้รายละเอียด: ${harnkanUrl}`,
    route: "split",
    agent: "SplitBillAgent",
    status: "ok",
    splitSessionId: sessionId,
  };
}

async function runHoroscopeAgent(text: string, context: GroupContext, openaiApiKey: string, model: string, tracker: CostTracker): Promise<AgentResult> {
  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        `${femalePersona} คุณคือ HoroscopeAgent ตอบดูดวงภาษาไทยเพื่อความบันเทิงเท่านั้น ห้ามให้คำแนะนำการเงิน สุขภาพ หรือกฎหมายแบบจริงจัง ถ้าไม่มีวันเกิดให้ดูแบบภาพรวมและชวนบอกวันเกิดได้`,
    },
    {
      role: "user",
      content: `${conversationContextSummary(context)}\n\nคำขอ: ${text}`,
    },
  ], tracker);
  return {
    reply: reply || "ดูดวงแบบสนุก ๆ วันนี้เหมาะกับการคุยให้ชัด เคลียร์ยอดให้ไว และอย่าเพิ่งรีบตัดสินใจเรื่องใหญ่นะคะ",
    route: "horoscope",
    agent: "HoroscopeAgent",
    status: "ok",
  };
}

async function runSpeechAnalysisAgent(text: string, context: GroupContext, openaiApiKey: string, model: string, tracker: CostTracker): Promise<AgentResult> {
  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        `${femalePersona} คุณคือ SpeechAnalysisAgent วิเคราะห์คำพูดโดยไม่ตัดสิน ไม่วินิจฉัยบุคลิก และไม่กล่าวหาบุคคล ตอบเป็น 3 หัวข้อ: โทนโดยรวม, จุดที่อาจเข้าใจผิด, เวอร์ชันสุภาพขึ้น`,
    },
    {
      role: "user",
      content: `${conversationContextSummary(context)}\n\nข้อความให้วิเคราะห์: ${text}`,
    },
  ], tracker);
  return {
    reply:
      reply ||
      "โทนโดยรวม: ยังวิเคราะห์ไม่ได้ชัดค่ะ\nจุดที่อาจเข้าใจผิด: ข้อความสั้นเกินไป\nเวอร์ชันสุภาพขึ้น: ลองส่งประโยคเต็มมาให้วิมลช่วยปรับได้ค่ะ",
    route: "speech",
    agent: "SpeechAnalysisAgent",
    status: "ok",
  };
}

async function saveAutoMemories(
  text: string,
  context: GroupContext,
  target: ChatTarget,
  openaiApiKey: string,
  model: string,
  tracker: CostTracker,
): Promise<void> {
  if (!text || isSensitiveText(text)) return;
  const memories = await extractMemories(text, context, openaiApiKey, model, tracker);
  const strongMemories = memories.filter((memory) => memory.confidence >= 0.72);
  if (!strongMemories.length) return;
  await Promise.all(strongMemories.slice(0, 3).map((memory) => saveMemory(target, memory)));
}

async function extractMemories(
  text: string,
  context: GroupContext,
  openaiApiKey: string,
  model: string,
  tracker: CostTracker,
): Promise<Array<Omit<MemberMemory, "id" | "createdAt">>> {
  if (!openaiApiKey || !text.trim()) return [];
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      memories: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            subjectName: { type: "string" },
            category: { type: "string", enum: ["profile", "food", "birthday", "preference", "split", "note"] },
            text: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["subjectName", "category", "text", "confidence"],
        },
      },
    },
    required: ["memories"],
  };

  const result = await createJsonCompletion<MemoryExtraction>(openaiApiKey, model, schema, [
    {
      role: "system",
      content:
        "คุณคือ MemoryAgent สกัดเฉพาะข้อมูลที่ควรจำแยกตามบุคคลในกลุ่ม LINE โดยใส่ subjectName ให้ตรงกับเจ้าของข้อมูลเสมอ หมวด profile ใช้กับชื่อเล่น/บทบาท/ลักษณะทั่วไป, food ใช้กับอาหารที่ชอบหรือไม่กิน, birthday ใช้กับวันเกิด/ราศี, preference ใช้กับความชอบ/นิสัย/สไตล์การคุย, split ใช้กับเงื่อนไขหารเงิน ห้ามสกัดรหัสผ่าน token secret เลขบัตร เลขบัญชี หรือข้อมูลสุขภาพละเอียด ถ้าไม่มีข้อมูลที่ควรจำให้ memories เป็น []",
    },
    {
      role: "user",
      content: `${conversationContextSummary(context)}\n\nสมาชิกที่รู้จัก: ${context.members.map((member) => member.displayName).join(", ")}\nข้อความ: ${text}`,
    },
  ], tracker);

  return (result?.memories || [])
    .filter((memory) => memory.text && !isSensitiveText(memory.text))
    .map((memory) => ({
      ownerUserId: userIdForExtractedSubject(memory.subjectName, context),
      category: memory.category,
      text: memory.text.slice(0, 240),
      confidence: clamp(Number(memory.confidence), 0, 1),
    }))
    .filter((memory) => memory.ownerUserId);
}

async function parseSplitExpense(
  text: string,
  context: GroupContext,
  openaiApiKey: string,
  model: string,
  tracker: CostTracker,
): Promise<ParsedSplitExpense> {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      amount: { type: "number" },
      payerName: { type: "string" },
      participants: { type: "array", items: { type: "string" } },
      excluded: { type: "array", items: { type: "string" } },
      notes: { type: "array", items: { type: "string" } },
      needsMoreInfo: { type: "boolean" },
      question: { type: "string" },
    },
    required: ["title", "amount", "payerName", "participants", "excluded", "notes", "needsMoreInfo", "question"],
  };

  const result = await createJsonCompletion<ParsedSplitExpense>(openaiApiKey, model, schema, [
    {
      role: "system",
      content:
        "คุณคือ SplitBillAgent แปลงข้อความหารค่าอาหารเป็น JSON ถ้าขาดยอดเงิน คนจ่าย หรือคนร่วมหาร ให้ needsMoreInfo=true และถามกลับสั้น ๆ ใช้ชื่อสมาชิกจากบริบทถ้าเจอ ห้ามเดาข้อมูลสำคัญ",
    },
    {
      role: "user",
      content: `${conversationContextSummary(context)}\n\nสมาชิกที่รู้จัก: ${context.members.map((member) => member.displayName).join(", ")}\nข้อความ: ${text}`,
    },
  ], tracker);

  return {
    title: result?.title || "ค่าใช้จ่าย",
    amount: Math.max(0, Number(result?.amount || 0)),
    payerName: result?.payerName || "",
    participants: Array.isArray(result?.participants) ? result.participants.filter(Boolean).slice(0, 30) : [],
    excluded: Array.isArray(result?.excluded) ? result.excluded.filter(Boolean).slice(0, 30) : [],
    notes: Array.isArray(result?.notes) ? result.notes.filter(Boolean).slice(0, 10) : [],
    needsMoreInfo: Boolean(result?.needsMoreInfo || !result?.amount || !result?.payerName),
    question: result?.question || "",
  };
}

async function createTextCompletion(openaiApiKey: string, model: string, messages: OpenAiMessage[], tracker: CostTracker): Promise<string> {
  if (!openaiApiKey) return "";
  const body = chatCompletionBody(model, messages, { temperature: 0.4, tokenLimit: 650 });
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OPENAI_TEXT_${response.status}: ${await safeOpenAiError(response)}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: OpenAiUsage };
  recordUsage(tracker, data.usage);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function createJsonCompletion<T>(openaiApiKey: string, model: string, schema: Record<string, unknown>, messages: OpenAiMessage[], tracker: CostTracker): Promise<T | null> {
  if (!openaiApiKey) return null;
  const body = chatCompletionBody(model, messages, {
    temperature: 0.1,
    tokenLimit: 700,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "harnkan_structured_output",
        strict: true,
        schema,
      },
    },
  });
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OPENAI_JSON_${response.status}: ${await safeOpenAiError(response)}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }>; usage?: OpenAiUsage };
  recordUsage(tracker, data.usage);
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as T;
}

function safetyReview(reply: string): string {
  const clean = reply
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/(channel\s*(secret|access token)|api\s*key)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .trim();
  return feminizeReply(clean).slice(0, 4800) || "ขอโทษค่ะ วิมลยังตอบเรื่องนี้ไม่ได้";
}

function feminizeReply(text: string): string {
  return text
    .replace(/นะครับ/g, "นะคะ")
    .replace(/ครับผม/g, "ค่ะ")
    .replace(/ครับ/g, "ค่ะ")
    .replace(/\bผม\b/g, "วิมล")
    .replace(/(^|\s)ผม/g, "$1วิมล");
}

function chatCompletionBody(
  model: string,
  messages: OpenAiMessage[],
  options: { temperature: number; tokenLimit: number; responseFormat?: Record<string, unknown> },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    temperature: options.temperature,
    messages,
  };
  body[usesMaxCompletionTokens(model) ? "max_completion_tokens" : "max_tokens"] = options.tokenLimit;
  if (options.responseFormat) body.response_format = options.responseFormat;
  return body;
}

function usesMaxCompletionTokens(model: string): boolean {
  return /^gpt-5/i.test(model);
}

async function safeOpenAiError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]").slice(0, 240);
  } catch {
    return "";
  }
}

function isSensitiveText(text: string): boolean {
  return /(รหัสผ่าน|password|api\s*key|token|secret|channel\s*secret|access\s*token|เลขบัตร|บัตรประชาชน|เลขบัญชี|account\s*number|sk-[A-Za-z0-9_-]+)/i.test(text);
}

function userIdForName(name: string, context: GroupContext): string {
  const clean = name.trim().toLowerCase();
  if (!clean) return context.currentUser.userId;
  return context.members.find((member) => member.displayName.toLowerCase() === clean)?.userId || "";
}

function userIdForExtractedSubject(name: string, context: GroupContext): string {
  const clean = String(name || "").trim();
  if (!clean || /^(ฉัน|เรา|ผม|หนู|กู|me|myself)$/i.test(clean)) return context.currentUser.userId;
  return userIdForName(clean, context);
}

function shouldExtractAutoMemory(text: string): boolean {
  return /(จำว่า|จำไว้|ชื่อ|เรียกว่า|เกิด|วันเกิด|ชอบ|ไม่ชอบ|ไม่กิน|แพ้|แฟน|ทำงาน|อยู่ที่|นิสัย|สไตล์|ไม่ต้องหาร|ออกค่า|รับผิดชอบ|มาแค่|มาช้า|กลับก่อน|ช่วงหลัง|ช่วงแรก)/i.test(String(text || ""));
}

function memoryListSummary(memories: MemberMemory[]): string {
  const rows = memories.slice(0, 12).map((memory) => `- ${memory.text}`);
  return rows.join("\n") || "- ไม่มี";
}

function conversationContextSummary(context: GroupContext, fallbackRecentMessages: string[] = []): string {
  const recentMessages = (context.recentMessages.length ? context.recentMessages : fallbackRecentMessages).slice(-20);
  const relatedNames = context.relatedMembers.map((member) => member.displayName).join(", ") || "- ไม่มี";
  return [
    `ผู้พูดหลัก: ${context.currentUser.displayName}`,
    `โปรไฟล์ผู้พูด:\n${profileSummaryLines(context.currentUser.profileSummary)}`,
    `ข้อความโฟกัส: ${context.focusText || "-"}`,
    `บริบทย้อนหลังล่าสุด:\n${messageListSummary(recentMessages)}`,
    `Memory รายบุคคลของผู้พูด:\n${memoryListSummary(context.speakerMemories)}`,
    `คนที่เกี่ยวข้องในบทสนทนานี้: ${relatedNames}`,
    `โปรไฟล์คนที่เกี่ยวข้อง:\n${context.relatedMembers.length ? context.relatedMembers.map((member) => `${member.displayName}: ${profileSummaryLines(member.profileSummary)}`).join("\n") : "- ไม่มี"}`,
    `Memory รายบุคคลของคนที่เกี่ยวข้อง:\n${memoryListSummary(context.relatedMemories)}`,
    `Memory กลุ่ม:\n${memoryListSummary(context.groupMemories)}`,
  ].join("\n\n");
}

function profileSummaryLines(profileSummary: Record<string, string> | undefined): string {
  const entries = Object.entries(profileSummary || {}).filter(([, value]) => value);
  if (!entries.length) return "- ไม่มี";
  const labels: Record<string, string> = {
    profile: "โปรไฟล์",
    food: "อาหาร/ข้อจำกัด",
    birthday: "วันเกิด",
    preference: "ความชอบ",
    split: "หารเงิน",
    note: "โน้ต",
  };
  return entries.map(([key, value]) => `- ${labels[key] || key}: ${value}`).join("\n");
}

function messageListSummary(messages: string[]): string {
  if (!messages.length) return "- ไม่มี";
  return messages.map((message, index) => `${index + 1}. ${message}`).join("\n");
}

function sectionLines(memories: MemberMemory[]): string {
  return memories.map((memory) => `- ${memory.text}`).join("\n");
}

function normalizePersonalityMode(value: unknown): PersonalityMode {
  const allowed: PersonalityMode[] = ["comedian", "reporter", "fortune_teller", "judge", "sports_commentator", "neutral"];
  return allowed.includes(value as PersonalityMode) ? (value as PersonalityMode) : "neutral";
}

function normalizeReplyIntent(value: unknown): ReplyIntent {
  const allowed: ReplyIntent[] = ["joke", "comfort", "opinion", "summary", "question", "none"];
  return allowed.includes(value as ReplyIntent) ? (value as ReplyIntent) : "none";
}

function normalizeDynamicTasks(value: unknown): string[] {
  const allowed = new Set(["chat", "memory", "split", "horoscope", "speech", "summary"]);
  const rows = Array.isArray(value) ? value : [];
  const normalized = rows.map((item) => String(item || "").trim()).filter((item) => allowed.has(item));
  return normalized.length ? [...new Set(normalized)].slice(0, 5) : ["chat"];
}

function normalizeExtractedMemories(
  value: unknown,
  context: GroupContext,
): Array<Omit<MemberMemory, "id" | "createdAt">> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((memory) => memory && typeof memory === "object")
    .map((memory) => {
      const item = memory as { subjectName?: unknown; category?: unknown; text?: unknown; confidence?: unknown };
      const text = String(item.text || "").trim();
      return {
        ownerUserId: userIdForExtractedSubject(String(item.subjectName || ""), context),
        category: normalizeMemoryCategory(item.category),
        text: text.slice(0, 240),
        confidence: clamp(Number(item.confidence || 0), 0, 1),
      };
    })
    .filter((memory) => memory.ownerUserId && memory.text && memory.confidence >= 0.72 && !isSensitiveText(memory.text))
    .slice(0, 3);
}

function normalizeMemoryCategory(value: unknown): MemberMemory["category"] {
  const allowed: MemberMemory["category"][] = ["profile", "food", "birthday", "preference", "split", "note"];
  return allowed.includes(value as MemberMemory["category"]) ? (value as MemberMemory["category"]) : "note";
}

function personalityModeInstruction(mode: PersonalityMode): string {
  const instructions: Record<PersonalityMode, string> = {
    comedian: "แซวขำ ๆ แบบเพื่อน กวนได้แต่ไม่แรง",
    reporter: "เล่าเหมือนรายงานข่าวสั้น ๆ ขำ ๆ",
    fortune_teller: "เล่นเป็นหมอดูสายบันเทิง ห้ามจริงจังเรื่องเงิน สุขภาพ หรือกฎหมาย",
    judge: "เล่นเป็นกรรมการตัดสินแบบขำ ๆ ไม่กล่าวหาใครจริง",
    sports_commentator: "พากย์เหมือนกีฬา สนุกและกระชับ",
    neutral: "ตอบเป็นเพื่อนธรรมชาติ ไม่ต้องเล่นบทชัด",
  };
  return instructions[mode];
}

function replyIntentInstruction(intent: ReplyIntent): string {
  const instructions: Record<ReplyIntent, string> = {
    joke: "ต่อมุกให้สั้นและปลอดภัย",
    comfort: "ปลอบหรือซัพพอร์ตแบบเพื่อน",
    opinion: "ให้ความเห็นสุภาพ ไม่ฟันธงเกินไป",
    summary: "สรุปสั้น ๆ ให้กลุ่มเข้าใจง่าย",
    question: "ถามกลับสั้น ๆ เพื่อให้คุยต่อ",
    none: "ถ้าจำเป็นต้องตอบ ให้ตอบกลาง ๆ และสั้นมาก",
  };
  return instructions[intent];
}

function formatBaht(amount: number): string {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

function recordUsage(tracker: CostTracker, usage: OpenAiUsage | undefined): void {
  tracker.openAiCalls += 1;
  tracker.inputTokens += Number(usage?.prompt_tokens || 0);
  tracker.outputTokens += Number(usage?.completion_tokens || 0);
}

function usageFromTracker(tracker: CostTracker): TokenUsage {
  return {
    model: tracker.model,
    inputTokens: tracker.inputTokens,
    outputTokens: tracker.outputTokens,
    totalTokens: tracker.inputTokens + tracker.outputTokens,
    openAiCalls: tracker.openAiCalls,
  };
}

function estimateCost(usage: TokenUsage): CostEstimate {
  const rates = ratesForModel(usage.model);
  const estimatedUsd =
    (usage.inputTokens / 1_000_000) * rates.inputUsdPerMillion +
    (usage.outputTokens / 1_000_000) * rates.outputUsdPerMillion;
  return {
    model: usage.model,
    inputUsdPerMillion: rates.inputUsdPerMillion,
    outputUsdPerMillion: rates.outputUsdPerMillion,
    usdToThb: defaultUsdToThb,
    estimatedUsd,
    estimatedThb: estimatedUsd * defaultUsdToThb,
  };
}

function ratesForModel(model: string): { inputUsdPerMillion: number; outputUsdPerMillion: number } {
  const normalized = model.toLowerCase();
  const option = aiModelOptions.find((item) => item.value.toLowerCase() === normalized);
  if (option) return { inputUsdPerMillion: option.inputUsdPerMillion, outputUsdPerMillion: option.outputUsdPerMillion };
  if (normalized.includes("gpt-4o-mini")) return { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 };
  if (normalized.includes("gpt-4.1-nano")) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.includes("gpt-4.1-mini")) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.includes("gpt-5.4-mini")) return { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 };
  return { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 };
}
