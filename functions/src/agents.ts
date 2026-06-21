import type { AgentResult, ChatTarget, GroupContext, MemberMemory, ParsedCommand, ParsedSplitExpense } from "./types";
import { createSplitExpense, deleteUserMemories, saveMemory } from "./repository";

const invocationPrefixes = ["@หารกัน", "/ai", "/ดูดวง", "/หาร", "/วิเคราะห์", "/จำ", "/ลืม"];
const harnkanUrl = "https://harnkan-givemeai-gpt-hub.web.app";

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

export function parseCommand(rawText: string): ParsedCommand {
  const text = rawText.trim();
  const matched = invocationPrefixes.find((prefix) => text === prefix || text.startsWith(`${prefix} `));
  if (!matched) return { invoked: false, route: "general", text, rawPrefix: "" };

  const body = text.slice(matched.length).trim();
  if (matched === "/ดูดวง" || /^(ดูดวง|ดวง|ราศี)\b/i.test(body)) {
    return { invoked: true, route: "horoscope", text: body || "ดูดวง", rawPrefix: matched };
  }
  if (matched === "/หาร" || /(?:หาร|ค่าอาหาร|ค่าเบียร์|จ่าย|โอน|บาท|\d)/i.test(body)) {
    return { invoked: true, route: "split", text: body || "หารค่าใช้จ่าย", rawPrefix: matched };
  }
  if (matched === "/วิเคราะห์" || /(?:วิเคราะห์|ปรับคำพูด|โทน|สุภาพ|แรงไปไหม)/i.test(body)) {
    return { invoked: true, route: "speech", text: body || "วิเคราะห์คำพูด", rawPrefix: matched };
  }
  if (matched === "/จำ" || /^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\b/i.test(body)) {
    return { invoked: true, route: "memory", text: body.replace(/^(จำว่า|จำไว้ว่า|บันทึกว่า|remember)\s*/i, ""), rawPrefix: matched };
  }
  if (matched === "/ลืม" || /^(ลืม|ล้างข้อมูล|ลบข้อมูล)\b/i.test(body)) {
    return { invoked: true, route: "memory_delete", text: body.replace(/^(ลืม|ล้างข้อมูล|ลบข้อมูล)\s*/i, ""), rawPrefix: matched };
  }
  if (/^(ข้อมูลของฉัน|จำอะไรเกี่ยวกับฉัน|profile|memory)\b/i.test(body)) {
    return { invoked: true, route: "memory_show", text: body, rawPrefix: matched };
  }
  return { invoked: true, route: "general", text: body || "ช่วยอะไรได้บ้าง", rawPrefix: matched };
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

  try {
    let result: AgentResult;
    if (command.route === "memory") {
      result = await runMemoryAgent(command.text, context, target, openaiApiKey, model);
    } else if (command.route === "memory_show") {
      result = runMemoryShowAgent(context);
    } else if (command.route === "memory_delete") {
      result = await runMemoryDeleteAgent(command.text, target);
    } else if (command.route === "split") {
      result = await runSplitBillAgent(command.text, context, target, openaiApiKey, model);
    } else if (command.route === "horoscope") {
      result = await runHoroscopeAgent(command.text, context, openaiApiKey, model);
    } else if (command.route === "speech") {
      result = await runSpeechAnalysisAgent(command.text, context, openaiApiKey, model);
    } else {
      result = await runGeneralChatAgent(command.text, context, openaiApiKey, model);
    }

    if (!["memory", "memory_show", "memory_delete"].includes(command.route)) {
      await saveAutoMemories(command.text, context, target, openaiApiKey, model);
    }
    return { ...result, reply: safetyReview(result.reply) };
  } catch (error) {
    console.error("Agent workflow failed", {
      route: command.route,
      elapsedMs: Date.now() - started,
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return {
      reply: "ขอโทษครับ ตอนนี้ระบบ AI มีปัญหาชั่วคราว ลองพิมพ์ใหม่อีกครั้งได้เลยครับ",
      route: command.route,
      agent: "SafetyReviewAgent",
      status: "error",
    };
  }
}

async function runGeneralChatAgent(text: string, context: GroupContext, openaiApiKey: string, model: string): Promise<AgentResult> {
  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        "คุณคือ GeneralChatAgent ของบอทหารกันใน LINE Group ตอบภาษาไทยสั้น ชัดเจน เป็นกันเอง ถ้างานควรใช้คำสั่งเฉพาะ ให้แนะนำคำสั่งที่ถูกต้อง เช่น /หาร /ดูดวง /วิเคราะห์ /จำ",
    },
    {
      role: "user",
      content: `ผู้พูด: ${context.currentUser.displayName}\nความจำที่เกี่ยวข้อง:\n${memorySummary(context)}\n\nข้อความ: ${text}`,
    },
  ]);

  return {
    reply: reply || "เรียกผมด้วย /หาร /ดูดวง /วิเคราะห์ หรือ /จำ ได้เลยครับ",
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
): Promise<AgentResult> {
  if (isSensitiveText(text)) {
    return {
      reply: "ข้อมูลนี้ดูอ่อนไหว ผมจะไม่บันทึกให้นะครับ",
      route: "memory",
      agent: "MemoryAgent",
      status: "blocked",
    };
  }

  const memories = await extractMemories(text, context, openaiApiKey, model);
  const usable = memories.length
    ? memories
    : [{ ownerUserId: target.userId, category: "note" as const, text, confidence: 0.7 }];

  await Promise.all(usable.map((memory) => saveMemory(target, memory)));
  return {
    reply: `จำให้แล้วครับ (${usable.length} รายการ)\n${usable.map((item) => `- ${item.text}`).join("\n")}`,
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
      reply: "ตอนนี้ผมยังไม่มีข้อมูลที่จำเกี่ยวกับคุณในกลุ่มนี้ครับ",
      route: "memory_show",
      agent: "MemoryAgent",
      status: "ok",
    };
  }
  return {
    reply: `ข้อมูลที่ผมจำเกี่ยวกับคุณในกลุ่มนี้:\n${memories.map((memory) => `- ${memory.text}`).join("\n")}`,
    route: "memory_show",
    agent: "MemoryAgent",
    status: "ok",
  };
}

async function runMemoryDeleteAgent(text: string, target: ChatTarget): Promise<AgentResult> {
  const count = await deleteUserMemories(target, text || "ทั้งหมด");
  return {
    reply: count ? `ลบข้อมูลความจำของคุณแล้ว ${count} รายการครับ` : "ยังไม่พบข้อมูลของคุณที่ตรงกับคำขอลบครับ",
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
): Promise<AgentResult> {
  const parsed = await parseSplitExpense(text, context, openaiApiKey, model);
  const sessionId = await createSplitExpense(target, parsed);
  if (parsed.needsMoreInfo) {
    return {
      reply: parsed.question || "ขอข้อมูลเพิ่มนิดครับ รายการนี้จำนวนเงินเท่าไหร่ ใครจ่าย และหารใครบ้าง?",
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
      `บันทึกร่างรายการหารแล้วครับ\n` +
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

async function runHoroscopeAgent(text: string, context: GroupContext, openaiApiKey: string, model: string): Promise<AgentResult> {
  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        "คุณคือ HoroscopeAgent ตอบดูดวงภาษาไทยเพื่อความบันเทิงเท่านั้น ห้ามให้คำแนะนำการเงิน สุขภาพ หรือกฎหมายแบบจริงจัง ถ้าไม่มีวันเกิดให้ดูแบบภาพรวมและชวนบอกวันเกิดได้",
    },
    {
      role: "user",
      content: `ผู้พูด: ${context.currentUser.displayName}\nความจำ:\n${memorySummary(context)}\n\nคำขอ: ${text}`,
    },
  ]);
  return {
    reply: reply || "ดูดวงแบบสนุก ๆ วันนี้เหมาะกับการคุยให้ชัด เคลียร์ยอดให้ไว และอย่าเพิ่งรีบตัดสินใจเรื่องใหญ่ครับ",
    route: "horoscope",
    agent: "HoroscopeAgent",
    status: "ok",
  };
}

async function runSpeechAnalysisAgent(text: string, context: GroupContext, openaiApiKey: string, model: string): Promise<AgentResult> {
  const reply = await createTextCompletion(openaiApiKey, model, [
    {
      role: "system",
      content:
        "คุณคือ SpeechAnalysisAgent วิเคราะห์คำพูดโดยไม่ตัดสิน ไม่วินิจฉัยบุคลิก และไม่กล่าวหาบุคคล ตอบเป็น 3 หัวข้อ: โทนโดยรวม, จุดที่อาจเข้าใจผิด, เวอร์ชันสุภาพขึ้น",
    },
    {
      role: "user",
      content: `ผู้พูด: ${context.currentUser.displayName}\nข้อความให้วิเคราะห์: ${text}`,
    },
  ]);
  return {
    reply:
      reply ||
      "โทนโดยรวม: ยังวิเคราะห์ไม่ได้ชัดครับ\nจุดที่อาจเข้าใจผิด: ข้อความสั้นเกินไป\nเวอร์ชันสุภาพขึ้น: ลองส่งประโยคเต็มมาให้ผมช่วยปรับได้ครับ",
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
): Promise<void> {
  if (!text || isSensitiveText(text)) return;
  const memories = await extractMemories(text, context, openaiApiKey, model);
  const strongMemories = memories.filter((memory) => memory.confidence >= 0.72);
  if (!strongMemories.length) return;
  await Promise.all(strongMemories.slice(0, 3).map((memory) => saveMemory(target, memory)));
}

async function extractMemories(
  text: string,
  context: GroupContext,
  openaiApiKey: string,
  model: string,
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
        "คุณคือ MemoryAgent สกัดเฉพาะข้อมูลที่ควรจำในกลุ่ม LINE เช่น ชื่อเล่น อาหารที่ไม่กิน วันเกิด ความชอบ หรือเงื่อนไขหารเงิน ห้ามสกัดรหัสผ่าน token secret เลขบัตร เลขบัญชี หรือข้อมูลสุขภาพละเอียด ถ้าไม่มีข้อมูลที่ควรจำให้ memories เป็น []",
    },
    {
      role: "user",
      content: `สมาชิกที่รู้จัก: ${context.members.map((member) => member.displayName).join(", ")}\nผู้พูด: ${context.currentUser.displayName}\nข้อความ: ${text}`,
    },
  ]);

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
  ]);

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

async function createTextCompletion(openaiApiKey: string, model: string, messages: OpenAiMessage[]): Promise<string> {
  if (!openaiApiKey) return "";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      max_tokens: 650,
      messages,
    }),
  });
  if (!response.ok) throw new Error(`OPENAI_TEXT_${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function createJsonCompletion<T>(openaiApiKey: string, model: string, schema: Record<string, unknown>, messages: OpenAiMessage[]): Promise<T | null> {
  if (!openaiApiKey) return null;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiApiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 700,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "harnkan_structured_output",
          strict: true,
          schema,
        },
      },
      messages,
    }),
  });
  if (!response.ok) throw new Error(`OPENAI_JSON_${response.status}`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as T;
}

function safetyReview(reply: string): string {
  const clean = reply
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]")
    .replace(/(channel\s*(secret|access token)|api\s*key)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .trim();
  return clean.slice(0, 4800) || "ขอโทษครับ ผมยังตอบเรื่องนี้ไม่ได้";
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
