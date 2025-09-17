// Cloudflare Worker: Telegram-бот для класса
// Функции: расписание-фото (#5А), привязка чатов, FAQ (/ask, /faq с категориями и кнопками),
// экспорт FAQ, пересылка неизвестных вопросов учителю, toggle пересылки.
// Хранилище: Cloudflare KV (binding: KV_BOT). Нужны Secrets/Vars: BOT_TOKEN, PUBLIC_URL.

const OK = (body = "ok") => new Response(body, { status: 200 });
const NO = (code = 404, body = "not found") => new Response(body, { status: code });

/* -------------------- Telegram API -------------------- */
async function tg(method, token, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

/* -------------------- State (KV) -------------------- */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) {
    return {
      teacher_id: null,
      classes: {}, // "5А": { general_chat_id, parents_chat_id, schedule_file_id, schedule_caption, last_update_iso }
      faq: [],     // { q, a, kw:[], cat:"" }
      forward_unknown_to_teacher: true,
    };
  }
  return JSON.parse(raw);
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
    };
  }
}

/* -------------------- Utils -------------------- */
function normalize(s = "") {
  return s.toLowerCase().replace(/[ё]/g, "е").replace(/[^a-zа-я0-9\s#:+-]/g, " ").replace(/\s+/g, " ").trim();
}
function parseClassFrom(text = "") {
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, "") : null;
}
function extractLargestPhotoId(photos = []) {
  if (!photos.length) return null;
  const bySize = photos.slice().sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
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
  const ranked = state.faq.map(it => ({ it, s: scoreMatch(question, it.kw || []) })).sort((a, b) => b.s - a.s);
  if (!ranked[0] || ranked[0].s < 5) return null;
  return ranked[0].it;
}
function listCategories(state) {
  const s = new Set();
  for (const f of state.faq || []) if (f.cat) s.add(f.cat);
  return [...s].sort();
}

/* -------------------- Keyboards -------------------- */
function kbCategories(cats) {
  return { inline_keyboard: cats.map(c => [{ text: `📚 ${c}`, callback_data: `faq_cat::${c}` }]) };
}
function kbFaqItems(items, page = 0, perPage = 8, cat = "") {
  const start = page * perPage;
  const slice = items.slice(start, start + perPage);
  const rows = slice.map((it, i) => [{ text: `${start + i + 1}. ${it.q.slice(0, 32)}…`, callback_data: `faq_show::${start + i}::${cat}` }]);
  const nav = [];
  if (start > 0) nav.push({ text: "◀️", callback_data: `faq_nav::prev::${cat}::${page - 1}` });
  if (start + perPage < items.length) nav.push({ text: "▶️", callback_data: `faq_nav::next::${cat}::${page + 1}` });
  if (nav.length) rows.push(nav);
  return { inline_keyboard: rows };
}

/* -------------------- Команды -------------------- */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "/schedule — показать расписание (для привязанных чатов)",
    "/ask ВОПРОС — спросить бота (FAQ + пересылка учителю при необходимости)",
    "/faq — список частых вопросов (с кнопками и категориями)",
    "",
    "Админ (учитель/родком):",
    "/iam_teacher — назначить себя учителем (в ЛС)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/faq_add Вопрос | Ответ | ключ1, ключ2 | категория",
    "/faq_del <номер>",
    "/faq_list — показать пронумерованный список FAQ",
    "/faq_export — экспорт FAQ (JSON)",
    "/forward_unknown on|off — пересылать неизвестные вопросы учителю",
    "",
    "Учитель: пришлите фото расписания в ЛС с подписью вида: #5А расписание на неделю",
  ].join("\n");
  await tg("sendMessage", token, { chat_id: chatId, text });
}
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Команда выполняется только в личке." });
  state.teacher_id = msg.from.id; await saveState(env, state);
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Вы назначены учителем ✅" });
}
async function cmdLink(token, msg, state, args, kind) {
  const cls = parseClassFrom(args);
  if (!cls) return tg("sendMessage", token, { chat_id: msg.chat.id, text: `Укажите класс, пример: /${kind} 5А` });
  ensureClass(state, cls);
  state.classes[cls][kind === "link_general" ? "general_chat_id" : "parents_chat_id"] = msg.chat.id;
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для класса ${cls} ✅` });
}
async function cmdSchedule(token, msg, state, args) {
  let cls = null;
  for (const [k, v] of Object.entries(state.classes)) {
    if (v.general_chat_id === msg.chat.id || v.parents_chat_id === msg.chat.id) { cls = k; break; }
  }
  if (!cls && msg.chat.type === "private") { const found = parseClassFrom(args); if (!found) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /schedule 5А" }); cls = found; }
  if (!cls) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Этот чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." });
  const rec = state.classes[cls];
  if (!rec?.schedule_file_id) return tg("sendMessage", token, { chat_id: msg.chat.id, text: `Для ${cls} расписание ещё не загружено.` });
  await tg("sendPhoto", token, { chat_id: msg.chat.id, photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
}
async function cmdAsk(env, token, msg, state, args) {
  const q = args || "";
  if (!q) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Напишите вопрос после команды. Пример: /ask Когда начинаются уроки?" });
  const hit = bestFaqAnswer(state, q);
  if (hit) return tg("sendMessage", token, { chat_id: msg.chat.id, text: `Ответ:\n${hit.a}` });
  if (state.forward_unknown_to_teacher && state.teacher_id) {
    await tg("sendMessage", token, { chat_id: state.teacher_id, text: `Вопрос от ${msg.from?.first_name || "родителя"} (${msg.chat.id}):\n${q}` });
  }
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Пока не нашёл готового ответа. Я передал вопрос учителю. Вы получите ответ в чате 🙌" });
}
async function cmdFaq(token, msg, state) {
  const faqs = state.faq || [];
  if (!faqs.length) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "FAQ пока пуст. Админ может добавить через /faq_add" });
  const cats = listCategories(state);
  if (cats.length) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Выберите тему:", reply_markup: kbCategories(cats) });
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Частые вопросы:", reply_markup: kbFaqItems(faqs, 0) });
}
async function cmdFaqList(token, chatId, state) {
  const faqs = state.faq || [];
  if (!faqs.length) return tg("sendMessage", token, { chat_id: chatId, text: "FAQ пуст." });
  const out = faqs.map((x, i) => `${i + 1}. ${x.q}${x.cat ? ` [${x.cat}]` : ""}`).join("\n");
  for (let i = 0; i < out.length; i += 3500) await tg("sendMessage", token, { chat_id: chatId, text: out.slice(i, i + 3500) });
}
async function cmdFaqExport(token, chatId, state) {
  const json = JSON.stringify(state.faq || [], null, 2);
  for (let i = 0; i < json.length; i += 3500) await tg("sendMessage", token, { chat_id: chatId, text: "```json\n" + json.slice(i, i + 3500) + "\n```", parse_mode: "Markdown" });
}
async function cmdFaqAdd(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может добавлять FAQ." });
  const parts = args.split("|").map(s => s.trim());
  if (parts.length < 2) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Формат: /faq_add Вопрос | Ответ | ключ1, ключ2 | категория" });
  const [q, a] = [parts[0], parts[1]];
  const kw = (parts[2] || "").split(",").map(s => s.trim()).filter(Boolean);
  const cat = parts[3] || "";
  state.faq = state.faq || []; state.faq.push({ q, a, kw, cat }); await saveState(env, state);
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Добавлено в FAQ ✅" });
}
async function cmdFaqDel(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может удалять FAQ." });
  const idx = parseInt(args, 10);
  if (!state.faq || isNaN(idx) || idx < 1 || idx > state.faq.length) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите номер записи: /faq_del 2" });
  state.faq.splice(idx - 1, 1); await saveState(env, state);
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Удалено ✅" });
}
async function cmdForwardUnknown(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Доступ только учителю." });
  const v = (args || "").trim().toLowerCase();
  if (!["on", "off"].includes(v)) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Используйте: /forward_unknown on|off" });
  state.forward_unknown_to_teacher = v === "on"; await saveState(env, state);
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: `Пересылка неизвестных вопросов: ${v === "on" ? "ВКЛ" : "ВЫКЛ"} ✅` });
}

/* -------------------- Фото расписания от учителя -------------------- */
async function handlePhotoFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать расписание. Введите /iam_teacher в личке." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if (!cls) return tg("sendMessage", token, { chat_id: msg.chat.id, text: "Добавьте в подпись класс, например: #5А расписание на неделю" });
  ensureClass(state, cls);
  const file_id = extractLargestPhotoId(msg.photo || []);
  state.classes[cls].schedule_file_id = file_id;
  state.classes[cls].schedule_caption = caption;
  state.classes[cls].last_update_iso = new Date().toISOString();
  await saveState(env, state);

  const rec = state.classes[cls];
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  if (!targets.length) {
    await tg("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено для ${cls}, но чаты не привязаны.\nЗайдите в нужный чат и выполните:\n/link_general ${cls}\n/link_parents ${cls}` });
    return;
  }
  for (const chatId of targets) await tg("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: `Расписание для ${cls} опубликовано в ${targets.length} чат(а/ов) ✅` });
}

/* -------------------- Callback FAQ -------------------- */
async function handleCallback(env, token, cb, state) {
  const chatId = cb.message.chat.id;
  const data = cb.data || "";
  const [kind, ...rest] = data.split("::");

  if (kind === "faq_cat") {
    const cat = rest[0] || "";
    const items = (state.faq || []).filter(x => (x.cat || "") === cat);
    if (!items.length) return tg("answerCallbackQuery", token, { callback_query_id: cb.id, text: "В этой категории пока пусто" });
    await tg("editMessageText", token, { chat_id: chatId, message_id: cb.message.message_id, text: `Категория: ${cat}\nВыберите вопрос:`, reply_markup: kbFaqItems(items, 0, 8, cat) });
    return;
  }
  if (kind === "faq_nav") {
    const cat = rest[1] || "";
    const page = Math.max(0, parseInt(rest[2] || "0", 10));
    const items = cat ? (state.faq || []).filter(x => (x.cat || "") === cat) : (state.faq || []);
    await tg("editMessageReplyMarkup", token, { chat_id: chatId, message_id: cb.message.message_id, reply_markup: kbFaqItems(items, page, 8, cat) });
    await tg("answerCallbackQuery", token, { callback_query_id: cb.id });
    return;
  }
  if (kind === "faq_show") {
    const idx = parseInt(rest[0] || "0", 10);
    const cat = rest[1] || "";
    const list = cat ? (state.faq || []).filter(x => (x.cat || "") === cat) : (state.faq || []);
    if (!list[idx]) return tg("answerCallbackQuery", token, { callback_query_id: cb.id, text: "Элемент не найден" });
    const item = list[idx];
    await tg("answerCallbackQuery", token, { callback_query_id: cb.id });
    await tg("sendMessage", token, { chat_id: chatId, text: `Q: ${item.q}\n— — —\n${item.a}` });
    return;
  }
  await tg("answerCallbackQuery", token, { callback_query_id: cb.id });
}

/* -------------------- Router -------------------- */
async function handleCommand(env, token, msg, state) {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start": await cmdStart(token, chatId); return true;
    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); return true;
    case "/link_general": await cmdLink(token, msg, state, args, "link_general"); await saveState(env, state); return true;
    case "/link_parents": await cmdLink(token, msg, state, args, "link_parents"); await saveState(env, state); return true;
    case "/schedule": await cmdSchedule(token, msg, state, args); return true;
    case "/ask": await cmdAsk(env, token, msg, state, args); return true;
    case "/faq": await cmdFaq(token, msg, state); return true;
    case "/faq_list": await cmdFaqList(token, chatId, state); return true;
    case "/faq_export": await cmdFaqExport(token, chatId, state); return true;
    case "/faq_add": await cmdFaqAdd(env, token, msg, state, args); return true;
    case "/faq_del": await cmdFaqDel(env, token, msg, state, args); return true;
    case "/forward_unknown": await cmdForwardUnknown(env, token, msg, state, args); return true;
    default: return false;
  }
}

/* -------------------- Worker entry -------------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    // Healthcheck
    if (url.pathname === "/") return OK("ok");

    // Ручная установка вебхука (альтернатива Testing)
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
