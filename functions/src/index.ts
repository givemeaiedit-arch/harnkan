import { createHmac, timingSafeEqual } from "node:crypto";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret, defineString } from "firebase-functions/params";
import OpenAI from "openai";

const lineChannelSecret = defineSecret("LINE_CHANNEL_SECRET");
const lineChannelAccessToken = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");
const openaiApiKey = defineSecret("OPENAI_API_KEY");
const openaiModel = defineString("OPENAI_MODEL", { default: "gpt-4o-mini" });

const lineReplyUrl = "https://api.line.me/v2/bot/message/reply";

type LineWebhookBody = {
  destination?: string;
  events?: LineEvent[];
};

type LineEvent = {
  type?: string;
  replyToken?: string;
  source?: {
    type?: string;
    userId?: string;
    groupId?: string;
    roomId?: string;
  };
  message?: {
    type?: string;
    text?: string;
  };
};

function verifyLineSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", lineChannelSecret.value())
    .update(rawBody)
    .digest("base64");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fallbackReply(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (["สรุป", "ยอด", "summary"].includes(normalized)) {
    return "เปิดเว็บหารกันเพื่อดูสรุปยอดล่าสุด หรือส่งลิงก์สรุปจากหน้าเว็บเข้ากลุ่มได้เลยครับ";
  }
  if (["help", "ช่วยเหลือ"].includes(normalized)) {
    return "พิมพ์คำถามเกี่ยวกับการหารเงิน ทริป หรือยอดโอนมาได้เลยครับ";
  }
  return `รับข้อความแล้วครับ: ${text}`;
}

async function buildAiReply(text: string): Promise<string> {
  const client = new OpenAI({ apiKey: openaiApiKey.value() });
  const response = await client.chat.completions.create({
    model: openaiModel.value(),
    temperature: 0.4,
    max_tokens: 500,
    messages: [
      {
        role: "system",
        content:
          "คุณคือผู้ช่วยของเว็บหารกัน ตอบภาษาไทยแบบสั้น ชัดเจน เป็นกันเอง ช่วยอธิบายการหารเงิน ยอดโอน ทริป ค่าใช้จ่าย และวิธีใช้เว็บ หากข้อมูลไม่พอให้ถามกลับสั้น ๆ",
      },
      {
        role: "user",
        content: text,
      },
    ],
  });
  const answer = response.choices[0]?.message?.content?.trim();
  return answer || fallbackReply(text);
}

async function replyToLine(replyToken: string, text: string): Promise<Response> {
  return fetch(lineReplyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineChannelAccessToken.value()}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
}

async function handleTextMessage(event: LineEvent): Promise<{ ok: boolean; status?: number; error?: string }> {
  const replyToken = event.replyToken;
  const text = event.message?.text?.trim();
  if (!replyToken || !text || event.message?.type !== "text") return { ok: true };

  let replyText = fallbackReply(text);
  try {
    replyText = await buildAiReply(text);
  } catch (error) {
    console.error("OpenAI reply failed", error);
  }

  const response = await replyToLine(replyToken, replyText);
  if (response.ok) return { ok: true, status: response.status };
  const errorText = await response.text();
  return { ok: false, status: response.status, error: errorText.slice(0, 300) };
}

export const lineWebhook = onRequest(
  {
    region: "asia-southeast1",
    secrets: [lineChannelSecret, lineChannelAccessToken, openaiApiKey],
    timeoutSeconds: 30,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body ?? {}));
    const signature = req.get("x-line-signature");
    if (!verifyLineSignature(rawBody, signature)) {
      res.status(401).json({ ok: false, error: "Invalid LINE signature" });
      return;
    }

    const body = req.body as LineWebhookBody;
    const events = Array.isArray(body.events) ? body.events : [];
    const replies = await Promise.all(events.map((event) => handleTextMessage(event)));
    res.status(200).json({ ok: true, eventCount: events.length, replies });
  },
);

export const lineConfig = onRequest(
  {
    region: "asia-southeast1",
    secrets: [lineChannelSecret, lineChannelAccessToken, openaiApiKey],
  },
  (_req, res) => {
    res.status(200).json({
      ok: true,
      webhookPath: "/line/webhook",
      channelSecretConfigured: Boolean(lineChannelSecret.value()),
      channelAccessTokenConfigured: Boolean(lineChannelAccessToken.value()),
      openaiApiKeyConfigured: Boolean(openaiApiKey.value()),
      aiReplyEnabled: true,
    });
  },
);

export const lineEvents = onRequest(
  {
    region: "asia-southeast1",
  },
  (_req, res) => {
    res.status(200).json({
      ok: true,
      events: [],
      note: "Firebase Functions version does not store webhook events yet.",
    });
  },
);
