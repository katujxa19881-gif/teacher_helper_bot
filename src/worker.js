// worker.js — Telegram bot (Cloudflare Workers)

// ====== ENV ======
const TG = (token, method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json());

const OK = () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" }});
const NO = () => new Response(JSON.stringify({ ok: true, result: "no-reply" }), { headers: { "content-type": "application/json" }});

// ====== KV state ======
const KV_KEY = "STATE_V3"; // новая схема (с миграцией)

async function loadState(env) {
  const raw = await env.KV_BOT.get(KV_KEY, "json");
  // базовое состояние
  const state = raw || {
    teacher_id: null,
    teacher_display_name: "Ирина Владимировна",
    classes: {}, // "1Б": { general_chat_id, parents_chat_id, ... }
  };
  // миграции тут если надо
  return state;
}

async function saveState(env, state) {
  await env.KV_BOT.put(KV_KEY, JSON.stringify(state), { expirationTtl: 60 * 60 * 24 * 365 });
}

function parseClassFrom(s) {
  const m = (s || "").toUpperCase().match(/(\d{1,2})\s*([А-ЯA-Z])/u);
  return m ? `${m[1]}${m[2]}` : null;
}

function ensureClass(state, cls) {
  if (!state.classes[cls]) state.classes[cls] = {};
  const rec = state.classes[cls];

  rec.general_chat_id ??= null; // общий чат
  rec.parents_chat_id ??= null; // при желании

  // Расписание (картинка документа расписания)
  rec.schedule_file_id ??= null;
  rec.schedule_caption ??= null;
  rec.last_update_iso ??= null;

  // Автобусы / Подвоз / Звонки (по одному файлу — как было)
  rec.bus_file_id ??= null; rec.bus_caption ??= null;
  rec.podvoz_file_id ??= null; rec.podvoz_caption ??= null;
  rec.bells_file_id ??= null; rec.bells_caption ??= null;

  // Школьная карта — теперь поддерживаем МАССИВ медиа
  rec.card_balance_media ??= []; // [{type,file_id,caption}]
  rec.card_topup_media ??= [];

  // миграция со старых одиночных полей, если вдруг были
  if (rec.card_balance_file_id) {
    rec.card_balance_media.push({
      type: rec.card_balance_type || "sendDocument",
      file_id: rec.card_balance_file_id,
      caption: rec.card_balance_caption || ""
    });
    delete rec.card_balance_file_id;
    delete rec.card_balance_caption;
    delete rec.card_balance_type;
  }
  if (rec.card_topup_file_id) {
    rec.card_topup_media.push({
      type: rec.card_topup_type || "sendDocument",
      file_id: rec.card_topup_file_id,
      caption: rec.card_topup_caption || ""
    });
    delete rec.card_topup_file_id;
    delete rec.card_topup_caption;
    delete rec.card_topup_type;
  }

  // Время забора (если есть)
  rec.pickup_times ??= null;

  state.classes[cls] = rec;
}

// ====== helpers ======
function log(...a){ console.log(...a); }

function nameForReply(state, mention) {
  const n = state.teacher_display_name || "Учитель";
  return mention ? `${mention}, ${n}` : n;
}

async function sendToSameThread(method, token, msg, payload) {
  // если это тема в супергруппе — сохраним thread_id
  const p = { ...payload };
  if (msg.is_topic_message && msg.message_thread_id) {
    p.message_thread_id = msg.message_thread_id;
  }
  if (msg.reply_to_message) {
    p.reply_parameters = { message_id: msg.message_id };
  }
  return TG(token, method, p);
}

async function sendText(token, msg, text) {
  return sendToSameThread("sendMessage", token, msg, { chat_id: msg.chat.id, text });
}

async function sendMediaToChat(token, chat_id, type, file_id, caption, msgForThread) {
  const payload = { chat_id, caption, ...(type === "sendPhoto" ? { photo: file_id }
                  : type === "sendVideo" ? { video: file_id }
                  : { document: file_id }) };
  if (msgForThread?.is_topic_message && msgForThread?.message_thread_id) {
    payload.message_thread_id = msgForThread.message_thread_id;
  }
  return TG(token, type, payload);
}

// отправка списка медиа (фото/видео/доки) подряд
async function sendMediaListToChat(token, msg, list = [], fallbackCaption = "") {
  if (!Array.isArray(list) || !list.length) return;
  for (const it of list) {
    const type = it.type || "sendDocument";
    const cap = it.caption || fallbackCaption;
    await sendMediaToChat(token, msg.chat.id, type, it.file_id, cap, msg);
  }
}

const norm = s => (s || "").toLowerCase().trim();
const hasAny = (t, arr) => arr.some(w => t.includes(w));

// выбрать класс, «прикреплённый» к этому чату
function pickClassFromChat(state, chatId) {
  for (const [cls, rec] of Object.entries(state.classes)) {
    if (rec.general_chat_id === chatId || rec.parents_chat_id === chatId) return cls;
  }
  return null;
}

// ====== commands ======
async function cmdPing(token, msg) {
  await sendText(token, msg, "pong ✅");
}

async function cmdStart(env, token, msg, state) {
  const text =
`Команды:
/schedule — показать расписание
/buses — расписание автобусов
/iam_teacher — назначить себя учителем (ЛС)
/link_general <КЛАСС> — привязать ЭТОТ чат как общий
/persona_set <Имя Отчество> — как будет подписываться бот
/card_media_clear <КЛАСС> balance|topup|both — очистить вложения по карте

Учитель: просто пришлите фото/видео с подписями:
  #1Б расписание на неделю
  #1Б автобусы
  #1Б подвоз
  #1Б звонки
  #1Б баланс карты
  #1Б пополнение карты
`;
  await sendText(token, msg, text);
}

async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") {
    await sendText(token, msg, "Команду нужно отправить в ЛИЧКУ боту.");
    return;
  }
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendText(token, msg, "Вы назначены учителем ✅");
}

async function cmdLinkGeneral(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendText(token, msg, "Доступ только учителю."); return; }

  const cls = parseClassFrom(args);
  if (!cls) { await sendText(token, msg, "Укажите класс, например: /link_general 1Б"); return; }

  ensureClass(state, cls);
  state.classes[cls].general_chat_id = msg.chat.id;
  await saveState(env, state);

  await sendText(token, msg, `Привязано: ОБЩИЙ чат для класса ${cls} ✅`);
}

async function cmdPersonaSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendText(token, msg, "Доступ только учителю."); return; }

  const n = args.trim();
  if (!n) { await sendText(token, msg, "Формат: /persona_set Имя Отчество"); return; }

  state.teacher_display_name = n;
  await saveState(env, state);
  await sendText(token, msg, `Имя учителя установлено: ${n} ✅`);
}

async function cmdCardMediaClear(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendText(token, msg, "Доступ только учителю."); return; }

  const parts = (args||"").trim().split(/\s+/);
  const cls = parseClassFrom(parts[0] || "");
  const what = (parts[1] || "").toLowerCase(); // balance|topup|both

  if (!cls || !what || !["balance","topup","both","all"].includes(what)) {
    await sendText(token, msg, "Формат: /card_media_clear 1Б balance|topup|both");
    return;
  }
  ensureClass(state, cls);
  const rec = state.classes[cls];
  if (what === "balance" || what === "both" || what === "all") rec.card_balance_media = [];
  if (what === "topup" || what === "both" || what === "all") rec.card_topup_media = [];
  await saveState(env, state);
  await sendText(token, msg, `Очищено: ${cls}, ${what}.`);
}

async function cmdSchedule(env, token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  if (!cls) return;
  const rec = state.classes[cls];
  if (rec?.schedule_file_id) {
    await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.schedule_file_id, rec.schedule_caption || `${state.teacher_display_name}: актуальное расписание.`, msg);
  }
}

async function cmdBuses(env, token, msg, state) {
  const cls = pickClassFromChat(state, msg.chat.id);
  if (!cls) return;
  const rec = state.classes[cls];

  // Приоритет «подвоз» (посёлки), затем общий «автобусы»
  if (rec?.podvoz_file_id) {
    await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.podvoz_file_id, rec.podvoz_caption || `${state.teacher_display_name}: актуальное расписание подвоза.`, msg);
    return;
  }
  if (rec?.bus_file_id) {
    await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.bus_file_id, rec.bus_caption || `${state.teacher_display_name}: актуальное расписание автобусов.`, msg);
  }
}

// ====== media intake from teacher ======
function getIncomingMedia(msg) {
  if (msg.photo?.length) {
    const file_id = msg.photo[msg.photo.length-1].file_id;
    return { type: "sendPhoto", file_id };
  }
  if (msg.video) return { type: "sendVideo", file_id: msg.video.file_id };
  if (msg.document) return { type: "sendDocument", file_id: msg.document.file_id };
  return null;
}

async function handleMediaFromTeacher(env, token, msg, state) {
  if (!state.teacher_id || state.teacher_id !== msg.from.id) return false;

  const media = getIncomingMedia(msg);
  if (!media) return false;

  const caption = msg.caption || "";
  const m = caption.match(/^#\s*([0-9]{1,2}\s*[А-ЯA-Z])\s+(.+)$/u);
  if (!m) return false;

  const cls = parseClassFrom(m[1]);
  const label = norm(m[2]);
  ensureClass(state, cls);
  const rec = state.classes[cls];

  let savedInfo = "";
  const capN = label;

  if (/расписан/.test(capN)) {
    rec.schedule_file_id = media.file_id;
    rec.schedule_caption = caption;
    rec.last_update_iso = new Date().toISOString();
    savedInfo = "расписание";
  } else if (/подвоз|пос[её]лок|поселок|п[оа]с[её]лк/.test(capN)) {
    rec.podvoz_file_id = media.file_id;
    rec.podvoz_caption = caption;
    savedInfo = "подвоз";
  } else if (/автобус/.test(capN)) {
    rec.bus_file_id = media.file_id;
    rec.bus_caption = caption;
    savedInfo = "автобусы";
  } else if (/звонк/.test(capN)) {
    rec.bells_file_id = media.file_id;
    rec.bells_caption = caption;
    savedInfo = "звонки";
  } else if (/баланс.*карт|карт.*баланс/.test(capN)) {
    rec.card_balance_media = rec.card_balance_media || [];
    rec.card_balance_media.push({ type: media.type, file_id: media.file_id, caption });
    savedInfo = `balance (карта) — всего: ${rec.card_balance_media.length}`;
  } else if (/попол/.test(capN) || /topup/.test(capN)) {
    rec.card_topup_media = rec.card_topup_media || [];
    rec.card_topup_media.push({ type: media.type, file_id: media.file_id, caption });
    savedInfo = `topup (карта) — всего: ${rec.card_topup_media.length}`;
  } else {
    // неизвестная подпись — молчим
    return true;
  }

  await saveState(env, state);
  await sendText(token, msg, `Сохранено (${cls} — ${savedInfo}).`);
  return true;
}

// ====== natural language ======
async function handleNaturalMessage(env, token, msg, state) {
  const t = norm(msg.text || "");
  if (!t) return false;

  const mention = msg.from?.username ? `@${msg.from.username}` : null;
  const teacherPrefix = `${nameForReply(state, mention)}:`;

  // 1) Запрос расписания уроков
  if (hasAny(t, ["расписан"]) && hasAny(t, ["урок","заняти","на недел","расписание уроков","расписание на неделю"])) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls) {
      const rec = state.classes[cls] || {};
      if (rec.schedule_file_id) {
        await sendText(token, msg, `${teacherPrefix} вот актуальное расписание. Если что-то изменится — сообщу заранее.`);
        await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.schedule_file_id, rec.schedule_caption || "", msg);
      }
    }
    return true;
  }

  // 2) Автобусы / подвоз
  if ( (hasAny(t, ["расписан","автобус","подвоз"]) && !hasAny(t, ["звонк"])) ||
       hasAny(t, ["из посёлка","с поселка","посёлков","поселков","во сколько автобус","будет подвоз"]) ) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls) {
      const rec = state.classes[cls] || {};
      // сначала подвоз (посёлки), затем автобусы
      if (rec.podvoz_file_id) {
        await sendText(token, msg, `${teacherPrefix} вот актуальное расписание подвоза. Если что-то изменится — сообщу заранее.`);
        await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.podvoz_file_id, rec.podvoz_caption || "", msg);
      } else if (rec.bus_file_id) {
        await sendText(token, msg, `${teacherPrefix} вот актуальное расписание автобусов. Если что-то изменится — сообщу заранее.`);
        await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.bus_file_id, rec.bus_caption || "", msg);
      }
    }
    return true;
  }

  // 3) Звонки: «когда перемена», «во сколько заканчивается N-й»
  if (hasAny(t, ["звонк","перемен","когда перемена","во сколько заканч"])) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls) {
      const rec = state.classes[cls] || {};
      if (rec.bells_file_id) {
        await sendText(token, msg, `${teacherPrefix} приложила расписание звонков.`);
        await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.bells_file_id, rec.bells_caption || "", msg);
      }
    }
    return true;
  }

  // 4) Баланс школьной карты — отправляем все вложения
  if (
    (hasAny(t, ["баланс", "проверить баланс", "остаток", "сколько денег"]) && hasAny(t, ["карта","карты","школьн","питани"])) ||
    hasAny(t, ["баланс карты","баланс школьной карты","баланс питания"])
  ) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls) {
      const rec = state.classes[cls] || {};
      if (rec.card_balance_media?.length) {
        await sendText(token, msg, `${teacherPrefix} инструкция — как проверить баланс школьной карты.`);
        await sendMediaListToChat(token, msg, rec.card_balance_media, "");
      }
    }
    return true;
  }

  // 5) Пополнение карты — отправляем все вложения
  if (
    (hasAny(t, ["пополнить","пополнение","зачислить","как пополнить","пополнения"]) && hasAny(t, ["карта","карты","школьн","питани"])) ||
    hasAny(t, ["пополнение карты","пополнить школьную карту","как пополнить карту"])
  ) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls) {
      const rec = state.classes[cls] || {};
      if (rec.card_topup_media?.length) {
        await sendText(token, msg, `${teacherPrefix} инструкция — как пополнить школьную карту.`);
        await sendMediaListToChat(token, msg, rec.card_topup_media, "");
      }
    }
    return true;
  }

  // 6) Отсутствие / опоздание / болезнь
  // болезнь — ключевые слова, тогда «выздоравливайте»
  const isSick = hasAny(t, ["заболел","заболела","болеет","болею","простыл","простыла","температур","насморк","кашель","сопл"]);
  const isAbsence = hasAny(t, ["не будет","не придем","не придём","отсутств","пропустит","не сможем прийти","пропускаем","не пойдём","не пойдем"]);

  if (isSick || isAbsence) {
    const cls = pickClassFromChat(state, msg.chat.id);
    if (cls) {
      // ответ в чат
      if (isSick) {
        await sendText(token, msg, `${teacherPrefix} Выздоравливайте 🙌 Придите в школу со справкой от врача.`);
      } else {
        await sendText(token, msg, `${teacherPrefix} Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`);
      }
      // уведомление учителю (если задан)
      if (state.teacher_id) {
        const who = msg.from?.first_name ? `${msg.from.first_name}${msg.from.last_name ? " "+msg.from.last_name : ""}` : "Родитель";
        const text = `🔔 Уведомление: ${who} написал(а) в чате ${cls}:\n«${msg.text}»`;
        await TG(env.BOT_TOKEN, "sendMessage", { chat_id: state.teacher_id, text });
      }
    }
    return true;
  }

  // 7) Приветствия — можно мягко откликнуться
  if (hasAny(t, ["привет","здравствуйте","добрый день","доброе утро","добрый вечер"])) {
    await sendText(token, msg, `${teacherPrefix} здравствуйте!`);
    return true;
  }

  // иначе — молчим
  return false;
}

// ====== commands router ======
async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ");

  switch (cmd) {
    case "/start": await cmdStart(env, token, msg, state); return true;
    case "/ping": await cmdPing(token, msg); return true;
    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); return true;
    case "/link_general": await cmdLinkGeneral(env, token, msg, state, args); return true;
    case "/persona_set": await cmdPersonaSet(env, token, msg, state, args); return true;
    case "/card_media_clear": await cmdCardMediaClear(env, token, msg, state, args); return true;
    case "/schedule": await cmdSchedule(env, token, msg, state); return true;
    case "/buses": await cmdBuses(env, token, msg, state); return true;
    default: return false;
  }
}

// ====== webhook ======
async function handleUpdate(env, token, update) {
  if (!update.message) return;

  const msg = update.message;
  const state = await loadState(env);

  // 1) teacher media intake
  if ((msg.photo || msg.video || msg.document) && msg.caption) {
    const done = await handleMediaFromTeacher(env, token, msg, state);
    if (done) return;
  }

  // 2) commands
  if (msg.text && msg.text.startsWith("/")) {
    const handled = await handleCommand(env, token, msg, state);
    if (handled) return;
  }

  // 3) natural language
  if (msg.text) {
    const handled = await handleNaturalMessage(env, token, msg, state);
    if (handled) return;
  }

  // 4) not matched — silence
}

// ====== routes ======
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // sanity check env
    if (!env.BOT_TOKEN || !env.PUBLIC_URL) {
      return new Response("Need BOT_TOKEN and PUBLIC_URL", { status: 500 });
    }

    // health/init
    if (url.pathname === "/init") {
      const hook = `${env.PUBLIC_URL.replace(/\/+$/,"")}/webhook/${env.BOT_TOKEN}`;
      const res = await TG(env.BOT_TOKEN, "setWebhook", { url: hook, allowed_updates: ["message","edited_message","callback_query","my_chat_member","chat_member"] });
      return new Response(JSON.stringify(res), { headers: { "content-type": "application/json" }});
    }

    // webhook
    if (url.pathname === `/webhook/${env.BOT_TOKEN}` && request.method === "POST") {
      const update = await request.json();
      try {
        await handleUpdate(env, env.BOT_TOKEN, update);
      } catch (e) { console.error("ERR", e); }
      return OK();
    }

    return new Response("OK");
  }
};
