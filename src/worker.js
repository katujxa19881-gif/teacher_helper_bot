// worker.js — Telegram bot (Cloudflare Workers) — V3.5 (fix bells & triggers)

const TG = (token, method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());

const OK = () =>
  new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });

const KV_KEY = "STATE_V3_5";

// ---------- STATE ----------
async function loadState(env) {
  const raw = await env.KV_BOT.get(KV_KEY, "json");
  const state =
    raw || {
      teacher_id: null,
      teacher_display_name: "Ирина Владимировна",
      default_class: null,
      reply_prefix: true,
      classes: {},
    };
  return state;
}
async function saveState(env, state) {
  await env.KV_BOT.put(KV_KEY, JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24 * 365,
  });
}
function ensureClass(state, cls) {
  if (!state.classes[cls]) state.classes[cls] = {};
  const r = state.classes[cls];
  r.general_chat_id ??= null;
  r.parents_chat_id ??= null;

  r.schedule_file_id ??= null;
  r.schedule_caption ??= null;
  r.last_update_iso ??= null;

  r.bus_file_id ??= null;
  r.bus_caption ??= null;

  r.podvoz_file_id ??= null;
  r.podvoz_caption ??= null;

  r.bells_file_id ??= null;
  r.bells_caption ??= null;

  r.card_balance_media ??= [];
  r.card_topup_media ??= [];

  r.pickup_times ??= null;
}

// ---------- UTILS ----------
const norm = (s) => (s || "").toLowerCase().trim();
const hasAny = (t, arr) => arr.some((w) => t.includes(w));
const parseClassFrom = (s) => {
  const m = (s || "").toUpperCase().match(/(\d{1,2})\s*([А-ЯA-Z])/u);
  return m ? `${m[1]}${m[2]}` : null;
};
function classFromText(text) {
  const m = (text || "")
    .toUpperCase()
    .match(/(?:^|\s)[#ДЛЯПО]*\s*(\d{1,2}\s*[А-ЯA-Z])\b/u);
  return parseClassFrom(m ? m[1] : null);
}
function pickClass(state, msg, textForFallback) {
  for (const [cls, rec] of Object.entries(state.classes)) {
    if (
      rec.general_chat_id === msg.chat.id ||
      rec.parents_chat_id === msg.chat.id
    )
      return cls;
  }
  const fromText = classFromText(textForFallback);
  if (fromText && state.classes[fromText]) return fromText;
  if (
    msg.chat.type === "private" &&
    state.default_class &&
    state.classes[state.default_class]
  )
    return state.default_class;
  const keys = Object.keys(state.classes);
  if (keys.length === 1) return keys[0];
  return null;
}
const makePrefix = (state, msg) => {
  if (!state.reply_prefix) return msg.from?.username ? `@${msg.from.username},` : "";
  const name = state.teacher_display_name || "Учитель";
  return msg.from?.username ? `@${msg.from.username}, ${name}:` : `${name}:`;
};
async function sendToSameThread(method, token, msg, payload) {
  const p = { ...payload };
  if (msg.is_topic_message && msg.message_thread_id)
    p.message_thread_id = msg.message_thread_id;
  return TG(token, method, p);
}
const sendText = (token, msg, text) =>
  sendToSameThread("sendMessage", token, msg, { chat_id: msg.chat.id, text });

async function sendMediaToChat(token, chat_id, type, file_id, caption, msgForThread) {
  const payload = { chat_id, caption };
  if (type === "sendPhoto") payload.photo = file_id;
  else if (type === "sendVideo") payload.video = file_id;
  else payload.document = file_id;
  if (msgForThread?.is_topic_message && msgForThread?.message_thread_id)
    payload.message_thread_id = msgForThread.message_thread_id;
  return TG(token, type, payload);
}
async function sendMediaListToChat(token, msg, list = [], fallbackCaption = "") {
  for (const it of list || []) {
    await sendMediaToChat(
      token,
      msg.chat.id,
      it.type || "sendDocument",
      it.file_id,
      it.caption || fallbackCaption,
      msg
    );
  }
}

// ---------- COMMANDS ----------
async function cmdStart(env, token, msg, state) {
  const text = `Команды:
/schedule — показать расписание
/buses — расписание автобусов/подвоза
/iam_teacher — назначить себя учителем (ЛС)
/link_general <КЛАСС> — привязать этот чат как общий
/persona_set <Имя Отчество> — как подписывается бот
/set_default_class <КЛАСС> — класс по умолчанию (для лички)
/prefix on|off — подпись вида «Имя:»
/card_media_clear <КЛАСС> balance|topup|both — очистить файлы по карте

Учителю: присылайте файлы с подписями:
#1Б расписание на неделю
#1Б автобусы
#1Б подвоз
#1Б звонки
#1Б баланс карты
#1Б пополнение карты`;
  await sendText(token, msg, text);
}
const cmdPing = (token, msg) => sendText(token, msg, "pong ✅");
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return sendText(token, msg, "Эту команду — в личку боту.");
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendText(token, msg, "Вы назначены учителем ✅");
}
async function cmdLinkGeneral(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) return sendText(token, msg, "Доступ только учителю.");
  const cls = parseClassFrom(args);
  if (!cls) return sendText(token, msg, "Формат: /link_general 1Б");
  ensureClass(state, cls);
  state.classes[cls].general_chat_id = msg.chat.id;
  await saveState(env, state);
  await sendText(token, msg, `Привязано: ОБЩИЙ чат для класса ${cls} ✅`);
}
async function cmdPersonaSet(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) return sendText(token, msg, "Доступ только учителю.");
  const n = (args || "").trim();
  if (!n) return sendText(token, msg, "Формат: /persona_set Имя Отчество");
  state.teacher_display_name = n;
  await saveState(env, state);
  await sendText(token, msg, `Имя учителя установлено: ${n} ✅`);
}
async function cmdSetDefaultClass(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) return sendText(token, msg, "Доступ только учителю.");
  const cls = parseClassFrom(args);
  if (!cls) return sendText(token, msg, "Формат: /set_default_class 1Б");
  ensureClass(state, cls);
  state.default_class = cls;
  await saveState(env, state);
  await sendText(token, msg, `Класс по умолчанию: ${cls} ✅`);
}
async function cmdPrefix(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) return sendText(token, msg, "Доступ только учителю.");
  const v = (args || "").toLowerCase().trim();
  if (!["on", "off"].includes(v)) return sendText(token, msg, "Формат: /prefix on|off");
  state.reply_prefix = v === "on";
  await saveState(env, state);
  await sendText(token, msg, `Подпись: ${state.reply_prefix ? "включена" : "выключена"} ✅`);
}
async function cmdCardMediaClear(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) return sendText(token, msg, "Доступ только учителю.");
  const [c, w] = (args || "").trim().split(/\s+/);
  const cls = parseClassFrom(c || "");
  const what = (w || "").toLowerCase();
  if (!cls || !["balance", "topup", "both", "all"].includes(what))
    return sendText(token, msg, "Формат: /card_media_clear 1Б balance|topup|both");
  ensureClass(state, cls);
  if (what === "balance" || what === "both" || what === "all") state.classes[cls].card_balance_media = [];
  if (what === "topup" || what === "both" || what === "all") state.classes[cls].card_topup_media = [];
  await saveState(env, state);
  await sendText(token, msg, `Очищено: ${cls}, ${what}.`);
}
async function cmdSchedule(env, token, msg, state) {
  const cls = pickClass(state, msg);
  if (!cls) return;
  const rec = state.classes[cls];
  if (rec?.schedule_file_id) {
    await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.schedule_file_id, rec.schedule_caption || "", msg);
  }
}
async function cmdBuses(env, token, msg, state) {
  const cls = pickClass(state, msg);
  if (!cls) return;
  const rec = state.classes[cls];
  if (rec?.podvoz_file_id) {
    await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.podvoz_file_id, rec.podvoz_caption || "", msg);
  } else if (rec?.bus_file_id) {
    await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.bus_file_id, rec.bus_caption || "", msg);
  }
}

// ---------- MEDIA FROM TEACHER ----------
function getIncomingMedia(msg) {
  if (msg.photo?.length) return { type: "sendPhoto", file_id: msg.photo.at(-1).file_id };
  if (msg.video) return { type: "sendVideo", file_id: msg.video.file_id };
  if (msg.document) return { type: "sendDocument", file_id: msg.document.file_id };
  return null;
}

// ВАЖНО: приоритет — сначала звонки/подвоз, затем автобусы, затем обычное расписание
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

  let saved = "";

  // 1) ЗВОНКИ
  if (/звонк/.test(label) || /перемен/.test(label)) {
    rec.bells_file_id = media.file_id;
    rec.bells_caption = caption;
    saved = "звонки";
  }
  // 2) ПОДВОЗ
  else if (/подвоз|пос[её]лок|поселок|посёлк/.test(label)) {
    rec.podvoz_file_id = media.file_id;
    rec.podvoz_caption = caption;
    saved = "подвоз";
  }
  // 3) АВТОБУСЫ
  else if (/автобус/.test(label)) {
    rec.bus_file_id = media.file_id;
    rec.bus_caption = caption;
    saved = "автобусы";
  }
  // 4) РАСПИСАНИЕ УРОКОВ (но НЕ звонков)
  else if (/расписан/.test(label) && !/звонк|перемен/.test(label)) {
    rec.schedule_file_id = media.file_id;
    rec.schedule_caption = caption;
    rec.last_update_iso = new Date().toISOString();
    saved = "расписание";
  }
  // 5) Баланс / пополнение карты
  else if (/баланс.*карт|карт.*баланс/.test(label)) {
    rec.card_balance_media.push({ type: media.type, file_id: media.file_id, caption });
    saved = `balance — ${rec.card_balance_media.length}`;
  } else if (/попол/.test(label) || /topup/.test(label)) {
    rec.card_topup_media.push({ type: media.type, file_id: media.file_id, caption });
    saved = `topup — ${rec.card_topup_media.length}`;
  } else {
    return true; // неизвестная подпись — ничего не ломаем
  }

  await saveState(env, state);
  await sendText(token, msg, `Сохранено (${cls} — ${saved}).`);
  return true;
}

// ---------- NATURAL LANGUAGE ----------
async function handleNaturalMessage(env, token, msg, state) {
  const t = norm(msg.text || "");
  if (!t) return false;

  const prefix = makePrefix(state, msg);
  const cls = pickClass(state, msg, msg.text);
  if (!cls) return false;
  const rec = state.classes[cls] || {};

  // Расписание уроков (шире)
  if (
    hasAny(t, ["расписан", "расписание"]) &&
    !hasAny(t, ["автобус", "подвоз", "звонк", "перемен"])
  ) {
    if (rec.schedule_file_id) {
      if (prefix) await sendText(token, msg, `${prefix} вот актуальное расписание. Если что-то изменится — сообщу заранее.`);
      await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.schedule_file_id, rec.schedule_caption || "", msg);
      return true;
    }
  }

  // Автобусы / подвоз
  if (hasAny(t, ["автобус", "автобусы", "подвоз", "поселок", "посёлк", "посёлков", "поселков"])) {
    if (rec.podvoz_file_id) {
      if (prefix) await sendText(token, msg, `${prefix} вот актуальное расписание подвоза. Если что-то изменится — сообщу заранее.`);
      await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.podvoz_file_id, rec.podvoz_caption || "", msg);
      return true;
    } else if (rec.bus_file_id) {
      if (prefix) await sendText(token, msg, `${prefix} вот актуальное расписание автобусов. Если что-то изменится — сообщу заранее.`);
      await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.bus_file_id, rec.bus_caption || "", msg);
      return true;
    }
  }

  // Звонки / перемена
  if (hasAny(t, ["перемен", "звонок", "звонки", "расписание звонков", "во сколько заканч", "когда заканч", "когда перемена"])) {
    if (rec.bells_file_id) {
      if (prefix) await sendText(token, msg, `${prefix} приложила расписание звонков.`);
      await sendMediaToChat(token, msg.chat.id, "sendDocument", rec.bells_file_id, rec.bells_caption || "", msg);
      return true;
    }
  }

  // Баланс карты
  if (
    (hasAny(t, ["баланс", "проверить баланс", "остаток", "сколько денег"]) && hasAny(t, ["карта", "карты", "школьн", "питани"])) ||
    hasAny(t, ["баланс карты", "баланс школьной карты", "баланс питания", "как проверить баланс карты"])
  ) {
    if (rec.card_balance_media?.length) {
      if (prefix) await sendText(token, msg, `${prefix} инструкция — как проверить баланс школьной карты.`);
      await sendMediaListToChat(token, msg, rec.card_balance_media, "");
      return true;
    }
  }

  // Пополнение карты
  if (
    (hasAny(t, ["пополнить", "пополнение", "зачислить"]) && hasAny(t, ["карта", "карты", "школьн", "питани"])) ||
    hasAny(t, ["пополнение карты", "пополнить школьную карту", "как пополнить карту", "как пополнить баланс карты"])
  ) {
    if (rec.card_topup_media?.length) {
      if (prefix) await sendText(token, msg, `${prefix} инструкция — как пополнить школьную карту.`);
      await sendMediaListToChat(token, msg, rec.card_topup_media, "");
      return true;
    }
  }

  // Болезнь / отсутствие
  const isSick = hasAny(t, ["заболел", "заболела", "болеет", "болею", "простыл", "простыла", "температур", "насморк", "кашель", "сопл"]);
  const isAbsence = hasAny(t, ["не будет", "не придем", "не придём", "отсутств", "пропустит", "не сможем прийти", "пропускаем", "не пойдём", "не пойдем"]);
  if (isSick || isAbsence) {
    if (isSick) {
      if (prefix) await sendText(token, msg, `${prefix} Выздоравливайте 🙌 Придите в школу со справкой от врача.`);
    } else {
      if (prefix) await sendText(token, msg, `${prefix} Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`);
    }
    if (state.teacher_id) {
      const who = msg.from?.first_name
        ? `${msg.from.first_name}${msg.from.last_name ? " " + msg.from.last_name : ""}`
        : "Родитель";
      const notify = `🔔 Уведомление: ${who} написал(а) в чате ${cls}:\n«${msg.text}»`;
      await TG(env.BOT_TOKEN, "sendMessage", { chat_id: state.teacher_id, text: notify });
    }
    return true;
  }

  // Приветствия — просто чтобы было живо
  if (hasAny(t, ["привет", "здравствуйте", "добрый день", "доброе утро", "добрый вечер"])) {
    if (prefix) await sendText(token, msg, `${prefix} здравствуйте!`);
    return true;
  }

  return false;
}

// ---------- ROUTER ----------
async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ");
  switch (cmd) {
    case "/start": return cmdStart(env, token, msg, state), true;
    case "/ping": return cmdPing(token, msg), true;
    case "/iam_teacher": return cmdIamTeacher(env, token, msg, state), true;
    case "/link_general": return cmdLinkGeneral(env, token, msg, state, args), true;
    case "/persona_set": return cmdPersonaSet(env, token, msg, state, args), true;
    case "/set_default_class": return cmdSetDefaultClass(env, token, msg, state, args), true;
    case "/prefix": return cmdPrefix(env, token, msg, state, args), true;
    case "/card_media_clear": return cmdCardMediaClear(env, token, msg, state, args), true;
    case "/schedule": return cmdSchedule(env, token, msg, state), true;
    case "/buses": return cmdBuses(env, token, msg, state), true;
    default: return false;
  }
}
async function handleUpdate(env, token, update) {
  if (!update.message) return;
  const msg = update.message;
  const state = await loadState(env);

  if ((msg.photo || msg.video || msg.document) && msg.caption) {
    const done = await handleMediaFromTeacher(env, token, msg, state);
    if (done) return;
  }
  if (msg.text && msg.text.startsWith("/")) {
    const handled = await handleCommand(env, token, msg, state);
    if (handled) return;
  }
  if (msg.text) {
    const handled = await handleNaturalMessage(env, token, msg, state);
    if (handled) return;
  }
}

// ---------- WORKER ----------
export default {
  async fetch(request, env) {
    if (!env.BOT_TOKEN || !env.PUBLIC_URL)
      return new Response("Need BOT_TOKEN and PUBLIC_URL", { status: 500 });

    const url = new URL(request.url);

    if (url.pathname === "/init") {
      const hook = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhook/${env.BOT_TOKEN}`;
      const res = await TG(env.BOT_TOKEN, "setWebhook", {
        url: hook,
        allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"],
      });
      return new Response(JSON.stringify(res), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === `/webhook/${env.BOT_TOKEN}` && request.method === "POST") {
      const update = await request.json();
      try {
        await handleUpdate(env, env.BOT_TOKEN, update);
      } catch (e) {
        console.error(e);
      }
      return OK();
    }

    return new Response("OK");
  },
};
