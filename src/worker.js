// Cloudflare Worker — Telegram бот «Учитель»
// Требуется настроить в Worker bindings:
//   - Secret: BOT_TOKEN
//   - Plaintext: PUBLIC_URL   (без завершающего /)
//   - KV namespace: KV_BOT
//
// Права бота в группе: админ (хотя бы право читать/писать).
// У бота через @BotFather должен быть отключён Privacy Mode: /setprivacy → Disable.

const OK = (body = "ok") => new Response(body, { status: 200 });
const NO = (code = 404, body = "not found") => new Response(body, { status: code });

/* -------------------- Telegram API -------------------- */
async function tg(method, token, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return r.json();
}
async function sendSafe(method, token, payload) {
  try {
    const res = await tg(method, token, payload);
    console.log("SEND", method, JSON.stringify(payload), "⇒", JSON.stringify(res));
    return res;
  } catch (e) {
    console.log("SEND ERROR", method, e?.message || String(e));
    return null;
  }
}
// Отправка в тот же чат/ту же тему (если сообщение пришло из темы)
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

/* -------------------- KV: state -------------------- */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) {
    return {
      teacher_id: null,
      teacher_display_name: "Учитель",
      autoreply_enabled: true,
      forward_unknown_to_teacher: true,
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      // classes["1Б"] = { general_chat_id, parents_chat_id, schedule_file_id, schedule_caption, bus_file_id, bus_caption, pickup_times{ПН:"12:00",...}, last_update_iso }
      classes: {},
      // faq: [{ q, a, kw:[], cat:"" }]
      faq: [],
    };
  }
  return JSON.parse(raw);
}
async function saveState(env, state) {
  await env.KV_BOT.put("state", JSON.stringify(state));
}
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

/* -------------------- Utils -------------------- */
function normalize(s = "") {
  return s
    .toLowerCase()
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
function scoreMatch(text, kws) {
  const t = " " + normalize(text) + " ";
  let s = 0;
  for (const k of kws || []) {
    const kk = " " + normalize(k) + " ";
    if (t.includes(kk)) s += Math.min(kk.length, 10);
  }
  return s;
}
function bestFaqAnswer(state, question) {
  if (!state.faq?.length) return null;
  const arr = state.faq
    .map((it) => ({ it, s: scoreMatch(question, it.kw || []) }))
    .sort((a, b) => b.s - a.s);
  if (!arr[0] || arr[0].s < 5) return null;
  return arr[0].it;
}
function listCategories(state) {
  const s = new Set();
  for (const f of state.faq || []) if (f.cat) s.add(f.cat);
  return [...s].sort();
}

/* -------------------- Time helpers -------------------- */
const TZ = "Europe/Kaliningrad";
const DAYS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
const DAYS_FULL = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];
function ruShortFromDate(d) {
  const idx = Number(
    new Date(d.toLocaleString("en-US", { timeZone: TZ })).getDay()
  );
  return DAYS[idx];
}
function todayRuShort() {
  return ruShortFromDate(new Date());
}
function dayFull(short) {
  const i = DAYS.indexOf(short);
  return i >= 0 ? DAYS_FULL[i] : short;
}
function dayShortFromInput(s = "") {
  const n = normalize(s);
  if (n === "сегодня") return todayRuShort();
  if (n === "завтра") {
    const d = new Date();
    d.setUTCMinutes(d.getUTCMinutes() + 24 * 60);
    return ruShortFromDate(d);
  }
  const map = {
    пн: "ПН",
    пон: "ПН",
    понедельник: "ПН",
    mon: "ПН",
    monday: "ПН",
    вт: "ВТ",
    вторник: "ВТ",
    tue: "ВТ",
    tuesday: "ВТ",
    ср: "СР",
    среда: "СР",
    wed: "СР",
    wednesday: "СР",
    чт: "ЧТ",
    четверг: "ЧТ",
    thu: "ЧТ",
    thursday: "ЧТ",
    пт: "ПТ",
    пятница: "ПТ",
    fri: "ПТ",
    friday: "ПТ",
    сб: "СБ",
    суббота: "СБ",
    sat: "СБ",
    saturday: "СБ",
    вс: "ВС",
    воскресенье: "ВС",
    sun: "ВС",
    sunday: "ВС",
  };
  return map[n] || null;
}

/* -------------------- Keyboards -------------------- */
function kbCategories(cats) {
  return {
    inline_keyboard: cats.map((c) => [
      { text: `📚 ${c}`, callback_data: `faq_cat::${c}` },
    ]),
  };
}
function kbFaqItems(items, page = 0, perPage = 8, cat = "") {
  const start = page * perPage;
  const part = items.slice(start, start + perPage);
  const rows = part.map((it, i) => [
    {
      text: `${start + i + 1}. ${it.q.slice(0, 32)}…`,
      callback_data: `faq_show::${start + i}::${cat}`,
    },
  ]);
  const nav = [];
  if (start > 0)
    nav.push({
      text: "◀️",
      callback_data: `faq_nav::prev::${cat}::${page - 1}`,
    });
  if (start + perPage < items.length)
    nav.push({
      text: "▶️",
      callback_data: `faq_nav::next::${cat}::${page + 1}`,
    });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

/* -------------------- Small helpers -------------------- */
function pickClassFromChat(state, chatId) {
  for (const [k, v] of Object.entries(state.classes || {})) {
    if (v.general_chat_id === chatId || v.parents_chat_id === chatId) return k;
  }
  return null;
}
function parsePickupMapping(str) {
  const out = {};
  const parts = str.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    const [kRaw, vRaw] = p.split("=").map((s) => s.trim());
    if (!kRaw || !vRaw) continue;
    const k = dayShortFromInput(kRaw) || kRaw.toUpperCase().slice(0, 2);
    if (!DAYS.includes(k)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(vRaw)) continue;
    out[k] = vRaw;
  }
  return Object.keys(out).length ? out : null;
}
function formatPickupWeek(mapping) {
  const order = ["ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ", "ВС"];
  return order.map((d) => `${d} — ${mapping?.[d] || "—"}`).join("\n");
}

/* -------------------- Команды -------------------- */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "/schedule — показать расписание",
    "/buses — расписание автобусов",
    "/pickup [день|класс] — во сколько забирать сегодня/день",
    "/pickup_week [класс] — время забора на всю неделю",
    "/ask ВОПРОС — спросить бота (FAQ → при необходимости учителю)",
    "/faq — список частых вопросов",
    "",
    "Админ (учитель/родком):",
    "/iam_teacher — назначить себя учителем (только ЛС боту)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40,...  или JSON",
    "/faq_add Вопрос | Ответ | ключ1, ключ2 | категория",
    "/faq_del <номер>   /faq_list   /faq_export",
    "/faq_import [append|replace] [JSON]   /faq_clear",
    "/forward_unknown on|off — пересылать неизвестные вопросы учителю",
    "/persona_set Имя Фамилия — как будет подписываться бот",
    "/autoreply on|off — автоответы «как учитель»",
    "/policy_absence_set Текст — ответ при болезни/пропуске",
    "",
    "Учитель: фото расписания — подпись: #5А расписание на неделю",
    "Учитель: фото автобусов — подпись: #5А автобусы ...",
  ].join("\n");
  await sendSafe("sendMessage", token, { chat_id: chatId, text });
}
async function cmdPing(token, msg) {
  await sendToSameThread("sendMessage", token, msg, { text: "pong ✅" });
}
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Команда выполняется только в личке боту.",
    });
    return;
  }
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendSafe("sendMessage", token, {
    chat_id: msg.chat.id,
    text: "Вы назначены учителем ✅",
  });
}
async function cmdLink(token, msg, state, args, kind) {
  const cls = parseClassFrom(args);
  if (!cls) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `Укажите класс, пример: /${kind} 1Б`,
    });
    return;
  }
  ensureClass(state, cls);
  state.classes[cls][
    kind === "link_general" ? "general_chat_id" : "parents_chat_id"
  ] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, {
    text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для класса ${cls} ✅`,
  });
}
async function cmdSchedule(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") cls = parseClassFrom(args || "");
  if (!cls) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Чат не привязан к классу. /link_general 1Б",
    });
    return;
  }
  const rec = state.classes[cls];
  if (!rec?.schedule_file_id) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `Для ${cls} ещё не загружено расписание.`,
    });
    return;
  }
  await sendToSameThread("sendPhoto", token, msg, {
    photo: rec.schedule_file_id,
    caption: rec.schedule_caption || `Расписание ${cls}`,
  });
}
async function cmdBuses(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") cls = parseClassFrom(args || "");
  if (!cls) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Чат не привязан к классу. /link_general 1Б",
    });
    return;
  }
  const rec = state.classes[cls];
  if (!rec?.bus_file_id) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `Для ${cls} автобусы ещё не загружены.`,
    });
    return;
  }
  await sendToSameThread("sendPhoto", token, msg, {
    photo: rec.bus_file_id,
    caption: rec.bus_caption || `Автобусы ${cls}`,
  });
}
async function cmdPickupSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) {
    await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
    return;
  }

  const parts = args.trim().split(/\s+/);
  const cls = parseClassFrom(parts[0] || "");
  if (!cls) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Формат: /pickup_set 1Б ПН=13:30,ВТ=12:40,...  или JSON",
    });
    return;
  }
  ensureClass(state, cls);

  const rest = args.slice(args.indexOf(parts[0]) + parts[0].length).trim();
  let mapping = null;

  if (rest.startsWith("{")) {
    try {
      const obj = JSON.parse(rest);
      const m = {};
      for (const [k, v] of Object.entries(obj || {})) {
        const kk = dayShortFromInput(k) || k.toString().toUpperCase().slice(0, 2);
        if (DAYS.includes(kk) && /^\d{1,2}:\d{2}$/.test(String(v))) m[kk] = String(v);
      }
      mapping = Object.keys(m).length ? m : null;
    } catch (_) {
      mapping = null;
    }
  } else {
    mapping = parsePickupMapping(rest);
  }
  if (!mapping) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Не распознал время. Пример: ПН=13:30,ВТ=12:40",
    });
    return;
  }

  state.classes[cls].pickup_times = mapping;
  await saveState(env, state);

  const pretty = Object.entries(mapping)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  await sendToSameThread("sendMessage", token, msg, {
    text: `Готово. Время забора для ${cls}: ${pretty}`,
  });

  if (!/\bsilent\b/i.test(args)) {
    const rec = state.classes[cls];
    for (const chatId of [rec.general_chat_id, rec.parents_chat_id].filter(Boolean)) {
      await sendSafe("sendMessage", token, {
        chat_id: chatId,
        text: `Обновлено время забора (${cls}):\n` + formatPickupWeek(mapping),
      });
    }
  }
}
async function cmdPickup(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  let day = null;
  if (args) {
    const maybeClass = parseClassFrom(args);
    if (maybeClass) cls = maybeClass;
    const maybeDay =
      dayShortFromInput(args) ||
      (/сегодня/.test(normalize(args)) ? todayRuShort() : null);
    if (maybeDay) day = maybeDay;
  }
  if (!cls && msg.chat.type === "private") {
    await sendSafe("sendMessage", token, {
      chat_id: msg.chat.id,
      text: "Укажите класс: /pickup 1Б",
    });
    return;
  }
  if (!cls) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Чат не привязан к классу. /link_general 1Б",
    });
    return;
  }
  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `Для ${cls} ещё не задано время. /pickup_set ${cls} ...`,
    });
    return;
  }
  const d = day || todayRuShort();
  const t = rec.pickup_times[d];
  if (!t) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `Для ${cls} на ${dayFull(d)} время не задано.`,
    });
    return;
  }
  await sendToSameThread("sendMessage", token, msg, {
    text: `${cls}: ${dayFull(d)} — забирать в ${t}`,
  });
}
async function cmdPickupWeek(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") cls = parseClassFrom(args || "");
  if (!cls) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Чат не привязан к классу. /link_general 1Б",
    });
    return;
  }
  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `Для ${cls} ещё не задано время. /pickup_set ${cls} ...`,
    });
    return;
  }
  await sendToSameThread("sendMessage", token, msg, {
    text: `Время забора на неделю — ${cls}:\n` + formatPickupWeek(rec.pickup_times),
  });
}
async function cmdAsk(env, token, msg, state, args) {
  const q = args?.trim();
  if (!q) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Напишите вопрос после команды. Пример: /ask Когда будут контрольные?",
    });
    return;
  }
  // быстрый хук «во сколько забирать»
  if (/(забирать|забрать|во сколько.*заб)/i.test(q)) {
    await cmdPickup(token, msg, state, "");
    return;
  }
  const hit = bestFaqAnswer(state, q);
  if (hit) {
    await sendToSameThread("sendMessage", token, msg, { text: `Ответ:\n${hit.a}` });
    return;
  }
  if (state.forward_unknown_to_teacher && state.teacher_id) {
    await sendSafe("sendMessage", token, {
      chat_id: state.teacher_id,
      text: `Вопрос из чата ${msg.chat.title || msg.chat.id}:\n${q}`,
    });
  }
  await sendToSameThread("sendMessage", token, msg, {
    text: "Пока не нашёл готового ответа. Передал учителю 🙌",
  });
}
async function cmdFaq(token, msg, state) {
  const faqs = state.faq || [];
  if (!faqs.length) {
    await sendToSameThread("sendMessage", token, msg, { text: "FAQ пока пуст." });
    return;
  }
  const cats = listCategories(state);
  if (cats.length) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Выберите тему:",
      reply_markup: kbCategories(cats),
    });
    return;
  }
  await sendToSameThread("sendMessage", token, msg, {
    text: "Частые вопросы:",
    reply_markup: kbFaqItems(faqs, 0),
  });
}
async function cmdFaqList(token, msg, state) {
  const faqs = state.faq || [];
  if (!faqs.length) {
    await sendToSameThread("sendMessage", token, msg, { text: "FAQ пуст." });
    return;
  }
  const out = faqs
    .map((x, i) => `${i + 1}. ${x.q}${x.cat ? ` [${x.cat}]` : ""}`)
    .join("\n");
  for (let i = 0; i < out.length; i += 3500)
    await sendToSameThread("sendMessage", token, msg, { text: out.slice(i, i + 3500) });
}
async function cmdFaqExport(token, msg, state) {
  const json = JSON.stringify(state.faq || [], null, 2);
  for (let i = 0; i < json.length; i += 3500)
    await sendToSameThread("sendMessage", token, msg, {
      text: "```json\n" + json.slice(i, i + 3500) + "\n```",
      parse_mode: "Markdown",
    });
}
async function cmdFaqAdd(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) {
    await sendToSameThread("sendMessage", token, msg, { text: "Только учитель может добавлять FAQ." });
    return;
  }
  const parts = args.split("|").map((s) => s.trim());
  if (parts.length < 2) {
    await sendToSameThread("sendMessage", token, msg, {
      text: "Формат: /faq_add Вопрос | Ответ | ключ1, ключ2 | категория",
    });
    return;
  }
  const [q, a] = [parts[0], parts[1]];
  const kw = (parts[2] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const cat = parts[3] || "";
  state.faq = state.faq || [];
  state.faq.push({ q, a, kw, cat });
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Добавлено в FAQ ✅" });
}
async function cmdFaqDel(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) {
    await sendToSameThread("sendMessage", token, msg, { text: "Только учитель может удалять FAQ." });
    return;
  }
  const idx = parseInt(args, 10);
  if (isNaN(idx) || idx < 1 || idx > (state.faq?.length || 0)) {
    await sendToSameThread("sendMessage", token, msg, { text: "Укажите номер записи: /faq_del 2" });
    return;
  }
  state.faq.splice(idx - 1, 1);
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Удалено ✅" });
}
function safeParseJson(s) {
  try {
    return [JSON.parse(s), null];
  } catch (e) {
    return [null, e?.message || String(e)];
  }
}
async function cmdFaqImport(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) {
    await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
    return;
  }
  let mode = "append";
  let payload = args.trim();
  if (payload.toLowerCase().startsWith("replace ")) {
    mode = "replace";
    payload = payload.slice(8).trim();
  } else if (payload.toLowerCase().startsWith("append ")) {
    payload = payload.slice(6).trim();
  }
  if (!payload) {
    await sendToSameThread("sendMessage", token, msg, { text: "Формат: /faq_import [append|replace] [JSON]" });
    return;
  }
  const [data, err] = safeParseJson(payload);
  if (err || !Array.isArray(data)) {
    await sendToSameThread("sendMessage", token, msg, { text: "Ошибка JSON или не массив." });
    return;
  }
  const added = [];
  for (const raw of data) {
    const q = (raw?.q || "").toString().trim();
    const a = (raw?.a || "").toString().trim();
    const kw = Array.isArray(raw?.kw)
      ? raw.kw.map((x) => x.toString().trim()).filter(Boolean)
      : typeof raw?.kw === "string"
      ? raw.kw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const cat = (raw?.cat || "").toString().trim();
    if (q && a) added.push({ q, a, kw, cat });
  }
  if (!added.length) {
    await sendToSameThread("sendMessage", token, msg, { text: "Нет валидных элементов (нужны q и a)." });
    return;
  }
  if (mode === "replace") state.faq = [];
  state.faq = (state.faq || []).concat(added);
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, {
    text: `Импорт завершён: ${added.length}. Режим: ${mode.toUpperCase()}. Всего: ${(state.faq || []).length}.`,
  });
}
async function cmdFaqClear(env, token, msg, state) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) {
    await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
    return;
  }
  state.faq = [];
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "FAQ очищен ✅" });
}
async function cmdForwardUnknown(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) {
    await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
    return;
  }
  const v = (args || "").trim().toLowerCase();
  if (!["on", "off"].includes(v)) {
    await sendToSameThread("sendMessage", token, msg, { text: "Используйте: /forward_unknown on|off" });
    return;
  }
  state.forward_unknown_to_teacher = v === "on";
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, {
    text: `Пересылать неизвестные вопросы учителю: ${state.forward_unknown_to_teacher ? "ДА" : "НЕТ"}`,
  });
}

/* -------------------- Persona & автоответы -------------------- */
function extractTimeHHMM(text) {
  const m = text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
function extractTimeFlexible(text) {
  const m = text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
function extractDelayMinutes(text) {
  const m = normalize(text).match(/\bна\s+(\d{1,2})\s*мин/);
  return m ? parseInt(m[1], 10) : null;
}
function guessChildName(text) {
  const m = text.match(
    /([А-ЯЁ][а-яё]+)(?=\s+(заболел|заболела|болеет|не\s+прид[её]т|опаздыва|опозда|задержива|уйд[её]т|заберу|забирать))/i
  );
  return m ? m[1] : null;
}
async function cmdPersonaSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher)
    return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const name = args.trim();
  if (!name)
    return sendToSameThread("sendMessage", token, msg, {
      text: "Укажите имя/подпись: /persona_set Мария Ивановна",
    });
  state.teacher_display_name = name;
  await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Теперь отвечаю как: ${name}` });
}
async function cmdAutoReply(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher)
    return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v = (args || "").trim().toLowerCase();
  if (!["on", "off"].includes(v))
    return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /autoreply on|off" });
  state.autoreply_enabled = v === "on";
  await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, {
    text: `Автоответы: ${state.autoreply_enabled ? "ВКЛ" : "ВЫКЛ"}`,
  });
}
async function cmdPolicyAbsenceSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher)
    return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const txt = args.trim();
  if (!txt)
    return sendToSameThread("sendMessage", token, msg, {
      text: "Формат: /policy_absence_set Текст ответа",
    });
  state.policy_absence = txt;
  await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: "Политика сохранена ✅" });
}
async function handleNaturalMessage(env, token, msg, state) {
  if (!state.autoreply_enabled) return false;
  const raw = (msg.text || "").trim();
  if (!raw) return false;
  const t = normalize(raw);

  if (/(^| )(привет|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `${state.teacher_display_name}: здравствуйте!`,
    });
    return true;
  }
  if (/(^| )(спасибо|благодарю)( |!|$)/.test(t)) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `${state.teacher_display_name}: пожалуйста!`,
    });
    return true;
  }
  if (/(^| )(пока|до свидания|досвидания|хорошего дня)( |!|$)/.test(t)) {
    await sendToSameThread("sendMessage", token, msg, {
      text: `${state.teacher_display_name}: до свидания!`,
    });
    return true;
  }
  // Болезнь/отсутствие
  if (/(заболел|заболела|болеет|температур|простуд|орви|не\s+будет|пропустит|не\s+прид[её]т)/.test(t)) {
    const name = guessChildName(raw) || "Ребёнок";
    await sendToSameThread("sendMessage", token, msg, {
      text: `${state.teacher_display_name}: ${name}, ${state.policy_absence}`,
    });
    if (state.teacher_id)
      await sendSafe("sendMessage", token, {
        chat_id: state.teacher_id,
        text: `Уведомление об отсутствии (${msg.chat.title || msg.chat.id}):\n"${raw}"`,
      });
    return true;
  }
  // Опоздание / задержка
  if (/(опаздыва|опозда|задержива|будем позже|буду позже|позже на)/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const delay = extractDelayMinutes(raw);
    const when = tm ? `к ${tm}` : delay ? `на ~${delay} мин` : "немного";
    await sendToSameThread("sendMessage", token, msg, {
      text: `${state.teacher_display_name}: приняла, подождём ${when}.`,
    });
    if (state.teacher_id)
      await sendSafe("sendMessage", token, {
        chat_id: state.teacher_id,
        text: `Сообщение об опоздании (${msg.chat.title || msg.chat.id}):\n"${raw}"`,
      });
    return true;
  }
  // Ранний уход / заберу в <время>
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|забер[уё])/i.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `в ${tm}` : "раньше обычного";
    await sendToSameThread("sendMessage", token, msg, {
      text: `${state.teacher_display_name}: хорошо, отпустим ${when}.`,
    });
    if (state.teacher_id)
      await sendSafe("sendMessage", token, {
        chat_id: state.teacher_id,
        text: `Просьба отпустить (${msg.chat.title || msg.chat.id}):\n"${raw}"`,
      });
    return true;
  }
  // «во сколько сегодня забирать»
  if (/(во сколько|сколько)\s+(сегодня|сегоня)?.*(забир|забрать|забирать)/.test(t)) {
    await cmdPickup(token, msg, state, "");
    return true;
  }
  return false;
}

/* -------------------- Фото от учителя -------------------- */
async function handlePhotoFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, {
      chat_id: msg.chat.id,
      text: "Только учитель может загружать. Сначала /iam_teacher в личке.",
    });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if (!cls) {
    await sendSafe("sendMessage", token, {
      chat_id: msg.chat.id,
      text: "Добавьте в подпись класс, например: #1Б ...",
    });
    return;
  }
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
    await sendSafe("sendMessage", token, {
      chat_id: msg.chat.id,
      text: `Сохранено для ${cls}, но чаты не привязаны. /link_general ${cls} и /link_parents ${cls}`,
    });
    return;
  }
  for (const chatId of targets) {
    await sendSafe("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
  }
  await sendSafe("sendMessage", token, {
    chat_id: msg.chat.id,
    text: `${isBuses ? "Автобусы" : "Расписание"} для ${cls} опубликовано ✅`,
  });
}

/* -------------------- FAQ callbacks -------------------- */
function kbFaqItemsWrap(items, page, cat) {
  return kbFaqItems(items, page, 8, cat);
}
async function handleCallback(env, token, cb, state) {
  const chatId = cb.message.chat.id;
  const data = cb.data || "";
  const [kind, ...rest] = data.split("::");

  if (kind === "faq_cat") {
    const cat = rest[0] || "";
    const items = (state.faq || []).filter((x) => (x.cat || "") === cat);
    if (!items.length) {
      await sendSafe("answerCallbackQuery", token, {
        callback_query_id: cb.id,
        text: "В этой категории пока пусто",
      });
      return;
    }
    await sendSafe("editMessageText", token, {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: `Категория: ${cat}\nВыберите вопрос:`,
      reply_markup: kbFaqItemsWrap(items, 0, cat),
    });
    return;
  }
  if (kind === "faq_nav") {
    const cat = rest[1] || "";
    const page = Math.max(0, parseInt(rest[2] || "0", 10));
    const items = cat ? (state.faq || []).filter((x) => (x.cat || "") === cat) : (state.faq || []);
    await sendSafe("editMessageReplyMarkup", token, {
      chat_id: chatId,
      message_id: cb.message.message_id,
      reply_markup: kbFaqItemsWrap(items, page, cat),
    });
    await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
    return;
  }
  if (kind === "faq_show") {
    const idx = parseInt(rest[0] || "0", 10);
    const cat = rest[1] || "";
    const list = cat ? (state.faq || []).filter((x) => (x.cat || "") === cat) : (state.faq || []);
    if (!list[idx]) {
      await sendSafe("answerCallbackQuery", token, {
        callback_query_id: cb.id,
        text: "Элемент не найден",
      });
      return;
    }
    const item = list[idx];
    await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
    await sendSafe("sendMessage", token, {
      chat_id: chatId,
      text: `Q: ${item.q}\n— — —\n${item.a}`,
    });
    return;
  }
  await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
}

/* -------------------- Роутер команд -------------------- */
async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start": return await cmdStart(token, msg.chat.id), true;
    case "/ping":  return await cmdPing(token, msg), true;

    case "/iam_teacher":   return await cmdIamTeacher(env, token, msg, state), true;
    case "/link_general":  return await cmdLink(token, msg, state, args, "link_general"), await saveState(env, state), true;
    case "/link_parents":  return await cmdLink(token, msg, state, args, "link_parents"), await saveState(env, state), true;

    case "/schedule":      return await cmdSchedule(token, msg, state, args), true;
    case "/buses":         return await cmdBuses(token, msg, state, args), true;

    case "/pickup_set":    return await cmdPickupSet(env, token, msg, state, args), true;
    case "/pickup":        return await cmdPickup(token, msg, state, args), true;
    case "/pickup_week":   return await cmdPickupWeek(token, msg, state, args), true;

    case "/ask":           return await cmdAsk(env, token, msg, state, args), true;

    case "/faq":           return await cmdFaq(token, msg, state), true;
    case "/faq_list":      return await cmdFaqList(token, msg, state), true;
    case "/faq_export":    return await cmdFaqExport(token, msg, state), true;
    case "/faq_add":       return await cmdFaqAdd(env, token, msg, state, args), true;
    case "/faq_del":       return await cmdFaqDel(env, token, msg, state, args), true;
    case "/faq_import":    return await cmdFaqImport(env, token, msg, state, args), true;
    case "/faq_clear":     return await cmdFaqClear(env, token, msg, state), true;

    case "/persona_set":        return await cmdPersonaSet(env, token, msg, state, args), true;
    case "/autoreply":          return await cmdAutoReply(env, token, msg, state, args), true;
    case "/policy_absence_set": return await cmdPolicyAbsenceSet(env, token, msg, state, args), true;
    case "/forward_unknown":    return await cmdForwardUnknown(env, token, msg, state, args), true;

    default: return false;
  }
}

/* -------------------- Worker entry -------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    // Простой health-check
    if (url.pathname === "/") return OK("ok");

    // Установка вебхука (допускаем GET и POST — так удобнее в браузере)
    if (url.pathname === "/init" && (request.method === "GET" || request.method === "POST")) {
      if (!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, {
        url: `${env.PUBLIC_URL}/webhook/${token}`,
        allowed_updates: ["message","edited_message","callback_query","my_chat_member","chat_member","channel_post"],
        max_connections: 40,
      });
      return new Response(JSON.stringify(res), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Основной вебхук
    if (url.pathname === `/webhook/${token}` && request.method === "POST") {
      let update;
      try {
        update = await request.json();
      } catch {
        return NO(400, "bad json");
      }

      // Немного логов, чтобы видеть, что прилетело
      if (update.message?.message_id) {
        console.log("UPDATE kind= message ids=", JSON.stringify({
          chat: update.message.chat?.id,
          from: update.message.from?.id,
        }));
      } else if (update.callback_query?.id) {
        console.log("UPDATE kind= callback from=", update.callback_query.from?.id);
      } else {
        console.log("UPDATE kind= other");
      }

      const state = await loadState(env);

      // Текстовые команды / обычный текст
      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();
      }

      // Фото — расписание/автобусы от учителя
      if (update.message?.photo?.length) {
        await handlePhotoFromTeacher(env, token, update.message, state);
        return OK();
      }

      // Inline-кнопки FAQ
      if (update.callback_query) {
        await handleCallback(env, token, update.callback_query, state);
        return OK();
      }

      // Остальное подтверждаем
      return OK();
    }

    return NO();
  },
};
