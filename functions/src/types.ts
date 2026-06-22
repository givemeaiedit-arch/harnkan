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
    quotedMessageId?: string;
    quoteToken?: string;
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
  focusText?: string;
  recentMessages: string[];
  speakerMemories: MemberMemory[];
  relatedMembers: GroupMember[];
  relatedMemories: MemberMemory[];
  groupMemories: MemberMemory[];
  recentMemories: MemberMemory[];
};

export type AgentRoute = "general" | "memory" | "memory_show" | "memory_delete" | "split" | "horoscope" | "speech";

export type PersonalityMode = "comedian" | "reporter" | "fortune_teller" | "judge" | "sports_commentator" | "neutral";

export type ReplyIntent = "joke" | "comfort" | "opinion" | "summary" | "question" | "none";

export type MessageClassification = {
  shouldReply: boolean;
  reason: string;
  confidence: number;
  personalityMode: PersonalityMode;
  replyIntent: ReplyIntent;
  usage?: TokenUsage;
  cost?: CostEstimate;
};

export type ParsedCommand = {
  invoked: boolean;
  route: AgentRoute;
  text: string;
  rawPrefix: string;
  trigger?: "mention" | "reply" | "classifier" | "";
};

export type AgentResult = {
  reply: string;
  route: AgentRoute;
  agent: string;
  status: "ok" | "needs_input" | "blocked" | "error";
  savedMemoryCount?: number;
  splitSessionId?: string;
  usage?: TokenUsage;
  cost?: CostEstimate;
};

export type TokenUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  openAiCalls: number;
};

export type CostEstimate = {
  model: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  usdToThb: number;
  estimatedUsd: number;
  estimatedThb: number;
};

export type AiRuntimeConfig = {
  model: string;
  modelLabel: string;
  updatedAt?: string;
};

export type AiModelOption = {
  label: string;
  value: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

export type SilentMemoryResult = {
  status: "saved" | "scanned" | "skipped" | "skipped_sensitive" | "error";
  savedMemoryCount: number;
  usage: TokenUsage;
  cost: CostEstimate;
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
  messagePreview?: string;
  trigger?: ParsedCommand["trigger"];
  contextMessageCount?: number;
  agent?: string;
  route?: string;
  status: string;
  latencyMs?: number;
  errorCode?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  openAiCalls?: number;
  savedMemoryCount?: number;
  estimatedUsd?: number;
  estimatedThb?: number;
  lineReplyStatus?: number;
  lineReplyOk?: boolean;
  lineReplyError?: string;
  classifierReason?: string;
  classifierConfidence?: number;
  personalityMode?: PersonalityMode;
};
