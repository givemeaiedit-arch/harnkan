import type { AgentResult, AiModelOption, ChatTarget, CostEstimate, GroupContext, MemberMemory, ParsedCommand, ParsedSplitExpense, SilentMemoryResult, TokenUsage } from "./types";
import { createSplitExpense, deleteUserMemories, saveMemory } from "./repository";

const botWakeWord = "วิมล";
const harnkanUrl = "https://harnkan-givemeai-gpt-hub.web.app";
const defaultUsdToThb = Number(process.env.USD_TO_THB_RATE || 32.9);
const femalePersona =
  "คุณคือวิมล ผู้ช่วย AI ผู้หญิงในกลุ่ม LINE พูดภาษาไทยแบบผู้หญิง ใช้คำลงท้ายค่ะ/นะคะ แทนตัวเองว่าวิมล ห้ามใช้คำว่า ผม หรือ ครับ น้ำเสียงสุภาพ อบอุ่น เป็นกันเอง ขี้เล่นเล็กน้อย และตอบให้เป็นธรรมชาติ";

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

export function parseCommand(rawText: string): ParsedCommand {
  const text = rawText.trim();
  const wakeIndex = text.indexOf(botWakeWord);
  if (wakeIndex < 0) return { invoked: false, route: "general", text, rawPrefix: "" };

  const body = `${text.slice(0, wakeIndex)} ${text.slice(wakeIndex + botWakeWord.length)}`.replace(/\s+/g, " ").trim();
  if (/^(ดูดวง|ดวง|ราศี)\b/i.test(body)) {
    return { invoked: true, route: "horoscope", text: body || "ดูดวง", rawPrefix: botWakeWord };
  }
  if (/(?:หาร|ค่าอาหาร|ค่าเบียร์|จ่าย|โอน|บาท|\d)/i.test(body)) {
    return { invoked: true, route: "split", text: body || "หารค่าใช้จ่าย", rawPrefix: botWakeWord };
  }
  if (/(?:วิเคราะห์|ปรับคำพูด|โทน|สุภาพ|แรงไปไหม)/i.test(body)) {
    return { invoked: true, route: "speech", text: body || "วิเคราะห์คำพูด", rawPrefix: botWakeWord };
  }
  if (/^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\b/i.test(body)) {
    return { invoked: true, route: "memory", text: body.replace(/^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\s*/i, ""), rawPrefix: botWakeWord };
  }
  if (/^(ลืม|ล้างข้อมูล|ลบข้อมูล)\b/i.test(body)) {
    return { invoked: true, route: "memory_delete", text: body.replace(/^(ลืม|ล้างข้อมูล|ลบข้อมูล)\s*/i, ""), rawPrefix: botWakeWord };
  }
  if (/^(ข้อมูลของฉัน|จำอะไรเกี่ยวกับฉัน|profile|memory)\b/i.test(body)) {
    return { invoked: true, route: "memory_show", text: body, rawPrefix: botWakeWord };
  }
  return { invoked: true, route: "general", text: body || "ช่วยอะไรได้บ้าง", rawPrefix: botWakeWord };
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
    if (command.route === "memory") {
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

    if (!["memory", "memory_show", "memory_delete"].includes(command.route)) {
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

async function runGeneralChatAgent(text: string, context: GroupContext, openaiApiKey: string, model: string, tracker: CostTracker): Promise<AgentResult> {
  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        `${femalePersona} ตอบสั้น ชัดเจน ถ้างานเกี่ยวกับหารเงิน ดูดวง วิเคราะห์คำพูด หรือความจำ ให้ช่วยต่อจากข้อความธรรมชาติได้ ไม่ต้องบังคับใช้คำสั่ง slash`,
    },
    {
      role: "user",
      content: `ผู้พูด: ${context.currentUser.displayName}\nความจำที่เกี่ยวข้อง:\n${memorySummary(context)}\n\nข้อความ: ${text}`,
    },
  ], tracker);

  return {
    reply: reply || "เรียกวิมลด้วยคำว่า “วิมล” แล้วพิมพ์เรื่องที่อยากให้ช่วยได้เลยค่ะ",
    route: "general",
    agent: "GeneralChatAgent",
    status: "ok",
  };
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
  const memories = context.currentUser.memories;
  if (!memories.length) {
    return {
      reply: "ตอนนี้วิมลยังไม่มีข้อมูลที่จำเกี่ยวกับคุณในกลุ่มนี้ค่ะ",
      route: "memory_show",
      agent: "MemoryAgent",
      status: "ok",
    };
  }
  return {
    reply: `ข้อมูลที่วิมลจำเกี่ยวกับคุณในกลุ่มนี้:\n${memories.map((memory) => `- ${memory.text}`).join("\n")}`,
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
      content: `ผู้พูด: ${context.currentUser.displayName}\nความจำ:\n${memorySummary(context)}\n\nคำขอ: ${text}`,
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
      content: `ผู้พูด: ${context.currentUser.displayName}\nข้อความให้วิเคราะห์: ${text}`,
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

export async function rememberSilentlyFromMessage(input: {
  text: string;
  context: GroupContext;
  target: ChatTarget;
  openaiApiKey: string;
  model: string;
}): Promise<SilentMemoryResult> {
  const tracker: CostTracker = { model: input.model, inputTokens: 0, outputTokens: 0, openAiCalls: 0 };
  if (!input.text.trim()) {
    const usage = usageFromTracker(tracker);
    return { status: "skipped", savedMemoryCount: 0, usage, cost: estimateCost(usage) };
  }
  if (isSensitiveText(input.text)) {
    const usage = usageFromTracker(tracker);
    return { status: "skipped_sensitive", savedMemoryCount: 0, usage, cost: estimateCost(usage) };
  }
  const memories = await extractMemories(input.text, input.context, input.openaiApiKey, input.model, tracker);
  const strongMemories = memories.filter((memory) => memory.confidence >= 0.82).slice(0, 2);
  if (strongMemories.length) {
    await Promise.all(strongMemories.map((memory) => saveMemory(input.target, memory)));
  }
  const usage = usageFromTracker(tracker);
  return {
    status: strongMemories.length ? "saved" : "scanned",
    savedMemoryCount: strongMemories.length,
    usage,
    cost: estimateCost(usage),
  };
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
        "คุณคือ MemoryAgent สกัดเฉพาะข้อมูลที่ควรจำในกลุ่ม LINE เช่น ชื่อเล่น อาหารที่ไม่กิน วันเกิด ความชอบ เลขสำคัญที่ผู้ใช้บอกเอง หรือเงื่อนไขหารเงิน ห้ามสกัดรหัสผ่าน token secret เลขบัตร เลขบัญชี หรือข้อมูลสุขภาพละเอียด ถ้าไม่มีข้อมูลที่ควรจำให้ memories เป็น []",
    },
    {
      role: "user",
      content: `สมาชิกที่รู้จัก: ${context.members.map((member) => member.displayName).join(", ")}\nผู้พูด: ${context.currentUser.displayName}\nข้อความ: ${text}`,
    },
  ], tracker);

  return (result?.memories || [])
    .filter((memory) => memory.text && !isSensitiveText(memory.text))
    .map((memory) => ({
      ownerUserId: userIdForName(memory.subjectName, context) || context.currentUser.userId,
      category: memory.category,
      text: memory.text.slice(0, 240),
      confidence: clamp(Number(memory.confidence), 0, 1),
    }));
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
      content: `สมาชิกที่รู้จัก: ${context.members.map((member) => member.displayName).join(", ")}\nข้อความ: ${text}`,
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

function memorySummary(context: GroupContext): string {
  const memories = context.recentMemories.slice(0, 12).map((memory) => `- ${memory.text}`);
  return memories.join("\n") || "- ยังไม่มีความจำในกลุ่มนี้";
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
  if (normalized.includes("gpt-4.1-mini")) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.includes("gpt-5.4-mini")) return { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 };
  return { inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6 };
}
