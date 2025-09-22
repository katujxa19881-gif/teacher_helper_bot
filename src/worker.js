// Cloudflare Worker: Telegram-бот "Учитель"
// Secrets: BOT_TOKEN
// Vars: PUBLIC_URL (без завершающего "/")
// KV: KV_BOT
//
// В BotFather: /setprivacy → Disable
//
// Главное:
// - Тишина на неизвестные вопросы (только пересылка учителю, если включено)
// - Подпись учителя выключена по умолчанию (вкл/выкл: /prefix on|off)
// - Класс по умолчанию: 1Б (меняется /default_class 2А)
// - Медиа-категории с одинаковыми подписями (#1Б ...), можно хранить несколько файлов
// - Триггеры для расписаний/подвоза/карт и школьных ситуаций

const OK = (b = "ok") => new Response(b, { status: 200 });
const NO = (code = 404, b = "not found") => new Response(b, { status: code });

/* ---------------- Telegram API ---------------- */
async function tg(method, token, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return res.json();
}
async function sendSafe(method, token, payload) {
  try {
    const r = await tg(method, token, payload);
    console.log("SEND", method, JSON.stringify(payload), "=>", JSON.stringify(r));
    return r;
  } catch (e) {
    console.log("SEND ERROR", method, e?.message || String(e));
    return null;
  }
}
async function sendToSameThread(method, token, msg, payload = {}) {
  const p = { ...payload, chat_id: msg.chat.id };
  if (
    (msg.chat?.type === "supergroup" || msg.chat?.type === "group") &&
    msg.is_topic_message &&
    msg.message_thread_id
  ) {
    p.message_thread_id = msg.message_thread_id;
  }
  return sendSafe(method, token, p);
}

/* ---------------- KV: состояние ---------------- */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) {
    return {
      teacher_id: null,
      teacher_display_name: "Ирина Владимировна",
      use_prefix: false, // подпись выключена по умолчанию
      default_class: "1Б",
      autoreply_enabled: true,
      forward_unknown_to_teacher: true,
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {},
      faq: [],
      teach: [],
    };
  }
  try {
    const s = JSON.parse(raw);
    s.teacher_display_name ||= "Ирина Владимировна";
    if (typeof s.use_prefix === "undefined") s.use_prefix = false;
    s.default_class ||= "1Б";
    if (typeof s.autoreply_enabled === "undefined") s.autoreply_enabled = true;
    if (typeof s.forward_unknown_to_teacher === "undefined") s.forward_unknown_to_teacher = true;
    s.policy_absence ||= "Выздоравливайте 🙌 Придите в школу со справкой от врача.";
    s.classes ||= {};
    s.faq ||= [];
    s.teach ||= [];
    return s;
  } catch {
    return {
      teacher_id: null,
      teacher_display_name: "Ирина Владимировна",
      use_prefix: false,
      default_class: "1Б",
      autoreply_enabled: true,
      forward_unknown_to_teacher: true,
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {},
      faq: [],
      teach: [],
    };
  }
}
async function saveState(env, state) { await env.KV_BOT.put("state", JSON.stringify(state)); }

const MEDIA_KEYS = [
  "schedule_lessons", // расписание уроков (последнее)
  "schedule_bells", // расписание звонков (последнее)
  "buses_city", // городские автобусы (последнее)
  "buses_villages", // подвоз/посёлки (последнее)
  "card_topup", // пополнение карты (несколько)
  "card_balance", // баланс карты (несколько)
];

function ensureClass(state, cls) {
  if (!state.classes[cls]) {
    state.classes[cls] = {
      general_chat_id: null,
      parents_chat_id: null,
      pickup_times: null,
      media: {
        schedule_lessons: [],
        schedule_bells: [],
        buses_city: [],
        buses_villages: [],
        card_topup: [],
        card_balance: [],
      },
    };
  } else {
    state.classes[cls].media ||= {};
    for (const k of MEDIA_KEYS) state.classes[cls].media[k] ||= [];
  }
}

/* ---------------- Утилиты ---------------- */
const DAYS = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
const DAYS_FULL = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
const TZ = "Europe/Kaliningrad";

function normalize(s = "") {
  return s.toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s#:+.()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseClassFrom(text = "") {
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, "") : null;
}
function extractLargestPhotoId(photos = []) {
  if (!photos?.length) return null;
  const by = [...photos].sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
  return by.at(-1)?.file_id || photos.at(-1)?.file_id || null;
}
function ruShortFromDate(d) {
  const idx = Number(new Date(d.toLocaleString("en-US", { timeZone: TZ })).getDay());
  return DAYS[idx];
}
function todayRuShort() { return ruShortFromDate(new Date()); }
function dayNameFull(short) { const i = DAYS.indexOf(short); return i >= 0 ? DAYS_FULL[i] : short; }
function dayShortFromInput(s = "") {
  const n = normalize(s);
  if (n === "сегодня") return todayRuShort();
  if (n === "завтра") { const d = new Date(); d.setUTCMinutes(d.getUTCMinutes() + 24*60); return ruShortFromDate(d); }
  const map = {
    "пн":"ПН","пон":"ПН","понедельник":"ПН","mon":"ПН","monday":"ПН",
    "вт":"ВТ","вторник":"ВТ","tue":"ВТ","tuesday":"ВТ",
    "ср":"СР","среда":"СР","wed":"СР","wednesday":"СР",
    "чт":"ЧТ","четверг":"ЧТ","thu":"ЧТ","thursday":"ЧТ",
    "пт":"ПТ","пятница":"ПТ","fri":"ПТ","friday":"ПТ",
    "сб":"СБ","суббота":"СБ","sat":"СБ","saturday":"СБ",
    "вс":"ВС","воскресенье":"ВС","sun":"ВС","sunday":"ВС",
  };
  return map[n] || null;
}
function pickClassFromChat(state, chatId) {
  for (const [k, v] of Object.entries(state.classes || {})) {
    if (v.general_chat_id === chatId || v.parents_chat_id === chatId) return k;
  }
  return state.default_class || "1Б";
}
function formatPickupWeek(mapping) {
  const order = ["ПН","ВТ","СР","ЧТ","ПТ","СБ","ВС"];
  return order.map(d => `${d} — ${mapping?.[d] || "—"}`).join("\n");
}

function userDisplay(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}
function addressPrefix(msg) {
  const u = msg.from || null;
  const disp = userDisplay(u);
  return disp ? `${disp}, ` : "";
}
function speak(state, msg, text) {
  const pref = addressPrefix(msg);
  const teacher = state.use_prefix ? `${state.teacher_display_name}: ` : "";
  return `${pref}${teacher}${text}`;
}

/* ---------------- Контекст (мини-память) ---------------- */
function ctxKey(msg) {
  const chat = msg.chat.id;
  const th = (msg.is_topic_message && msg.message_thread_id) ? msg.message_thread_id : 0;
  return `ctx::${chat}::${th}`;
}
async function rememberContext(env, msg, role, text) {
  const key = ctxKey(msg);
  const raw = await env.KV_BOT.get(key);
  let arr = [];
  if (raw) try { arr = JSON.parse(raw) || []; } catch { arr = []; }
  arr.push({ t: Date.now(), role, text: (text||"").slice(0, 800) });
  if (arr.length > 10) arr = arr.slice(arr.length - 10);
  await env.KV_BOT.put(key, JSON.stringify(arr));
}

/* ---------------- Забор (pickup) ---------------- */
function parsePickupMapping(str) {
  const out = {};
  const parts = str.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
  for (const p of parts) {
    const [kRaw, vRaw] = p.split("=").map(s=>s.trim());
    if (!kRaw || !vRaw) continue;
    const k = dayShortFromInput(kRaw) || kRaw.toUpperCase().slice(0,2);
    if (!DAYS.includes(k)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(vRaw)) continue;
    out[k] = vRaw;
  }
  return Object.keys(out).length ? out : null;
}
async function cmdPickupSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });

  const parts = args.trim().split(/\s+/);
  const cls = parseClassFrom(parts[0] || "") || state.default_class;
  ensureClass(state, cls);

  const rest = args.trim().slice(args.indexOf(parts[0]) + parts[0].length).trim();
  let mapping = null;
  if (rest.startsWith("{")) {
    try {
      const obj = JSON.parse(rest); const m = {};
      for (const [k,v] of Object.entries(obj || {})) {
        const kk = dayShortFromInput(k) || k.toString().toUpperCase().slice(0,2);
        if (DAYS.includes(kk) && /^\d{1,2}:\d{2}$/.test(String(v))) m[kk]=String(v);
      }
      mapping = Object.keys(m).length ? m : null;
    } catch { mapping = null; }
  } else {
    mapping = parsePickupMapping(rest);
  }
  if (!mapping) return sendToSameThread("sendMessage", token, msg, { text: "Не удалось распознать времена. Пример: /pickup_set 1Б ПН=13:30,ВТ=12:40" });

  state.classes[cls].pickup_times = mapping;
  await saveState(env, state);

  const pretty = Object.entries(mapping).map(([k,v])=>`${k}=${v}`).join(", ");
  await sendToSameThread("sendMessage", token, msg, { text: `Готово. Время забора для ${cls}: ${pretty}` });

  const rec = state.classes[cls];
  for (const chatId of [rec.general_chat_id, rec.parents_chat_id].filter(Boolean)) {
    await sendSafe("sendMessage", token, { chat_id: chatId, text: `Обновлено время забора (${cls}):\n` + formatPickupWeek(mapping) });
  }
}
async function cmdPickup(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  let day = null;

  if (args) {
    const maybeClass = parseClassFrom(args);
    if (maybeClass) cls = maybeClass;
    const maybeDay = dayShortFromInput(args) || (/сегодня/.test(normalize(args)) ? todayRuShort() : null);
    if (maybeDay) day = maybeDay;
  }
  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} ещё не задано время забора. /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` });

  const d = day || todayRuShort();
  const t = rec.pickup_times[d];
  if (!t) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} на ${dayNameFull(d)} время не задано.` });

  const text = speak(state, msg, `${cls}, ${dayNameFull(d)} — забираем в ${t}.`);
  await sendToSameThread("sendMessage", token, msg, { text });
}

/* ---------------- Распознавание триггеров ---------------- */
function extractTimeHHMM(text) { const m = text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractTimeFlexible(text) { const m = text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractDelayMinutes(text) { const m = normalize(text).match(/\bна\s+(\d{1,2})\s*мин/); return m ? parseInt(m[1], 10) : null; }

function resolvePickupNatural(state, msg, freeText) {
  const raw = (freeText || "").trim();
  let cls = pickClassFromChat(state, msg.chat.id);
  if (msg.chat.type === "private") {
    const m = parseClassFrom(raw);
    if (m) cls = m;
  }
  ensureClass(state, cls);
  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) return { ok:false, text:`Для ${cls} еще не задано время забора.` };

  let d = dayShortFromInput(raw);
  if (!d) {
    if (/\bзавтра\b/.test(normalize(raw))) { const now = new Date(); now.setUTCMinutes(now.getUTCMinutes() + 24*60); d = ruShortFromDate(now); }
    else d = todayRuShort();
  }
  const t = rec.pickup_times[d];
  if (!t) return { ok:false, text:`Для ${cls} на ${dayNameFull(d)} время не задано.` };

  return { ok:true, text: speak(state, msg, `${cls}, ${dayNameFull(d)} — забираем в ${t}.`) };
}

/* ---------------- Медиа-хранилище ---------------- */
function detectCategory(captionNorm) {
  // порядок от более специфичного к общему
  if (/(расписани[ея].*звонк|звонк|перемен)/.test(captionNorm)) return "schedule_bells";
  if (/(расписани[ея].*урок|уроки|на неделю|на завтра)/.test(captionNorm)) return "schedule_lessons";
  if (/(подвоз|поселк|посёлк)/.test(captionNorm)) return "buses_villages";
  if (/(автобус)/.test(captionNorm)) return "buses_city";
  if (/(пополнен|пополни|реквизит|оплата|сбербанк|через сбер)/.test(captionNorm)) return "card_topup";
  if (/(баланс.*карт|как.*проверить.*баланс)/.test(captionNorm)) return "card_balance";
  return null;
}

function pushMedia(state, cls, cat, media) {
  ensureClass(state, cls);
  const arr = state.classes[cls].media[cat] || [];
  // Для расписаний/автобусов храним только последние 3, для карт — до 10
  const limit = (cat === "card_topup" || cat === "card_balance") ? 10 : 3;
  arr.push({ ...media, ts: Date.now() });
  while (arr.length > limit) arr.shift();
  state.classes[cls].media[cat] = arr;
}

async function sendMediaItem(token, msgOrChat, item, caption = "") {
  const payload = { chat_id: (msgOrChat.chat ? msgOrChat.chat.id : msgOrChat) };
  if (msgOrChat.chat && msgOrChat.is_topic_message && msgOrChat.message_thread_id) {
    payload.message_thread_id = msgOrChat.message_thread_id;
  }
  if (item.type === "photo") {
    await sendSafe("sendPhoto", token, { ...payload, photo: item.file_id, caption });
  } else if (item.type === "video") {
    await sendSafe("sendVideo", token, { ...payload, video: item.file_id, caption });
  } else if (item.type === "document") {
    await sendSafe("sendDocument", token, { ...payload, document: item.file_id, caption });
  }
}

async function sendMediaSet(token, msg, items, captionText = "") {
  if (!items?.length) return;
  // если несколько — шлём по одному; для топап/баланса шлём все, для расписаний — только последний
  const many = items.length > 1 && (captionText === "card_topup" || captionText === "card_balance");
  if (!many) { await sendMediaItem(token, msg, items.at(-1), undefined); return; }
  for (const it of items) await sendMediaItem(token, msg, it, undefined);
}

/* ---------------- Ответы по триггерам ---------------- */
async function answerScheduleLessons(token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  const arr = state.classes[cls]?.media?.schedule_lessons || [];
  if (!arr.length) return false;
  const txt = speak(state, msg, "вот актуальное расписание. Если что-то изменится — сообщу заранее.");
  await sendToSameThread("sendMessage", token, msg, { text: txt });
  await sendMediaSet(token, msg, arr);
  return true;
}
async function answerScheduleBells(token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  const arr = state.classes[cls]?.media?.schedule_bells || [];
  if (!arr.length) return false;
  await sendMediaSet(token, msg, arr);
  return true;
}
async function answerBusesCity(token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  const arr = state.classes[cls]?.media?.buses_city || [];
  if (!arr.length) return false;
  const txt = speak(state, msg, "вот актуальное расписание. Если что-то изменится — сообщу заранее.");
  await sendToSameThread("sendMessage", token, msg, { text: txt });
  await sendMediaSet(token, msg, arr);
  return true;
}
async function answerBusesVillages(token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  const arr = state.classes[cls]?.media?.buses_villages || [];
  if (!arr.length) return false;
  const txt = speak(state, msg, "вот актуальное расписание. Если что-то изменится — сообщу заранее.");
  await sendToSameThread("sendMessage", token, msg, { text: txt });
  await sendMediaSet(token, msg, arr);
  return true;
}
async function answerCardTopup(token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  const arr = state.classes[cls]?.media?.card_topup || [];
  if (!arr.length) return false;
  const txt = speak(state, msg, "как пополнить карту — прикрепляю инструкции:");
  await sendToSameThread("sendMessage", token, msg, { text: txt });
  await sendMediaSet(token, msg, arr, "card_topup");
  return true;
}
async function answerCardBalance(token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  const arr = state.classes[cls]?.media?.card_balance || [];
  if (!arr.length) return false;
  const txt = speak(state, msg, "как проверить баланс — прикрепляю:");
  await sendToSameThread("sendMessage", token, msg, { text: txt });
  await sendMediaSet(token, msg, arr, "card_balance");
  return true;
}

/* ---------------- FAQ/Teach (минимум) ---------------- */
function normalizeContains(hay, needle) { return normalize(hay).includes(normalize(needle)); }
function findTeachAnswer(state, question) {
  const qn = normalize(question);
  for (const r of state.teach || []) {
    const pn = normalize(r.pat);
    if (pn && qn.includes(pn)) return r.ans;
  }
  return null;
}

/* ---------------- Small talk & школьные интенты ---------------- */
function guessChildName(text) { const m = text.match(/([А-ЯЁ][а-яё]+)(?=\s+(заболел|заболела|болеет|не\s+прид[её]т|опаздыва|задержива|уйд[её]т|заберу|забирать))/i); return m ? m[1] : null; }

async function handleNaturalMessage(env, token, msg, state) {
  if (state.autoreply_enabled === false) return false;
  const raw = (msg.text || "").trim();
  if (!raw) return false;
  const t = normalize(raw);

  await rememberContext(env, msg, "user", raw);

  // teach — в приоритете
  const taught = findTeachAnswer(state, raw);
  if (taught) {
    const txt = speak(state, msg, taught);
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); 
    return true;
  }

  // болеет
  if (/(кашл|кашель|сопл|насморк|температур|орви|грипп|заболел|заболела|болеет)/.test(t)) {
    const child = guessChildName(raw) || "";
    const txt = speak(state, msg, `${child ? child + ", " : ""}принято. Выздоравливайте 🙌 Придите в школу со справкой от врача.`);
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Отсутствие (болезнь) из "${msg.chat.title || msg.chat.id}":\n${raw}` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }
  // отсутствие по др. причинам
  if (/(не будет|пропустит|не прид[её]т|отсутств)/.test(t)) {
    const txt = speak(state, msg, "приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.");
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Отсутствие (не болезнь) из "${msg.chat.title || msg.chat.id}":\n${raw}` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }
  // опоздание / бежим / задержимся
  if (/(опаздыва|опозда|задержива|будем позже|буду позже|позже на|бежим)/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const delay = extractDelayMinutes(raw);
    const when = tm ? `к ${tm}` : (delay ? `на ~${delay} мин` : "немного");
    const txt = speak(state, msg, `поняла, ждём ${when}.`);
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Опоздание из "${msg.chat.title || msg.chat.id}":\n${raw}` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }
  // ранний уход
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|забер[уё]).*/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `в ${tm}` : "раньше обычного";
    const txt = speak(state, msg, `хорошо, отпустим ${when}.`);
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Просьба отпустить ("${msg.chat.title || msg.chat.id}"):\n${raw}` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }
  // заканчиваются/во сколько забрать
  if (/(во сколько|до скольки).*(заканч|кончат|урок)/.test(t) || /(во сколько|когда).*(забир|забрать|забирать)/.test(t)) {
    const r = resolvePickupNatural(state, msg, raw);
    if (r.ok) {
      await sendToSameThread("sendMessage", token, msg, { text: r.text });
      await rememberContext(env, msg, "bot", r.text);
      return true;
    }
  }

  // расписание уроков
  if (/(расписани[ея].*урок|какие.*урок(и|а)|расписание на (сегодня|завтра)|какие уроки)/.test(t)) {
    const ok = await answerScheduleLessons(token, msg, state);
    if (ok) return true;
  }
  // звонки/перемены
  if (/(когда.*перемен|перемен[аы]|звонк|расписани[ея].*звонк)/.test(t)) {
    const ok = await answerScheduleBells(token, msg, state);
    if (ok) return true;
  }
  // автобусы: подвоз/посёлки
  if (/(подвоз|поселк|посёлк)/.test(t)) {
    const ok = await answerBusesVillages(token, msg, state);
    if (ok) return true;
  }
  // автобусы: город
  if (/(расписани[ея].*автобус|автобус)/.test(t)) {
    const ok = await answerBusesCity(token, msg, state);
    if (ok) return true;
  }
  // карта: пополнение
  if (/(как.*пополни|пополнен.*карт|оплатить.*карта|реквизит|сбербанк)/.test(t)) {
    const ok = await answerCardTopup(token, msg, state);
    if (ok) return true;
  }
  // карта: баланс
  if (/(как.*проверить.*баланс|баланс.*карт)/.test(t)) {
    const ok = await answerCardBalance(token, msg, state);
    if (ok) return true;
  }

  // ничего не нашли → молчим, но пересылаем учителю при включенной опции
  if (state.forward_unknown_to_teacher && state.teacher_id) {
    await sendSafe("sendMessage", token, {
      chat_id: state.teacher_id,
      text: `Вопрос из чата ${msg.chat.title || msg.chat.id}:\n${raw}`
    });
  }
  return true; // обработано (но без ответа в чат)
}

/* ---------------- Приём медиа от учителя ---------------- */
async function handleMediaFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать: сначала /iam_teacher в личке." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption) || state.default_class;
  ensureClass(state, cls);

  const ncap = normalize(caption);
  const cat = detectCategory(ncap);
  if (!cat) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Не распознал категорию. Примеры подписей: #1Б расписание уроков / #1Б расписание звонков / #1Б подвоз / #1Б автобусы / #1Б пополнение карты / #1Б баланс карты" });
    return;
  }

  // выясняем тип и file_id
  let type = null, file_id = null;
  if (msg.photo?.length) { type = "photo"; file_id = extractLargestPhotoId(msg.photo); }
  else if (msg.video) { type = "video"; file_id = msg.video.file_id; }
  else if (msg.document) { type = "document"; file_id = msg.document.file_id; }

  if (!type || !file_id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Пришлите фото/видео/документ с подписью (#1Б …)." });
    return;
  }

  pushMedia(state, cls, cat, { type, file_id, caption });
  await saveState(env, state);

  const rec = state.classes[cls];
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  const publText = speak(state, { chat: {} , from: msg.from }, caption || "");

  if (targets.length) {
    // при публикации отправляем именно этот новый файл
    for (const chatId of targets) await sendMediaItem(token, chatId, { type, file_id }, caption);
  }
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено (${cls} — ${cat.replace("_"," ")}) ✅` });
}

/* ---------------- Команды ---------------- */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40,... — задать время забора",
    "/pickup [день|класс] — подсказать точное время забора",
    "/pickup_week — время забора на неделю",
    "/persona_set Имя Отчество — имя в ответах",
    "/prefix on|off — включить/выключить подпись именем учителя",
    "/default_class <КЛАСС> — класс по умолчанию (сейчас 1Б)",
    "",
    "Дообучение в ЛС:",
    '/teach "шаблон" => "ответ", /teach_list, /teach_del <№>, /teach_clear',
    "",
    "Учитель (ЛС боту): фото/видео с подписями:",
    "#1Б расписание уроков / #1Б расписание звонков",
    "#1Б подвоз / #1Б автобусы",
    "#1Б пополнение карты … / #1Б баланс карты",
  ].join("\n");
  await sendSafe("sendMessage", token, { chat_id: chatId, text });
}
async function cmdPing(token, msg) { await sendToSameThread("sendMessage", token, msg, { text: "pong ✅" }); }
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private")
    return sendToSameThread("sendMessage", token, msg, { text: "Команда выполняется только в личке." });
  state.teacher_id = msg.from.id; await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Вы назначены учителем ✅" });
}
async function cmdLink(token, msg, state, args, kind) {
  const cls = parseClassFrom(args) || state.default_class;
  ensureClass(state, cls);
  state.classes[cls][kind === "link_general" ? "general_chat_id" : "parents_chat_id"] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, { text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для ${cls} ✅` });
}

async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start": await cmdStart(token, msg.chat.id); return true;
    case "/ping": await cmdPing(token, msg); return true;

    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); return true;
    case "/link_general": await cmdLink(token, msg, state, args, "link_general"); await saveState(env, state); return true;
    case "/link_parents": await cmdLink(token, msg, state, args, "link_parents"); await saveState(env, state); return true;

    case "/pickup_set": await cmdPickupSet(env, token, msg, state, args); return true;
    case "/pickup": await cmdPickup(token, msg, state, args); return true;
    case "/pickup_week": {
      const cls = pickClassFromChat(state, msg.chat.id);
      if (!cls || !state.classes[cls]?.pickup_times)
        await sendToSameThread("sendMessage", token, msg, { text: "Нужно сначала задать через /pickup_set" });
      else
        await sendToSameThread("sendMessage", token, msg, { text: `Время забора на неделю — ${cls}:\n` + formatPickupWeek(state.classes[cls].pickup_times) });
      return true;
    }

    // подпись
    case "/persona_set": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) { await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." }); return true; }
      const name = args.trim(); if (!name) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите: /persona_set Ирина Владимировна" }); return true; }
      state.teacher_display_name = name; await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Теперь отвечаю как: ${name}` }); return true;
    }
    case "/prefix": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) { await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." }); return true; }
      const v = (args||"").toLowerCase();
      if (!["on","off"].includes(v)) { await sendToSameThread("sendMessage", token, msg, { text: `Сейчас: ${state.use_prefix ? "on" : "off"}. Используйте: /prefix on|off` }); return true; }
      state.use_prefix = v === "on"; await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Подпись учителя: ${state.use_prefix ? "ВКЛ" : "ВЫКЛ"}` }); return true;
    }
    case "/default_class": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) { await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." }); return true; }
      const cls = parseClassFrom(args);
      if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите класс: /default_class 1Б" }); return true; }
      state.default_class = cls; ensureClass(state, cls); await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Класс по умолчанию: ${cls}` }); return true;
    }

    // Дообучение
    case "/teach": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) { await sendToSameThread("sendMessage", token, msg, { text: "Только учитель может обучать ответы." }); return true; }
      const m = args.match(/"([^"]+)"\s*=>\s*"([^"]+)"/);
      if (!m) { await sendToSameThread("sendMessage", token, msg, { text: 'Формат: /teach "шаблон" => "ответ"' }); return true; }
      const [_,pat,ans] = m; state.teach = state.teach || []; state.teach.push({ pat:pat.trim(), ans:ans.trim() });
      await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Добавлено правило #${state.teach.length} ✅` }); return true;
    }
    case "/teach_list": {
      const list = state.teach || [];
      if (!list.length) { await sendToSameThread("sendMessage", token, msg, { text: "Правила пусты. /teach \"шаблон\" => \"ответ\"" }); return true; }
      const out = list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,80)}"`).join("\n").slice(0,4000);
      await sendToSameThread("sendMessage", token, msg, { text: out }); return true;
    }
    case "/teach_del": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) { await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." }); return true; }
      const idx = parseInt(args,10); const list = state.teach || [];
      if (isNaN(idx)||idx<1||idx>list.length) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите номер: /teach_del 2" }); return true; }
      list.splice(idx-1,1); state.teach = list; await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: "Удалено ✅" }); return true;
    }
    case "/teach_clear": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) { await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." }); return true; }
      state.teach = []; await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: "Все пользовательские правила очищены ✅" }); return true;
    }

    default: return false;
  }
}

/* ---------------- Callback (на будущее) ---------------- */
async function handleCallback(env, token, cb, state) {
  await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
}

/* ---------------- Entry ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    if (url.pathname === "/") return OK("ok");

    // setWebhook
    if (url.pathname === "/init" && (request.method === "GET" || request.method === "POST")) {
      if (!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, {
        url: `${env.PUBLIC_URL}/webhook/${token}`,
        allowed_updates: ["message","edited_message","callback_query","channel_post","my_chat_member","chat_member"],
        max_connections: 40,
        drop_pending_updates: false,
      });
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.pathname === `/webhook/${token}` && request.method === "POST") {
      let update;
      try { update = await request.json(); } catch { return NO(400, "bad json"); }

      console.log("UPDATE kind=", (update.message?"message": update.callback_query?"callback": Object.keys(update)[0] || "other"),
                  "ids=", JSON.stringify({chat: update.message?.chat?.id, from: update.message?.from?.id}),
                  "text=", update.message?.text?.slice(0,120)||"");

      const state = await loadState(env);

      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();
        return OK();
      }

      // медиа от учителя в ЛС
      if (update.message && (update.message.photo?.length || update.message.video || update.message.document)) {
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      if (update.callback_query) {
        await handleCallback(env, token, update.callback_query, state);
        return OK();
      }

      return OK();
    }

    return NO();
  },
};
