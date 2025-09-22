// Cloudflare Worker: Telegram-бот «Учитель»
// Bindings (Settings → Variables / Secrets / KV):
// Secret: BOT_TOKEN
// Plaintext: PUBLIC_URL (например: https://teacher-helper.<account>.workers.dev) — БЕЗ завершающего "/"
// KV: KV_BOT
//
// В @BotFather → /setprivacy → Disable
//
// Возможности:
// - small talk (по-учительски), но БЕЗ подписи (по умолчанию). Вкл/выкл: /prefix on|off
// - автоответы на: опоздаем/бежим/задержимся; «не будет/пропустит»; болезнь (насморк, температура и т.п.)
// + пересылка таких сообщений учителю в ЛС
// - триггеры по естественным фразам:
// • «расписание / какие уроки» → Последнее расписание уроков
// • «звонки/перемена/во сколько заканчивается …» → Расписание звонков
// • «автобус/подвоз» → Расписание подвоза/автобусов
// • «как пополнить карту» → ВСЕ сохранённые медиа по пополнению
// • «как проверить баланс/баланс карты» → ВСЕ сохранённые медиа по балансу
// - загрузка медиа учителем в ЛС (фото/видео/док): подпись `#1Б ...` + ключевые слова:
// • «подвоз|автобус» → автобусы (1 файл — всегда актуальный)
// • «звонок|звонки|перемен» → звонки (1 файл — актуальный)
// • «попол…» → библиотека «пополнение карты» (мульти-файлы)
// • «баланс» → библиотека «баланс карты» (мульти-файлы)
// • иначе → расписание уроков (1 файл — актуальный)
// При обновлении расписаний/автобусов — авто-публикация в привязанные чаты класса
// - /teach "шаблон" => "ответ" (дообучение), /teach_list, /teach_del, /teach_clear
// - /iam_teacher, /link_general 1Б, /link_parents 1Б
// - forward_unknown on|off — пересылать учителю неизвестные вопросы (по умолчанию: on)
// - Класс по умолчанию при загрузке — 1Б (если в подписи нет #Класса)
// - Неизвестные вопросы в чате — бот молчит, только тихая пересылка учителю (если включено)

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
    console.log("SEND", method, JSON.stringify(payload).slice(0, 500), "=>", JSON.stringify(r).slice(0, 500));
    return r;
  } catch (e) {
    console.log("SEND ERROR", method, e?.message || String(e));
    return null;
  }
}
async function sendToSameThread(method, token, msg, payload = {}) {
  const p = { ...payload, chat_id: msg.chat.id };
  if ((msg.chat?.type === "supergroup" || msg.chat?.type === "group") && msg.is_topic_message && msg.message_thread_id) {
    p.message_thread_id = msg.message_thread_id;
  }
  return sendSafe(method, token, p);
}

/* ---------------- KV: состояние ---------------- */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) return freshState();
  try {
    const s = JSON.parse(raw);
    return normalizeState(s);
  } catch {
    return freshState();
  }
}
async function saveState(env, state) { await env.KV_BOT.put("state", JSON.stringify(state)); }

function freshState() {
  return {
    teacher_id: null,
    teacher_display_name: "Ирина Владимировна",
    use_prefix: false, // подпись «Ирина Владимировна: …» — выкл
    forward_unknown_to_teacher: true,
    classes: {}, // "1Б": {...}
    teach: [], // [{pat, ans}]
  };
}
function normalizeState(s) {
  s.teacher_display_name ||= "Ирина Владимировна";
  if (typeof s.use_prefix === "undefined") s.use_prefix = false;
  if (typeof s.forward_unknown_to_teacher === "undefined") s.forward_unknown_to_teacher = true;
  s.classes ||= {};
  s.teach ||= [];
  return s;
}

function ensureClass(state, cls) {
  if (!state.classes[cls]) {
    state.classes[cls] = {
      general_chat_id: null,
      parents_chat_id: null,
      // расписания: храним только актуальный файл
      schedule_file_id: null, schedule_caption: null, // уроки
      bells_file_id: null, bells_caption: null, // звонки
      bus_file_id: null, bus_caption: null, // автобусы/подвоз
      last_update_iso: null,

      // библиотеки по карте (множественные файлы)
      card_topup_media: [], // [{type:'photo'|'video'|'document', file_id, caption}]
      card_balance_media: [],

      pickup_times: null, // на будущее
    };
  }
}

/* ---------------- Утилиты ---------------- */
const DAYS = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
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
function userDisplay(u) {
  if (!u) return "";
  if (u.username) return `@${u.username}`;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || "";
}
function addressPrefix(msg, state) {
  if (!state.use_prefix) return ""; // подпись выключена
  const disp = userDisplay(msg.from || null);
  return disp ? `${disp}, ${state.teacher_display_name}: ` : `${state.teacher_display_name}: `;
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

/* ---------------- Дообучение ---------------- */
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
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general 1Б — привязать ЭТОТ чат как общий",
    "/link_parents 1Б — привязать ЭТОТ чат как чат родителей",
    "/teach \"шаблон\" => \"ответ\"; /teach_list; /teach_del <№>; /teach_clear",
    "/forward_unknown on|off — пересылать неизвестные вопросы учителю",
    "/prefix on|off — подпись в ответах (имя учителя)",
    "",
    "Загрузка медиа (ЛС учителю):",
    " #1Б подвоз — расписание автобусов (актуальный файл)",
    " #1Б звонки/перемена — расписание звонков (актуальный файл)",
    " #1Б (без ключевых слов) — расписание уроков (актуальный файл)",
    " #1Б пополнение карты … — в библиотеку «пополнение» (много файлов)",
    " #1Б баланс карты … — в библиотеку «баланс» (много файлов)",
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
  const cls = parseClassFrom(args || "") || "1Б";
  ensureClass(state, cls);
  state.classes[cls][kind === "link_general" ? "general_chat_id" : "parents_chat_id"] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, { text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для ${cls} ✅` });
}
async function cmdTeach(env, token, msg, state, args) {
  const isT = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isT) return sendToSameThread("sendMessage", token, msg, { text: "Только учитель может обучать ответы." });
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
  if (!list.length) return sendToSameThread("sendMessage", token, msg, { text: "Правила пусты." });
  const out = list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,80)}"`).join("\n");
  await sendToSameThread("sendMessage", token, msg, { text: out.slice(0,4000) });
}
async function cmdTeachDel(env, token, msg, state, args) {
  const isT = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isT) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const idx = parseInt(args,10); const list = state.teach || [];
  if (isNaN(idx)||idx<1||idx>list.length) return sendToSameThread("sendMessage", token, msg, { text: "Укажите номер: /teach_del 2" });
  list.splice(idx-1,1); state.teach = list; await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Удалено ✅" });
}
async function cmdTeachClear(env, token, msg, state) {
  const isT = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isT) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  state.teach = []; await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: "Все пользовательские правила очищены ✅" });
}
async function cmdForwardUnknown(env, token, msg, state, args) {
  const isT = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isT) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v=(args||"").trim().toLowerCase();
  if (!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /forward_unknown on|off" });
  state.forward_unknown_to_teacher = v==="on"; await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: `Пересылать неизвестные вопросы учителю: ${state.forward_unknown_to_teacher?"ДА":"НЕТ"}` });
}
async function cmdPrefix(env, token, msg, state, args) {
  const isT = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isT) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v=(args||"").trim().toLowerCase();
  if (!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /prefix on|off" });
  state.use_prefix = v==="on"; await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, { text: `Подпись в ответах: ${state.use_prefix?"ВКЛ":"ВЫКЛ"}` });
}

async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start": await cmdStart(token, msg.chat.id); return true;
    case "/ping": await cmdPing(token, msg); return true;

    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); await saveState(env, state); return true;
    case "/link_general": await cmdLink(token, msg, state, args, "link_general"); await saveState(env, state); return true;
    case "/link_parents": await cmdLink(token, msg, state, args, "link_parents"); await saveState(env, state); return true;

    case "/teach": await cmdTeach(env, token, msg, state, args); return true;
    case "/teach_list": await cmdTeachList(token, msg, state); return true;
    case "/teach_del": await cmdTeachDel(env, token, msg, state, args); return true;
    case "/teach_clear": await cmdTeachClear(env, token, msg, state); return true;

    case "/forward_unknown": await cmdForwardUnknown(env, token, msg, state, args); return true;
    case "/prefix": await cmdPrefix(env, token, msg, state, args); return true;

    default: return false;
  }
}

/* ---------------- Медиа учителя: автобусы/звонки/уроки/карта ---------------- */
function detectBucket(caption = "") {
  const n = normalize(caption);
  if (/автобус|подвоз/.test(n)) return "buses";
  if (/звонок|звонки|перемен/.test(n)) return "bells";
  if (/попол/.test(n)) return "card_topup";
  if (/баланс/.test(n)) return "card_balance";
  return "lessons";
}
function pickMediaFromMsg(msg) {
  if (msg.photo?.length) return { type: "photo", file_id: extractLargestPhotoId(msg.photo) };
  if (msg.video?.file_id) return { type: "video", file_id: msg.video.file_id };
  if (msg.document?.file_id) return { type: "document", file_id: msg.document.file_id };
  return null;
}
async function handleMediaFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать: введите /iam_teacher в личке." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption) || "1Б";
  ensureClass(state, cls);

  const media = pickMediaFromMsg(msg);
  if (!media) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Не удалось определить тип файла." }); return; }

  const bucket = detectBucket(caption);
  const rec = state.classes[cls];

  if (bucket === "lessons") {
    rec.schedule_file_id = media.file_id; rec.schedule_caption = caption; rec.last_update_iso = new Date().toISOString();
  } else if (bucket === "bells") {
    rec.bells_file_id = media.file_id; rec.bells_caption = caption;
  } else if (bucket === "buses") {
    rec.bus_file_id = media.file_id; rec.bus_caption = caption;
  } else if (bucket === "card_topup") {
    rec.card_topup_media.push({ ...media, caption });
  } else if (bucket === "card_balance") {
    rec.card_balance_media.push({ ...media, caption });
  }
  await saveState(env, state);

  // авто-публикация только для расписаний/автобусов
  if (bucket === "lessons" || bucket === "bells" || bucket === "buses") {
    const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
    for (const chatId of targets) {
      const payload = { chat_id: chatId, caption };
      if (media.type === "photo") await sendSafe("sendPhoto", token, { ...payload, photo: media.file_id });
      else if (media.type === "video") await sendSafe("sendVideo", token, { ...payload, video: media.file_id });
      else await sendSafe("sendDocument", token, { ...payload, document: media.file_id });
    }
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `${bucket === "buses" ? "Автобусы" : bucket === "bells" ? "Звонки" : "Расписание"} для ${cls} опубликовано ✅` });
  } else {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено для ${cls}: ${bucket === "card_topup" ? "пополнение карты" : "баланс карты"} ✅` });
  }
}

/* ---------------- Естественные фразы ---------------- */
function extractTimeHHMM(text) { const m = text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractTimeFlexible(text) { const m = text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }

async function handleNaturalMessage(env, token, msg, state) {
  const raw = (msg.text || "").trim();
  if (!raw) return false;
  const t = normalize(raw);

  await rememberContext(env, msg, "user", raw);

  // Дообучение имеет приоритет
  const taught = findTeachAnswer(state, raw);
  if (taught) {
    const txt = `${addressPrefix(msg, state)}${taught}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // Привет/спасибо/пока — без подписи
  if (/(^| )(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)) {
    const txt = `Здравствуйте! Чем могу помочь?`;
    await sendToSameThread("sendMessage", token, msg, { text: txt }); await rememberContext(env, msg, "bot", txt); return true;
  }
  if (/(^| )(спасибо|благодарю)( |!|$)/.test(t)) {
    const txt = `Пожалуйста!`; await sendToSameThread("sendMessage", token, msg, { text: txt }); await rememberContext(env, msg, "bot", txt); return true;
  }
  if (/(^| )(пока|до свидания|досвидания|хорошего дня)( |!|$)/.test(t)) {
    const txt = `До свидания!`; await sendToSameThread("sendMessage", token, msg, { text: txt }); await rememberContext(env, msg, "bot", txt); return true;
  }

  // Болезнь / отсутствие (ключевые слова: заболел, температура, орви, сопли, кашель, не будет, пропустит ...)
  if (/(заболел|заболела|болеет|температур|простуд|орви|грипп|насморк|сопл|кашля|не\s+будет|пропустит|не\s+прид[её]т)/.test(t)) {
    const txt = `Приняла. Выздоравливайте! Придите в школу со справкой от врача.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Уведомление об отсутствии:\n"${raw}"` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // Опоздание/задержимся/бежим
  if (/(опаздыва|опозда|задержива|будем позже|позже на|бежим)/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `к ${tm}` : "немного позже";
    const txt = `Поняла, подождём ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Сообщение об опоздании:\n"${raw}"` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // Отпустить пораньше / заберу в 10:30
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|забер[уё])/.test(t)) {
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `в ${tm}` : "раньше обычного";
    const txt = `Хорошо, отпустим ${when}. Сообщите, пожалуйста, причину в личные сообщения.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Просьба отпустить:\n"${raw}"` });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // Пополнение карты — отправляем ВСЕ медиа
  if (/(как|где|через что).*(попол|пополнить).*(карт|карта)/.test(t) || /\bпополнение карты\b/.test(t)) {
    const cls = parseClassFrom(raw) || (state.classes && Object.keys(state.classes).length ? null : null) || (parseClassFrom(msg.chat?.title||"") || null) || "1Б";
    ensureClass(state, cls);
    const list = state.classes[cls].card_topup_media || [];
    if (list.length) {
      for (const m of list) {
        const payload = { caption: m.caption || "" };
        if (m.type === "photo") await sendToSameThread("sendPhoto", token, msg, { ...payload, photo: m.file_id });
        else if (m.type === "video") await sendToSameThread("sendVideo", token, msg, { ...payload, video: m.file_id });
        else await sendToSameThread("sendDocument", token, msg, { ...payload, document: m.file_id });
      }
      return true;
    }
    return false; // молчим, если нет материалов
  }

  // Баланс карты — отправляем ВСЕ медиа
  if (/(как|где).*(провер|узнать).*(баланс).*(карт|карты)/.test(t) || /\bбаланс карты\b/.test(t)) {
    const cls = parseClassFrom(raw) || "1Б";
    ensureClass(state, cls);
    const list = state.classes[cls].card_balance_media || [];
    if (list.length) {
      for (const m of list) {
        const payload = { caption: m.caption || "" };
        if (m.type === "photo") await sendToSameThread("sendPhoto", token, msg, { ...payload, photo: m.file_id });
        else if (m.type === "video") await sendToSameThread("sendVideo", token, msg, { ...payload, video: m.file_id });
        else await sendToSameThread("sendDocument", token, msg, { ...payload, document: m.file_id });
      }
      return true;
    }
    return false;
  }

  // Расписание уроков
  if (/(расписан|какие .*урок|что за .*урок|уроки .*сегодня|уроки .*завтра|расписание на завтра|расписание на сегодня)/.test(t)) {
    const cls = parseClassFrom(raw) || "1Б";
    const rec = state.classes[cls] || {};
    if (rec.schedule_file_id) {
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
      return true;
    }
    return false;
  }

  // Звонки / перемены / «во сколько заканчивается …»
  if (/(звонк|перемен|во сколько.*(урок|заканч))/.test(t)) {
    const cls = parseClassFrom(raw) || "1Б";
    const rec = state.classes[cls] || {};
    if (rec.bells_file_id) {
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bells_file_id, caption: rec.bells_caption || `Звонки ${cls}` });
      return true;
    }
    return false;
  }

  // Автобусы / подвоз
  if (/(автобус|подвоз)/.test(t)) {
    const cls = parseClassFrom(raw) || "1Б";
    const rec = state.classes[cls] || {};
    if (rec.bus_file_id) {
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы ${cls}` });
      return true;
    }
    return false;
  }

  // Нераспознанное — молчим; при необходимости — тихо шлём учителю
  if (state.forward_unknown_to_teacher && state.teacher_id) {
    await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Вопрос из чата ${msg.chat.title || msg.chat.id}:\n"${raw}"` });
  }
  return false;
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

      console.log("UPDATE", JSON.stringify({
        kind: update.message?"message": update.callback_query?"callback": Object.keys(update)[0]||"other",
        chat: update.message?.chat?.id, from: update.message?.from?.id,
        text: update.message?.text?.slice(0,120)||"",
      }));

      const state = await loadState(env);

      // команды/текст
      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();
        return OK();
      }

      // медиа от учителя в ЛС: фото/видео/док
      if (update.message && (update.message.photo?.length || update.message.video || update.message.document)) {
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      return OK();
    }

    return NO();
  },
};
