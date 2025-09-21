// Cloudflare Worker: Telegram-бот "Учитель"
// Bindings (Settings → Variables / Secrets / KV):
//   Secret:    BOT_TOKEN
//   Plaintext: PUBLIC_URL   (например: https://teacher-helper.<account>.workers.dev) — БЕЗ завершающего "/"
//   KV:        KV_BOT
//
// В @BotFather отключить privacy: /setprivacy → Disable

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
      autoreply_enabled: true,
      forward_unknown_to_teacher: true,
      notify_absence_to_teacher: true,       // уведомлять учителя об отсутствии
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {},  // "1Б": {...}
      faq: [],      // [{q,a,kw,cat}]
      teach: [],    // [{pat, ans}]
    };
  }
  try {
    const s = JSON.parse(raw);
    if (typeof s.autoreply_enabled === "undefined") s.autoreply_enabled = true;
    if (typeof s.forward_unknown_to_teacher === "undefined") s.forward_unknown_to_teacher = true;
    s.notify_absence_to_teacher = (typeof s.notify_absence_to_teacher === "boolean") ? s.notify_absence_to_teacher : true;
    s.teacher_display_name ||= "Ирина Владимировна";
    s.policy_absence ||= "Выздоравливайте 🙌 Придите в школу со справкой от врача.";
    s.classes ||= {};
    s.faq ||= [];
    s.teach ||= [];
    return s;
  } catch {
    return {
      teacher_id: null,
      teacher_display_name: "Ирина Владимировна",
      autoreply_enabled: true,
      forward_unknown_to_teacher: true,
      notify_absence_to_teacher: true,
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {},
      faq: [],
      teach: [],
    };
  }
}
async function saveState(env, state) { await env.KV_BOT.put("state", JSON.stringify(state)); }
function ensureClass(state, cls) {
  if (!state.classes[cls]) {
    state.classes[cls] = {
      general_chat_id: null,
      parents_chat_id: null,
      schedule_file_id: null,
      schedule_caption: null,
      last_update_iso: null,
      bus_file_id: null,
      bus_caption: null,
      pickup_times: null,
    };
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
  return null;
}
function formatPickupWeek(mapping) {
  const order = ["ПН","ВТ","СР","ЧТ","ПТ","СБ","ВС"];
  return order.map(d => `${d} — ${mapping?.[d] || "—"}`).join("\n");
}

/* ---- Автообращение к родителю ---- */
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

/* ---------------- Клавиатуры FAQ ---------------- */
function kbCategories(cats) {
  return { inline_keyboard: cats.map(c => [{ text: `📚 ${c}`, callback_data: `faq_cat::${c}` }]) };
}
function kbFaqItems(items, page = 0, perPage = 8, cat = "") {
  const start = page * perPage;
  const slice = items.slice(start, start + perPage);
  const rows = slice.map((it, i) => [
    { text: `${start + i + 1}. ${it.q.slice(0, 32)}…`, callback_data: `faq_show::${start + i}::${cat}` },
  ]);
  const nav = [];
  if (start > 0) nav.push({ text: "◀️", callback_data: `faq_nav::prev::${cat}::${page - 1}` });
  if (start + perPage < items.length) nav.push({ text: "▶️", callback_data: `faq_nav::next::${cat}::${page + 1}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

/* ---------------- Команды: базовые/служебные ---------------- */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "/schedule — показать расписание",
    "/buses — расписание автобусов",
    "/pickup [день|класс] — во сколько забирать",
    "/pickup_week [класс] — время забора на неделю",
    "/ask ВОПРОС — спросить бота (FAQ + дообучение)",
    "/faq — список частых вопросов (кнопки/категории)",
    "",
    "Админ (учитель/родком):",
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40,...  или  /pickup_set <КЛАСС> {JSON}",
    "/faq_add Вопрос | Ответ | ключ1, ключ2 | категория",
    "/faq_del <номер>   /faq_list   /faq_export",
    "/faq_import [append|replace] [JSON]   /faq_clear",
    "/forward_unknown on|off — пересылать неизвестные вопросы учителю",
    "/persona_set Имя Отчество — подпись в ответах",
    "/autoreply on|off — автоответы «как учитель»",
    "/policy_absence_set Текст — ответ при болезни/пропуске",
    "/notify_absence on|off — уведомлять учителя о любом отсутствии",
    "",
    "Дообучение:",
    "/teach \"шаблон\" => \"ответ\"",
    "/teach_list, /teach_del <№>, /teach_clear",
    "",
    "Учитель: фото расписания — подпись: #5А расписание на неделю",
    "Учитель: фото автобусов — подпись: #5А автобусы ...",
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

/* ---------------- Расписание/автобусы/забор ---------------- */
async function cmdSchedule(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args || "");
    if (!found) return sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /schedule 1Б" });
    cls = found;
  }
  if (!cls) return sendToSameThread("sendMessage", token, msg, { text: "Чат не привязан к классу. /link_general 1Б или /link_parents 1Б." });
  const rec = state.classes[cls];
  if (!rec?.schedule_file_id) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} расписание ещё не загружено.` });
  await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
}
async function cmdBuses(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args || "");
    if (!found) return sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /buses 1Б" });
    cls = found;
  }
  if (!cls) return sendToSameThread("sendMessage", token, msg, { text: "Чат не привязан к классу. /link_general 1Б или /link_parents 1Б." });
  const rec = state.classes[cls];
  if (!rec?.bus_file_id) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} расписание автобусов ещё не загружено.` });
  await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы ${cls}` });
}

/* ----- pickup core ----- */
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
  const cls = parseClassFrom(parts[0] || "");
  if (!cls) return sendToSameThread("sendMessage", token, msg, { text: "Формат: /pickup_set 1Б ПН=13:30,ВТ=12:40,..." });
  ensureClass(state, cls);

  const rest = args.trim().slice(args.indexOf(parts[0]) + parts[0].length).trim();
  let mapping = null;

  if (rest.startsWith("{")) {
    try {
      const obj = JSON.parse(rest);
      const m = {};
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
  if (!cls && msg.chat.type === "private") return sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /pickup 1Б" });
  if (!cls) return sendToSameThread("sendMessage", token, msg, { text: "Чат не привязан к классу. /link_general 1Б или /link_parents 1Б." });

  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} ещё не задано время забора. /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` });

  const d = day || todayRuShort();
  const t = rec.pickup_times[d];
  if (!t) return sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} на ${dayNameFull(d)} время не задано.` });

  const pref = addressPrefix(msg);
  await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: ${cls}, ${dayNameFull(d)} — забираем в ${t}.` });
}

/* ----- NATURAL: помощь для свободных фраз (точное время) ----- */
function resolvePickupNatural(state, msg, freeText, teacherName) {
  const raw = (freeText || "").trim();
  const n = normalize(raw);

  // Класс
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const m = parseClassFrom(raw);
    if (m) cls = m;
  }
  if (!cls) {
    if (msg.chat.type === "private") {
      return { ok:false, text: "Укажите класс в сообщении, например: «5А во сколько забирать сегодня?» или используйте /pickup 5А" };
    }
    return { ok:false, text: "Этот чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." };
  }

  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) {
    return { ok:false, text: `Для ${cls} еще не задано время забора. Команда учителя: /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` };
  }

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

  const t = rec.pickup_times[d];
  if (!t) {
    return { ok:false, text: `${cls}: на ${dayNameFull(d)} время не задано.` };
  }

  const pref = addressPrefix(msg);
  return { ok:true, text: `${pref}${teacherName}: ${cls}, ${dayNameFull(d)} — забираем в ${t}.` };
}

/* ---------------- FAQ/ASK + Дообучение ---------------- */
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

/* ---------- уведомления учителю ---------- */
async function notifyTeacher(env, token, state, msg, kind, originalText) {
  if (!state.notify_absence_to_teacher || !state.teacher_id) return;
  const place = msg.chat?.title ? `из чата «${msg.chat.title}»` : `из чата ${msg.chat?.id}`;
  const text = `Уведомление об отсутствии (${kind}) ${place}:\n"${originalText || ""}"`;
  await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text });
}

async function cmdAsk(env, token, msg, state, args) {
  const q = args || "";
  if (!q) { await sendToSameThread("sendMessage", token, msg, { text: "Напишите вопрос после команды. Пример: /ask Когда начинаются уроки?" }); return; }

  const n = normalize(q);

  // Болезнь — мед. признаки
  if (/(заболел|заболела|болеет|температур|простуд|орви|насморк|сопл|кашел)/.test(n)) {
    const nameChild = q.match(/([А-ЯЁ][а-яё]+)/)?.[1] || "Ребёнок";
    await sendToSameThread("sendMessage", token, msg, { text: `${state.teacher_display_name}: ${nameChild}, ${state.policy_absence}` });
    await notifyTeacher(env, token, state, msg, "болезнь", q);
    return;
  }
  // Отсутствие без болезни — нейтрально + уведомление
  if (/(не\s+будет|пропустит|не\s+прид[её]т|не\s+сможем\s+прийти|будем\s+отсутствовать|отсутствует|отсутствуем|семейн|уезжаем|уедем)/.test(n)) {
    await sendToSameThread("sendMessage", token, msg, { text: `${state.teacher_display_name}: Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.` });
    await notifyTeacher(env, token, state, msg, "не болезнь", q);
    return;
  }

  if (/(забирать|забрать|во сколько.*заб)/.test(n)) {
    const r = resolvePickupNatural(state, msg, q, state.teacher_display_name);
    await sendToSameThread("sendMessage", token, msg, { text: r.text });
    return;
  }

  const taught = findTeachAnswer(state, q);
  if (taught) {
    const pref = addressPrefix(msg);
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: ${taught}` });
    return;
  }

  const hit = bestFaqAnswer(state, q);
  if (hit) {
    const pref = addressPrefix(msg);
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: ${hit.a}` });
    return;
  }

  // Ничего не знаем — молчим
  return;
}

/* ---------------- Small talk & школьные интенты ---------------- */
function extractTimeHHMM(text) { const m = text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractTimeFlexible(text) { const m = text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractDelayMinutes(text) { const m = normalize(text).match(/\bна\s+(\d{1,2})\s*мин/); return m ? parseInt(m[1], 10) : null; }
function guessChildName(text) { const m = text.match(/([А-ЯЁ][а-яё]+)(?=\s+(заболел|заболела|болеет|не\s+прид[её]т|опаздыва|опозда|задержива|уйд[её]т|заберу|забирать))/i); return m ? m[1] : null; }

async function handleNaturalMessage(env, token, msg, state) {
  if (state.autoreply_enabled === false) return false;
  const raw = (msg.text || "").trim();
  if (!raw) return false;
  const t = normalize(raw);
  const pref = addressPrefix(msg);

  await rememberContext(env, msg, "user", raw);

  // teach-правила — приоритетно
  const taught = findTeachAnswer(state, raw);
  if (taught) {
    const txt = `${pref}${state.teacher_display_name}: ${taught}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }

  // ❶ Авто-выдача расписания уроков
  if (/(расписан|урок)/.test(t)) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls && state.classes[cls]?.schedule_file_id) {
      await sendToSameThread("sendPhoto", token, msg, {
        photo: state.classes[cls].schedule_file_id,
        caption: `${state.teacher_display_name}: вот актуальное расписание 📋 Если будут изменения — дополню.`,
      });
      await rememberContext(env, msg, "bot", "[фото расписания]");
      return true;
    }
  }

  // ❷ Авто-выдача автобусов
  if (/(автобус|подвоз)/.test(t)) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls && state.classes[cls]?.bus_file_id) {
      await sendToSameThread("sendPhoto", token, msg, {
        photo: state.classes[cls].bus_file_id,
        caption: `${state.teacher_display_name}: вот актуальное расписание автобусов 🚌 Если будут изменения — напишу.`,
      });
      await rememberContext(env, msg, "bot", "[фото автобусов]");
      return true;
    }
  }

  // small talk
  if (/(^| )(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)) {
    const txt = `${pref}${state.teacher_display_name}: здравствуйте! Чем могу помочь?`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }
  if (/(^| )(спасибо|благодарю)( |!|$)/.test(t)) {
    const txt = `${pref}${state.teacher_display_name}: пожалуйста!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }
  if (/(^| )(пока|до свидания|досвидания|хорошего дня)( |!|$)/.test(t)) {
    const txt = `${pref}${state.teacher_display_name}: до свидания!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt); return true;
  }

  // БОЛЕЗНЬ: только мед. триггеры
  if (/(заболел|заболела|болеет|температур|простуд|орви|насморк|сопл|кашел)/.test(t)) {
    const nameChild = guessChildName(raw) || "Ребёнок";
    const txt = `${pref}${state.teacher_display_name}: ${nameChild}, ${state.policy_absence}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    await notifyTeacher(env, token, state, msg, "болезнь", raw);
    return true;
  }

  // ОТСУТСТВИЕ БЕЗ БОЛЕЗНИ: нейтральный ответ + уведомление учителю
  if (/(не\s+будет|пропустит|не\s+прид[её]м?|не\s+сможем\s+прийти|будем\s+отсутствовать|отсутствует|отсутствуем|семейн|уезжаем|уедем)/.test(t)) {
    const txt = `${pref}${state.teacher_display_name}: Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    await notifyTeacher(env, token, state, msg, "не болезнь", raw);
    return true;
  }

  // опоздание
  if (/(опаздыва|опозда|задержива|будем позже|буду позже|позже на)/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const delay = extractDelayMinutes(raw);
    const when = tm ? `к ${tm}` : (delay ? `на ~${delay} мин` : "немного");
    const txt = `${pref}${state.teacher_display_name}: поняла, подождём ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // ранний уход
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|забер[уё]).*/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `в ${tm}` : "раньше обычного";
    const txt = `${pref}${state.teacher_display_name}: хорошо, отпустим ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // заканчиваются уроки — если задан pickup, отвечаем точным временем
  if (/(во сколько|до скольки).*(заканч|кончат|урок)/.test(t)) {
    const r = resolvePickupNatural(state, msg, raw, state.teacher_display_name);
    if (r.ok) {
      await sendToSameThread("sendMessage", token, msg, { text: r.text });
      await rememberContext(env, msg, "bot", r.text);
      return true;
    }
    return false;
  }

  // какие уроки сегодня/завтра — если нет картинки, молчим
  if (/(какие|что за).*(урок|предмет).*(сегодня|завтра)/.test(t)) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls && state.classes[cls]?.schedule_file_id) {
      await sendToSameThread("sendPhoto", token, msg, {
        photo: state.classes[cls].schedule_file_id,
        caption: `${state.teacher_display_name}: по расписанию. При переносах напишу заранее.`,
      });
      await rememberContext(env, msg, "bot", "[фото расписания]");
      return true;
    }
    return false;
  }

  // «во сколько забирать/забрать»
  if (/(во сколько|сколько|когда).*(забир|забрать|забирать)/.test(t)) {
    const r = resolvePickupNatural(state, msg, raw, state.teacher_display_name);
    if (r.ok) {
      await sendToSameThread("sendMessage", token, msg, { text: r.text });
      await rememberContext(env, msg, "bot", r.text);
      return true;
    }
    return false;
  }

  // FAQ
  const hit = bestFaqAnswer(state, raw);
  if (hit) {
    const txt = `${pref}${state.teacher_display_name}: ${hit.a}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // НИЧЕГО НЕ НАЙДЕНО → МОЛЧИМ
  return false;
}

/* ---------------- Фото от учителя ---------------- */
async function handlePhotoFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать: введите /iam_teacher в личке." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Добавьте в подпись класс, например: #1Б ..." }); return; }
  ensureClass(state, cls);
  const file_id = extractLargestPhotoId(msg.photo || []);
  const isBuses = /автобус|bus/i.test(caption);

  if (isBuses) {
    state.classes[cls].bus_file_id = file_id;
    state.classes[cls].bus_caption = caption;
  } else {
    state.classes[cls].schedule_file_id = file_id;
    state.classes[cls].schedule_caption = caption;
    state.classes[cls].last_update_iso = new Date().toISOString();
  }
  await saveState(env, state);

  const rec = state.classes[cls];
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  if (!targets.length) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено для ${cls}, но чаты не привязаны. /link_general ${cls} и /link_parents ${cls}` });
    return;
  }
  for (const chatId of targets) {
    await sendSafe("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
  }
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `${isBuses ? "Автобусы" : "Расписание"} для ${cls} опубликовано ✅` });
}

/* ---------------- FAQ callbacks ---------------- */
function kbFaqItemsWrap(items, page, cat){ return kbFaqItems(items, page, 8, cat); }
async function handleCallback(env, token, cb, state) {
  const chatId = cb.message.chat.id;
  const data = cb.data || "";
  const [kind, ...rest] = data.split("::");

  if (kind === "faq_cat") {
    const cat = rest[0] || "";
    const items = (state.faq || []).filter(x => (x.cat || "") === cat);
    if (!items.length) { await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id, text: "В этой категории пока пусто" }); return; }
    await sendSafe("editMessageText", token, {
      chat_id: chatId, message_id: cb.message.message_id,
      text: `Категория: ${cat}\nВыберите вопрос:`,
      reply_markup: kbFaqItemsWrap(items, 0, cat),
    });
    return;
  }

  if (kind === "faq_nav") {
    const cat = rest[1] || "";
    const page = Math.max(0, parseInt(rest[2] || "0", 10));
    const items = cat ? (state.faq || []).filter(x => (x.cat || "") === cat) : (state.faq || []);
    await sendSafe("editMessageReplyMarkup", token, {
      chat_id: chatId, message_id: cb.message.message_id,
      reply_markup: kbFaqItemsWrap(items, page, cat),
    });
    await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
    return;
  }

  if (kind === "faq_show") {
    const idx = parseInt(rest[0] || "0", 10);
    const cat = rest[1] || "";
    const list = cat ? (state.faq || []).filter(x => (x.cat || "") === cat) : (state.faq || []);
    if (!list[idx]) { await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id, text: "Элемент не найден" }); return; }
    const item = list[idx];
    await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
    await sendSafe("sendMessage", token, { chat_id: chatId, text: `${state.teacher_display_name}: ${item.a}` });
    return;
  }

  await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
}

/* ---------------- Роутер команд ---------------- */
async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start":         await cmdStart(token, msg.chat.id); return true;
    case "/ping":          await cmdPing(token, msg); return true;

    case "/iam_teacher":   await cmdIamTeacher(env, token, msg, state); return true;
    case "/link_general":  await cmdLink(token, msg, state, args, "link_general"); await saveState(env, state); return true;
    case "/link_parents":  await cmdLink(token, msg, state, args, "link_parents"); await saveState(env, state); return true;

    case "/schedule":      await cmdSchedule(token, msg, state, args); return true;
    case "/buses":         await cmdBuses(token, msg, state, args); return true;

    case "/pickup_set":    await cmdPickupSet(env, token, msg, state, args); return true;
    case "/pickup":        await cmdPickup(token, msg, state, args); return true;
    case "/pickup_week":   {
      const cls = pickClassFromChat(state, msg.chat.id);
      if (!cls || !state.classes[cls]?.pickup_times)
        await sendToSameThread("sendMessage", token, msg, { text: "Нужно сначала задать через /pickup_set" });
      else
        await sendToSameThread("sendMessage", token, msg, { text: `Время забора на неделю — ${cls}:\n` + formatPickupWeek(state.classes[cls].pickup_times) });
      return true;
    }

    case "/ask":           await cmdAsk(env, token, msg, state, args); return true;

    case "/faq":           await cmdFaq(token, msg, state); return true;
    case "/faq_list":      await cmdFaqList(token, msg, state); return true;
    case "/faq_export":    await cmdFaqExport(token, msg, state); return true;
    case "/faq_add":       await cmdFaqAdd(env, token, msg, state, args); return true;
    case "/faq_del":       await cmdFaqDel(env, token, msg, state, args); return true;
    case "/faq_import":    await cmdFaqImport(env, token, msg, state, args); return true;
    case "/faq_clear":     await cmdFaqClear(env, token, msg, state); return true;

    case "/persona_set":        await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                  if(!isT){await sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});return;}
                                  const name=args.trim(); if(!name){await sendToSameThread("sendMessage",token,msg,{text:"Укажите отображаемое имя: /persona_set Ирина Владимировна"});return;}
                                  state.teacher_display_name=name; await saveState(env,state);
                                  await sendToSameThread("sendMessage",token,msg,{text:`Теперь отвечаю как: ${name}`}); })(); return true;

    case "/autoreply":          await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                  if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});
                                  const v=(args||"").trim().toLowerCase(); if(!["on","off"].includes(v))
                                    return sendToSameThread("sendMessage",token,msg,{text:"Используйте: /autoreply on|off"});
                                  state.autoreply_enabled=v==="on"; await saveState(env,state);
                                  await sendToSameThread("sendMessage",token,msg,{text:`Автоответы: ${state.autoreply_enabled?"ВКЛ":"ВЫКЛ"}`}); })(); return true;

    case "/policy_absence_set": await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                  if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});
                                  const txt=args.trim(); if(!txt) return sendToSameThread("sendMessage",token,msg,{text:"Формат: /policy_absence_set Текст ответа"});
                                  state.policy_absence=txt; await saveState(env,state);
                                  await sendToSameThread("sendMessage",token,msg,{text:"Политика ответа сохранена ✅"}); })(); return true;

    case "/forward_unknown":    await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                  if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});
                                  const v=(args||"").trim().toLowerCase(); if(!["on","off"].includes(v))
                                    return sendToSameThread("sendMessage",token,msg,{text:"Используйте: /forward_unknown on|off"});
                                  state.forward_unknown_to_teacher=(v==="on"); await saveState(env,state);
                                  await sendToSameThread("sendMessage",token,msg,{text:`Пересылать неизвестные вопросы учителю: ${state.forward_unknown_to_teacher?"ДА":"НЕТ"}`}); })(); return true;

    case "/notify_absence":     await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                  if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});
                                  const v=(args||"").trim().toLowerCase();
                                  if(!["on","off"].includes(v))
                                    return sendToSameThread("sendMessage",token,msg,{text:"Используйте: /notify_absence on|off"});
                                  state.notify_absence_to_teacher=(v==="on"); await saveState(env,state);
                                  await sendToSameThread("sendMessage",token,msg,{text:`Уведомления учителю о любом отсутствии: ${state.notify_absence_to_teacher?"ВКЛ":"ВЫКЛ"}`}); })(); return true;

    case "/teach":        await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Только учитель может обучать ответы."});
                                const m=args.match(/"([^"]+)"\s*=>\s*"([^"]+)"/);
                                if(!m) return sendToSameThread("sendMessage",token,msg,{text:'Формат: /teach "шаблон" => "ответ"'});
                                const [_,pat,ans]=m; state.teach=state.teach||[]; state.teach.push({pat:pat.trim(),ans:ans.trim()});
                                await saveState(env,state);
                                await sendToSameThread("sendMessage",token,msg,{text:`Добавлено правило #${state.teach.length} ✅`}); })(); return true;

    case "/teach_list":   await (async()=>{ const list=state.teach||[];
                                if(!list.length) return sendToSameThread("sendMessage",token,msg,{text:"Правила пусты. Добавьте: /teach \"шаблон\" => \"ответ\""});
                                const out=list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,80)}"`).join("\n");
                                await sendToSameThread("sendMessage",token,msg,{text: out.slice(0,4000)}); })(); return true;

    case "/teach_del":    await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});
                                const idx=parseInt(args,10); const list=state.teach||[];
                                if(isNaN(idx)||idx<1||idx>list.length) return sendToSameThread("sendMessage",token,msg,{text:"Укажите номер правила: /teach_del 2"});
                                list.splice(idx-1,1); state.teach=list; await saveState(env,state);
                                await sendToSameThread("sendMessage",token,msg,{text:"Удалено ✅"}); })(); return true;

    case "/teach_clear":  await (async()=>{ const isT=state.teacher_id&&state.teacher_id===msg.from.id;
                                if(!isT) return sendToSameThread("sendMessage",token,msg,{text:"Доступ только учителю."});
                                state.teach=[]; await saveState(env,state);
                                await sendToSameThread("sendMessage",token,msg,{text:"Все пользовательские правила очищены ✅"}); })(); return true;

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
                  "text=", update.message?.text?.slice(0,80)||"");

      const state = await loadState(env);

      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();
        // НИЧЕГО НЕ СДЕЛАЛИ → МОЛЧИМ
        return OK();
      }

      if (update.message?.photo?.length) {
        await handlePhotoFromTeacher(env, token, update.message, state);
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
