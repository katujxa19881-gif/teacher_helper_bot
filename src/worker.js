// Cloudflare Worker: Telegram-бот для класса
// Bindings / Vars (Cloudflare → Settings):
// - KV Namespace binding: KV_BOT
// - Secret: BOT_TOKEN
// - Text:   PUBLIC_URL  (без завершающего "/"; напр. https://teacher-helper.xxx.workers.dev)

const OK = (body = "ok") => new Response(body, { status: 200 });
const NO = (code = 404, body = "not found") => new Response(body, { status: code });

/* ======================= Telegram API ======================= */
async function tg(method, token, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// Диагностика: логируем каждый вызов к Telegram (видно ok/401/403)
async function sendSafe(method, token, payload) {
  try {
    const res = await tg(method, token, payload);
    console.log("SEND", method, JSON.stringify(payload), "=>", JSON.stringify(res));
    return res;
  } catch (e) {
    console.log("SEND ERROR", method, e?.toString?.() || e);
    return null;
  }
}

/* ======================= KV state ======================= */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) {
    return {
      teacher_id: null,
      classes: {
        // "5А": {
        //   general_chat_id, parents_chat_id,
        //   schedule_file_id, schedule_caption, last_update_iso,
        //   bus_file_id, bus_caption,
        //   pickup_times: {"ПН":"13:30","ВТ":"12:40",...}
        // }
      },
      faq: [],     // { q, a, kw:[], cat:"" }
      forward_unknown_to_teacher: true,
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

/* ======================= Utils ======================= */
function normalize(s = "") {
  return s.toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^a-zа-я0-9\s#:+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseClassFrom(text = "") {
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, "") : null;
}
function extractLargestPhotoId(photos = []) {
  if (!photos.length) return null;
  const bySize = [...photos].sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
  return bySize.at(-1)?.file_id || photos.at(-1)?.file_id || null;
}
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
function listCategories(state) {
  const s = new Set();
  for (const f of state.faq || []) if (f.cat) s.add(f.cat);
  return [...s].sort();
}

/* ======================= Time helpers (Europe/Amsterdam) ======================= */
const TZ = "Europe/Kaliningrad";
const DAY_SHORT = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
const DAY_FULL  = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];

function ruShortFor(date) {
  // берём первые две буквы "пн", "вт" и т.п., приводим к верхнему регистру
  const s = new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: TZ }).format(date);
  const v = s.slice(0,2).toUpperCase();
  const map = { "ПН":"ПН","ВТ":"ВТ","СР":"СР","ЧТ":"ЧТ","ПТ":"ПТ","СБ":"СБ","ВС":"ВС" };
  return map[v] || v;
}
function todayRuShort() { return ruShortFor(new Date()); }
function tomorrowRuShort() { return ruShortFor(new Date(Date.now() + 86400000)); }

function dayShortFromInput(s = "") {
  const n = normalize(s);
  if (!n) return null;
  if (n === "сегодня") return todayRuShort();
  if (n === "завтра") return tomorrowRuShort();
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
function dayNameFull(short) {
  const i = DAY_SHORT.indexOf(short);
  return i >= 0 ? DAY_FULL[i] : short;
}

/* ======================= Keyboards ======================= */
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

/* ======================= Команды: базовые ======================= */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "/schedule — показать расписание",
    "/buses — расписание автобусов",
    "/pickup [день|класс] — во сколько забирать (по дням недели)",
    "/pickup_week [класс] — время забора на всю неделю",
    "/ask ВОПРОС — спросить бота (FAQ + пересылка учителю при необходимости)",
    "/faq — список частых вопросов (кнопки/категории)",
    "",
    "Админ (учитель/родком):",
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40,...  или  /pickup_set <КЛАСС> {JSON}  (добавь 'silent' в конце, чтобы не оповещать чаты)",
    "/faq_add Вопрос | Ответ | ключ1, ключ2 | категория",
    "/faq_del <номер>   /faq_list   /faq_export",
    "/faq_import [append|replace] [JSON]",
    "/faq_clear — очистить FAQ",
    "/forward_unknown on|off — пересылать неизвестные вопросы учителю",
    "",
    "Учитель: фото расписания — подпись: #5А расписание на неделю",
    "Учитель: фото автобусов — подпись: #5А автобусы ...",
  ].join("\n");
  await sendSafe("sendMessage", token, { chat_id: chatId, text });
}
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Команда выполняется только в личке." });
    return;
  }
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Вы назначены учителем ✅" });
}
async function cmdLink(token, msg, state, args, kind) {
  const cls = parseClassFrom(args);
  if (!cls) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Укажите класс, пример: /${kind} 5А` });
    return;
  }
  ensureClass(state, cls);
  state.classes[cls][kind === "link_general" ? "general_chat_id" : "parents_chat_id"] = msg.chat.id;
  await sendSafe("sendMessage", token, {
    chat_id: msg.chat.id,
    text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для класса ${cls} ✅`,
  });
}
async function cmdSchedule(token, msg, state, args) {
  let cls = null;
  for (const [k, v] of Object.entries(state.classes)) {
    if (v.general_chat_id === msg.chat.id || v.parents_chat_id === msg.chat.id) { cls = k; break; }
  }
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args);
    if (!found) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /schedule 5А" }); return; }
    cls = found;
  }
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Этот чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." }); return; }
  const rec = state.classes[cls];
  if (!rec?.schedule_file_id) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Для ${cls} расписание ещё не загружено.` }); return; }
  await sendSafe("sendPhoto", token, { chat_id: msg.chat.id, photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
}

/* ======================= Pickup (время забора) ======================= */
function parsePickupMapping(str) {
  // ПН=13:30,ВТ=12:40,...  (разделители: запятая/точка с запятой)
  const out = {};
  const parts = str.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
  for (const p of parts) {
    const [kRaw, vRaw] = p.split("=").map(s=>s.trim());
    if (!kRaw || !vRaw) continue;
    const k = dayShortFromInput(kRaw) || kRaw.toUpperCase().slice(0,2);
    if (!DAY_SHORT.includes(k)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(vRaw)) continue;
    out[k] = vRaw;
  }
  return Object.keys(out).length ? out : null;
}
function pickClassFromChat(state, chatId) {
  for (const [k, v] of Object.entries(state.classes)) {
    if (v.general_chat_id === chatId || v.parents_chat_id === chatId) return k;
  }
  return null;
}
function formatPickupWeek(mapping) {
  const order = ["ПН","ВТ","СР","ЧТ","ПТ","СБ","ВС"];
  const rows = order.map(d => `${d} — ${mapping?.[d] || "—"}`);
  return rows.join("\n");
}
async function cmdPickupSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Доступ только учителю." }); return; }

  const parts = args.trim().split(/\s+/);
  const cls = parseClassFrom(parts[0] || "");
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Формат: /pickup_set 5А ПН=13:30,ВТ=12:40,..." }); return; }
  ensureClass(state, cls);

  const rest = args.trim().slice(args.indexOf(parts[0]) + parts[0].length).trim();
  let mapping = null;

  if (rest.startsWith("{")) {
    // JSON-формат
    try {
      const obj = JSON.parse(rest);
      const m = {};
      for (const [k,v] of Object.entries(obj || {})) {
        const kk = dayShortFromInput(k) || k.toString().toUpperCase().slice(0,2);
        if (DAY_SHORT.includes(kk) && /^\d{1,2}:\d{2}$/.test(v)) m[kk]=v;
      }
      mapping = Object.keys(m).length ? m : null;
    } catch(e) { mapping = null; }
  } else {
    // пары ключ=значение
    mapping = parsePickupMapping(rest.replace(/\bsilent\b/i, "").trim());
  }

  if (!mapping) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Не удалось распознать времена. Пример: /pickup_set 5А ПН=13:30,ВТ=12:40" }); return; }

  state.classes[cls].pickup_times = mapping;
  await saveState(env, state);

  const pretty = Object.entries(mapping).map(([k,v])=>`${k}=${v}`).join(", ");
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Готово. Время забора для ${cls}: ${pretty}` });

  // Автооповещение в чаты (кроме режима silent)
  const isSilent = /\bsilent\b/i.test(args);
  if (!isSilent) {
    const rec = state.classes[cls];
    const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
    if (targets.length) {
      const note = `Обновлено время забора (${cls}):\n` + formatPickupWeek(mapping);
      for (const chatId of targets) await sendSafe("sendMessage", token, { chat_id: chatId, text: note });
    }
  }
}
async function cmdPickup(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  let day = null;

  if (args) {
    const maybeClass = parseClassFrom(args);
    if (maybeClass) cls = maybeClass;
    const maybeDay = dayShortFromInput(args) || (normalize(args).includes("сегодня") ? todayRuShort() : null);
    if (maybeDay) day = maybeDay;
  }
  if (!cls && msg.chat.type === "private") {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /pickup 5А" });
    return;
  }
  if (!cls) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." });
    return;
  }

  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Для ${cls} ещё не задано время забора. Команда учителя: /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` });
    return;
  }

  const d = day || todayRuShort();
  const t = rec.pickup_times[d];
  if (!t) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Для ${cls} на ${dayNameFull(d)} время не задано.` });
    return;
  }
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `${cls}: ${dayNameFull(d)} — забирать в ${t}` });
}
async function cmdPickupWeek(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args || "");
    if (!found) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /pickup_week 5А" }); return; }
    cls = found;
  }
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." }); return; }

  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Для ${cls} ещё не задано время забора. /pickup_set ${cls} ПН=13:30,...` }); return; }

  const text = `Время забора на неделю — ${cls}:\n` + formatPickupWeek(rec.pickup_times);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text });
}

/* ======================= Buses ======================= */
async function cmdBuses(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args || "");
    if (!found) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /buses 5А" }); return; }
    cls = found;
  }
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." }); return; }

  const rec = state.classes[cls];
  if (!rec?.bus_file_id) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Для ${cls} расписание автобусов ещё не загружено.` }); return; }
  await sendSafe("sendPhoto", token, { chat_id: msg.chat.id, photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы ${cls}` });
}

/* ======================= FAQ ======================= */
async function cmdAsk(env, token, msg, state, args) {
  const q = args || "";
  if (!q) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Напишите вопрос после команды. Пример: /ask Когда начинаются уроки?" }); return; }

  // Спец-обработка вопросов «во сколько забирать»
  const n = normalize(q);
  if (/(забирать|забрать|во сколько.*заб)/.test(n)) {
    let cls = pickClassFromChat(state, msg.chat.id);
    if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Чтобы ответить точно, укажите класс: /pickup 5А" }); return; }
    const rec = state.classes[cls] || {};
    if (rec.pickup_times) {
      const d = todayRuShort();
      const t = rec.pickup_times[d];
      if (t) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `${cls}: сегодня (${dayNameFull(d)}) — забирать в ${t}` }); return; }
    }
    // иначе — падаем в обычный FAQ/пересылку
  }

  const hit = bestFaqAnswer(state, q);
  if (hit) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Ответ:\n${hit.a}` }); return; }

  if (state.forward_unknown_to_teacher && state.teacher_id) {
    await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Вопрос от ${msg.from?.first_name || "родителя"} (${msg.chat.id}):\n${q}` });
  }
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Пока не нашёл готового ответа. Я передал вопрос учителю. Вы получите ответ в чате 🙌" });
}
async function cmdFaq(token, msg, state) {
  const faqs = state.faq || [];
  if (!faqs.length) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "FAQ пока пуст. Админ может добавить через /faq_add" }); return; }
  const cats = listCategories(state);
  if (cats.length) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Выберите тему:", reply_markup: kbCategories(cats) });
    return;
  }
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Частые вопросы:", reply_markup: kbFaqItems(faqs, 0) });
}
async function cmdFaqList(token, chatId, state) {
  const faqs = state.faq || [];
  if (!faqs.length) { await sendSafe("sendMessage", token, { chat_id: chatId, text: "FAQ пуст." }); return; }
  const out = faqs.map((x, i) => `${i + 1}. ${x.q}${x.cat ? ` [${x.cat}]` : ""}`).join("\n");
  for (let i = 0; i < out.length; i += 3500) await sendSafe("sendMessage", token, { chat_id: chatId, text: out.slice(i, i + 3500) });
}
async function cmdFaqExport(token, chatId, state) {
  const json = JSON.stringify(state.faq || [], null, 2);
  for (let i = 0; i < json.length; i += 3500) {
    await sendSafe("sendMessage", token, { chat_id: chatId, text: "```json\n" + json.slice(i, i + 3500) + "\n```", parse_mode: "Markdown" });
  }
}
async function cmdFaqAdd(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может добавлять FAQ." }); return; }
  const parts = args.split("|").map(s => s.trim());
  if (parts.length < 2) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Формат: /faq_add Вопрос | Ответ | ключ1, ключ2 | категория" }); return; }
  const [q, a] = [parts[0], parts[1]];
  const kw = (parts[2] || "").split(",").map(s => s.trim()).filter(Boolean);
  const cat = parts[3] || "";
  state.faq = state.faq || []; state.faq.push({ q, a, kw, cat }); await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Добавлено в FAQ ✅" });
}
async function cmdFaqDel(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может удалять FAQ." }); return; }
  const idx = parseInt(args, 10);
  if (!state.faq || isNaN(idx) || idx < 1 || idx > state.faq.length) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите номер записи: /faq_del 2" }); return; }
  state.faq.splice(idx - 1, 1); await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Удалено ✅" });
}

/* ===== Импорт/очистка FAQ (массово) ===== */
function safeParseJson(s) { try { return [JSON.parse(s), null]; } catch (e) { return [null, e?.message || String(e)]; } }
async function cmdFaqImport(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Доступ только учителю." }); return; }
  let mode = "append";
  let payload = args.trim();
  if (payload.toLowerCase().startsWith("replace ")) { mode = "replace"; payload = payload.slice(8).trim(); }
  else if (payload.toLowerCase().startsWith("append ")) { payload = payload.slice(6).trim(); }
  if (!payload) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Формат: /faq_import [append|replace] [JSON]" }); return; }
  const [data, err] = safeParseJson(payload);
  if (err || !Array.isArray(data)) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Ошибка JSON или не массив." }); return; }
  const added = [];
  for (const raw of data) {
    const q = (raw?.q || "").toString().trim();
    const a = (raw?.a || "").toString().trim();
    const kw = Array.isArray(raw?.kw) ? raw.kw.map(x=>x.toString().trim()).filter(Boolean)
      : (typeof raw?.kw === "string" ? raw.kw.split(",").map(s=>s.trim()).filter(Boolean) : []);
    const cat = (raw?.cat || "").toString().trim();
    if (q && a) added.push({ q, a, kw, cat });
  }
  if (!added.length) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Нет валидных элементов (нужны q и a)." }); return; }
  if (mode === "replace") state.faq = [];
  state.faq = (state.faq || []).concat(added);
  await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Импорт завершён: ${added.length}. Режим: ${mode.toUpperCase()}. Всего: ${(state.faq||[]).length}.` });
}
async function cmdFaqClear(env, token, msg, state) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Доступ только учителю." }); return; }
  state.faq = []; await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "FAQ очищен ✅" });
}

/* ======================= Фото-обработчик (расписание / автобусы) ======================= */
async function handlePhotoFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать: введите /iam_teacher в личке." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Добавьте в подпись класс, например: #5А ..." }); return; }
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
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `${isBuses ? "Автобусы" : "Расписание"} для ${cls} опубликовано в ${targets.length} чат(а/ов) ✅` });
}

/* ======================= Callback (FAQ UI) ======================= */
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
    await sendSafe("sendMessage", token, { chat_id: chatId, text: `Q: ${item.q}\n— — —\n${item.a}` });
    return;
  }

  await sendSafe("answerCallbackQuery", token, { callback_query_id: cb.id });
}

/* ======================= Router ======================= */
async function handleCommand(env, token, msg, state) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  // было: const [cmd, ...rest] = text.split(/\s+/);
  // стало — отрезаем @username у команды:
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.replace(/@[\w_]+$/i, "");  // <-- ключевая строка
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start":          await cmdStart(token, chatId);                          return true;
    case "/iam_teacher":    await cmdIamTeacher(env, token, msg, state);            return true;
    case "/link_general":   await cmdLink(token, msg, state, args, "link_general"); await saveState(env, state); return true;
    case "/link_parents":   await cmdLink(token, msg, state, args, "link_parents"); await saveState(env, state); return true;
    case "/schedule":       await cmdSchedule(token, msg, state, args);             return true;
    case "/buses":          await cmdBuses(token, msg, state, args);                return true;
    case "/pickup_set":     await cmdPickupSet(env, token, msg, state, args);       return true;
    case "/pickup":         await cmdPickup(token, msg, state, args);               return true;
    case "/pickup_week":    await cmdPickupWeek(token, msg, state, args);           return true;
    case "/ask":            await cmdAsk(env, token, msg, state, args);             return true;
    case "/faq":            await cmdFaq(token, msg, state);                        return true;
    case "/faq_list":       await cmdFaqList(token, chatId, state);                 return true;
    case "/faq_export":     await cmdFaqExport(token, chatId, state);               return true;
    case "/faq_add":        await cmdFaqAdd(env, token, msg, state, args);          return true;
    case "/faq_del":        await cmdFaqDel(env, token, msg, state, args);          return true;
    case "/faq_import":     await cmdFaqImport(env, token, msg, state, args);       return true;
    case "/faq_clear":      await cmdFaqClear(env, token, msg, state);              return true;
    default: return false;
  }
}

/* ======================= Worker entry ======================= */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    // Healthcheck
    if (url.pathname === "/") return OK("ok");

    // Установка вебхука (ручная)
    if (url.pathname === "/init" && request.method === "POST") {
      if (!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, { url: `${env.PUBLIC_URL}/webhook/${token}` });
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    }

    // Вебхук от Telegram
    if (url.pathname === `/webhook/${token}` && request.method === "POST") {
      const update = await request.json();
      const state = await loadState(env);

      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
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
