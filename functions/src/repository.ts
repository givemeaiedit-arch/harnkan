import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { AuditEvent, ChatTarget, GroupContext, LineProfile, MemberMemory, ParsedSplitExpense } from "./types";
import { hashId } from "./line";

if (!getApps().length) initializeApp();

const db = getFirestore();
const defaultAliases = ["@หารกัน", "/ai", "/ดูดวง", "/หาร", "/วิเคราะห์", "/จำ", "/ลืม"];

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
      latencyMs: data.latencyMs || 0,
      errorCode: data.errorCode || "",
      receivedAt: data.receivedAt?.toDate?.()?.toISOString?.() || "",
    };
  });
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
