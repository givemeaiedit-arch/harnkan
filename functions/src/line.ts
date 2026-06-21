import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { ChatTarget, LineEvent, LineProfile, LineSource } from "./types";

const lineReplyUrl = "https://api.line.me/v2/bot/message/reply";
const lineProfileUrl = "https://api.line.me/v2/bot/profile";

export function verifyLineSignature(rawBody: Buffer, signature: string | undefined, channelSecret: string): boolean {
  if (!signature || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashId(value: string | undefined): string {
  if (!value) return "";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function chatTargetFromEvent(event: LineEvent): ChatTarget | null {
  const source = event.source || {};
  const userId = source.userId || "";
  if (!userId) return null;
  if (source.groupId) {
    return { chatId: source.groupId, chatType: "group", userId, source };
  }
  if (source.roomId) {
    return { chatId: source.roomId, chatType: "room", userId, source };
  }
  if (source.type === "user") {
    return { chatId: userId, chatType: "user", userId, source };
  }
  return null;
}

export async function replyToLine(accessToken: string, replyToken: string, text: string): Promise<Response> {
  return fetch(lineReplyUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
}

export async function fetchLineProfile(accessToken: string, source: LineSource): Promise<LineProfile | null> {
  const userId = source.userId;
  if (!userId) return null;

  const url = profileUrlForSource(source, userId);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    return (await response.json()) as LineProfile;
  } catch {
    return null;
  }
}

function profileUrlForSource(source: LineSource, userId: string): string {
  if (source.groupId) {
    return `https://api.line.me/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(userId)}`;
  }
  if (source.roomId) {
    return `https://api.line.me/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(userId)}`;
  }
  return `${lineProfileUrl}/${encodeURIComponent(userId)}`;
}
