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

export async function getGroupContext(
  target: ChatTarget,
  options: { focusText?: string; recentMessagesLimit?: number } = {},
): Promise<GroupContext> {
  const groupRef = db.collection("lineGroups").doc(target.chatId);
  const [groupSnap, membersSnap, memoriesSnap, recentMessages] = await Promise.all([
    groupRef.get(),
    groupRef.collection("members").limit(30).get(),
    groupRef.collection("memories").orderBy("createdAt", "desc").limit(60).get(),
    recentGroupMessageContext(target.chatId, options.recentMessagesLimit || 12),
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

  const speakerMemories = currentUser.memories.slice(0, 10);
  const relatedMembers = findRelatedMembers(members, currentUser, options.focusText || "", recentMessages);
  const relatedMemories = dedupeMemories(
    relatedMembers
      .flatMap((member) => member.memories)
      .sort(compareMemoryCreatedAt)
      .slice(0, 16),
  );
  const groupMemories = dedupeMemories(
    allMemories
      .filter((memory) => memory.ownerUserId !== currentUser.userId)
      .sort(compareMemoryCreatedAt)
      .slice(0, 20),
  );

  return {
    chatId: target.chatId,
    chatType: target.chatType,
    aliasPrefixes: Array.isArray(aliases) && aliases.length ? aliases.map(String) : defaultAliases,
    members,
    currentUser,
    focusText: String(options.focusText || ""),
    recentMessages,
    speakerMemories,
    relatedMembers,
    relatedMemories,
    groupMemories,
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
      trigger: data.trigger || "",
      contextMessageCount: data.contextMessageCount || 0,
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
      classifierReason: data.classifierReason || "",
      classifierConfidence: data.classifierConfidence || 0,
      personalityMode: data.personalityMode || "",
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

export async function lineDashboardAnalytics(limit = 5000): Promise<Record<string, unknown>> {
  const snap = await db.collection("lineEventSummaries").orderBy("receivedAt", "desc").limit(limit).get();
  const rows = snap.docs.map((doc) => {
    const data = doc.data();
    return {
      chatId: String(data.chatId || ""),
      chatIdHash: String(data.chatIdHash || ""),
      userIdHash: String(data.userIdHash || ""),
      eventType: String(data.eventType || ""),
      status: String(data.status || ""),
      lineReplyOk: Boolean(data.lineReplyOk),
      estimatedUsd: Number(data.estimatedUsd || 0),
      estimatedThb: Number(data.estimatedThb || 0),
      openAiCalls: Number(data.openAiCalls || 0),
      totalTokens: Number(data.totalTokens || 0),
      receivedAt: data.receivedAt?.toDate?.() || null,
    };
  }).filter((row) => row.receivedAt);

  const primaryChatId = mostActiveChatId(rows);
  const memberNames = primaryChatId ? await memberNameMap(primaryChatId) : new Map<string, string>();
  const primaryRows = rows.filter((row) => !primaryChatId || row.chatId === primaryChatId);
  const messageRows = primaryRows.filter((row) => row.eventType === "message");
  const repliedRows = messageRows.filter((row) => row.lineReplyOk);
  const classifierRows = messageRows.filter((row) => ["classifier_reply", "spontaneous_reply"].includes(row.status) && row.lineReplyOk);
  const activeDays = distinctBangkokDays(messageRows);
  const todayKey = bangkokDateKey(new Date());
  const todayRows = messageRows.filter((row) => bangkokDateKey(row.receivedAt as Date) === todayKey);
  const todayReplies = repliedRows.filter((row) => bangkokDateKey(row.receivedAt as Date) === todayKey);
  const todayClassifier = classifierRows.filter((row) => bangkokDateKey(row.receivedAt as Date) === todayKey);
  const hourlyToday = buildHourlyBuckets(todayRows, todayReplies, todayClassifier);
  const speakerStats = buildSpeakerStats(messageRows, memberNames);
  const totalCostUsd = primaryRows.reduce((sum, row) => sum + row.estimatedUsd, 0);
  const totalCostThb = primaryRows.reduce((sum, row) => sum + row.estimatedThb, 0);
  const totalTokens = primaryRows.reduce((sum, row) => sum + row.totalTokens, 0);
  const totalCalls = primaryRows.reduce((sum, row) => sum + row.openAiCalls, 0);
  const dayCount = Math.max(activeDays.length, 1);

  return {
    primaryChatIdHash: primaryRows[0]?.chatIdHash || "",
    totals: {
      receivedMessages: messageRows.length,
      repliedMessages: repliedRows.length,
      spontaneousReplies: classifierRows.length,
      classifierReplies: classifierRows.length,
      totalAiCalls: totalCalls,
      totalTokens,
      totalCostUsd,
      totalCostThb,
      averageCostUsdPerDay: totalCostUsd / dayCount,
      averageCostThbPerDay: totalCostThb / dayCount,
      averageReceivedPerDay: messageRows.length / dayCount,
      averageRepliesPerDay: repliedRows.length / dayCount,
      totalDays: activeDays.length,
    },
    today: {
      receivedMessages: todayRows.length,
      repliedMessages: todayReplies.length,
      spontaneousReplies: todayClassifier.length,
      classifierReplies: todayClassifier.length,
      receivedTimes: todayRows.slice(0, 200).map((row) => (row.receivedAt as Date).toISOString()),
      repliedTimes: todayReplies.slice(0, 200).map((row) => (row.receivedAt as Date).toISOString()),
      spontaneousTimes: todayClassifier.slice(0, 200).map((row) => (row.receivedAt as Date).toISOString()),
      classifierTimes: todayClassifier.slice(0, 200).map((row) => (row.receivedAt as Date).toISOString()),
      firstReceivedAt: todayRows[0]?.receivedAt?.toISOString?.() || "",
      lastReceivedAt: todayRows[todayRows.length - 1]?.receivedAt?.toISOString?.() || "",
    },
    hourlyToday,
    speakers: {
      top: speakerStats.slice(0, 8),
      bottom: [...speakerStats].reverse().slice(0, 6).reverse(),
    },
    dateRange: {
      firstSeenAt: messageRows[messageRows.length - 1]?.receivedAt?.toISOString?.() || "",
      lastSeenAt: messageRows[0]?.receivedAt?.toISOString?.() || "",
    },
  };
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
      const names = await memberNameMap(chatId);
      const snap = await db.collection("lineGroups").doc(chatId).collection("memories").orderBy("createdAt", "desc").limit(limit).get();
      return snap.docs.map((doc) => {
        const memory = memoryFromDoc(doc.id, doc.data() as MemoryDoc);
        const ownerUserIdHash = hashId(memory.ownerUserId);
        return {
          id: memory.id,
          chatIdHash: hashId(chatId),
          ownerUserIdHash,
          ownerDisplayName: names.get(ownerUserIdHash) || `LINE-${ownerUserIdHash}`,
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

export async function detailedPublicMemories(limit = 120): Promise<Record<string, unknown>> {
  const memories = await recentPublicMemories(limit);
  const byCategory = new Map<string, number>();
  const byOwner = new Map<string, { ownerUserIdHash: string; ownerDisplayName: string; count: number }>();
  memories.forEach((memory) => {
    const category = String(memory.category || "note");
    byCategory.set(category, (byCategory.get(category) || 0) + 1);
    const ownerUserIdHash = String(memory.ownerUserIdHash || "");
    const ownerDisplayName = String(memory.ownerDisplayName || ownerUserIdHash || "Unknown");
    const current = byOwner.get(ownerUserIdHash);
    byOwner.set(ownerUserIdHash, {
      ownerUserIdHash,
      ownerDisplayName,
      count: (current?.count || 0) + 1,
    });
  });
  return {
    items: memories,
    categories: [...byCategory.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((left, right) => right.count - left.count),
    owners: [...byOwner.values()].sort((left, right) => right.count - left.count),
  };
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

function mostActiveChatId(rows: Array<{ chatId: string }>): string {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    if (!row.chatId || row.chatId === "invalid-signature") return;
    counts.set(row.chatId, (counts.get(row.chatId) || 0) + 1);
  });
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "";
}

async function memberNameMap(chatId: string): Promise<Map<string, string>> {
  const snap = await db.collection("lineGroups").doc(chatId).collection("members").limit(100).get();
  const map = new Map<string, string>();
  snap.docs.forEach((doc) => {
    const userId = String(doc.get("userId") || doc.id);
    map.set(hashId(userId), String(doc.get("displayName") || `LINE-${hashId(userId)}`));
  });
  return map;
}

function bangkokDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "00";
  const day = parts.find((part) => part.type === "day")?.value || "00";
  return `${year}-${month}-${day}`;
}

function bangkokHour(date: Date): number {
  const value = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(value);
}

function distinctBangkokDays(rows: Array<{ receivedAt: Date | null }>): string[] {
  return [...new Set(rows.map((row) => bangkokDateKey(row.receivedAt as Date)))];
}

function buildHourlyBuckets(
  receivedRows: Array<{ receivedAt: Date | null }>,
  repliedRows: Array<{ receivedAt: Date | null }>,
  spontaneousRows: Array<{ receivedAt: Date | null }>,
): Array<Record<string, number | string>> {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${String(hour).padStart(2, "0")}:00`, received: 0, replied: 0, spontaneous: 0 }));
  receivedRows.forEach((row) => {
    buckets[bangkokHour(row.receivedAt as Date)].received += 1;
  });
  repliedRows.forEach((row) => {
    buckets[bangkokHour(row.receivedAt as Date)].replied += 1;
  });
  spontaneousRows.forEach((row) => {
    buckets[bangkokHour(row.receivedAt as Date)].spontaneous += 1;
  });
  return buckets;
}

function buildSpeakerStats(
  rows: Array<{ userIdHash: string; receivedAt: Date | null }>,
  memberNames: Map<string, string>,
): Array<Record<string, unknown>> {
  const counts = new Map<string, number>();
  rows.forEach((row) => {
    if (!row.userIdHash) return;
    counts.set(row.userIdHash, (counts.get(row.userIdHash) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([userIdHash, messageCount]) => ({
      userIdHash,
      displayName: memberNames.get(userIdHash) || `สมาชิก ${userIdHash.slice(0, 4)}`,
      messageCount,
    }))
    .sort((left, right) => Number(right.messageCount) - Number(left.messageCount));
}

function findRelatedMembers(
  members: GroupContext["members"],
  currentUser: GroupContext["currentUser"],
  focusText: string,
  recentMessages: string[],
): GroupContext["relatedMembers"] {
  const combined = `${focusText}\n${recentMessages.join("\n")}`.toLowerCase();
  const scored = members
    .filter((member) => member.userId !== currentUser.userId)
    .map((member) => {
      const name = member.displayName.trim().toLowerCase();
      if (!name) return { member, score: 0 };
      const escaped = escapeRegExp(name);
      const directMatches = (combined.match(new RegExp(escaped, "g")) || []).length;
      const memoryMatches = member.memories
        .slice(0, 6)
        .reduce((sum, memory) => sum + ((focusText.toLowerCase().includes(memory.text.toLowerCase()) || combined.includes(memory.text.toLowerCase())) ? 1 : 0), 0);
      return { member, score: directMatches * 2 + memoryMatches };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  return scored.slice(0, 4).map((item) => item.member);
}

function compareMemoryCreatedAt(left: MemberMemory, right: MemberMemory): number {
  return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
}

function dedupeMemories(memories: MemberMemory[]): MemberMemory[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = `${memory.ownerUserId}|${memory.category}|${memory.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
