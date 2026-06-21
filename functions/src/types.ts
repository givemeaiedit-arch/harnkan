export type LineSource = {
  type?: "user" | "group" | "room" | string;
  userId?: string;
  groupId?: string;
  roomId?: string;
};

export type LineEvent = {
  type?: string;
  replyToken?: string;
  timestamp?: number;
  source?: LineSource;
  message?: {
    id?: string;
    type?: string;
    text?: string;
  };
};

export type LineWebhookBody = {
  destination?: string;
  events?: LineEvent[];
};

export type LineProfile = {
  displayName?: string;
  pictureUrl?: string;
};

export type ChatTarget = {
  chatId: string;
  chatType: "group" | "room" | "user";
  userId: string;
  source: LineSource;
};

export type MemberMemory = {
  id?: string;
  ownerUserId: string;
  category: "profile" | "food" | "birthday" | "preference" | "split" | "note";
  text: string;
  confidence: number;
  createdAt?: string;
};

export type GroupMember = {
  userId: string;
  displayName: string;
  memories: MemberMemory[];
};

export type GroupContext = {
  chatId: string;
  chatType: ChatTarget["chatType"];
  aliasPrefixes: string[];
  members: GroupMember[];
  currentUser: GroupMember;
  recentMemories: MemberMemory[];
};

export type AgentRoute = "general" | "memory" | "memory_show" | "memory_delete" | "split" | "horoscope" | "speech";

export type ParsedCommand = {
  invoked: boolean;
  route: AgentRoute;
  text: string;
  rawPrefix: string;
};

export type AgentResult = {
  reply: string;
  route: AgentRoute;
  agent: string;
  status: "ok" | "needs_input" | "blocked" | "error";
  savedMemoryCount?: number;
  splitSessionId?: string;
};

export type ParsedSplitExpense = {
  title: string;
  amount: number;
  payerName: string;
  participants: string[];
  excluded: string[];
  notes: string[];
  needsMoreInfo: boolean;
  question: string;
};

export type AuditEvent = {
  chatId: string;
  chatType: ChatTarget["chatType"];
  userIdHash: string;
  eventType: string;
  agent?: string;
  route?: string;
  status: string;
  latencyMs?: number;
  errorCode?: string;
};
