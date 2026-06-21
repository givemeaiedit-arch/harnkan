import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { AiRuntimeConfig, AuditEvent, ChatTarget, GroupContext, LineProfile, LineEvent, MemberMemory, ParsedSplitExpense } from "./types";
import { hashId } from "./line";

if (!getApps().length) initializeApp();

const db = getFirestore();
const defaultAliases = ["วิมล"];
const configDocRef = db.collection("appConfig").doc("lineAi");

type MemoryDoc = {
  ownerUserId?: string;
  category?: MemberMemory["category"];
  text?: string;
  confidence?: number;
  createdAt?: Timestamp;
};

export async function ensureLineIdentity(target: ChatTarget, profile: LineProfile | null): Promise<void> {
  const now = FieldValue.serverTimestamp();
  const displayName = safeDisplayName(profile?.displayName, target.userId);

  await Promise.all([
    db.collection("lineGroups").doc(target.chatId).set(
      {
        chatType: target.chatType,
        aliases: defaultAliases,
        botEnabled: true,
        updatedAt: now,
        createdAt: now,
      },
      { merge: true },
    ),
    db.collection("lineUsers").doc(target.userId).set(
      {
        displayName,
        pictureUrl: profile?.pictureUrl || "",
        updatedAt: now,
        createdAt: now,
      },
      { merge: true },
    ),
    db.collection("lineGroups").doc(target.chatId).collection("members").doc(target.userId).set(
      {
        userId: target.userId,
        displayName,
        pictureUrl: profile?.pictureUrl || "",
        lastSeenAt: now,
        updatedAt: now,
        createdAt: now,
      },
      { merge: true },
    ),
  ]);
}

export async function getGroupContext(target: ChatTarget): Promise<GroupContext> {
  const groupRef = db.collection("lineGroups").doc(target.chatId);
  const [groupSnap, membersSnap, memoriesSnap] = await Promise.all([
    groupRef.get(),
    groupRef.collection("members").limit(30).get(),
    groupRef.collection("memories").orderBy("createdAt", "desc").limit(30).get(),
  ]);

  const aliases = groupSnap.get("aliases");
  const allMemories = memoriesSnap.docs.map((doc) => memoryFromDoc(doc.id, doc.data() as MemoryDoc));
  const members = membersSnap.docs.map((doc) => {
    const data = doc.data();
    const userId = String(data.userId || doc.id);
    return {
      userId,
      displayName: String(data.displayName || hashId(userId)),
      memories: allMemories.filter((memory) => memory.ownerUserId === userId),
    };
  });

  let currentUser = members.find((member) => member.userId === target.userId);
  if (!currentUser) {
    currentUser = { userId: target.userId, displayName: hashId(target.userId), memories: [] };
    members.push(currentUser);
  }

  return {
    chatId: target.chatId,
    chatType: target.chatType,
    aliasPrefixes: Array.isArray(aliases) && aliases.length ? aliases.map(String) : defaultAliases,
    members,
    currentUser,
    recentMemories: allMemories,
  };
}

export async function saveMemory(target: ChatTarget, memory: Omit<MemberMemory, "id" | "createdAt">): Promise<string> {
  const groupRef = db.collection("lineGroups").doc(target.chatId);
  const docRef = groupRef.collection("memories").doc();
  await docRef.set({
    ...memory,
    ownerUserId: memory.ownerUserId || target.userId,
    createdAt: FieldValue.serverTimestamp(),
  });
  return docRef.id;
}

export async function deleteUserMemories(target: ChatTarget, selector: string): Promise<number> {
  const groupRef = db.collection("lineGroups").doc(target.chatId);
  const snap = await groupRef.collection("memories").where("ownerUserId", "==", target.userId).limit(50).get();
  const normalizedSelector = selector.trim().toLowerCase();
  const batch = db.batch();
  let count = 0;

  snap.docs.forEach((doc) => {
    const text = String(doc.get("text") || "").toLowerCase();
    if (!normalizedSelector || text.includes(normalizedSelector) || ["ทั้งหมด", "all", "ข้อมูลของฉัน"].includes(normalizedSelector)) {
      batch.delete(doc.ref);
      count += 1;
    }
  });

  if (count) await batch.commit();
  return count;
}

export async function createSplitExpense(target: ChatTarget, expense: ParsedSplitExpense): Promise<string> {
  const docRef = db.collection("lineGroups").doc(target.chatId).collection("sessions").doc();
  await docRef.set({
    kind: "splitExpense",
    status: expense.needsMoreInfo ? "needs_input" : "draft",
    expense,
    createdBy: target.userId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return docRef.id;
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  const payload = {
    ...event,
    chatIdHash: hashId(event.chatId),
    chatId: event.chatId,
    receivedAt: FieldValue.serverTimestamp(),
  };
  await Promise.all([
    db.collection("lineEventSummaries").add(payload),
    db.collection("lineGroups").doc(event.chatId).collection("events").add(payload),
  ]);
}

export async function recordBotReplyMessages(target: ChatTarget, messageIds: string[]): Promise<void> {
  const cleanIds = messageIds.map(String).filter(Boolean).slice(0, 5);
  if (!cleanIds.length) return;
  const batch = db.batch();
  cleanIds.forEach((messageId) => {
    batch.set(
      db.collection("lineGroups").doc(target.chatId).collection("botMessages").doc(messageId),
      {
        messageId,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  await batch.commit();
}

export async function isReplyToKnownBotMessage(target: ChatTarget, event: LineEvent): Promise<boolean> {
  const quotedMessageId = String(event.message?.quotedMessageId || "");
  if (!quotedMessageId) return false;
  const snap = await db.collection("lineGroups").doc(target.chatId).collection("botMessages").doc(quotedMessageId).get();
  return snap.exists;
}

export async function recentGroupMessageContext(chatId: string, limit = 10): Promise<string[]> {
  const snap = await db.collection("lineGroups").doc(chatId).collection("events").orderBy("receivedAt", "desc").limit(Math.max(limit * 2, limit)).get();
  return snap.docs
    .map((doc) => String(doc.get("messagePreview") || "").trim())
    .filter((message) => message && message !== "ไม่แสดงข้อความ เพราะ LINE signature ไม่ผ่าน")
    .filter((message, index, all) => all.indexOf(message) === index)
    .slice(0, limit)
    .reverse();
}

export async function recentLineEvents(limit = 30): Promise<Record<string, unknown>[]> {
  const snap = await db.collection("lineEventSummaries").orderBy("receivedAt", "desc").limit(limit).get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      chatIdHash: data.chatIdHash || hashId(String(data.chatId || "")),
      userIdHash: data.userIdHash || "",
      eventType: data.eventType || "",
      eventCount: 1,
      events: [
        {
          type: data.eventType || "webhook",
          messageType: data.route || "",
          text: `${data.agent || "LINE"}: ${data.status || ""}`.trim(),
        },
      ],
      agent: data.agent || "",
      route: data.route || "",
      status: data.status || "",
      messagePreview: data.messagePreview || "",
      latencyMs: data.latencyMs || 0,
      errorCode: data.errorCode || "",
      model: data.model || "",
      inputTokens: data.inputTokens || 0,
      outputTokens: data.outputTokens || 0,
      totalTokens: data.totalTokens || 0,
      openAiCalls: data.openAiCalls || 0,
      savedMemoryCount: data.savedMemoryCount || 0,
      estimatedUsd: data.estimatedUsd || 0,
      estimatedThb: data.estimatedThb || 0,
      lineReplyStatus: data.lineReplyStatus || 0,
      lineReplyOk: Boolean(data.lineReplyOk),
      lineReplyError: data.lineReplyError || "",
      receivedAt: data.receivedAt?.toDate?.()?.toISOString?.() || "",
    };
  });
}

export async function aiUsageSummary(limit = 1000): Promise<Record<string, unknown>> {
  const snap = await db.collection("lineEventSummaries").orderBy("receivedAt", "desc").limit(limit).get();
  const summary = {
    eventCount: 0,
    openAiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    estimatedThb: 0,
  };

  snap.docs.forEach((doc) => {
    const data = doc.data();
    const calls = Number(data.openAiCalls || 0);
    if (!calls) return;
    summary.eventCount += 1;
    summary.openAiCalls += calls;
    summary.inputTokens += Number(data.inputTokens || 0);
    summary.outputTokens += Number(data.outputTokens || 0);
    summary.totalTokens += Number(data.totalTokens || 0);
    summary.estimatedUsd += Number(data.estimatedUsd || 0);
    summary.estimatedThb += Number(data.estimatedThb || 0);
  });

  return summary;
}

export async function recentPublicMemories(limit = 30): Promise<Record<string, unknown>[]> {
  const eventsSnap = await db.collection("lineEventSummaries").orderBy("receivedAt", "desc").limit(100).get();
  const chatIds = eventsSnap.docs
    .map((doc) => String(doc.get("chatId") || ""))
    .filter((chatId) => chatId && chatId !== "invalid-signature")
    .filter((chatId, index, all) => all.indexOf(chatId) === index)
    .slice(0, 3);

  const memories = await Promise.all(
    chatIds.map(async (chatId) => {
      const snap = await db.collection("lineGroups").doc(chatId).collection("memories").orderBy("createdAt", "desc").limit(limit).get();
      return snap.docs.map((doc) => {
        const memory = memoryFromDoc(doc.id, doc.data() as MemoryDoc);
        return {
          id: memory.id,
          chatIdHash: hashId(chatId),
          ownerUserIdHash: hashId(memory.ownerUserId),
          category: memory.category,
          text: memory.text,
          confidence: memory.confidence,
          createdAt: memory.createdAt,
        };
      });
    }),
  );

  return memories.flat().sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || ""))).slice(0, limit);
}

export async function getAiRuntimeConfig(defaultModel: string, modelOptions: Array<{ label: string; value: string }>): Promise<AiRuntimeConfig> {
  const snap = await configDocRef.get();
  const configuredModel = String(snap.get("model") || defaultModel || "");
  const option = modelOptions.find((item) => item.value === configuredModel) || modelOptions[0] || { label: configuredModel, value: configuredModel };
  return {
    model: option.value,
    modelLabel: option.label,
    updatedAt: snap.get("updatedAt")?.toDate?.()?.toISOString?.() || "",
  };
}

export async function setAiRuntimeModel(model: string, modelOptions: Array<{ label: string; value: string }>): Promise<AiRuntimeConfig> {
  const option = modelOptions.find((item) => item.value === model);
  if (!option) throw new Error("UnsupportedModel");
  await configDocRef.set(
    {
      model: option.value,
      modelLabel: option.label,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  return getAiRuntimeConfig(option.value, modelOptions);
}

export async function groupMemoriesForAdmin(chatId: string): Promise<Record<string, unknown>[]> {
  const snap = await db.collection("lineGroups").doc(chatId).collection("memories").orderBy("createdAt", "desc").limit(100).get();
  return snap.docs.map((doc) => {
    const memory = memoryFromDoc(doc.id, doc.data() as MemoryDoc);
    return {
      id: memory.id,
      ownerUserIdHash: hashId(memory.ownerUserId),
      category: memory.category,
      text: memory.text,
      confidence: memory.confidence,
      createdAt: memory.createdAt,
    };
  });
}

function memoryFromDoc(id: string, data: MemoryDoc): MemberMemory {
  return {
    id,
    ownerUserId: String(data.ownerUserId || ""),
    category: data.category || "note",
    text: String(data.text || ""),
    confidence: Number(data.confidence || 0.6),
    createdAt: data.createdAt?.toDate?.()?.toISOString?.() || "",
  };
}

function safeDisplayName(displayName: string | undefined, userId: string): string {
  const clean = String(displayName || "").trim();
  return clean || `LINE-${hashId(userId)}`;
}
