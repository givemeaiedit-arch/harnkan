const STORAGE_KEY = "harnkan-manual-state-v1";
const API_STATE_URL = "/api/state";
const LINE_CONFIG_URL = "/api/line/config";
const LINE_EVENTS_URL = "/api/line/events";
const LINE_WEBHOOK_PATH = "/line/webhook";
const CANCEL_TRANSFER_LABEL = "\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01\u0e01\u0e32\u0e23\u0e42\u0e2d\u0e19";
const CANCEL_TRANSFER_CONFIRM = "\u0e22\u0e37\u0e19\u0e22\u0e31\u0e19\u0e17\u0e35\u0e48\u0e08\u0e30\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01\u0e01\u0e32\u0e23\u0e42\u0e2d\u0e19\u0e19\u0e35\u0e49\u0e44\u0e2b\u0e21?";
let remoteSaveEnabled = false;
let saveTimer;

function canUseSharedStateApi() {
  return location.protocol.startsWith("http") && !location.hostname.endsWith("github.io");
}

let sharedLinkError = false;
const SHARE_CATEGORIES = ["food", "beer", "stay", "fuel", "other"];
const SHARE_MODES = ["equal", "custom", "time"];

function encodeSharePayload(payload) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(compactSharePayload(payload)))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeSharePayload(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const payload = JSON.parse(deURIComponentCompat(atob(padded)));
  return expandSharePayload(payload);
}

function sharedHashValue() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (!hash) return "";
  const params = new URLSearchParams(hash);
  return params.get("s") || params.get("share") || "";
}

function compressedSharedHashValue() {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  if (!hash) return "";
  return new URLSearchParams(hash).get("z") || "";
}

function deURIComponentCompat(value) {
  return decodeURIComponent(escape(value));
}

function bytesToBase64Url(bytes) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function encodeCompressedSharePayload(payload) {
  if (!("CompressionStream" in window)) return "";
  const json = JSON.stringify(compactSharePayload(payload));
  const stream = new Blob([new TextEncoder().encode(json)]).stream().pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return bytesToBase64Url(new Uint8Array(buffer));
}

async function decodeCompressedSharePayload(value) {
  if (!("DecompressionStream" in window)) throw new Error("DecompressionStream unavailable");
  const stream = new Blob([base64UrlToBytes(value)]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return expandSharePayload(JSON.parse(text));
}

function compactSharePayload(payload) {
  const trip = payload?.trips?.[0];
  if (!trip) return payload;
  return [4, compactTripV4(trip)];
}

function expandSharePayload(payload) {
  if (Array.isArray(payload) && payload[0] === 4) {
    const trip = expandTripV4(payload[1]);
    return {
      trips: [trip],
      currentTripId: trip.id,
    };
  }
  if (payload?.v === 3) {
    const trip = expandTripV3(payload.t);
    return {
      trips: [trip],
      currentTripId: trip.id,
      sharedAt: payload.a || "",
    };
  }
  if (payload?.v !== 2) return payload;
  const trip = expandTrip(payload.t);
  return {
    trips: [trip],
    currentTripId: trip.id,
    sharedAt: payload.a || "",
  };
}

function trimDefaults(row, defaults) {
  while (row.length > 1 && isShareDefaultValue(row[row.length - 1], defaults[row.length - 1])) row.pop();
  return row;
}

function isShareDefaultValue(value, defaultValue) {
  if (Array.isArray(value) && Array.isArray(defaultValue)) return value.length === 0 && defaultValue.length === 0;
  return value === defaultValue;
}

function compactPayment(payment = {}) {
  const clean = sanitizePayment(payment);
  if (!clean.account) return [];
  const bankIndex = thaiBanks.indexOf(clean.bank);
  return [
    clean.type === "bank" ? "b" : "p",
    clean.type === "bank" ? (bankIndex >= 0 ? bankIndex : clean.bank) : "",
    clean.account,
  ];
}

function expandPayment(row = []) {
  if (!row.length) return sanitizePayment();
  const type = row[0] === "b" ? "bank" : "promptpay";
  const bank = type === "bank" ? (typeof row[1] === "number" ? thaiBanks[row[1]] : row[1]) : thaiBanks[0];
  return sanitizePayment({ type, bank, account: row[2] || "" });
}

function compactMembers(list = []) {
  return list.map((member) => trimDefaults([
    member.id,
    member.name,
    member.abbr,
    member.active === false ? 0 : 1,
    member.color,
    compactPayment(member.payment),
  ], ["", "", "", 1, "", []]));
}

function expandMembers(list = []) {
  return list.map((row) => ({
    id: row[0],
    name: row[1],
    abbr: row[2],
    active: row[3] !== 0,
    color: row[4],
    payment: expandPayment(row[5]),
  }));
}

function compactParticipants(participants = {}) {
  return Object.entries(participants).map(([memberId, config = {}]) => trimDefaults([
    memberId,
    config.included === false ? 0 : 1,
    Number(config.weight) || 1,
    Number(config.fixed) || 0,
  ], ["", 1, 1, 0]));
}

function expandParticipants(list = []) {
  return Object.fromEntries(list.map((row) => [
    row[0],
    {
      included: row[1] === undefined ? true : row[1] !== 0,
      weight: row[2] === undefined ? 1 : Number(row[2]) || 0,
      fixed: row[3] === undefined ? 0 : Number(row[3]) || 0,
    },
  ]));
}

function compactSubItems(list = []) {
  return list.map((item) => [
    item.id,
    item.title,
    Number(item.amount) || 0,
    item.participantIds || [],
  ]);
}

function expandSubItems(list = []) {
  return list.map((row) => ({
    id: row[0],
    title: row[1],
    amount: Number(row[2]) || 0,
    participantIds: row[3] || [],
  }));
}

function compactConfirmedTransfers(transfers = {}) {
  return Object.entries(transfers).map(([key, info = {}]) => trimDefaults([
    key,
    info.confirmedAt || "",
    info.slipName || "",
    info.slipType || "",
  ], ["", "", "", ""]));
}

function expandConfirmedTransfers(list = []) {
  return Object.fromEntries(list.map((row) => [
    row[0],
    {
      confirmedAt: row[1] || "",
      slipName: row[2] || "",
      slipType: row[3] || "",
    },
  ]));
}

function compactExpenses(list = []) {
  return list.map((expense) => trimDefaults([
    expense.id,
    expense.title,
    Number(expense.amount) || 0,
    expense.payerId,
    expense.category,
    expense.mode,
    expense.note || "",
    compactParticipants(expense.participants),
    compactSubItems(expense.subItems),
  ], ["", "", 0, "", "", "equal", "", [], []]));
}

function expandExpenses(list = []) {
  return list.map((row) => ({
    id: row[0],
    title: row[1],
    amount: Number(row[2]) || 0,
    payerId: row[3],
    category: row[4],
    mode: row[5] || "equal",
    note: row[6] || "",
    participants: expandParticipants(row[7]),
    subItems: expandSubItems(row[8]),
  }));
}

function compactTrip(trip) {
  return [
    trip.id,
    trip.name,
    trip.subtitle,
    trip.closedAt || "",
    compactMembers(trip.members),
    compactExpenses(trip.expenses),
    compactConfirmedTransfers(trip.confirmedTransfers),
  ];
}

function expandTrip(row = []) {
  return {
    id: row[0],
    name: row[1],
    subtitle: row[2],
    closedAt: row[3] || "",
    members: expandMembers(row[4]),
    expenses: expandExpenses(row[5]),
    confirmedTransfers: expandConfirmedTransfers(row[6]),
  };
}

function compactTripV3(trip) {
  const memberIds = (trip.members || []).map((member) => member.id);
  const memberIndex = new Map(memberIds.map((id, index) => [id, index]));
  return [
    trip.name,
    trip.subtitle,
    trip.closedAt || "",
    compactMembersV3(trip.members),
    compactExpensesV3(trip.expenses, memberIndex),
    compactConfirmedTransfersV3(trip.confirmedTransfers, memberIndex),
  ];
}

function expandTripV3(row = []) {
  const members = expandMembersV3(row[3]);
  const memberIds = members.map((member) => member.id);
  return {
    id: "shared-trip",
    name: row[0],
    subtitle: row[1],
    closedAt: row[2] || "",
    members,
    expenses: expandExpensesV3(row[4], memberIds),
    confirmedTransfers: expandConfirmedTransfersV3(row[5], memberIds),
  };
}

function compactMembersV3(list = []) {
  return list.map((member) => trimDefaults([
    member.name,
    member.abbr,
    member.active === false ? 0 : 1,
    compactPayment(member.payment),
  ], ["", "", 1, []]));
}

function expandMembersV3(list = []) {
  return list.map((row, index) => ({
    id: `m${index}`,
    name: row[0],
    abbr: row[1] || makeMemberAbbr(row[0]),
    active: row[2] !== 0,
    color: defaultMembers[index % defaultMembers.length]?.color || pickColor(row[0]),
    payment: expandPayment(row[3]),
  }));
}

function compactMemberIndex(memberId, memberIndex) {
  return memberIndex.has(memberId) ? memberIndex.get(memberId) : memberId;
}

function expandMemberId(value, memberIds) {
  return typeof value === "number" ? memberIds[value] : value;
}

function compactParticipantsV3(participants = {}, memberIndex) {
  return Object.entries(participants).map(([memberId, config = {}]) => trimDefaults([
    compactMemberIndex(memberId, memberIndex),
    config.included === false ? 0 : 1,
    Number(config.weight) || 1,
    Number(config.fixed) || 0,
  ], ["", 1, 1, 0]));
}

function expandParticipantsV3(list = [], memberIds) {
  return Object.fromEntries(list.map((row) => [
    expandMemberId(row[0], memberIds),
    {
      included: row[1] === undefined ? true : row[1] !== 0,
      weight: row[2] === undefined ? 1 : Number(row[2]) || 0,
      fixed: row[3] === undefined ? 0 : Number(row[3]) || 0,
    },
  ]).filter(([memberId]) => memberId));
}

function compactSubItemsV3(list = [], memberIndex) {
  return list.map((item) => [
    item.title,
    Number(item.amount) || 0,
    (item.participantIds || []).map((id) => compactMemberIndex(id, memberIndex)),
  ]);
}

function expandSubItemsV3(list = [], memberIds) {
  return list.map((row, index) => ({
    id: `s${index}`,
    title: row[0],
    amount: Number(row[1]) || 0,
    participantIds: (row[2] || []).map((id) => expandMemberId(id, memberIds)).filter(Boolean),
  }));
}

function compactExpensesV3(list = [], memberIndex) {
  return list.map((expense, index) => trimDefaults([
    expense.title,
    Number(expense.amount) || 0,
    compactMemberIndex(expense.payerId, memberIndex),
    expense.category,
    expense.mode,
    expense.note || "",
    compactParticipantsV3(expense.participants, memberIndex),
    compactSubItemsV3(expense.subItems, memberIndex),
  ], ["", 0, "", "", "equal", "", [], []]));
}

function expandExpensesV3(list = [], memberIds) {
  return list.map((row, index) => ({
    id: `e${index}`,
    title: row[0],
    amount: Number(row[1]) || 0,
    payerId: expandMemberId(row[2], memberIds),
    category: row[3],
    mode: row[4] || "equal",
    note: row[5] || "",
    participants: expandParticipantsV3(row[6], memberIds),
    subItems: expandSubItemsV3(row[7], memberIds),
  }));
}

function compactConfirmedTransfersV3(transfers = {}, memberIndex) {
  return Object.entries(transfers).map(([key, info = {}]) => {
    const [fromId, toId, cents] = key.split("|");
    return trimDefaults([
      compactMemberIndex(fromId, memberIndex),
      compactMemberIndex(toId, memberIndex),
      Number(cents) || 0,
      info.confirmedAt || "",
      info.slipName || "",
      info.slipType || "",
    ], ["", "", 0, "", "", ""]);
  });
}

function expandConfirmedTransfersV3(list = [], memberIds) {
  return Object.fromEntries(list.map((row) => {
    const fromId = expandMemberId(row[0], memberIds);
    const toId = expandMemberId(row[1], memberIds);
    const cents = Number(row[2]) || 0;
    return [
      `${fromId}|${toId}|${cents}`,
      {
        confirmedAt: row[3] || "",
        slipName: row[4] || "",
        slipType: row[5] || "",
      },
    ];
  }).filter(([key]) => !key.startsWith("undefined|") && !key.includes("|undefined|")));
}

function compactCategory(category) {
  const index = SHARE_CATEGORIES.indexOf(category);
  return index >= 0 ? index : category;
}

function expandCategory(value) {
  return typeof value === "number" ? SHARE_CATEGORIES[value] : value;
}

function compactMode(mode) {
  const index = SHARE_MODES.indexOf(mode);
  return index >= 0 ? index : mode;
}

function expandMode(value) {
  return typeof value === "number" ? SHARE_MODES[value] : value;
}

function compactTripV4(trip) {
  const memberIds = (trip.members || []).map((member) => member.id);
  const memberIndex = new Map(memberIds.map((id, index) => [id, index]));
  return trimDefaults([
    trip.name,
    trip.subtitle,
    compactMembersV3(trip.members),
    compactExpensesV4(trip.expenses, memberIndex),
    compactConfirmedTransfersV3(trip.confirmedTransfers, memberIndex),
    trip.closedAt || "",
  ], ["", "", [], [], [], ""]);
}

function expandTripV4(row = []) {
  const members = expandMembersV3(row[2]);
  const memberIds = members.map((member) => member.id);
  return {
    id: "shared-trip",
    name: row[0],
    subtitle: row[1],
    closedAt: row[5] || "",
    members,
    expenses: expandExpensesV4(row[3], memberIds),
    confirmedTransfers: expandConfirmedTransfersV3(row[4], memberIds),
  };
}

function compactExpensesV4(list = [], memberIndex) {
  return list.map((expense) => trimDefaults([
    expense.title,
    Number(expense.amount) || 0,
    compactMemberIndex(expense.payerId, memberIndex),
    compactCategory(expense.category),
    compactMode(expense.mode),
    expense.note || "",
    compactParticipantsV3(expense.participants, memberIndex),
    compactSubItemsV3(expense.subItems, memberIndex),
  ], ["", 0, "", 4, 0, "", [], []]));
}

function expandExpensesV4(list = [], memberIds) {
  return list.map((row, index) => ({
    id: `e${index}`,
    title: row[0],
    amount: Number(row[1]) || 0,
    payerId: expandMemberId(row[2], memberIds),
    category: expandCategory(row[3]),
    mode: expandMode(row[4]) || "equal",
    note: row[5] || "",
    participants: expandParticipantsV3(row[6], memberIds),
    subItems: expandSubItemsV3(row[7], memberIds),
  }));
}

const defaultMembers = [
  { id: "som", name: "ส้ม", abbr: "S", active: true, color: "#ef7d9a" },
  { id: "not", name: "น๊อต", abbr: "N", active: true, color: "#2563eb" },
  { id: "oshi", name: "โอชิ", abbr: "O", active: true, color: "#10b981" },
  { id: "pang", name: "แป้ง", abbr: "P", active: true, color: "#f59e0b" },
  { id: "bank", name: "แบงค์", abbr: "B", active: true, color: "#0ea5c7" },
  { id: "tee", name: "พี่ตี้", abbr: "T", active: true, color: "#7c3aed" },
];

const thaiBanks = [
  "ธนาคารกสิกรไทย",
  "ธนาคารไทยพาณิชย์",
  "ธนาคารกรุงเทพ",
  "ธนาคารกรุงไทย",
  "ธนาคารกรุงศรีอยุธยา",
  "ธนาคารทหารไทยธนชาต",
  "ธนาคารออมสิน",
  "ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร",
  "ธนาคารยูโอบี",
  "ธนาคารซีไอเอ็มบี ไทย",
  "ธนาคารเกียรตินาคินภัทร",
  "ธนาคารแลนด์ แอนด์ เฮ้าส์",
  "ธนาคารทิสโก้",
  "ธนาคารไอซีบีซี ไทย",
  "ธนาคารอิสลามแห่งประเทศไทย",
];

const defaultExpenses = [
  {
    id: uid(),
    title: "อาหารเย็น ซีฟู้ด",
    amount: 4800,
    payerId: "not",
    category: "food",
    mode: "time",
    note: "แป้งกับพี่ตี้มาเพิ่มช่วง 22:00-24:00",
    participants: {
      som: { included: true, weight: 6, fixed: 0 },
      not: { included: true, weight: 6, fixed: 0 },
      oshi: { included: true, weight: 6, fixed: 0 },
      pang: { included: true, weight: 2, fixed: 0 },
      bank: { included: true, weight: 6, fixed: 0 },
      tee: { included: true, weight: 2, fixed: 0 },
    },
  },
  {
    id: uid(),
    title: "ที่พัก บ้านพักริมทะเล",
    amount: 4800,
    payerId: "bank",
    category: "stay",
    mode: "equal",
    note: "ทุกคนหารเท่ากัน",
    participants: {},
  },
  {
    id: uid(),
    title: "เบียร์",
    amount: 1260,
    payerId: "oshi",
    category: "beer",
    mode: "equal",
    note: "โอชิไม่กินเบียร์",
    participants: {
      oshi: { included: false, weight: 1, fixed: 0 },
    },
  },
  {
    id: uid(),
    title: "น้ำมัน",
    amount: 1500,
    payerId: "tee",
    category: "fuel",
    mode: "custom",
    note: "น๊อตออกค่าน้ำมันเอง 500 บาท ที่เหลือหาร",
    participants: {
      not: { included: true, weight: 1, fixed: 500 },
    },
  },
  {
    id: uid(),
    title: "อาหารเช้า",
    amount: 680,
    payerId: "som",
    category: "food",
    mode: "equal",
    note: "",
    participants: {},
  },
];

const defaultTrip = {
  id: "trip-rayong",
  name: "ทริประยอง 15-16 พ.ค.",
  subtitle: "15-16 พฤษภาคม 2568 (2 วัน 1 คืน)",
  closedAt: "",
  members: clone(defaultMembers),
  expenses: clone(defaultExpenses),
};

let trips = [clone(defaultTrip)];
let currentTripId = defaultTrip.id;
let members = trips[0].members;
let expenses = trips[0].expenses;
const savedState = loadState();
const sharedState = loadSharedStateFromUrl();
let sharedStateLoaded = Boolean(sharedState);
if (sharedState || savedState) {
  const initialState = sharedState || savedState;
  trips = initialState.trips;
  currentTripId = initialState.currentTripId;
  syncCurrentTripRefs();
}

let currentView = "overview";
let selectedMode = "equal";
let toastTimer;

const categoryMeta = {
  food: { icon: "utensils", className: "food", color: "#f97316" },
  beer: { icon: "beer", className: "mint", color: "#16a34a" },
  stay: { icon: "bed-double", className: "purple", color: "#7c3aed" },
  fuel: { icon: "fuel", className: "blue", color: "#1768d5" },
  other: { icon: "badge-baht", className: "orange", color: "#f97316" },
};

const $ = (selector) => document.querySelector(selector);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uid(prefix = "id") {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function statePayload() {
  return { trips, currentTripId, updatedAt: new Date().toISOString() };
}

function applyState(state) {
  if (!state) return false;
  const normalized = normalizeState(state);
  if (!normalized) return false;
  trips = normalized.trips;
  currentTripId = normalized.currentTripId;
  syncCurrentTripRefs();
  return true;
}

function normalizeState(state) {
  if (Array.isArray(state.trips)) {
    const restoredTrips = state.trips.map(sanitizeTrip).filter(Boolean);
    if (!restoredTrips.length) return null;
    return {
      trips: restoredTrips,
      currentTripId: restoredTrips.some((trip) => trip.id === state.currentTripId) ? state.currentTripId : restoredTrips[0].id,
    };
  }

  if (Array.isArray(state.members) && Array.isArray(state.expenses)) {
    return {
      trips: [
        sanitizeTrip({
          ...defaultTrip,
          members: state.members,
          expenses: state.expenses,
        }),
      ],
      currentTripId: defaultTrip.id,
    };
  }

  return null;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function loadSharedStateFromUrl() {
  const value = sharedHashValue();
  if (!value) return null;
  try {
    const normalized = normalizeState(decodeSharePayload(value));
    if (normalized) return normalized;
  } catch {}
  sharedLinkError = true;
  return null;
}

async function loadCompressedSharedStateFromUrl() {
  const value = compressedSharedHashValue();
  if (!value) return false;
  try {
    const normalized = normalizeState(await decodeCompressedSharePayload(value));
    if (!normalized) throw new Error("Invalid shared state");
    trips = normalized.trips;
    currentTripId = normalized.currentTripId;
    syncCurrentTripRefs();
    sharedStateLoaded = true;
    renderAll();
    setView("settlements");
    showAllSettlementsDetail();
    showToast("\u0e40\u0e1b\u0e34\u0e14\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e08\u0e32\u0e01\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e41\u0e0a\u0e23\u0e4c\u0e41\u0e25\u0e49\u0e27");
    return true;
  } catch {
    sharedLinkError = true;
    showToast("\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e41\u0e0a\u0e23\u0e4c\u0e44\u0e21\u0e48\u0e2a\u0e21\u0e1a\u0e39\u0e23\u0e13\u0e4c");
    return false;
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(statePayload()));
  } catch {
    showToast("บันทึกข้อมูลในเครื่องไม่สำเร็จ");
  }

  if (!remoteSaveEnabled) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(syncStateToServer, 180);
}

async function hydrateSharedState() {
  if (sharedStateLoaded || !canUseSharedStateApi()) return;
  try {
    const response = await fetch(API_STATE_URL, { cache: "no-store" });
    if (!response.ok) return;
    const state = await response.json();
    remoteSaveEnabled = true;
    if (Object.keys(state).length && applyState(state)) {
      renderAll();
      showToast("โหลดข้อมูลกลางจาก LAN แล้ว");
      return;
    }
    await syncStateToServer();
  } catch {
    remoteSaveEnabled = false;
  }
}

async function syncStateToServer() {
  if (!canUseSharedStateApi()) return;
  try {
    const response = await fetch(API_STATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(statePayload()),
    });
    remoteSaveEnabled = response.ok;
  } catch {
    remoteSaveEnabled = false;
    showToast("เชื่อม server กลางไม่ได้ บันทึกเฉพาะเครื่องนี้");
  }
}

function sanitizeTrip(trip) {
  if (!trip || !Array.isArray(trip.members) || !Array.isArray(trip.expenses)) return null;
  return {
    id: trip.id || `trip-${Date.now()}`,
    name: trip.name || "ทริปใหม่",
    subtitle: trip.subtitle || "บันทึกแบบแมนนวลในเครื่องนี้",
    closedAt: trip.closedAt || "",
    confirmedTransfers: trip.confirmedTransfers && typeof trip.confirmedTransfers === "object" ? trip.confirmedTransfers : {},
    members: trip.members.map((member, index) => ({
      ...member,
      id: member.id || `member-${Date.now()}-${index}`,
      name: member.name || `คนที่ ${index + 1}`,
      abbr: member.abbr || defaultMembers[index % defaultMembers.length]?.abbr || makeMemberAbbr(member.name),
      active: member.active !== false,
      color: member.color || defaultMembers[index % defaultMembers.length]?.color || pickColor(member.name),
      payment: sanitizePayment(member.payment),
    })),
    expenses: trip.expenses,
  };
}

function sanitizePayment(payment = {}) {
  const type = payment.type === "bank" ? "bank" : "promptpay";
  return {
    type,
    bank: thaiBanks.includes(payment.bank) ? payment.bank : thaiBanks[0],
    account: String(payment.account || "").trim(),
  };
}

function currentTrip() {
  return trips.find((trip) => trip.id === currentTripId) || trips[0];
}

function isTripClosed(trip = currentTrip()) {
  return Boolean(trip?.closedAt);
}

function openTrips() {
  return trips.filter((trip) => !isTripClosed(trip));
}

function closedTrips() {
  return trips.filter((trip) => isTripClosed(trip)).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
}

function syncCurrentTripRefs() {
  if (!trips.some((trip) => trip.id === currentTripId)) currentTripId = trips[0].id;
  const trip = currentTrip();
  members = trip.members;
  expenses = trip.expenses;
}

function pickColor(seed) {
  const colors = ["#ef7d9a", "#2563eb", "#10b981", "#f59e0b", "#0ea5c7", "#7c3aed", "#f97316", "#64748b"];
  const total = Array.from(seed || "หารกัน").reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return colors[total % colors.length];
}

function makeMemberAbbr(name) {
  const clean = String(name || "").trim();
  const ascii = clean.match(/[A-Za-z0-9]+/g);
  if (ascii?.length) return ascii.map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const thaiMap = {
    "ส้ม": "S",
    "น๊อต": "N",
    "น็อต": "N",
    "โอชิ": "O",
    "แป้ง": "P",
    "แบงค์": "B",
    "พี่ตี้": "T",
  };
  return thaiMap[clean] || "M";
}

function memberAbbr(member) {
  return (member?.abbr || makeMemberAbbr(member?.name)).slice(0, 2).toUpperCase();
}

function formatBaht(value) {
  return new Intl.NumberFormat("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.max(0, Math.abs(value)));
}

function memberById(id) {
  return members.find((member) => member.id === id);
}

function activeMembers() {
  return members.filter((member) => member.active);
}

function bankOptions(selectedBank = thaiBanks[0]) {
  return thaiBanks.map((bank) => `<option value="${escapeHtml(bank)}" ${bank === selectedBank ? "selected" : ""}>${escapeHtml(bank)}</option>`).join("");
}

function memberPayment(member) {
  return sanitizePayment(member?.payment);
}

function paymentLabel(member) {
  const payment = memberPayment(member);
  if (!payment.account) return "ยังไม่ได้ใส่เลขบัญชี";
  return payment.type === "bank" ? `${payment.bank} ${payment.account}` : `พร้อมเพย์ ${payment.account}`;
}

function accountCopyText(member) {
  const payment = memberPayment(member);
  return payment.account;
}

function normalizeParticipants(expense) {
  const active = activeMembers();
  const result = {};
  active.forEach((member) => {
    result[member.id] = {
      included: true,
      weight: 1,
      fixed: 0,
      ...(expense.participants?.[member.id] || {}),
    };
  });
  return result;
}

function calculateExpenseShares(expense) {
  const amount = expenseAmount(expense);
  const subItems = conditionalSubItems(expense);
  if (subItems.length) {
    const subTotal = subItemsTotal(subItems);
    const baseShares = calculateBaseShares(expense, Math.max(0, amount - subTotal));
    const subShares = calculateSubItemShares(expense);
    Object.entries(subShares).forEach(([memberId, share]) => {
      baseShares[memberId] = (baseShares[memberId] || 0) + share;
    });
    return baseShares;
  }

  return calculateBaseShares(expense, amount);
}

function calculateBaseShares(expense, amount) {
  const participants = normalizeParticipants(expense);
  const shares = {};
  const included = Object.entries(participants).filter(([, config]) => config.included);

  if (!included.length || amount <= 0) return shares;

  if (expense.mode === "custom") {
    let fixedTotal = 0;
    const flexIds = [];
    included.forEach(([memberId, config]) => {
      const fixed = Number(config.fixed) || 0;
      if (fixed > 0) {
        shares[memberId] = fixed;
        fixedTotal += fixed;
      } else {
        flexIds.push(memberId);
      }
    });
    const remaining = Math.max(0, amount - fixedTotal);
    const flexShare = flexIds.length ? remaining / flexIds.length : 0;
    flexIds.forEach((memberId) => {
      shares[memberId] = flexShare;
    });
    return shares;
  }

  if (expense.mode === "time") {
    const totalWeight = included.reduce((sum, [, config]) => sum + Math.max(0, Number(config.weight) || 0), 0);
    if (!totalWeight) return shares;
    included.forEach(([memberId, config]) => {
      shares[memberId] = (amount * Math.max(0, Number(config.weight) || 0)) / totalWeight;
    });
    return shares;
  }

  const equalShare = amount / included.length;
  included.forEach(([memberId]) => {
    shares[memberId] = equalShare;
  });
  return shares;
}

function calculateSubItemShares(expense) {
  const shares = {};
  conditionalSubItems(expense).forEach((item) => {
    const amount = Number(item.amount) || 0;
    const participantIds = (item.participantIds || []).filter((id) => members.some((member) => member.id === id));
    if (amount <= 0 || !participantIds.length) return;
    const share = amount / participantIds.length;
    participantIds.forEach((memberId) => {
      shares[memberId] = (shares[memberId] || 0) + share;
    });
  });
  return shares;
}

function expenseAmount(expense) {
  return Number(expense.amount) || 0;
}

function subItemsTotal(subItems = []) {
  return subItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function normalizedMemberIds(ids = []) {
  const validIds = new Set(members.map((member) => member.id));
  return Array.from(new Set(ids.filter((id) => validIds.has(id)))).sort();
}

function sameMemberIds(a = [], b = []) {
  const left = normalizedMemberIds(a);
  const right = normalizedMemberIds(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function mainParticipantIds(expense) {
  return Object.entries(normalizeParticipants(expense))
    .filter(([, config]) => config.included)
    .map(([memberId]) => memberId);
}

function conditionalSubItems(expense) {
  const subItems = Array.isArray(expense.subItems) ? expense.subItems : [];
  const mainIds = mainParticipantIds(expense);
  return subItems.filter((item) => {
    const amount = Number(item.amount) || 0;
    const participantIds = normalizedMemberIds(item.participantIds || []);
    return amount > 0 && participantIds.length > 0 && !sameMemberIds(participantIds, mainIds);
  });
}

function splitModeLabel(mode) {
  if (mode === "time") return "หารตามเวลา";
  if (mode === "custom") return "เฉพาะบางส่วน";
  return "หารเท่ากัน";
}

function memberNamesByIds(ids = []) {
  const names = ids.map((id) => memberById(id)?.name).filter(Boolean);
  return names.length ? names.join(", ") : "ไม่มีคนหาร";
}

function expenseParticipantNames(expense) {
  return memberNamesByIds(mainParticipantIds(expense));
}

function expenseDetailsText(expense) {
  const payer = memberById(expense.payerId);
  const amount = expenseAmount(expense);
  const subItems = conditionalSubItems(expense);
  const subTotal = subItemsTotal(subItems);
  const baseAmount = Math.max(0, amount - subTotal);
  const lines = [
    expense.title,
    `คนจ่ายก่อน: ${payer?.name || "-"}`,
    `ยอดหลัก: ${formatBaht(amount)} บาท`,
    `วิธีหารหลัก: ${splitModeLabel(expense.mode)}`,
    `หารหลักกับ: ${expenseParticipantNames(expense)}`,
  ];

  if (expense.note) lines.push(`หมายเหตุ: ${expense.note}`);

  if (!subItems.length) {
    lines.push("ยอดนี้ไม่มีเงื่อนไขย่อย จึงหารตามเงื่อนไขหลักทั้งหมด");
    return lines.join("\n");
  }

  lines.push(`ยอดปกติที่เหลือ: ${formatBaht(baseAmount)} บาท (หารตามเงื่อนไขหลัก)`);
  lines.push("ยอดย่อยที่มีเงื่อนไข:");
  subItems.forEach((item) => {
    lines.push(`- ${item.title || "ยอดย่อย"}: ${formatBaht(Number(item.amount) || 0)} บาท / หาร: ${memberNamesByIds(item.participantIds || [])}`);
  });
  return lines.join("\n");
}

function calculateBalances() {
  const balances = new Map(members.map((member) => [member.id, { paid: 0, owes: 0, net: 0 }]));

  expenses.forEach((expense) => {
    if (balances.has(expense.payerId)) {
      balances.get(expense.payerId).paid += expenseAmount(expense);
    }
    Object.entries(calculateExpenseShares(expense)).forEach(([memberId, share]) => {
      if (balances.has(memberId)) balances.get(memberId).owes += share;
    });
  });

  balances.forEach((value) => {
    value.net = value.paid - value.owes;
  });

  return balances;
}

function calculateSettlements() {
  const balances = calculateBalances();
  const debtors = [];
  const creditors = [];

  balances.forEach((balance, memberId) => {
    const rounded = Math.round(balance.net * 100) / 100;
    if (rounded < -0.01) debtors.push({ memberId, amount: Math.abs(rounded) });
    if (rounded > 0.01) creditors.push({ memberId, amount: rounded });
  });

  debtors.sort((a, b) => b.amount - a.amount);
  creditors.sort((a, b) => b.amount - a.amount);

  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.amount, creditor.amount);

    if (amount > 0.01) {
      settlements.push({
        fromId: debtor.memberId,
        toId: creditor.memberId,
        amount: Math.round(amount * 100) / 100,
      });
    }

    debtor.amount = Math.round((debtor.amount - amount) * 100) / 100;
    creditor.amount = Math.round((creditor.amount - amount) * 100) / 100;
    if (debtor.amount <= 0.01) debtorIndex += 1;
    if (creditor.amount <= 0.01) creditorIndex += 1;
  }

  return settlements;
}

function settlementKey(item) {
  return `${item.fromId}|${item.toId}|${Math.round((Number(item.amount) || 0) * 100)}`;
}

function confirmedTransfers() {
  const trip = currentTrip();
  if (!trip.confirmedTransfers || typeof trip.confirmedTransfers !== "object") trip.confirmedTransfers = {};
  return trip.confirmedTransfers;
}

function confirmedTransferInfo(keyOrItem) {
  const key = typeof keyOrItem === "string" ? keyOrItem : settlementKey(keyOrItem);
  return confirmedTransfers()[key] || null;
}

function isTransferConfirmed(item) {
  return Boolean(confirmedTransferInfo(item));
}

function totalUnsettled() {
  return calculateSettlements().reduce((sum, item) => sum + item.amount, 0);
}

function iconMarkup(icon) {
  const paths = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    "receipt-text": '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M8 8h8"/><path d="M8 12h8"/><path d="M8 16h5"/>',
    "users-round": '<path d="M16 21v-2a4 4 0 0 0-8 0v2"/><circle cx="12" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M2 21v-2a4 4 0 0 1 3-3.9"/>',
    "clock-3": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5h5"/>',
    "arrow-left-right": '<path d="M8 7h13"/><path d="M18 4l3 3-3 3"/><path d="M16 17H3"/><path d="M6 14l-3 3 3 3"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    "circle-help": '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.7 2.7 0 1 1 4.8 1.7c-.9.9-2.3 1.3-2.3 3"/><path d="M12 17h.01"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    "chevron-down": '<path d="M6 9l6 6 6-6"/>',
    pencil: '<path d="M3 21l3.8-1 11-11a2.1 2.1 0 0 0-3-3l-11 11z"/><path d="M14 6l4 4"/>',
    "user-round-plus": '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><path d="M19 8v6"/><path d="M16 11h6"/>',
    ellipsis: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    "user-round-cog": '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a6 6 0 0 1 9.5-4.8"/><circle cx="18" cy="17" r="3"/><path d="M18 13v1"/><path d="M18 20v1"/><path d="M14 17h1"/><path d="M21 17h1"/>',
    "clipboard-list": '<path d="M9 4h6l1 2h3v15H5V6h3z"/><path d="M9 11h6"/><path d="M9 15h6"/><path d="M9 19h4"/>',
    utensils: '<path d="M4 3v8"/><path d="M7 3v8"/><path d="M10 3v8"/><path d="M7 11v10"/><path d="M17 3v18"/><path d="M14 3c4 2 4 7 0 9"/>',
    "chevron-right": '<path d="M9 18l6-6-6-6"/>',
    coins: '<ellipse cx="8" cy="7" rx="5" ry="3"/><path d="M3 7v6c0 1.7 2.2 3 5 3s5-1.3 5-3V7"/><path d="M11 11c.9-.6 2.3-1 4-1 2.8 0 5 1.3 5 3v4c0 1.7-2.2 3-5 3-1.7 0-3.2-.5-4-1.2"/>',
    "list-checks": '<path d="M10 6h10"/><path d="M10 12h10"/><path d="M10 18h10"/><path d="M3 6l1.5 1.5L7 5"/><path d="M3 12l1.5 1.5L7 11"/><path d="M3 18l1.5 1.5L7 17"/>',
    save: '<path d="M5 3h12l2 2v16H5z"/><path d="M8 3v6h8"/><path d="M8 21v-7h8v7"/>',
    "wallet-cards": '<path d="M4 7h16v13H4z"/><path d="M4 9l4-5h10v3"/><path d="M16 14h4"/>',
    "check-circle-2": '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    calculator: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8"/><path d="M8 11h2"/><path d="M12 11h2"/><path d="M16 11h.01"/><path d="M8 15h2"/><path d="M12 15h2"/><path d="M16 15h.01"/>',
    "message-circle": '<path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.7L3 21l1.8-5.5A8.5 8.5 0 1 1 21 11.5z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 3h-5l-.3 3.1a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 3.1h5l.3-3.1a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z"/>',
    wallet: '<path d="M4 7h16v13H4z"/><path d="M4 7l3-4h11v4"/><path d="M16 14h4"/>',
    "badge-baht": '<circle cx="12" cy="12" r="9"/><path d="M10 7v10"/><path d="M10 8h3a2 2 0 0 1 0 4h-3"/><path d="M10 12h4a2 2 0 0 1 0 4h-4"/><path d="M14 5v2"/><path d="M14 17v2"/>',
    beer: '<path d="M6 8h10v10a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z"/><path d="M16 10h2a3 3 0 0 1 0 6h-2"/><path d="M8 8V5h6v3"/>',
    "bed-double": '<path d="M3 11V5h7v6"/><path d="M21 11V7a2 2 0 0 0-2-2h-5v6"/><path d="M3 21v-8h18v8"/><path d="M3 17h18"/>',
    fuel: '<path d="M5 21V4h10v17"/><path d="M5 9h10"/><path d="M15 7l4 4v7a2 2 0 0 0 2 2"/><path d="M19 11h2"/>',
    "trash-2": '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    "arrow-right": '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    "share-2": '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-4.2"/><path d="M8.6 13.4l6.8 4.2"/>',
    bot: '<path d="M12 8V4"/><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M8 13h.01"/><path d="M16 13h.01"/><path d="M9 17h6"/>',
    terminal: '<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>',
    "refresh-cw": '<path d="M21 12a9 9 0 0 1-15.3 6.4"/><path d="M3 12A9 9 0 0 1 18.3 5.6"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/>',
    send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  };

  return `<svg class="lucide lucide-${icon}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[icon] || paths.home}</svg>`;
}

function renderIcons() {
  document.querySelectorAll("i[data-lucide]").forEach((node) => {
    node.outerHTML = iconMarkup(node.dataset.lucide);
  });
}

function avatarMarkup(member, size = "small") {
  const label = escapeHtml(member?.name || "?");
  const initial = escapeHtml(memberAbbr(member));
  const color = member?.color || pickColor(member?.name || "");
  const className = size === "large" ? "member-avatar" : "small-avatar";
  return `<span class="${className} avatar-initial" style="--avatar-color:${color}" aria-label="${label}">${initial}</span>`;
}

function renderTripHeader() {
  const trip = currentTrip();
  $("#tripNameLabel").textContent = trip.name;
  $("#tripSubtitleLabel").textContent = trip.subtitle;
  const selectableTrips = isTripClosed(trip) ? [trip, ...openTrips()] : openTrips();
  $("#tripSelect").innerHTML = selectableTrips.map((item) => `
    <option value="${item.id}" ${item.id === currentTripId ? "selected" : ""}>${escapeHtml(item.name)}</option>
  `).join("");
  $("#editTripNameInput").value = trip.name;
  $("#editTripSubtitleInput").value = trip.subtitle;
  $("#closeTripBtn").innerHTML = isTripClosed(trip) ? `${iconMarkup("archive")}ปิดแล้ว` : `${iconMarkup("archive")}ปิดทริป`;
  document.body.classList.toggle("is-trip-closed", isTripClosed(trip));
}

function addTrip(name, subtitle = "") {
  if (!name) return;
  const id = `trip-${Date.now()}`;
  trips.push({
    id,
    name,
    subtitle: subtitle || "บันทึกแบบแมนนวลในเครื่องนี้",
    closedAt: "",
    members: members.map((member) => ({ ...member, active: true })),
    expenses: [],
  });
  currentTripId = id;
  syncCurrentTripRefs();
  resetExpenseForm();
  saveState();
  renderAll();
  showToast(`สร้าง ${name} แล้ว`);
}

function editTripName(name, subtitle) {
  const trip = currentTrip();
  if (!name) return;
  trip.name = name;
  trip.subtitle = subtitle || "บันทึกแบบแมนนวลในเครื่องนี้";
  saveState();
  renderAll();
  showToast("แก้ไขชื่อทริปแล้ว");
}

function closeCurrentTrip() {
  const trip = currentTrip();
  if (isTripClosed(trip)) {
    setView("history");
    return;
  }
  if (!confirm(`ปิดทริป "${trip.name}" และย้ายไปบันทึกย้อนหลัง?`)) return;
  trip.closedAt = new Date().toISOString();
  const nextOpenTrip = openTrips()[0];
  if (nextOpenTrip) currentTripId = nextOpenTrip.id;
  syncCurrentTripRefs();
  saveState();
  renderAll();
  setView("history");
  showToast("ปิดทริปและบันทึกย้อนหลังแล้ว");
}

function viewHistoryTrip(id) {
  if (!trips.some((trip) => trip.id === id)) return;
  currentTripId = id;
  syncCurrentTripRefs();
  resetExpenseForm();
  saveState();
  renderAll();
  setView("overview");
  showToast(`เปิดรายละเอียด ${currentTrip().name}`);
}

function renderStats() {
  const total = expenses.reduce((sum, expense) => sum + expenseAmount(expense), 0);
  const latestCount = expenses.length;
  const activeCount = activeMembers().length;
  const unsettled = totalUnsettled();

  $("#statsGrid").innerHTML = `
    <article class="stat-card">
      <span class="soft-icon blue">${iconMarkup("wallet")}</span>
      <div>
        <small>ค่าใช้จ่ายรวมทั้งหมด</small>
        <strong>${formatBaht(total)} บาท</strong>
        <span>จาก ${latestCount} รายการ</span>
      </div>
    </article>
    <article class="stat-card">
      <span class="soft-icon mint">${iconMarkup("users-round")}</span>
      <div>
        <small>สมาชิกทั้งหมด</small>
        <strong>${activeCount} คน</strong>
        <span>ดูรายชื่อสมาชิก</span>
      </div>
    </article>
    <article class="stat-card overdue">
      <span class="soft-icon orange">${iconMarkup("badge-baht")}</span>
      <div>
        <small>ยอดคงค้างที่ยังไม่ลงตัว</small>
        <strong>${formatBaht(unsettled)} บาท</strong>
        <span>ยังต้องชำระ</span>
      </div>
    </article>
  `;
}

function renderExpenses() {
  const latest = expenses.slice(0, 5);
  $("#latestExpenses").innerHTML = latest.map((expense) => expenseRow(expense)).join("") || emptyState("ยังไม่มีรายการค่าใช้จ่าย");
  $("#allExpenses").innerHTML = expenses.map((expense) => expenseRow(expense, true)).join("") || emptyState("เพิ่มรายการแรกเพื่อเริ่มหารกัน");
}

function expenseRow(expense, editable = false) {
  const payer = memberById(expense.payerId);
  const meta = categoryMeta[expense.category] || categoryMeta.other;
  const subItems = conditionalSubItems(expense);
  if (Array.isArray(expense.subItems) && expense.subItems.length !== subItems.length) {
    expense = { ...expense, subItems };
  }
  const note = expense.note ? `<div class="expense-note">${escapeHtml(expense.note)}</div>` : "";
  const subItemNote = subItems.length
    ? `<div class="expense-note">แยก ${expense.subItems.length} ยอดย่อยจากยอดหลัก</div>`
    : "";
  const actions = editable
    ? `<div class="row-actions">
        <button class="icon-button" type="button" aria-label="แก้ไข ${escapeHtml(expense.title)}" data-edit-expense="${expense.id}">${iconMarkup("pencil")}</button>
        <button class="icon-button" type="button" aria-label="ลบ ${escapeHtml(expense.title)}" data-delete-expense="${expense.id}">${iconMarkup("trash-2")}</button>
      </div>`
    : "";

  return `
    <div class="expense-row" title="${escapeHtml(expenseDetailsText(expense))}">
      <span class="expense-icon soft-icon ${meta.className}">${iconMarkup(meta.icon)}</span>
      <div class="expense-main">
        <b>${escapeHtml(expense.title)}</b>
        <span>โดย ${escapeHtml(payer?.name || "-")} • ${expense.mode === "time" ? "หารตามเวลา" : expense.mode === "custom" ? "เฉพาะบางส่วน" : "หารเท่ากัน"}</span>
        ${note}
        ${subItemNote}
      </div>
      <div class="amount" style="color:${meta.color}">${formatBaht(expenseAmount(expense))} <small>บาท</small></div>
      ${actions}
    </div>
  `;
}

function renderMembers() {
  $("#memberCountLabel").textContent = activeMembers().length;
  $("#memberStrip").innerHTML = activeMembers().map((member) => `
    <div class="member-chip" title="${escapeHtml(member.name)}">
      ${avatarMarkup(member, "large")}
      <span class="member-label">${escapeHtml(member.name)}</span>
    </div>
  `).join("");

  $("#memberManager").innerHTML = members.map((member) => `
    <div class="member-card">
      ${avatarMarkup(member)}
      <label class="member-name-field">
        <span>ชื่อสมาชิก</span>
        <input type="text" value="${escapeHtml(member.name)}" data-member-name-input="${member.id}" />
      </label>
      <label class="member-abbr-field">
        <span>ตัวย่อ</span>
        <input type="text" maxlength="2" value="${escapeHtml(memberAbbr(member))}" data-member-abbr-input="${member.id}" />
      </label>
      <label class="member-payment-type-field">
        <span>ประเภทบัญชี</span>
        <select data-member-payment-type="${member.id}">
          <option value="promptpay" ${memberPayment(member).type === "promptpay" ? "selected" : ""}>พร้อมเพย์</option>
          <option value="bank" ${memberPayment(member).type === "bank" ? "selected" : ""}>เลขบัญชีธนาคาร</option>
        </select>
      </label>
      <label class="member-bank-field ${memberPayment(member).type === "bank" ? "" : "is-hidden"}">
        <span>ธนาคาร</span>
        <select data-member-bank="${member.id}">${bankOptions(memberPayment(member).bank)}</select>
      </label>
      <label class="member-account-field">
        <span>${memberPayment(member).type === "bank" ? "เลขบัญชี" : "เลขพร้อมเพย์"}</span>
        <input type="text" value="${escapeHtml(memberPayment(member).account)}" data-member-account="${member.id}" placeholder="${memberPayment(member).type === "bank" ? "เช่น 123-4-56789-0" : "เบอร์มือถือ/เลขบัตร/เลข e-Wallet"}" />
      </label>
      <button class="status-pill ${member.active ? "" : "out"}" data-toggle-member="${member.id}" type="button">
        ${member.active ? "อยู่ในทริป" : "ไม่ร่วม"}
      </button>
      <button class="icon-button" data-remove-member="${member.id}" type="button" aria-label="ลบ ${escapeHtml(member.name)}">${iconMarkup("trash-2")}</button>
    </div>
  `).join("");
}

function renderParticipantEditor(existingExpense = null) {
  const participants = normalizeParticipants(existingExpense || { participants: {}, mode: selectedMode });
  $("#participantGrid").innerHTML = activeMembers().map((member) => {
    const config = participants[member.id] || { included: true, weight: 1, fixed: 0 };
    const isTime = selectedMode === "time";
    const fields = isTime
      ? `<div class="participant-fields">
          <label>
            <span>ชั่วโมง</span>
            <input type="number" min="0" step="0.25" data-participant-weight="${member.id}" value="${Number(config.weight) || 1}" />
          </label>
        </div>`
      : `
        <input type="hidden" data-participant-weight="${member.id}" value="${Number(config.weight) || 1}" />
        <input type="hidden" data-participant-fixed="${member.id}" value="0" />
      `;
    return `
      <div class="participant-card ${config.included ? "" : "is-off"}" data-participant="${member.id}">
        <div class="participant-top">
          ${avatarMarkup(member)}
          <b>${escapeHtml(member.name)}</b>
          <label class="toggle" aria-label="${escapeHtml(member.name)} ร่วมหาร">
            <input type="checkbox" data-participant-included="${member.id}" ${config.included ? "checked" : ""} />
            <span></span>
          </label>
        </div>
        ${fields}
      </div>
    `;
  }).join("") || emptyState("เพิ่มสมาชิกก่อนจึงจะเลือกรายการหารได้");
}

function renderConditionItems(items = []) {
  $("#conditionItemsList").innerHTML = items.map((item) => conditionItemMarkup(item)).join("") || emptyState("ยังไม่ได้เพิ่มยอดย่อย รายการนี้จะใช้ยอดรวมด้านบนและเงื่อนไขหลัก");
  renderIcons();
}

function conditionItemMarkup(item) {
  const participantIds = item.participantIds || activeMembers().map((member) => member.id);
  return `
    <div class="condition-item" data-condition-item="${item.id}">
      <div class="condition-item-top">
        <label>
          <span>ชื่อยอดย่อย</span>
          <input type="text" data-condition-title="${item.id}" value="${escapeHtml(item.title || "")}" placeholder="เช่น เบียร์, ของส้ม" />
        </label>
        <label>
          <span>จำนวนเงิน</span>
          <input type="number" min="0" step="0.01" data-condition-amount="${item.id}" value="${Number(item.amount) || 0}" />
        </label>
        <button class="icon-button" type="button" data-remove-condition-item="${item.id}" aria-label="ลบยอดย่อย">${iconMarkup("trash-2")}</button>
      </div>
      <div>
        <b>หารกับใครบ้าง</b>
        <div class="condition-member-grid">
          ${activeMembers().map((member) => `
            <label class="condition-member">
              <input type="checkbox" data-condition-member="${item.id}" value="${member.id}" ${participantIds.includes(member.id) ? "checked" : ""} />
              <span>${escapeHtml(member.name)}</span>
            </label>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function collectConditionItemsFromForm() {
  return Array.from(document.querySelectorAll("[data-condition-item]")).map((element) => {
    const id = element.dataset.conditionItem;
    return {
      id,
      title: document.querySelector(`[data-condition-title="${id}"]`)?.value.trim() || "ยอดย่อย",
      amount: Number(document.querySelector(`[data-condition-amount="${id}"]`)?.value) || 0,
      participantIds: Array.from(document.querySelectorAll(`[data-condition-member="${id}"]:checked`)).map((input) => input.value),
    };
  }).filter((item) => item.amount > 0);
}

function addConditionItem() {
  const items = collectConditionItemsFromForm();
  items.push({
    id: uid("subitem"),
    title: "",
    amount: 0,
    participantIds: activeMembers().map((member) => member.id),
  });
  renderConditionItems(items);
}

function renderPayerOptions() {
  const active = activeMembers();
  const options = active.length
    ? active.map((member) => `<option value="${member.id}">${escapeHtml(member.name)}</option>`).join("")
    : `<option value="">เพิ่มสมาชิกก่อน</option>`;
  $("#expensePayerSelect").innerHTML = options;
}

function renderSettlements() {
  const settlements = calculateSettlements();
  const overviewItems = settlements.slice(0, 3);
  const unsettled = totalUnsettled();
  $("#unsettledLabel").textContent = unsettled ? `ยังไม่ลงตัว ${formatBaht(unsettled)} บาท` : "ลงตัวแล้ว";
  $("#overviewSettlements").innerHTML = overviewItems.map(settlementCard).join("") || emptyState("ทุกคนลงตัวแล้ว");
  $("#settlementList").innerHTML = settlements.map(settlementCard).join("") || emptyState("ไม่มียอดที่ต้องโอน");

  const balances = calculateBalances();
  $("#balanceTable").innerHTML = members.map((member) => {
    const balance = balances.get(member.id) || { paid: 0, owes: 0, net: 0 };
    const refund = Math.max(0, balance.net);
    const transfer = Math.max(0, -balance.net);
    return `
      <div class="balance-row">
        ${avatarMarkup(member)}
        <b>${escapeHtml(member.name)}</b>
        <div class="balance-metrics">
          <div class="balance-metric"><span>จ่ายไปทั้งหมด</span><strong>${formatBaht(balance.paid)}</strong></div>
          <div class="balance-metric"><span>ต้องรับผิดชอบ</span><strong>${formatBaht(balance.owes)}</strong></div>
          <div class="balance-metric"><span>ได้คืน</span><strong class="positive">${formatBaht(refund)}</strong></div>
          <div class="balance-metric"><span>ต้องโอน</span><strong class="${transfer > 0.01 ? "negative" : "neutral"}">${formatBaht(transfer)}</strong></div>
        </div>
      </div>
    `;
  }).join("");
}

function tripTotal(trip) {
  return trip.expenses.reduce((sum, expense) => sum + expenseAmount(expense), 0);
}

function renderHistory() {
  const archived = closedTrips();
  $("#historyList").innerHTML = archived.map((trip) => `
    <div class="history-card">
      <div>
        <span class="closed-pill">ปิดทริปแล้ว</span>
        <h3>${escapeHtml(trip.name)}</h3>
        <p>${escapeHtml(trip.subtitle || "บันทึกย้อนหลัง")} • ปิดเมื่อ ${formatClosedDate(trip.closedAt)}</p>
      </div>
      <div class="history-metric"><span>สมาชิก</span><strong>${trip.members.length} คน</strong></div>
      <div class="history-metric"><span>รายการ</span><strong>${trip.expenses.length} รายการ</strong></div>
      <div class="history-metric"><span>ยอดรวม</span><strong>${formatBaht(tripTotal(trip))} บาท</strong></div>
      <button class="primary-outline" type="button" data-view-history-trip="${trip.id}">${iconMarkup("chevron-right")}ดูรายละเอียด</button>
    </div>
  `).join("") || emptyState("ยังไม่มีทริปที่ปิดแล้ว");
}

function formatClosedDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function settlementCard(item) {
  const from = memberById(item.fromId);
  const to = memberById(item.toId);
  const detailKey = settlementKey(item);
  const confirmed = isTransferConfirmed(item);
  const confirmedActions = confirmed
    ? `<button class="secondary-button settlement-slip-action" type="button" data-view-slip="${escapeHtml(detailKey)}">${iconMarkup("receipt-text")}ดูสลิป</button>
       <button class="icon-button transfer-cancel-round settlement-cancel-action" type="button" data-cancel-transfer="${escapeHtml(detailKey)}" aria-label="${CANCEL_TRANSFER_LABEL}" title="${CANCEL_TRANSFER_LABEL}">${iconMarkup("x")}</button>`
    : "";
  return `
    <div class="settlement-card ${confirmed ? "is-confirmed" : ""}">
      <div class="settlement-person">
        ${avatarMarkup(from)}
        ${confirmed ? `<span class="transfer-check" title="โอนแล้ว">${iconMarkup("check")}</span>` : ""}
        <b>${escapeHtml(from.name)}</b>
      </div>
      <span class="settlement-arrow">${iconMarkup("arrow-right")}</span>
      <div class="settlement-person">
        ${avatarMarkup(to)}
        <b>${escapeHtml(to.name)}</b>
      </div>
      <div class="amount">${formatBaht(item.amount)} บาท</div>
      <button class="secondary-button settlement-detail-action" type="button" data-share-settlement="${escapeHtml(detailKey)}">${iconMarkup("share-2")}แชร์รายละเอียด</button>
      ${confirmedActions}
    </div>
  `;
}

function settlementFromKey(key) {
  return calculateSettlements().find((item) => settlementKey(item) === key);
}

function expenseShareRows(expense) {
  const shares = calculateExpenseShares(expense);
  const rows = Object.entries(shares)
    .filter(([, amount]) => amount > 0.01)
    .map(([memberId, amount]) => `<span>${escapeHtml(memberById(memberId)?.name || "-")} ${formatBaht(amount)} บาท</span>`)
    .join("");
  return rows || "<span>ไม่มีคนหาร</span>";
}

function expenseConditionRows(expense) {
  const subItems = conditionalSubItems(expense);
  if (!subItems.length) return "";
  return `
    <div class="detail-subitems">
      ${subItems.map((item) => `
        <div>
          <b>${escapeHtml(item.title || "ยอดย่อย")}</b>
          <span>${formatBaht(item.amount)} บาท • หาร: ${escapeHtml(memberNamesByIds(item.participantIds || []))}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function settlementExpenseDetails() {
  return expenses.map((expense) => {
    const payer = memberById(expense.payerId);
    const subTotal = subItemsTotal(conditionalSubItems(expense));
    const normalAmount = Math.max(0, expenseAmount(expense) - subTotal);
    return `
      <article class="detail-expense-card">
        <div class="detail-expense-head">
          <div>
            <b>${escapeHtml(expense.title)}</b>
            <span>จ่ายก่อนโดย ${escapeHtml(payer?.name || "-")} • ${splitModeLabel(expense.mode)}</span>
          </div>
          <strong>${formatBaht(expenseAmount(expense))} บาท</strong>
        </div>
        <div class="detail-meta">
          <span>ยอดปกติ ${formatBaht(normalAmount)} บาท • หารหลักกับ ${escapeHtml(expenseParticipantNames(expense))}</span>
          ${expense.note ? `<span>หมายเหตุ: ${escapeHtml(expense.note)}</span>` : ""}
        </div>
        ${expenseConditionRows(expense)}
        <div class="detail-share-list">${expenseShareRows(expense)}</div>
      </article>
    `;
  }).join("") || emptyState("ยังไม่มีรายการค่าใช้จ่าย");
}

function showSettlementDetail(key) {
  const settlement = settlementFromKey(key);
  if (!settlement) {
    showToast("ไม่พบรายละเอียดการโอนนี้");
    return;
  }
  const from = memberById(settlement.fromId);
  const to = memberById(settlement.toId);
  const account = accountCopyText(to);
  $("#settlementDetailTitle").textContent = `${from?.name || "-"} โอนให้ ${to?.name || "-"}`;
  $("#settlementDetailBody").innerHTML = `
    <div class="detail-transfer-summary">
      <div class="settlement-person">${avatarMarkup(from)}<b>${escapeHtml(from?.name || "-")}</b></div>
      <span class="settlement-arrow">${iconMarkup("arrow-right")}</span>
      <div class="settlement-person">${avatarMarkup(to)}<b>${escapeHtml(to?.name || "-")}</b></div>
      <strong>${formatBaht(settlement.amount)} บาท</strong>
    </div>
    <div class="detail-account-box">
      <div>
        <span>บัญชีรับโอนของ ${escapeHtml(to?.name || "-")}</span>
        <b>${escapeHtml(paymentLabel(to))}</b>
      </div>
      <button class="secondary-button" type="button" data-copy-account="${escapeHtml(to?.id || "")}" ${account ? "" : "disabled"}>${iconMarkup("copy")}คัดลอกเลขบัญชี</button>
    </div>
    <div class="detail-section-title">
      <h3>รายละเอียดค่าใช้จ่ายและการหาร</h3>
    </div>
    <div class="detail-expense-list">${settlementExpenseDetails()}</div>
  `;
  $("#settlementDetailModal").classList.add("is-open");
  $("#settlementDetailModal").setAttribute("aria-hidden", "false");
  document.body.classList.add("has-modal");
  renderIcons();
}

function allTransferRows(settlements) {
  return settlements.map((item) => {
    const key = settlementKey(item);
    const from = memberById(item.fromId);
    const to = memberById(item.toId);
    const confirmed = confirmedTransferInfo(key);
    return `
      <div class="transfer-select-row ${confirmed ? "is-confirmed" : ""}">
        <input type="checkbox" data-settlement-select="${escapeHtml(key)}" data-settlement-amount="${item.amount}" ${confirmed ? "disabled" : "checked"} />
        <span class="transfer-select-main">
          <b>${confirmed ? `${iconMarkup("check")} ` : ""}${escapeHtml(from?.name || "-")} โอนให้ ${escapeHtml(to?.name || "-")}</b>
          <small>${escapeHtml(paymentLabel(to))}${confirmed?.slipName ? ` • สลิป: ${escapeHtml(confirmed.slipName)}` : ""}</small>
        </span>
        <strong>${formatBaht(item.amount)} บาท</strong>
        <button class="icon-button account-copy-button" type="button" data-copy-account="${escapeHtml(to?.id || "")}" ${accountCopyText(to) ? "" : "disabled"} aria-label="คัดลอก" title="คัดลอก">${iconMarkup("copy")}</button>
        ${confirmed ? `
          <button class="secondary-button transfer-slip-button" type="button" data-view-slip="${escapeHtml(key)}">${iconMarkup("receipt-text")}ดูสลิป</button>
          <button class="icon-button transfer-cancel-round transfer-cancel-button" type="button" data-cancel-transfer="${escapeHtml(key)}" aria-label="${CANCEL_TRANSFER_LABEL}" title="${CANCEL_TRANSFER_LABEL}">${iconMarkup("x")}</button>
        ` : ""}
      </div>
    `;
  }).join("");
}

function allBalanceRows() {
  const balances = calculateBalances();
  return members.map((member) => {
    const balance = balances.get(member.id) || { paid: 0, owes: 0, net: 0 };
    return `
      <div class="all-balance-row">
        ${avatarMarkup(member)}
        <b>${escapeHtml(member.name)}</b>
        <span>จ่ายไป ${formatBaht(balance.paid)}</span>
        <span>รับผิดชอบ ${formatBaht(balance.owes)}</span>
        <strong class="${balance.net >= 0 ? "positive" : "negative"}">${balance.net >= 0 ? "ได้คืน" : "ต้องโอน"} ${formatBaht(balance.net)} บาท</strong>
      </div>
    `;
  }).join("");
}

function shareableTripSnapshot() {
  const trip = clone(currentTrip());
  const confirmed = trip.confirmedTransfers || {};
  trip.confirmedTransfers = Object.fromEntries(Object.entries(confirmed).map(([key, info]) => [
    key,
    {
      confirmedAt: info.confirmedAt || "",
      slipName: info.slipName || "",
      slipType: info.slipType || "",
    },
  ]));
  return trip;
}

async function buildSettlementShareLink() {
  const trip = shareableTripSnapshot();
  const payload = {
    trips: [trip],
    currentTripId: trip.id,
    sharedAt: new Date().toISOString(),
  };
  const url = new URL(location.href);
  url.search = "";
  try {
    const compressed = await encodeCompressedSharePayload(payload);
    url.hash = compressed ? `z=${compressed}` : `s=${encodeSharePayload(payload)}`;
  } catch {
    url.hash = `s=${encodeSharePayload(payload)}`;
  }
  return url.toString();
}

async function copySettlementShareLink() {
  const link = await buildSettlementShareLink();
  if (await copyText(link)) {
    showToast("\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e41\u0e0a\u0e23\u0e4c\u0e41\u0e25\u0e49\u0e27");
  } else {
    showToast("\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e2d\u0e31\u0e15\u0e42\u0e19\u0e21\u0e31\u0e15\u0e34\u0e44\u0e21\u0e48\u0e44\u0e14\u0e49 \u0e25\u0e34\u0e07\u0e01\u0e4c\u0e16\u0e39\u0e01\u0e41\u0e2a\u0e14\u0e07\u0e44\u0e27\u0e49\u0e43\u0e2b\u0e49\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01");
    showCopyFallback(link);
  }
}

function showAllSettlementsDetail() {
  const settlements = calculateSettlements();
  if (!settlements.length) {
    showToast("ไม่มียอดที่ต้องโอน");
    return;
  }
  $("#settlementDetailTitle").textContent = "แชร์รายละเอียดทั้งหมด";
  $("#settlementDetailBody").innerHTML = `
    <div class="detail-section-title">
      <h3>ยอดของทุกคน</h3>
    </div>
    <div class="all-balance-list">${allBalanceRows()}</div>
    <div class="detail-section-title">
      <h3>เลือกยอดที่จะโอน</h3>
    </div>
    <div class="transfer-select-list">${allTransferRows(settlements)}</div>
    <div class="transfer-total-box">
      <span>รวมยอดที่เลือก</span>
      <strong id="selectedTransferTotal">0.00 บาท</strong>
    </div>
    <div class="detail-action-row">
      <button class="secondary-button full-width" type="button" data-copy-share-link>${iconMarkup("copy")}\u0e04\u0e31\u0e14\u0e25\u0e2d\u0e01\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e41\u0e0a\u0e23\u0e4c</button>
    </div>
    <label class="slip-upload">
      <span>แนบสลิป</span>
      <input id="transferSlipInput" type="file" accept="image/*,.pdf" />
      <small id="transferSlipName">ยังไม่ได้แนบสลิป</small>
    </label>
    <button class="primary-button full-width" id="confirmTransfersBtn" type="button" disabled title="กรุณาแนบสลิปก่อน">${iconMarkup("check-circle-2")}ยืนยันการโอน</button>
    <div class="detail-section-title">
      <h3>รายละเอียดค่าใช้จ่ายและการหารทั้งหมด</h3>
    </div>
    <div class="detail-expense-list">${settlementExpenseDetails()}</div>
  `;
  $("#settlementDetailModal").classList.add("is-open");
  $("#settlementDetailModal").setAttribute("aria-hidden", "false");
  document.body.classList.add("has-modal");
  updateSelectedTransferTotal();
  renderIcons();
}

function hideSettlementDetail() {
  $("#settlementDetailModal").classList.remove("is-open");
  $("#settlementDetailModal").setAttribute("aria-hidden", "true");
  document.body.classList.remove("has-modal");
}

function updateSelectedTransferTotal() {
  const target = $("#selectedTransferTotal");
  if (!target) return;
  const total = Array.from(document.querySelectorAll("[data-settlement-select]:checked"))
    .reduce((sum, input) => sum + (Number(input.dataset.settlementAmount) || 0), 0);
  target.textContent = `${formatBaht(total)} บาท`;
}

function updateSlipName() {
  const input = $("#transferSlipInput");
  const label = $("#transferSlipName");
  const confirmButton = $("#confirmTransfersBtn");
  if (!input || !label) return;
  const file = input.files?.[0];
  label.textContent = file?.name || "ยังไม่ได้แนบสลิป";
  if (confirmButton) {
    confirmButton.disabled = !file;
    confirmButton.title = file ? "ยืนยันการโอน" : "กรุณาแนบสลิปก่อน";
  }
}

function readSlipFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function confirmSelectedTransfers() {
  const selected = Array.from(document.querySelectorAll("[data-settlement-select]:checked:not(:disabled)"));
  if (!selected.length) {
    showToast("เลือกยอดที่จะยืนยันก่อน");
    return;
  }
  const slipFile = $("#transferSlipInput")?.files?.[0];
  if (!slipFile) {
    showToast("กรุณาแนบสลิปก่อนยืนยันการโอน");
    updateSlipName();
    return;
  }
  let slipData = "";
  try {
    slipData = await readSlipFile(slipFile);
  } catch {
    showToast("อ่านไฟล์สลิปไม่สำเร็จ ลองแนบใหม่อีกครั้ง");
    return;
  }
  const store = confirmedTransfers();
  selected.forEach((input) => {
    store[input.dataset.settlementSelect] = {
      confirmedAt: new Date().toISOString(),
      slipName: slipFile.name,
      slipType: slipFile.type || "",
      slipData,
    };
  });
  saveState();
  renderAll();
  showAllSettlementsDetail();
  showToast("ยืนยันการโอนแล้ว");
}

function showSlipDetail(key) {
  const info = confirmedTransferInfo(key);
  if (!info) {
    showToast("ยังไม่มีข้อมูลการโอนนี้");
    return;
  }
  if (!info.slipData) {
    showToast("รายการนี้ยังไม่มีไฟล์สลิปให้ดู");
    return;
  }
  const item = settlementFromKey(key);
  const from = item ? memberById(item.fromId) : null;
  const to = item ? memberById(item.toId) : null;
  const isPdf = String(info.slipType || "").includes("pdf") || String(info.slipData).startsWith("data:application/pdf");
  $("#settlementDetailTitle").textContent = "สลิปการโอน";
  $("#settlementDetailBody").innerHTML = `
    <div class="slip-view-head">
      <div>
        <b>${escapeHtml(from?.name || "-")} โอนให้ ${escapeHtml(to?.name || "-")}</b>
        <span>${info.slipName ? escapeHtml(info.slipName) : "สลิปการโอน"} • ${info.confirmedAt ? formatClosedDate(info.confirmedAt) : ""}</span>
      </div>
      <button class="icon-button transfer-cancel-round" type="button" data-cancel-transfer="${escapeHtml(key)}" aria-label="${CANCEL_TRANSFER_LABEL}" title="${CANCEL_TRANSFER_LABEL}">${iconMarkup("x")}</button>
    </div>
    <div class="slip-preview">
      ${isPdf
        ? `<iframe title="สลิปการโอน" src="${escapeHtml(info.slipData)}"></iframe>`
        : `<img src="${escapeHtml(info.slipData)}" alt="สลิปการโอน" />`}
    </div>
  `;
  $("#settlementDetailModal").classList.add("is-open");
  $("#settlementDetailModal").setAttribute("aria-hidden", "false");
  document.body.classList.add("has-modal");
  renderIcons();
}

function cancelTransfer(key) {
  const store = confirmedTransfers();
  if (!store[key]) {
    showToast("ยังไม่มีรายการโอนให้ยกเลิก");
    return;
  }
  if (!confirm(CANCEL_TRANSFER_CONFIRM)) return;
  delete store[key];
  saveState();
  renderAll();
  showAllSettlementsDetail();
  showToast("ยกเลิกการโอนแล้ว");
}

async function copyMemberAccount(memberId) {
  const member = memberById(memberId);
  const account = accountCopyText(member);
  if (!account) {
    showToast("ยังไม่ได้ใส่เลขบัญชีของคนรับโอน");
    return;
  }
  if (await copyText(account)) {
    showToast("คัดลอกเลขบัญชีแล้ว");
  } else {
    showToast("คัดลอกอัตโนมัติไม่ได้ เลือกคัดลอกจากหน้ารายละเอียดแทน");
  }
}

function renderTimeExample() {
  const total = 4800;
  const fullPeople = 6;
  const fullHours = 6;
  const latePeople = 2;
  const lateHours = 2;
  const units = fullPeople * fullHours + latePeople * lateHours;
  const unitCost = total / units;

  $("#timeExampleBox").innerHTML = `
    <div class="formula-row"><span>${fullPeople} คน x ${fullHours} ชม.</span><strong>${fullPeople * fullHours} หน่วย</strong></div>
    <div class="formula-row"><span>${latePeople} คน x ${lateHours} ชม.</span><strong>${latePeople * lateHours} หน่วย</strong></div>
    <div class="formula-row"><span>รวม</span><strong>${units} หน่วย</strong></div>
    <div class="formula-row"><span>ค่าใช้จ่ายต่อหน่วย</span><strong>${formatBaht(unitCost)} บาท</strong></div>
    <div class="formula-row"><span>คนอยู่เต็มเวลา</span><strong>${formatBaht(fullHours * unitCost)} บาท</strong></div>
    <div class="formula-row"><span>คนมาช่วงหลัง</span><strong>${formatBaht(lateHours * unitCost)} บาท</strong></div>
  `;
}

function renderStaticCopy() {
  const conditionHelp = document.querySelector(".conditional-editor .section-head span");
  if (conditionHelp) {
    conditionHelp.textContent = "ใส่เฉพาะยอดย่อยที่มีเงื่อนไขพิเศษ เช่น บางคนกิน/ไม่กิน ยอดที่เหลือจากยอดหลักจะหารตามรายชื่อหลักด้านบน";
  }
}

function isGithubPagesHost() {
  return location.hostname.endsWith("github.io");
}

function lineWebhookUrl() {
  if (isGithubPagesHost()) return "https://<your-backend-domain>/line/webhook";
  return `${location.origin}${LINE_WEBHOOK_PATH}`;
}

function lineEnvCommand() {
  const secret = $("#lineChannelSecretInput")?.value.trim() || "<CHANNEL_SECRET>";
  const token = $("#lineAccessTokenInput")?.value.trim() || "<CHANNEL_ACCESS_TOKEN>";
  return [
    `$env:LINE_CHANNEL_SECRET="${secret}"`,
    `$env:LINE_CHANNEL_ACCESS_TOKEN="${token}"`,
    "python server.py",
  ].join("\n");
}

function defaultLineAiModels() {
  return [
    { label: "GPT 5.4 mini", value: "gpt-5.4-mini", inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5 },
    { label: "GPT 4o1 mini", value: "gpt-4.1-mini", inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 },
  ];
}

function lineCurlCommand() {
  return [
    `curl -X POST "${lineWebhookUrl()}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "{\\"destination\\":\\"local-test\\",\\"events\\":[]}"`,
  ].join("\n");
}

function renderLineWebhookPage() {
  const webhookLabel = $("#lineWebhookUrlLabel");
  if (!webhookLabel) return;
  webhookLabel.textContent = lineWebhookUrl();
  $("#lineRuntimeLabel").textContent = isGithubPagesHost() ? "GitHub Pages" : "Server mode";
  $("#lineRuntimeHelp").textContent = isGithubPagesHost()
    ? "หน้านี้เป็น static site จึงใช้ดูคู่มือ/คัดลอกคำสั่งได้ แต่รับ webhook จริงไม่ได้"
    : "พร้อมใช้ endpoint บน origin นี้ ถ้าเปิดจาก public HTTPS";
  $("#lineEnvCommandBox").textContent = lineEnvCommand();
  $("#lineConfigStatusLabel").textContent = "กำลังตรวจสอบ...";
  if (isGithubPagesHost()) {
    $("#lineConfigStatusLabel").textContent = "ต้อง deploy backend";
    renderLineDashboardUnavailable("GitHub Pages ไม่มี backend สำหรับรับ LINE webhook โดยตรง");
    return;
  }
  refreshLineStatus();
}

async function refreshLineStatus() {
  if (isGithubPagesHost()) {
    renderLineWebhookPage();
    return;
  }
  try {
    const configResponse = await fetch(LINE_CONFIG_URL, { cache: "no-store" });
    const config = await configResponse.json();
    const secretText = config.channelSecretConfigured ? "Secret พร้อม" : "ยังไม่ตั้ง Secret";
    const tokenText = config.channelAccessTokenConfigured ? "Token พร้อม" : "ยังไม่ตั้ง Token";
    const openaiText = config.openaiApiKeyConfigured ? "OpenAI พร้อม" : config.aiReplyEnabled ? "ยังไม่ตั้ง OpenAI" : "";
    $("#lineConfigStatusLabel").textContent = [secretText, tokenText, openaiText].filter(Boolean).join(" / ");
    renderLineModelConfig(config);
  } catch {
    $("#lineConfigStatusLabel").textContent = "เชื่อม server ไม่ได้";
  }
  await refreshLineEvents();
}

function renderLineModelConfig(config) {
  const select = $("#lineAiModelSelect");
  if (!select) return;
  const options = Array.isArray(config.modelOptions) && config.modelOptions.length ? config.modelOptions : defaultLineAiModels();
  select.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}" ${option.value === config.aiModel ? "selected" : ""}>${escapeHtml(option.label)}</option>`)
    .join("");
  select.value = config.aiModel || options[0]?.value || "gpt-5.4-mini";
  const selected = options.find((option) => option.value === select.value) || options[0];
  const help = $("#lineAiModelHelp");
  if (help && selected) {
    help.textContent = `${selected.value} • ประมาณ $${Number(selected.inputUsdPerMillion || 0).toFixed(3)} in / $${Number(selected.outputUsdPerMillion || 0).toFixed(3)} out ต่อ 1M tokens`;
  }
}

async function refreshLineEvents() {
  const list = $("#lineEventsList");
  if (!list || isGithubPagesHost()) return;
  try {
    const response = await fetch(LINE_EVENTS_URL, { cache: "no-store" });
    const data = await response.json();
    const events = Array.isArray(data.events) ? data.events : [];
    renderLineAiSummary(data.usageSummary || {}, data.analytics || {});
    renderLineDashboard(data.analytics || {});
    renderLineMemories(data.memoryDetails || { items: Array.isArray(data.memories) ? data.memories : [], categories: [] });
    list.innerHTML = events.length ? events.slice(0, 8).map(lineEventMarkup).join("") : emptyState("ยังไม่มี webhook event");
  } catch {
    renderLineDashboardUnavailable("อ่าน dashboard ของวิมลไม่ได้");
    list.innerHTML = emptyState("อ่าน event ล่าสุดไม่ได้");
  }
}

function renderLineAiSummary(summary, analytics = {}) {
  const cost = $("#lineAiTotalCostLabel");
  const usage = $("#lineAiUsageLabel");
  const totals = analytics.totals || {};
  const totalUsd = totals.totalCostUsd ?? summary.estimatedUsd ?? 0;
  const totalThb = totals.totalCostThb ?? summary.estimatedThb ?? 0;
  if (cost) cost.textContent = `${formatUsd(totalUsd)} / ${formatThb(totalThb)}`;
  if (usage) {
    usage.textContent = `${formatInteger(totals.totalAiCalls ?? summary.openAiCalls ?? 0)} calls • ${formatInteger(totals.totalTokens ?? summary.totalTokens ?? 0)} tokens จาก ${formatInteger(totals.receivedMessages ?? summary.eventCount ?? 0)} ข้อความ`;
  }
}

function renderLineDashboard(analytics = {}) {
  const totals = analytics.totals || {};
  const today = analytics.today || {};
  $("#lineTodayReceivedLabel").textContent = formatInteger(today.receivedMessages || 0);
  $("#lineTodayRepliesLabel").textContent = formatInteger(today.repliedMessages || 0);
  $("#lineTodaySpontaneousLabel").textContent = formatInteger(today.spontaneousReplies || 0);
  $("#lineTodayReceivedTimes").textContent = summarizeLineTimes(today.receivedTimes, "ยังไม่มีข้อความวันนี้");
  $("#lineTodayRepliesTimes").textContent = summarizeLineTimes(today.repliedTimes, "ยังไม่ได้ตอบวันนี้");
  $("#lineTodaySpontaneousTimes").textContent = summarizeLineTimes(today.spontaneousTimes, "วันนี้ยังไม่ตอบเอง");
  $("#lineAverageCostPerDayLabel").textContent = formatUsd(totals.averageCostUsdPerDay || 0);
  $("#lineAverageCostPerDayThbLabel").textContent = formatThb(totals.averageCostThbPerDay || 0);
  renderLineHourlyChart(Array.isArray(analytics.hourlyToday) ? analytics.hourlyToday : []);
  renderLineSummaryMetrics(totals, analytics.dateRange || {});
  renderLineSpeakers(analytics.speakers || {});
}

function renderLineSummaryMetrics(totals = {}, dateRange = {}) {
  const target = $("#lineSummaryMetrics");
  if (!target) return;
  const items = [
    ["ข้อความรับรวมทั้งหมด", formatInteger(totals.receivedMessages || 0)],
    ["ข้อความตอบรวมทั้งหมด", formatInteger(totals.repliedMessages || 0)],
    ["ตอบเองแบบไม่มีคนเรียก", formatInteger(totals.spontaneousReplies || 0)],
    ["เฉลี่ยรับต่อวัน", formatDecimal(totals.averageReceivedPerDay || 0, 1)],
    ["เฉลี่ยตอบต่อวัน", formatDecimal(totals.averageRepliesPerDay || 0, 1)],
    ["จำนวนวันมีข้อมูล", `${formatInteger(totals.totalDays || 0)} วัน`],
    ["ค่าใช้จ่ายรวมทั้งหมด", `${formatUsd(totals.totalCostUsd || 0)} / ${formatThb(totals.totalCostThb || 0)}`],
    ["ช่วงข้อมูล", summarizeDateRange(dateRange.firstSeenAt, dateRange.lastSeenAt)],
  ];
  target.innerHTML = items.map(([label, value]) => `
    <div class="line-summary-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `).join("");
}

function renderLineHourlyChart(hourly = []) {
  const target = $("#lineHourlyChart");
  if (!target) return;
  if (!hourly.length) {
    target.innerHTML = emptyState("วันนี้ยังไม่มีข้อมูลรายชั่วโมง");
    return;
  }
  const maxValue = Math.max(...hourly.map((item) => Math.max(Number(item.received || 0), Number(item.replied || 0), Number(item.spontaneous || 0))), 1);
  target.innerHTML = hourly.map((item) => {
    const received = Number(item.received || 0);
    const replied = Number(item.replied || 0);
    const spontaneous = Number(item.spontaneous || 0);
    const total = received + replied + spontaneous;
    return `
      <div class="line-hour-bar" title="${escapeHtml(`${item.label} • รับ ${received} • ตอบ ${replied} • ตอบเอง ${spontaneous}`)}">
        <div class="line-hour-total">${escapeHtml(String(total))}</div>
        <div class="line-hour-bars">
          <span class="line-hour-col line-hour-col--received" style="height:${Math.max((received / maxValue) * 160, received ? 8 : 4)}px"></span>
          <span class="line-hour-col line-hour-col--replied" style="height:${Math.max((replied / maxValue) * 160, replied ? 8 : 4)}px"></span>
          <span class="line-hour-col line-hour-col--spontaneous" style="height:${Math.max((spontaneous / maxValue) * 160, spontaneous ? 8 : 4)}px"></span>
        </div>
        <div class="line-hour-label">${escapeHtml(item.label || "-")}</div>
      </div>
    `;
  }).join("");
}

function renderLineSpeakers(speakers = {}) {
  const top = $("#lineTopSpeakers");
  const bottom = $("#lineBottomSpeakers");
  if (top) {
    const topRows = Array.isArray(speakers.top) ? speakers.top : [];
    top.innerHTML = topRows.length ? topRows.map((speaker, index) => lineSpeakerMarkup(speaker, index + 1, "มาก")).join("") : emptyState("ยังไม่มีสถิติผู้พูด");
  }
  if (bottom) {
    const bottomRows = Array.isArray(speakers.bottom) ? speakers.bottom : [];
    bottom.innerHTML = bottomRows.length ? bottomRows.map((speaker, index) => lineSpeakerMarkup(speaker, index + 1, "น้อย")).join("") : emptyState("ยังไม่มีสถิติผู้พูด");
  }
}

function lineSpeakerMarkup(speaker, rank, toneLabel) {
  return `
    <div class="line-rank-item">
      <div class="line-rank-badge">${escapeHtml(String(rank))}</div>
      <div>
        <b>${escapeHtml(speaker.displayName || `สมาชิก ${speaker.userIdHash || "-"}`)}</b>
        <span>${escapeHtml(toneLabel)} • ${escapeHtml(String(speaker.userIdHash || "").slice(0, 8))}</span>
      </div>
      <small>${formatInteger(speaker.messageCount || 0)} ข้อความ</small>
    </div>
  `;
}

function renderLineMemories(payload) {
  const list = $("#lineMemoryList");
  const categories = $("#lineMemoryCategoryList");
  const memories = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  const categoryRows = Array.isArray(payload?.categories) ? payload.categories : [];
  if (categories) {
    categories.innerHTML = categoryRows.length
      ? categoryRows.map((item) => `<span class="line-memory-chip">${escapeHtml(item.category || "note")} <b>${formatInteger(item.count || 0)}</b></span>`).join("")
      : `<span class="line-memory-chip">ยังไม่มีหมวดความจำ</span>`;
  }
  if (!list) return;
  if (!memories.length) {
    list.innerHTML = emptyState("ยังไม่มีความจำที่บันทึกไว้");
    return;
  }
  list.innerHTML = memories.slice(0, 18).map((memory) => `
    <div class="line-memory-item line-memory-item--detailed">
      <div class="line-memory-main">
        <b>${escapeHtml(memory.text || "-")}</b>
        <div class="line-memory-tags">
          <span class="line-memory-tag">${escapeHtml(memory.category || "note")}</span>
          <span class="line-memory-tag">confidence ${formatDecimal(memory.confidence || 0, 2)}</span>
        </div>
        <div class="line-memory-owner">
          <span>owner ${escapeHtml(memory.ownerUserIdHash || "-")}</span>
          ${memory.chatIdHash ? `<span>group ${escapeHtml(memory.chatIdHash)}</span>` : ""}
        </div>
      </div>
      <small>${escapeHtml(formatThaiDateTime(memory.createdAt))}</small>
    </div>
  `).join("");
}

function renderLineDashboardUnavailable(message) {
  const fallback = emptyState(message);
  const ids = ["lineHourlyChart", "lineSummaryMetrics", "lineTopSpeakers", "lineBottomSpeakers", "lineMemoryList", "lineEventsList"];
  ids.forEach((id) => {
    const node = $(`#${id}`);
    if (node) node.innerHTML = fallback;
  });
  const categories = $("#lineMemoryCategoryList");
  if (categories) categories.innerHTML = `<span class="line-memory-chip">ยังไม่มีข้อมูล</span>`;
}

function lineEventMarkup(entry) {
  const first = entry.events?.[0] || {};
  const statusClass = entry.status === "ok" || entry.lineReplyOk ? "ok" : String(entry.status || "").includes("ignored") ? "idle" : "error";
  const replyHint = lineReplyHint(entry);
  const errorHint = lineEventErrorHint(entry);
  const directionText = entry.lineReplyStatus
    ? `รับแล้ว / ส่งกลับ ${entry.lineReplyStatus}`
    : String(entry.status || "").includes("ignored")
      ? "รับแล้ว / ไม่ตอบ"
      : "รับแล้ว";
  const tokenText = `${formatInteger(entry.inputTokens || 0)} in / ${formatInteger(entry.outputTokens || 0)} out`;
  const costText = `${formatUsd(entry.estimatedUsd || 0)} • ${formatThb(entry.estimatedThb || 0)}`;
  const messagePreview = entry.messagePreview || first.messagePreview || "";
  return `
    <div class="line-event-row line-event-row--${statusClass}">
      <div class="line-event-main">
        <div class="line-event-title">
          <b>${escapeHtml(first.type || entry.eventType || "webhook")}${first.messageType ? ` / ${escapeHtml(first.messageType)}` : ""}</b>
          <span class="line-event-status">${escapeHtml(directionText)}</span>
        </div>
        <span>${escapeHtml(first.text || entry.status || "ไม่มีข้อความ")} ${entry.eventCount ? `(${entry.eventCount} event)` : ""}</span>
        ${messagePreview ? `<div class="line-event-message"><strong>ข้อความที่ได้รับ</strong><span>${escapeHtml(messagePreview)}</span></div>` : ""}
        <div class="line-event-meta">
          <small>Agent: ${escapeHtml(entry.agent || "-")}</small>
          <small>Route: ${escapeHtml(entry.route || "-")}</small>
          <small>Latency: ${formatInteger(entry.latencyMs || 0)} ms</small>
          ${entry.savedMemoryCount ? `<small>จำได้: ${formatInteger(entry.savedMemoryCount)} รายการ</small>` : ""}
          ${entry.errorCode ? `<small class="line-event-error">Error: ${escapeHtml(entry.errorCode)}</small>` : ""}
          ${errorHint ? `<small class="line-event-error">${escapeHtml(errorHint)}</small>` : ""}
          ${replyHint ? `<small class="line-event-error">${escapeHtml(replyHint)}</small>` : ""}
        </div>
        <div class="line-event-cost">
          <span>Model: ${escapeHtml(entry.model || "-")}</span>
          <span>Calls: ${formatInteger(entry.openAiCalls || 0)}</span>
          <span>Tokens: ${tokenText}</span>
          <strong>${costText}</strong>
        </div>
      </div>
      <small>${escapeHtml(formatThaiDateTime(entry.receivedAt))}</small>
    </div>
  `;
}

function lineEventErrorHint(entry) {
  if (entry.errorCode === "LINE_SIGNATURE_INVALID") {
    return "Channel Secret ใน Firebase ไม่ตรงกับ Channel Secret ของ LINE OA ตอนนี้ ระบบจึงไม่อ่าน/ไม่ตอบข้อความนี้";
  }
  return "";
}

function lineReplyHint(entry) {
  if (!entry.lineReplyStatus || entry.lineReplyOk) return "";
  const detail = entry.lineReplyError ? ` • ${entry.lineReplyError}` : "";
  if (entry.lineReplyStatus === 400) return "LINE 400: ตอบกลับไม่ทัน/เป็น event เก่าหรือ event ทดสอบ จึงใช้ replyToken ไม่ได้";
  if (entry.lineReplyStatus === 401) return `LINE 401: Channel Access Token ไม่ถูกต้องหรือหมดอายุ${detail}`;
  if (entry.lineReplyStatus === 429) return `LINE 429: ส่งข้อความถี่เกินโควตา${detail}`;
  return `LINE ${entry.lineReplyStatus}: ส่งกลับไม่สำเร็จ${detail}`;
}

async function saveLineAiModel() {
  const select = $("#lineAiModelSelect");
  const result = $("#lineTestResult");
  if (!select || isGithubPagesHost()) return;
  try {
    const response = await fetch(LINE_CONFIG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiModel: select.value }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    showToast("บันทึก Model AI แล้ว");
    if (result) result.textContent = `บันทึก Model AI แล้ว: ${data.config?.modelLabel || select.value}`;
    await refreshLineStatus();
  } catch (error) {
    if (result) result.textContent = `บันทึก Model AI ไม่สำเร็จ: ${error.message}`;
  }
}

function formatThaiDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatThaiTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString("th-TH", { maximumFractionDigits: 0 });
}

function formatDecimal(value, digits = 1) {
  return Number(value || 0).toLocaleString("th-TH", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatUsd(value) {
  const amount = Number(value || 0);
  if (!amount) return "$0.000000";
  return `$${amount.toFixed(6)}`;
}

function formatThb(value) {
  const amount = Number(value || 0);
  if (!amount) return "฿0.0000";
  return `฿${amount.toFixed(4)}`;
}

function summarizeLineTimes(times, emptyText) {
  const values = (Array.isArray(times) ? times : []).map(formatThaiTime).filter(Boolean);
  if (!values.length) return emptyText;
  if (values.length === 1) return `เวลา ${values[0]}`;
  if (values.length <= 4) return values.join(", ");
  return `${values[0]} - ${values[values.length - 1]} • ${formatInteger(values.length)} ครั้ง`;
}

function summarizeDateRange(firstSeenAt, lastSeenAt) {
  if (!firstSeenAt || !lastSeenAt) return "-";
  const first = formatThaiDateTime(firstSeenAt);
  const last = formatThaiDateTime(lastSeenAt);
  return first === last ? first : `${first} ถึง ${last}`;
}

function updateLineEnvCommand() {
  const target = $("#lineEnvCommandBox");
  if (target) target.textContent = lineEnvCommand();
}

async function copyLineWebhookUrl() {
  if (await copyText(lineWebhookUrl())) showToast("คัดลอก Webhook URL แล้ว");
  else showCopyFallback(lineWebhookUrl());
}

async function copyLineEnvCommand() {
  const text = lineEnvCommand();
  if (await copyText(text)) showToast("คัดลอกคำสั่งตั้งค่า LINE แล้ว");
  else showCopyFallback(text);
}

async function copyLineCurlCommand() {
  const text = lineCurlCommand();
  if (await copyText(text)) showToast("คัดลอก curl ทดสอบแล้ว");
  else showCopyFallback(text);
}

async function saveLineConfigToServer() {
  const secret = $("#lineChannelSecretInput")?.value.trim() || "";
  const token = $("#lineAccessTokenInput")?.value.trim() || "";
  const result = $("#lineTestResult");
  if (isGithubPagesHost()) {
    result.textContent = "GitHub Pages บันทึก token ลง server ไม่ได้ ต้องเปิดจาก backend ที่รัน server.py";
    return;
  }
  if (!secret || !token) {
    showToast("กรุณาใส่ Channel Secret และ Channel Access Token ก่อน");
    return;
  }
  try {
    const response = await fetch(LINE_CONFIG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelSecret: secret, channelAccessToken: token }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    showToast("บันทึก LINE config ลง server แล้ว");
    result.textContent = "บันทึก LINE config แล้ว พร้อมทดสอบ webhook";
    await refreshLineStatus();
  } catch (error) {
    result.textContent = `บันทึก config ไม่สำเร็จ: ${error.message}`;
  }
}

async function lineTestSignature(body, secret) {
  if (!secret || !window.crypto?.subtle) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function testLineWebhook() {
  const result = $("#lineTestResult");
  if (isGithubPagesHost()) {
    result.textContent = "GitHub Pages รับ webhook ไม่ได้ ต้องทดสอบกับ backend ที่รัน server.py บน public HTTPS หรือ localhost";
    return;
  }
  const body = JSON.stringify({ destination: "local-test", events: [] });
  const secret = $("#lineChannelSecretInput")?.value.trim() || "";
  const headers = { "Content-Type": "application/json" };
  const signature = await lineTestSignature(body, secret);
  if (signature) headers["X-Line-Signature"] = signature;
  result.textContent = "กำลังทดสอบ...";
  try {
    const response = await fetch(LINE_WEBHOOK_PATH, { method: "POST", headers, body });
    const text = await response.text();
    result.textContent = `HTTP ${response.status}: ${text}`;
    await refreshLineStatus();
  } catch (error) {
    result.textContent = `ทดสอบไม่สำเร็จ: ${error.message}`;
  }
}

function renderAll() {
  document.body.dataset.currentView = currentView;
  renderStaticCopy();
  renderTripHeader();
  renderPayerOptions();
  renderStats();
  renderExpenses();
  renderMembers();
  renderSettlements();
  renderHistory();
  renderLineWebhookPage();
  renderTimeExample();
  renderParticipantEditor(getEditingExpense());
  renderIcons();
}

function setView(view) {
  currentView = view;
  document.body.dataset.currentView = view;
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("is-visible", section.id === `view-${view}`);
  });
  document.querySelectorAll("[data-nav] button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.view === view);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function getParticipantConfigFromForm() {
  const config = {};
  activeMembers().forEach((member) => {
    config[member.id] = {
      included: Boolean(document.querySelector(`[data-participant-included="${member.id}"]`)?.checked),
      weight: Number(document.querySelector(`[data-participant-weight="${member.id}"]`)?.value) || 0,
      fixed: Number(document.querySelector(`[data-participant-fixed="${member.id}"]`)?.value) || 0,
    };
  });
  return config;
}

function resetExpenseForm() {
  $("#expenseIdInput").value = "";
  $("#expenseFormTitle").textContent = "เพิ่มว่าใครจ่ายอะไร";
  $("#expenseTitleInput").value = "";
  $("#expenseAmountInput").value = "";
  $("#expenseCategorySelect").value = "food";
  $("#expenseNoteInput").value = "";
  selectedMode = "equal";
  document.querySelectorAll("#splitModeGroup button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.mode === selectedMode);
  });
  renderPayerOptions();
  renderParticipantEditor();
  renderConditionItems();
  renderIcons();
}

function getEditingExpense() {
  const id = $("#expenseIdInput")?.value;
  return id ? expenses.find((expense) => expense.id === id) : null;
}

function editExpense(id) {
  const expense = expenses.find((item) => item.id === id);
  if (!expense) return;

  $("#expenseIdInput").value = expense.id;
  $("#expenseFormTitle").textContent = "แก้ไขว่าใครจ่ายอะไร";
  $("#expenseTitleInput").value = expense.title;
  $("#expenseAmountInput").value = expense.amount;
  $("#expensePayerSelect").value = expense.payerId;
  $("#expenseCategorySelect").value = expense.category;
  $("#expenseNoteInput").value = expense.note || "";
  selectedMode = expense.mode;
  document.querySelectorAll("#splitModeGroup button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.mode === selectedMode);
  });
  renderParticipantEditor(expense);
  renderConditionItems(conditionalSubItems(expense));
  setView("expenses");
  renderIcons();
}

function deleteExpense(id) {
  currentTrip().expenses = expenses.filter((expense) => expense.id !== id);
  syncCurrentTripRefs();
  saveState();
  renderAll();
  showToast("ลบรายการแล้ว");
}

function buildSummaryText() {
  const balances = calculateBalances();
  const settlements = calculateSettlements();
  const total = expenses.reduce((sum, expense) => sum + expenseAmount(expense), 0);
  const trip = currentTrip();
  const lines = [
    `สรุป${trip.name}`,
    `ค่าใช้จ่ายรวม ${formatBaht(total)} บาท`,
    "",
    "รายการค่าใช้จ่าย:",
    ...expenses.flatMap((expense) => {
      const base = [`- ${expense.title}: ${formatBaht(expenseAmount(expense))} บาท โดย ${memberById(expense.payerId)?.name || "-"}`];
      const subItems = conditionalSubItems(expense);
      if (!subItems.length) return base;
      return [
        ...base,
        ...subItems.map((item) => {
          const names = (item.participantIds || []).map((id) => memberById(id)?.name).filter(Boolean).join(", ") || "ไม่มีคนหาร";
          return `  • ${item.title}: ${formatBaht(item.amount)} บาท (หาร: ${names})`;
        }),
      ];
    }),
    "",
    "ยอดแต่ละคน:",
    ...members.map((member) => {
      const balance = balances.get(member.id);
      const label = balance.net > 0.01 ? "รับคืน" : balance.net < -0.01 ? "ต้องโอน" : "ลงตัว";
      return `- ${member.name}: จ่ายก่อน ${formatBaht(balance.paid)} / รับผิดชอบ ${formatBaht(balance.owes)} / ${label} ${formatBaht(balance.net)} บาท`;
    }),
    "",
    "โอนให้กัน:",
    ...(settlements.length
      ? settlements.map((item) => `- ${memberById(item.fromId).name} โอนให้ ${memberById(item.toId).name} ${formatBaht(item.amount)} บาท`)
      : ["- ทุกคนลงตัวแล้ว"]),
  ];
  return lines.join("\n");
}

async function copySummary() {
  const text = buildSummaryText();
  if (await copyText(text)) {
    showToast("คัดลอกสรุปแล้ว พร้อมส่งเข้ากลุ่มไลน์");
  } else {
    showToast("คัดลอกอัตโนมัติไม่ได้ ข้อความสรุปถูกแสดงไว้ให้เลือกคัดลอก");
    showCopyFallback(text);
  }
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function showCopyFallback(text) {
  const existing = document.querySelector(".copy-fallback");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.className = "copy-fallback";
  box.innerHTML = `
    <div>
      <b>ข้อความสำหรับแชร์</b>
      <button class="icon-button" type="button" aria-label="ปิด">${iconMarkup("trash-2")}</button>
    </div>
    <textarea readonly rows="8"></textarea>
  `;
  box.querySelector("textarea").value = text;
  box.querySelector("button").addEventListener("click", () => box.remove());
  document.body.appendChild(box);
  box.querySelector("textarea").focus();
  box.querySelector("textarea").select();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function emptyState(message) {
  return `<div class="empty-state">${message}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const navButton = event.target.closest("[data-view]");
    const shortcut = event.target.closest("[data-view-shortcut]");
    const editButton = event.target.closest("[data-edit-expense]");
    const deleteButton = event.target.closest("[data-delete-expense]");
    const historyButton = event.target.closest("[data-view-history-trip]");
    const removeConditionButton = event.target.closest("[data-remove-condition-item]");
    const toggleMember = event.target.closest("[data-toggle-member]");
    const removeMember = event.target.closest("[data-remove-member]");
    const includedToggle = event.target.closest("[data-participant-included]");
    const shareSettlement = event.target.closest("[data-share-settlement]");
    const copyAccountButton = event.target.closest("[data-copy-account]");
    const closeSettlementModal = event.target.closest("[data-close-settlement-modal]");
    const confirmTransfersButton = event.target.closest("#confirmTransfersBtn");
    const viewSlipButton = event.target.closest("[data-view-slip]");
    const cancelTransferButton = event.target.closest("[data-cancel-transfer]");
    const copyShareLinkButton = event.target.closest("[data-copy-share-link]");
    const copyLineWebhookButton = event.target.closest("#copyLineWebhookUrlBtn");
    const copyLineEnvButton = event.target.closest("#copyLineEnvBtn");
    const copyLineCurlButton = event.target.closest("#copyLineCurlBtn");
    const refreshLineButton = event.target.closest("#refreshLineStatusBtn");
    const testLineButton = event.target.closest("#testLineWebhookBtn");
    const saveLineConfigButton = event.target.closest("#saveLineConfigBtn");
    const saveLineAiModelButton = event.target.closest("#saveLineAiModelBtn");

    if (event.target.closest("#addTripBtn")) {
      $("#newTripNameInput").focus();
      $("#newTripNameInput").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (event.target.closest("#editTripBtn")) {
      $("#editTripNameInput").focus();
      $("#editTripNameInput").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (event.target.closest("#closeTripBtn")) closeCurrentTrip();
    if (navButton) setView(navButton.dataset.view);
    if (shortcut) setView(shortcut.dataset.viewShortcut);
    if (editButton) editExpense(editButton.dataset.editExpense);
    if (deleteButton) deleteExpense(deleteButton.dataset.deleteExpense);
    if (historyButton) viewHistoryTrip(historyButton.dataset.viewHistoryTrip);
    if (shareSettlement) showSettlementDetail(shareSettlement.dataset.shareSettlement);
    if (copyAccountButton) copyMemberAccount(copyAccountButton.dataset.copyAccount);
    if (closeSettlementModal) hideSettlementDetail();
    if (confirmTransfersButton && !confirmTransfersButton.disabled) confirmSelectedTransfers();
    if (confirmTransfersButton && confirmTransfersButton.disabled) showToast("กรุณาแนบสลิปก่อนยืนยันการโอน");
    if (viewSlipButton) showSlipDetail(viewSlipButton.dataset.viewSlip);
    if (cancelTransferButton) cancelTransfer(cancelTransferButton.dataset.cancelTransfer);
    if (copyShareLinkButton) copySettlementShareLink();
    if (copyLineWebhookButton) copyLineWebhookUrl();
    if (copyLineEnvButton) copyLineEnvCommand();
    if (copyLineCurlButton) copyLineCurlCommand();
    if (refreshLineButton) refreshLineStatus();
    if (testLineButton) testLineWebhook();
    if (saveLineConfigButton) saveLineConfigToServer();
    if (saveLineAiModelButton) saveLineAiModel();
    if (removeConditionButton) {
      const id = removeConditionButton.dataset.removeConditionItem;
      renderConditionItems(collectConditionItemsFromForm().filter((item) => item.id !== id));
    }

    if (toggleMember) {
      const member = memberById(toggleMember.dataset.toggleMember);
      member.active = !member.active;
      saveState();
      renderAll();
    }

    if (removeMember) {
      const id = removeMember.dataset.removeMember;
      const index = members.findIndex((member) => member.id === id);
      if (index >= 0) {
        currentTrip().expenses = expenses.filter((expense) => expense.payerId !== id);
        members.splice(index, 1);
        syncCurrentTripRefs();
        saveState();
        renderAll();
        showToast("ลบสมาชิกและรายการที่คนนั้นจ่ายก่อนแล้ว");
      }
    }

    if (includedToggle) {
      includedToggle.closest(".participant-card")?.classList.toggle("is-off", !includedToggle.checked);
    }
  });

  document.addEventListener("change", (event) => {
    const nameInput = event.target.closest("[data-member-name-input]");
    const abbrInput = event.target.closest("[data-member-abbr-input]");
    const paymentTypeInput = event.target.closest("[data-member-payment-type]");
    const bankInput = event.target.closest("[data-member-bank]");
    const accountInput = event.target.closest("[data-member-account]");
    const settlementSelect = event.target.closest("[data-settlement-select]");
    const slipInput = event.target.closest("#transferSlipInput");

    if (settlementSelect) updateSelectedTransferTotal();
    if (slipInput) updateSlipName();

    if (nameInput) {
      const member = memberById(nameInput.dataset.memberNameInput);
      const nextName = nameInput.value.trim();
      if (member && nextName) {
        const oldAutoAbbr = makeMemberAbbr(member.name);
        member.name = nextName;
        if (!member.abbr || member.abbr === "M" || member.abbr === oldAutoAbbr) member.abbr = makeMemberAbbr(nextName);
        saveState();
        renderAll();
        showToast("แก้ไขชื่อสมาชิกแล้ว");
      }
    }

    if (abbrInput) {
      const member = memberById(abbrInput.dataset.memberAbbrInput);
      const nextAbbr = abbrInput.value.trim().toUpperCase().slice(0, 2);
      if (member && nextAbbr) {
        member.abbr = nextAbbr;
        saveState();
        renderAll();
        showToast("แก้ไขตัวย่อสมาชิกแล้ว");
      }
    }
    if (paymentTypeInput) {
      const member = memberById(paymentTypeInput.dataset.memberPaymentType);
      if (member) {
        member.payment = { ...memberPayment(member), type: paymentTypeInput.value === "bank" ? "bank" : "promptpay" };
        saveState();
        renderAll();
        showToast("บันทึกประเภทบัญชีแล้ว");
      }
    }

    if (bankInput) {
      const member = memberById(bankInput.dataset.memberBank);
      if (member) {
        member.payment = { ...memberPayment(member), type: "bank", bank: bankInput.value };
        saveState();
        renderAll();
        showToast("บันทึกธนาคารแล้ว");
      }
    }

    if (accountInput) {
      const member = memberById(accountInput.dataset.memberAccount);
      if (member) {
        member.payment = { ...memberPayment(member), account: accountInput.value.trim() };
        saveState();
        renderAll();
        showToast("บันทึกเลขบัญชีแล้ว");
      }
    }
  });

  $("#tripSelect").addEventListener("change", (event) => {
    currentTripId = event.target.value;
    syncCurrentTripRefs();
    resetExpenseForm();
    saveState();
    renderAll();
    showToast(`เปิด ${currentTrip().name}`);
  });

  $("#tripCreateForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#newTripNameInput").value.trim();
    const subtitle = $("#newTripSubtitleInput").value.trim();
    if (!name) {
      showToast("กรอกชื่อทริปก่อน");
      return;
    }
    addTrip(name, subtitle);
    $("#newTripNameInput").value = "";
    $("#newTripSubtitleInput").value = "";
  });

  $("#tripEditForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#editTripNameInput").value.trim();
    const subtitle = $("#editTripSubtitleInput").value.trim();
    if (!name) {
      showToast("กรอกชื่อทริปก่อน");
      return;
    }
    editTripName(name, subtitle);
  });

  $("#memberForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#memberNameInput").value.trim();
    if (!name) return;
    members.push({
      id: `member-${Date.now()}`,
      name,
      abbr: makeMemberAbbr(name),
      active: true,
      color: pickColor(name),
      payment: sanitizePayment(),
    });
    $("#memberNameInput").value = "";
    saveState();
    renderAll();
    showToast(`เพิ่ม ${name} แล้ว`);
  });

  $("#expenseForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!activeMembers().length) {
      showToast("เพิ่มสมาชิกในทริปนี้ก่อน แล้วค่อยเพิ่มรายการ");
      setView("members");
      return;
    }
    const id = $("#expenseIdInput").value || uid("expense");
    const rawSubItems = collectConditionItemsFromForm();
    const emptySplitItem = rawSubItems.find((item) => !item.participantIds.length);
    if (emptySplitItem) {
      showToast(`เลือกคนหารในยอดย่อย "${emptySplitItem.title}" อย่างน้อย 1 คน`);
      return;
    }
    const participants = getParticipantConfigFromForm();
    const subItems = conditionalSubItems({ participants, subItems: rawSubItems });
    const mainAmount = Number($("#expenseAmountInput").value) || 0;
    const subItemTotal = subItemsTotal(subItems);
    if (subItems.length && subItemTotal - mainAmount > 0.01) {
      showToast(`ยอดย่อยรวม ${formatBaht(subItemTotal)} บาท มากกว่ายอดหลัก ${formatBaht(mainAmount)} บาท`);
      return;
    }
    const payload = {
      id,
      title: $("#expenseTitleInput").value.trim(),
      amount: mainAmount,
      payerId: $("#expensePayerSelect").value,
      category: $("#expenseCategorySelect").value,
      mode: selectedMode,
      note: $("#expenseNoteInput").value.trim(),
      participants,
      subItems,
    };

    if (!payload.title || payload.amount <= 0 || !payload.payerId) {
      showToast("กรอกชื่อรายการ จำนวนเงิน และคนจ่ายก่อนให้ครบ");
      return;
    }

    const index = expenses.findIndex((expense) => expense.id === id);
    if (index >= 0) {
      expenses[index] = payload;
      saveState();
      showToast("แก้ไขรายการแล้ว");
    } else {
      expenses.unshift(payload);
      saveState();
      showToast("เพิ่มรายการแล้ว");
    }
    resetExpenseForm();
    renderAll();
  });

  $("#splitModeGroup").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    selectedMode = button.dataset.mode;
    document.querySelectorAll("#splitModeGroup button").forEach((item) => {
      item.classList.toggle("is-selected", item === button);
    });
    renderParticipantEditor(getEditingExpense());
    renderIcons();
  });

  $("#addConditionItemBtn").addEventListener("click", addConditionItem);

  $("#selectActiveMembersBtn").addEventListener("click", () => {
    activeMembers().forEach((member) => {
      const checkbox = document.querySelector(`[data-participant-included="${member.id}"]`);
      if (checkbox) {
        checkbox.checked = true;
        checkbox.closest(".participant-card")?.classList.remove("is-off");
      }
    });
  });

  $("#resetExpenseBtn").addEventListener("click", resetExpenseForm);
  $("#copySummaryBtn").addEventListener("click", copySummary);
  $("#shareLineBtn").addEventListener("click", copySummary);
  $("#shareAllSettlementsBtn").addEventListener("click", showAllSettlementsDetail);
}

bindEvents();
resetExpenseForm();
renderAll();
if (sharedStateLoaded) {
  setView("settlements");
  showAllSettlementsDetail();
  showToast("\u0e40\u0e1b\u0e34\u0e14\u0e02\u0e49\u0e2d\u0e21\u0e39\u0e25\u0e08\u0e32\u0e01\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e41\u0e0a\u0e23\u0e4c\u0e41\u0e25\u0e49\u0e27");
} else if (compressedSharedHashValue()) {
  loadCompressedSharedStateFromUrl().then((loaded) => {
    if (!loaded && !sharedLinkError) hydrateSharedState();
  });

  document.addEventListener("input", (event) => {
    if (event.target.closest("#lineChannelSecretInput, #lineAccessTokenInput")) updateLineEnvCommand();
  });
} else if (sharedLinkError) {
  showToast("\u0e25\u0e34\u0e07\u0e01\u0e4c\u0e41\u0e0a\u0e23\u0e4c\u0e44\u0e21\u0e48\u0e2a\u0e21\u0e1a\u0e39\u0e23\u0e13\u0e4c");
} else {
  hydrateSharedState();
}
