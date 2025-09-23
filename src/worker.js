// Cloudflare Worker: Telegram-бот "Ирина Владимировна" (класс/школа)
// Bindings (Dashboard → Workers → Settings):
// - Secret: BOT_TOKEN
// - Variable (plain text): PUBLIC_URL (например: https://teacher-helper.<account>.workers.dev) — БЕЗ завершающего "/"
// - KV Namespace: KV_BOT
//
// В @BotFather: /setprivacy → Disable
//
// Что внутри:
// • Small talk «как учитель» + уведомления учителю по важным поводам
// • /teach (текстовые правила) + мини-контекст на 10 реплик
// • Расписания времени: три независимых — уроки (main), продлёнка/ГПД (gpd), полдник (snack)
// • Триггеры по свободному тексту для фото: расписание уроков / автобусы / звонки
// • Медиатека (скринкасты): темы topup (пополнение карты), balance (проверка баланса)
// • По умолчанию: молчать, если не знает; подпись учителя выключена (можно включить /prefix on)

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
      prefix_enabled: false, // подпись в ответах выключена по умолчанию
      autoreply_enabled: true,
      forward_unknown_to_teacher: false, // по умолчанию НЕ пересылаем неизвестные вопросы
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {}, // "1Б": {...}
      faq: [], // [{q,a,kw,cat}]
      teach: [], // [{pat, ans}]
      // медиатека по классам: media["1Б"] = { topup:[{kind,file_id,caption}], balance:[...] }
      media: {}
    };
  }
  try {
    const s = JSON.parse(raw);
    s.teacher_display_name ||= "Ирина Владимировна";
    if (typeof s.prefix_enabled === "undefined") s.prefix_enabled = false;
    if (typeof s.autoreply_enabled === "undefined") s.autoreply_enabled = true;
    if (typeof s.forward_unknown_to_teacher === "undefined") s.forward_unknown_to_teacher = false;
    s.policy_absence ||= "Выздоравливайте 🙌 Придите в школу со справкой от врача.";
    s.classes ||= {};
    s.faq ||= [];
    s.teach ||= [];
    s.media ||= {};
    return s;
  } catch {
    return {
      teacher_id: null,
      teacher_display_name: "Ирина Владимировна",
      prefix_enabled: false,
      autoreply_enabled: true,
      forward_unknown_to_teacher: false,
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {},
      faq: [],
      teach: [],
      media: {}
    };
  }
}
async function saveState(env, state) { await env.KV_BOT.put("state", JSON.stringify(state)); }

ffunction ensureClass(state, cls) {
if (!state.classes) state.classes = {};

// значения по умолчанию
  const defaults = {
// привязки чатов
    general_chat_id: null,
// медиа: расписание уроков, звонков, автобус
    schedule_file_id: null,
    schedule_caption: null,
    bells_file_id: null,
    bells_caption: null,
    bus_file_id: null,
    bus_caption: null,
// три независимых набора "времён"
    pickup_times: null, // уроки (основное)
    aftercare_times: null, // продлёнка / ГПД
    snack_times: null // полдник

// создаём запись класса, не затирая уже сохранённые поля
  state.classes[cls] = Object.assign({}, defaults, state.classes[cls] || {});

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
function extractMediaFromMessage(msg) {
  if (msg.photo?.length) return { kind: "photo", file_id: extractLargestPhotoId(msg.photo) };
  if (msg.video?.file_id) return { kind: "video", file_id: msg.video.file_id };
  if (msg.document?.file_id) return { kind: "document", file_id: msg.document.file_id };
  if (msg.animation?.file_id) return { kind: "animation", file_id: msg.animation.file_id };
  return null;
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
    "пн":"ПН","пон":"ПН","понедельник":"ПН","mon":"ПН",
    "вт":"ВТ","вторник":"ВТ","tue":"ВТ",
    "ср":"СР","среда":"СР","wed":"СР",
    "чт":"ЧТ","четверг":"ЧТ","thu":"ЧТ",
    "пт":"ПТ","пятница":"ПТ","fri":"ПТ",
    "сб":"СБ","суббота":"СБ","sat":"СБ",
    "вс":"ВС","воскресенье":"ВС","sun":"ВС",
  };
  return map[n] || null;
}
function pickClassFromChat(state, chatId) {
  for (const [k, v] of Object.entries(state.classes || {})) {
    if (v.general_chat_id === chatId || v.parents_chat_id === chatId) return k;
  }
  return "1Б"; // класс по умолчанию
}
function formatPickupWeek(mapping) {
  const order = ["ПН","ВТ","СР","ЧТ","ПТ","СБ","ВС"];
  return order.map(d => `${d} — ${mapping?.[d] || "—"}`).join("\n");
}
// Определяем «сценарий» по тексту: уроки / продлёнка / полдник
function detectScope(raw = "") {
  const n = normalize(raw);
  if (/\b(продл[её]нк|гпд)\b/.test(n)) return "aftercare"; // продлёнка / ГПД
  if (/\b(полдник)\b/.test(n)) return "snack"; // полдник
  return "main"; // по умолчанию — уроки
}

// Куда сохранять в state.classes[cls]
function mappingFieldByScope(scope) {
  if (scope === "aftercare") return "aftercare_times";
  if (scope === "snack") return "snack_times";
  return "pickup_times";
}

// Человекочитаемое имя для уведомления
function prettyNameByScope(scope) {
  if (scope === "aftercare") return "продлёнка";
  if (scope === "snack") return "полдник";
  return "уроки";
}

/* ---- Адресация к родителю ---- */
function userDisplay(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}
function prefixText(state, msg) {
  if (!state.prefix_enabled) return ""; // подпись выключена
  const disp = userDisplay(msg.from || null);
  const who = state.teacher_display_name || "Учитель";
  return (disp ? `${disp}, ` : "") + `${who}: `;
}

/* ---------------- Мини-контекст (KV) ---------------- */
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
async function getContext(env, msg) {
  const key = ctxKey(msg);
  const raw = await env.KV_BOT.get(key);
  if (!raw) return [];
  try { return JSON.parse(raw) || []; } catch { return []; }
}

/* ---------------- Парсеры времени ---------------- */
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
function resolvePickupKindByText(text="") {
  const n = normalize(text);
  if (/(гпд|продл[её]нк)/.test(n)) return "gpd";
  if (/полдник/.test(n)) return "snack";
  return "main";
}
function pickupLabel(kind) {
  return kind==="gpd" ? "продлёнка" : kind==="snack" ? "полдник" : "уроки";
}

/* ---------------- FAQ/Teach ---------------- */
function scoreMatch(text, kwList) {
  const t = " " + normalize(text) + " ";
  let score = 0;
  for (const kw of kwList || []) {
    const k = " " + normalize(kw) + " ";
    if (t.includes(k)) score += Math.min(k.length, 10);
  }
  return score;
}
function bestFaqAnswer(state, question) {
  if (!state.faq?.length) return null;
  const ranked = state.faq
    .map(it => ({ it, s: scoreMatch(question, it.kw || []) }))
    .sort((a, b) => b.s - a.s);
  if (!ranked[0] || ranked[0].s < 5) return null;
  return ranked[0].it;
}
function findTeachAnswer(state, question) {
  const qn = normalize(question);
  for (const r of state.teach || []) {
    const pn = normalize(r.pat);
    if (pn && qn.includes(pn)) return r.ans;
  }
  return null;
}

/* ---------------- Команды ---------------- */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "• /pickup_set <КЛАСС> [уроки|продлёнка|полдник] ПН=13:30,ВТ=12:40,... — задать время",
    "• /pickup_week [КЛАСС] [уроки|продлёнка|полдник] — показать неделю",
    "• /teach \"шаблон\" => \"ответ\", /teach_list, /teach_del <№>, /teach_clear",
    "• /media_list [КЛАСС], /media_del <тема> <№|all> [КЛАСС], /media_clear [КЛАСС]",
    "",
    "Админ (учитель/родком):",
    "• /iam_teacher — назначить себя учителем (ЛС)",
    "• /link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "• /link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "• /persona_set Имя Отчество — от чьего имени отвечать",
    "• /prefix on|off — показывать/скрывать подпись в ответах",
    "• /autoreply on|off — автоответы «как учитель»",
    "• /forward_unknown on|off — пересылать неизвестные вопросы учителю",
    "• /policy_absence_set Текст — ответ при болезни/пропуске",
    "",
    "Загрузка в ЛС бота:",
    "• Фото: #1Б расписание на неделю — расписание уроков (фото)",
    "• Фото: #1Б расписание звонков — расписание звонков (фото)",
    "• Фото: #1Б автобусы — расписание автобусов/подвоз (фото)",
    "• Фото/видео: #1Б пополнить карту … — тема topup",
    "• Фото/видео: #1Б баланс карты … — тема balance",
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
  const cls = parseClassFrom(args);
  if (!cls) return sendToSameThread("sendMessage", token, msg, { text: `Укажите класс, пример: /${kind} 1Б` });
  ensureClass(state, cls);
  state.classes[cls][kind === "link_general" ? "general_chat_id" : "parents_chat_id"] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, { text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для ${cls} ✅` });
}

async function cmdPickupSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher)
    return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });

  // 1) Класс — всегда первый «токен»
  const parts = (args || "").trim().split(/\s+/).filter(Boolean);
  const cls = parseClassFrom(parts[0] || "");
  if (!cls)
    return sendToSameThread("sendMessage", token, msg, {
      text: 'Формат: /pickup_set 1Б [продлёнка|полдник] ПН=13:30,ВТ=12:40,... или JSON',
    });

  ensureClass(state, cls);

  // 2) Второй токен — необязательный «тип» (продлёнка / полдник)
  let scope = "main";
  if (parts[1]) {
    const cand = detectScope(parts[1]);
    if (cand !== "main") scope = cand;
  }

  // 3) «Хвост» (пары ПН=.. или JSON) — это всё после первого токена +,
  // если есть ключевое слово (продлёнка/полдник), то и после второго.
  const restStart =
    scope === "main" ? args.indexOf(parts[0]) + parts[0].length
                     : args.indexOf(parts[1]) + parts[1].length;
  const rest = args.slice(restStart).trim().replace(/^,/, "").trim();

  // 4) Разбор в mapping { ПН: "12:15", ВТ: "11:40", ... }
  let mapping = null;

  if (rest.startsWith("{")) {
    // JSON-формат
    try {
      const obj = JSON.parse(rest);
      const m = {};
      for (const [k, v] of Object.entries(obj || {})) {
        const kk = dayShortFromInput(k) || k.toString().toUpperCase().slice(0, 2);
        if (DAYS.includes(kk) && /^\d{1,2}:\d{2}$/.test(String(v))) m[kk] = String(v);
      }
      mapping = Object.keys(m).length ? m : null;
    } catch {
      mapping = null;
    }
  } else {
    // Пары вида "ПН=12:15, ВТ=11:40, ..."
    mapping = parsePickupMapping(rest);
  }

  if (!mapping)
    return sendToSameThread("sendMessage", token, msg, {
      text:
        'Не удалось распознать времена.\nПримеры:\n' +
        '/pickup_set 1Б ПН=12:15,ВТ=11:40\n' +
        '/pickup_set 1Б продлёнка {"пн":"13:40","вт":"13:40"}',
    });

  // 5) Сохраняем в нужное поле по «сценарию»
  const field = mappingFieldByScope(scope);
  const pretty = prettyNameByScope(scope);

  state.classes[cls][field] = mapping;
  await saveState(env, state);

  // 6) Подтверждение и авто-публикация в привязанные чаты
  const pairs = Object.entries(mapping).map(([k, v]) => `${k}=${v}`).join(", ");
  await sendToSameThread("sendMessage", token, msg, {
    text: `Готово, ${pretty} для ${cls}: ${pairs}`,
  });

  const rec = state.classes[cls];
  const label =
    scope === "aftercare" ? "Обновлено время (продлёнка, " + cls + "):\n"
    : scope === "snack" ? "Обновлено время (полдник, " + cls + "):\n"
                           : "Обновлено время (уроки, " + cls + "):\n";
  for (const chatId of [rec.general_chat_id, rec.parents_chat_id].filter(Boolean)) {
    await sendSafe("sendMessage", token, {
      chat_id: chatId,
      text: label + formatPickupWeek(mapping),
    });
  }
}

  ensureClass(state, cls);

  // тип по умолчанию — уроки (main)
  let kind = "main";
  if (/^уроки$/i.test(parts[1])) kind = "main";
  else if (/^(гпд|продл[её]нка)$/i.test(parts[1])) kind = "gpd";
  else if (/^полдник$/i.test(parts[1])) kind = "snack";

  const restStart = (kind === "main") ? parts[0].length : (parts[0] + " " + parts[1]).length;
  const rest = args.trim().slice(args.indexOf(parts[0]) + restStart - parts[0].length).trim();

  let mapping = null;
  if (rest.startsWith("{")) {
    try {
      const obj = JSON.parse(rest);
      const m = {};
      for (const [k, v] of Object.entries(obj || {})) {
        const kk = dayShortFromInput(k) || k.toString().toUpperCase().slice(0,2);
        if (DAYS.includes(kk) && /^\d{1,2}:\d{2}$/.test(String(v))) m[kk] = String(v);
      }
      mapping = Object.keys(m).length ? m : null;
    } catch { mapping = null; }
  } else {
    mapping = parsePickupMapping(rest);
  }

  if (!mapping) return sendToSameThread("sendMessage", token, msg, { text: "Не удалось распознать времена. Пример: /pickup_set 1Б продлёнка ПН=15:30,ВТ=16:00" });

  state.classes[cls].pickup ||= { main:null, gpd:null, snack:null };
  state.classes[cls].pickup[kind] = mapping;
  await saveState(env, state);

  const pretty = Object.entries(mapping).map(([k,v])=>`${k}=${v}`).join(", ");
  await sendToSameThread("sendMessage", token, msg, { text: `Готово. ${pickupLabel(kind)} для ${cls}: ${pretty}` });

  const rec = state.classes[cls];
  for (const chatId of [rec.general_chat_id, rec.parents_chat_id].filter(Boolean)) {
    await sendSafe("sendMessage", token, { chat_id: chatId, text: `Обновлено время (${pickupLabel(kind)}, ${cls}):\n` + formatPickupWeek(mapping) });
  }
}

async function cmdPickupWeek(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args || "");
    if (found) cls = found;
  }
  if (!cls) return sendToSameThread("sendMessage", token, msg, { text: "Чат не привязан к классу. /link_general 1Б или /link_parents 1Б." });

  const kind = resolvePickupKindByText(args || "");
  const mapping = state.classes[cls]?.pickup?.[kind];
  if (!mapping) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} на «${pickupLabel(kind)}» время ещё не задано.` });

  const text = `Время (${pickupLabel(kind)}) на неделю — ${cls}:\n` + formatPickupWeek(mapping);
  await sendToSameThread("sendMessage", token, msg, { text });
}

/* ---------------- Natural helpers ---------------- */
function extractTimeHHMM(text) { const m = text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractTimeFlexible(text) { const m = text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractDelayMinutes(text) { const m = normalize(text).match(/\bна\s+(\d{1,2})\s*мин/); return m ? parseInt(m[1], 10) : null; }
function guessChildName(text) { const m = text.match(/([А-ЯЁ][а-яё]+)(?=\s+(заболел|заболела|болеет|не\s+прид[её]т|опаздыва|опозда|задержива|уйд[её]т|заберу|забирать|пропустит|не\s+будет))/i); return m ? m[1] : null; }

function resolvePickupNatural(state, msg, freeText) {
  const raw = (freeText || "").trim();
  const n = normalize(raw);

  // Класс
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const m = parseClassFrom(raw);
    if (m) cls = m;
  }
  if (!cls) return { ok:false, text: "Этот чат не привязан к классу. Выполните /link_general 1Б или укажите класс в сообщении." };

  const kind = resolvePickupKindByText(raw);
  const mapping = (state.classes[cls]?.pickup || {})[kind];
  if (!mapping) return { ok:false, text: `Для ${cls} на ${pickupLabel(kind)} ещё не задано время.` };

  // День
  let d = dayShortFromInput(raw);
  if (!d) {
    if (/\bзавтра\b/.test(n)) {
      const now = new Date(); now.setUTCMinutes(now.getUTCMinutes() + 24*60);
      d = ruShortFromDate(now);
    } else {
      d = todayRuShort();
    }
  }

  const t = mapping[d];
  if (!t) return { ok:false, text: `${cls}: на ${dayNameFull(d)} для «${pickupLabel(kind)}» время не задано.` };

  const pref = ""; // подпись добавим выше по месту
  return { ok:true, text: `${pref}${cls}, ${dayNameFull(d)} — ${pickupLabel(kind)} в ${t}.` };
}

/* ---------------- Медиатека (скринкасты) ---------------- */
function ensureMediaClass(state, cls) {
  if (!state.media[cls]) state.media[cls] = { topup: [], balance: [] };
}
function topicFromCaption(caption="") {
  const n = normalize(caption);
  if (/баланс карт/.test(n) || /\bбаланс\b/.test(n)) return "balance";
  if (/пополни(ть|м)\s*карт/.test(n) || /пополнен/.test(n)) return "topup";
  return null;
}
async function sendMediaTopic(token, msg, items) {
  // Отправляем все элементы темы в порядке добавления
  for (const it of items) {
    if (it.kind === "photo") await sendToSameThread("sendPhoto", token, msg, { photo: it.file_id, caption: it.caption || "" });
    else if (it.kind === "video") await sendToSameThread("sendVideo", token, msg, { video: it.file_id, caption: it.caption || "" });
    else if (it.kind === "document") await sendToSameThread("sendDocument", token, msg, { document: it.file_id, caption: it.caption || "" });
    else if (it.kind === "animation") await sendToSameThread("sendAnimation", token, msg, { animation: it.file_id, caption: it.caption || "" });
  }
}

/* ---------------- Small talk & intents ---------------- */
async function handleNaturalMessage(env, token, msg, state) {
  if (state.autoreply_enabled === false) return false;
  const raw = (msg.text || "").trim();
  if (!raw) return false;
  const t = normalize(raw);
  const pref = prefixText(state, msg);

  await rememberContext(env, msg, "user", raw);

  // teach-правила — приоритет
  const taught = findTeachAnswer(state, raw);
  if (taught) {
    const txt = `${pref}${taught}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // триггеры медиа тем: topup / balance
  const clsForMedia = pickClassFromChat(state, msg.chat.id);
  ensureClass(state, clsForMedia);
  ensureMediaClass(state, clsForMedia);
  if (/(как\s+пополни(ть|м)\s*карт|пополнен[ие]|пополнить карту)/.test(t)) {
    const arr = state.media[clsForMedia]?.topup || [];
    if (arr.length) {
      await sendToSameThread("sendMessage", token, msg, { text: `${pref}Пошагово про пополнение карты:` });
      await sendMediaTopic(token, msg, arr);
      return true;
    }
  }
  if (/(баланс\s*карт|как\s+проверить\s+баланс|проверить\s+баланс|баланс карты)/.test(t)) {
    const arr = state.media[clsForMedia]?.balance || [];
    if (arr.length) {
      await sendToSameThread("sendMessage", token, msg, { text: `${pref}Где посмотреть баланс карты:` });
      await sendMediaTopic(token, msg, arr);
      return true;
    }
  }

  // расписание: фото
  if (/(расписан|какие.*уроки|что.*по.*расписан)/.test(t) && !/(звонк|перемен)/.test(t) && !/(автобус|подвоз)/.test(t)) {
    const cls = pickClassFromChat(state, msg.chat.id);
    const rec = state.classes[cls] || {};
    if (rec.schedule_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${pref}Вот актуальное расписание уроков.` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
      return true;
    }
  }
  if (/(автобус|подвоз)/.test(t)) {
    const cls = pickClassFromChat(state, msg.chat.id);
    const rec = state.classes[cls] || {};
    if (rec.bus_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${pref}Вот актуальное расписание автобусов. Если что-то изменится — сообщу заранее.` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы ${cls}` });
      return true;
    }
  }
  if (/(звонк|перемен)/.test(t)) {
    const cls = pickClassFromChat(state, msg.chat.id);
    const rec = state.classes[cls] || {};
    if (rec.bells_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${pref}Расписание звонков:` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bells_file_id, caption: rec.bells_caption || `Звонки ${cls}` });
      return true;
    }
  }

  // точное «во сколько забрать» (уроки/продлёнка/полдник)
  if (/(во сколько|сколько|когда).*(забир|забрать|забирать|заканч|кончат|урок|продл|гпд|полдник)/.test(t)) {
    const r = resolvePickupNatural(state, msg, raw);
    if (r.ok) {
      const txt = pref + r.text.replace(/^,?\s*/, "");
      await sendToSameThread("sendMessage", token, msg, { text: txt });
      await rememberContext(env, msg, "bot", txt);
      return true;
    }
  }

  // болезнь / отсутствие — разные ответы
  if (/(кашел|насморк|сопл|температур|орви|грипп|заболел|заболела|болеет)/.test(t)) {
    const nameChild = guessChildName(raw) || "Ребёнок";
    const txt = `${pref}${nameChild}, ${state.policy_absence}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `⚕️ Болезнь/самочувствие:\nИз чата ${msg.chat.title || msg.chat.id}\n"${raw}"` });
    return true;
  }
  if (/(не\s+будет|пропустит|не\s+прид[её]т|отсутств|сегодня не сможем)/.test(t)) {
    const txt = `${pref}Принято. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `📝 Отсутствие:\nИз чата ${msg.chat.title || msg.chat.id}\n"${raw}"` });
    return true;
  }

  // опоздания/задержки
  if (/(опаздыва|опозда|задержива|будем позже|буду позже|бежим)/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const delay = extractDelayMinutes(raw);
    const when = tm ? `к ${tm}` : (delay ? `на ~${delay} мин` : "немного");
    const txt = `${pref}Поняла, подождём ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `⏱ Опоздание/задержка:\nИз чата ${msg.chat.title || msg.chat.id}\n"${raw}"` });
    return true;
  }

  // ранний уход / отпустить
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|забер[уё]).*/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `в ${tm}` : "раньше обычного";
    const txt = `${pref}Хорошо, отпустим ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `🚪 Просьба отпустить:\nИз чата ${msg.chat.title || msg.chat.id}\n"${raw}"` });
    return true;
  }

  // small talk
  if (/(^| )(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)) {
    const txt = `${pref}Здравствуйте!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }
  if (/(^| )(спасибо|благодарю)( |!|$)/.test(t)) {
    const txt = `${pref}Пожалуйста!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }
  if (/(^| )(пока|до свидания|досвидания|хорошего дня)( |!|$)/.test(t)) {
    const txt = `${pref}До свидания!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }

  // FAQ
  const hit = bestFaqAnswer(state, raw);
  if (hit) {
    const txt = `${pref}${hit.a}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // Неизвестное — молчим (не отвечаем вообще)
  if (state.forward_unknown_to_teacher && state.teacher_id) {
    await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `❓ Неопознанный вопрос из чата ${msg.chat.title || msg.chat.id}:\n"${raw}"` });
  }
  return false;
}

/* ---------------- Фото/медиа от учителя (ЛС) ---------------- */
async function handleMediaFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;

  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать материалы: введите /iam_teacher в личке." });
    return;
  }

  const cap = msg.caption || "";
  const cls = parseClassFrom(cap) || "1Б";
  ensureClass(state, cls);

  const media = extractMediaFromMessage(msg);
  if (!media) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Не распознала медиа. Пришлите фото/видео/документ с подписью #1Б ..." });
    return;
  }

  // Темы медиатеки (пополнение/баланс)
  const topic = topicFromCaption(cap);
  if (topic) {
    const entry = { kind: media.kind, file_id: media.file_id, caption: cap };
    ensureMediaClass(state, cls);
    state.media[cls][topic].push(entry);
    await saveState(env, state);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Файл сохранён в тему ${topic} для ${cls} ✅ (всего: ${state.media[cls][topic].length})` });
    return;
  }

  // Фото-расписания
  const ncap = normalize(cap);
  let handledPhoto = false;

  if (/расписан.*звонк/.test(ncap) || /\bзвонк(и)?\b/.test(ncap) || /перемен/.test(ncap)) {
    state.classes[cls].bells_file_id = media.file_id;
    state.classes[cls].bells_caption = cap;
    await saveState(env, state);
    const rec = state.classes[cls];
    const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
    if (targets.length) {
      for (const chatId of targets) await sendSafe("sendPhoto", token, { chat_id: chatId, photo: media.file_id, caption: cap });
    }
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Расписание звонков для ${cls} сохранено и опубликовано ✅` });
    handledPhoto = true;
  }

  if (!handledPhoto && (/автобус|подвоз/.test(ncap))) {
    state.classes[cls].bus_file_id = media.file_id;
    state.classes[cls].bus_caption = cap;
    await saveState(env, state);
    const rec = state.classes[cls];
    const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
    if (targets.length) {
      for (const chatId of targets) await sendSafe("sendPhoto", token, { chat_id: chatId, photo: media.file_id, caption: cap });
    }
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Расписание автобусов для ${cls} сохранено и опубликовано ✅` });
    handledPhoto = true;
  }

  if (!handledPhoto && (/расписан/.test(ncap) || /урок/.test(ncap))) {
    state.classes[cls].schedule_file_id = media.file_id;
    state.classes[cls].schedule_caption = cap;
    state.classes[cls].last_update_iso = new Date().toISOString();
    await saveState(env, state);
    const rec = state.classes[cls];
    const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
    if (targets.length) {
      for (const chatId of targets) await sendSafe("sendPhoto", token, { chat_id: chatId, photo: media.file_id, caption: cap });
    }
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Расписание уроков для ${cls} сохранено и опубликовано ✅` });
    handledPhoto = true;
  }

  if (!handledPhoto) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Файл сохранён, но по подписи не определила тип. Используйте:\n#1Б расписание на неделю\n#1Б расписание звонков\n#1Б автобусы\nили #1Б пополнить карту / #1Б баланс карты" });
  }
}

/* ---------------- Управление медиатекой ---------------- */
async function cmdMediaList(token, msg, state, args) {
  const cls = parseClassFrom(args) || pickClassFromChat(state, msg.chat.id);
  ensureClass(state, cls);
  ensureMediaClass(state, cls);
  const top = state.media[cls].topup.length;
  const bal = state.media[cls].balance.length;
  const txt = `Медиатека для ${cls}:\n• topup: ${top} файл(ов)\n• balance: ${bal} файл(ов)`;
  await sendToSameThread("sendMessage", token, msg, { text: txt });
}
async function cmdMediaDel(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });

  const p = args.trim().split(/\s+/);
  const topic = (p[0] || "").toLowerCase();
  const num = p[1] || "all";
  const cls = parseClassFrom(args) || pickClassFromChat(state, msg.chat.id);

  if (!["topup","balance"].includes(topic)) return sendToSameThread("sendMessage", token, msg, { text: "Тема: topup | balance. Пример: /media_del topup 2" });
  ensureClass(state, cls);
  ensureMediaClass(state, cls);

  if (num === "all") {
    state.media[cls][topic] = [];
  } else {
    const i = parseInt(num, 10);
    if (isNaN(i) || i < 1 || i > state.media[cls][topic].length)
      return sendToSameThread("sendMessage", token, msg, { text: "Неверный номер файла." });
    state.media[cls][topic].splice(i-1, 1);
  }
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Готово." });
}
async function cmdMediaClear(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const cls = parseClassFrom(args) || pickClassFromChat(state, msg.chat.id);
  ensureClass(state, cls); ensureMediaClass(state, cls);
  state.media[cls] = { topup: [], balance: [] };
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: `Медиатека для ${cls} очищена ✅` });
}

/* ---------------- FAQ mgmt (минимум) ---------------- */
async function cmdFaqImport(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  let mode = "append";
  let payload = args.trim();
  if (payload.toLowerCase().startsWith("replace ")) { mode = "replace"; payload = payload.slice(8).trim(); }
  else if (payload.toLowerCase().startsWith("append ")) { payload = payload.slice(6).trim(); }
  if (!payload) return sendToSameThread("sendMessage", token, msg, { text: "Формат: /faq_import [append|replace] [JSON]" });
  let data;
  try { data = JSON.parse(payload); } catch { return sendToSameThread("sendMessage", token, msg, { text: "Ошибка JSON." }); }
  if (!Array.isArray(data)) return sendToSameThread("sendMessage", token, msg, { text: "Нужен массив." });

  const added = [];
  for (const raw of data) {
    const q = (raw?.q || "").toString().trim();
    const a = (raw?.a || "").toString().trim();
    const kw = Array.isArray(raw?.kw) ? raw.kw.map(x=>x.toString().trim()).filter(Boolean)
      : (typeof raw?.kw === "string" ? raw.kw.split(",").map(s=>s.trim()).filter(Boolean) : []);
    const cat = (raw?.cat || "").toString().trim();
    if (q && a) added.push({ q, a, kw, cat });
  }
  if (!added.length) return sendToSameThread("sendMessage", token, msg, { text: "Нет валидных элементов (нужны q и a)." });
  if (mode === "replace") state.faq = [];
  state.faq = (state.faq || []).concat(added);
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: `Импорт завершён: ${added.length}. Всего: ${(state.faq||[]).length}.` });
}

/* ---------------- Команды управления поведением ---------------- */
async function cmdPersonaSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const name = args.trim();
  if (!name) return sendToSameThread("sendMessage", token, msg, { text: "Укажите имя: /persona_set Ирина Владимировна" });
  state.teacher_display_name = name; await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Теперь отвечаю как: ${name}` });
}
async function cmdPrefix(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v = (args||"").trim().toLowerCase();
  if (!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /prefix on|off" });
  state.prefix_enabled = (v === "on"); await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Подпись в ответах: ${state.prefix_enabled ? "ВКЛ" : "ВЫКЛ"}` });
}
async function cmdAutoReply(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v = (args||"").trim().toLowerCase();
  if (!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /autoreply on|off" });
  state.autoreply_enabled = (v === "on"); await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Автоответы: ${state.autoreply_enabled?"ВКЛ":"ВЫКЛ"}` });
}
async function cmdPolicyAbsenceSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const txt = args.trim();
  if (!txt) return sendToSameThread("sendMessage", token, msg, { text: "Формат: /policy_absence_set Текст" });
  state.policy_absence = txt; await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: "Политика ответа сохранена ✅" });
}
async function cmdForwardUnknown(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v = (args||"").trim().toLowerCase();
  if (!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /forward_unknown on|off" });
  state.forward_unknown_to_teacher = (v === "on"); await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Пересылать неизвестные вопросы учителю: ${state.forward_unknown_to_teacher?"ДА":"НЕТ"}` });
}

/* ---------------- /teach ---------------- */
async function cmdTeach(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Только учитель может обучать ответы." });
  const m = args.match(/"([^"]+)"\s*=>\s*"([^"]+)"/);
  if (!m) return sendToSameThread("sendMessage", token, msg, { text: 'Формат: /teach "шаблон" => "ответ"' });
  const [_, pat, ans] = m;
  state.teach = state.teach || [];
  state.teach.push({ pat: pat.trim(), ans: ans.trim() });
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: `Добавлено правило #${state.teach.length} ✅` });
}
async function cmdTeachList(token, msg, state) {
  const list = state.teach || [];
  if (!list.length) return sendToSameThread("sendMessage", token, msg, { text: "Правила пусты. Добавьте: /teach \"шаблон\" => \"ответ\"" });
  const out = list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,120)}"`).join("\n");
  await sendToSameThread("sendMessage", token, msg, { text: out.slice(0,4000) });
}
async function cmdTeachDel(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const idx = parseInt(args, 10);
  const list = state.teach || [];
  if (isNaN(idx) || idx < 1 || idx > list.length) return sendToSameThread("sendMessage", token, msg, { text: "Укажите номер правила: /teach_del 2" });
  list.splice(idx-1, 1); state.teach = list; await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Удалено ✅" });
}
async function cmdTeachClear(env, token, msg, state) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  state.teach = []; await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Все пользовательские правила очищены ✅" });
}

/* ---------------- Роутер команд ---------------- */
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
    case "/pickup_week": await cmdPickupWeek(token, msg, state, args); return true;

    case "/persona_set": await cmdPersonaSet(env, token, msg, state, args); return true;
    case "/prefix": await cmdPrefix(env, token, msg, state, args); return true;
    case "/autoreply": await cmdAutoReply(env, token, msg, state, args); return true;
    case "/policy_absence_set": await cmdPolicyAbsenceSet(env, token, msg, state, args); return true;
    case "/forward_unknown": await cmdForwardUnknown(env, token, msg, state, args); return true;

    case "/teach": await cmdTeach(env, token, msg, state, args); return true;
    case "/teach_list": await cmdTeachList(token, msg, state); return true;
    case "/teach_del": await cmdTeachDel(env, token, msg, state, args); return true;
    case "/teach_clear": await cmdTeachClear(env, token, msg, state); return true;

    case "/media_list": await cmdMediaList(token, msg, state, args); return true;
    case "/media_del": await cmdMediaDel(env, token, msg, state, args); return true;
    case "/media_clear": await cmdMediaClear(env, token, msg, state, args); return true;

    case "/faq_import": await cmdFaqImport(env, token, msg, state, args); return true;

    default: return false;
  }
}

/* ---------------- Entry ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    if (url.pathname === "/") return OK("ok");

    // Быстрая установка/переустановка вебхука
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
                  "text=", update.message?.text?.slice(0,80)||"",
                  "hasMedia=", !!(update.message?.photo||update.message?.video||update.message?.document||update.message?.animation));

      const state = await loadState(env);

      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();
        return OK(); // неизвестное — молчим
      }

      if (update.message && (update.message.photo || update.message.video || update.message.document || update.message.animation)) {
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      // inline callbacks (FAQ кнопки, если будут)
      if (update.callback_query) {
        await sendSafe("answerCallbackQuery", token, { callback_query_id: update.callback_query.id });
        return OK();
      }

      return OK();
    }

    return NO();
  },
};
