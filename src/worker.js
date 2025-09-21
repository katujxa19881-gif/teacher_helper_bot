// worker.js — Telegram bot (Cloudflare Workers) — V3.4 (wider triggers)

const TG = (token, method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(r => r.json());

const OK = () =>
  new Response(JSON.stringify({ ok: true }), {
    headers: { "content-type": "application/json" },
  });

const KV_KEY = "STATE_V3_4";

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

const norm = (s) => (s || "").toLowerCase().trim();
const hasAny = (t, arr) => arr.some((w) => t.includes(w));

function parseClassFrom(s) {
  const m = (s || "").toUpperCase().match(/(\d{1,2})\s*([А-ЯA-Z])/u);
  return m ? `${m[1]}${m[2]}` : null;
}

function ensureClass(state, cls) {
  if (!state.classes[cls]) state.classes[cls] = {};
  const rec = state.classes[cls];

  rec.general_chat_id ??= null;
  rec.parents_chat_id ??= null;

  rec.schedule_file_id ??= null;
  rec.schedule_caption ??= null;
  rec.last_update_iso ??= null;

  rec.bus_file_id ??= null;
  rec.bus_caption ??= null;

  rec.podvoz_file_id ??= null;
  rec.podvoz_caption ??= null;

  rec.bells_file_id ??= null;
  rec.bells_caption ??= null;

  rec.card_balance_media ??= [];
  rec.card_topup_media ??= [];

  rec.pickup_times ??= null;
}

function makePrefix(state, msg) {
  const mention = msg.from?.username ? `@${msg.from.username}` : null;
  const name = state.teacher_display_name || "Учитель";
  if (!state.reply_prefix) return mention ? `${mention},` : "";
  return mention ? `${mention}, ${name}:` : `${name}:`;
}

async function sendToSameThread(method, token, msg, payload) {
  const p = { ...payload };
  if (msg.is_topic_message && msg.message_thread_id)
    p.message_thread_id = msg.message_thread_id;
  return TG(token, method, p);
}
async function sendText(token, msg, text) {
  return sendToSameThread("sendMessage", token, msg, {
    chat_id: msg.chat.id,
    text,
  });
}
async function sendMediaToChat(token, chat_id, type, file_id, caption, msgForThread) {
  const payload = { chat_id, caption };
  if (type === "sendPhoto") payload.photo = file_id;
  else if (type === "sendVideo") payload.video = file_id;
  else payload.document = file_id;
  if (msgForThread?.is_topic_message && msgForThread?.message_thread_id) {
    payload.message_thread_id = msgForThread.message_thread_id;
  }
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
  ) {
    return state.default_class;
  }
  const keys = Object.keys(state.classes);
  if (keys.length === 1) return keys[0];
  return null;
}

// ===== команды
async function cmdStart(env, token, msg, state) {
  const text = `Команды:
/schedule — показать расписание
/buses — расписание автобусов/подвоза
/iam_teacher — назначить себя учителем (ЛС)
/link_general <КЛАСС> — привязать ЭТОТ чат как общий
/persona_set <Имя Отчество> — как подписывается бот
/set_default_class <КЛАСС> — класс по умолчанию (для лички)
/prefix on|off — показывать в ответе «Имя:» (по умолчанию: on)
/card_media_clear <КЛАСС> balance|topup|both — очистить вложения по карте

Учитель может присылать файлы с подписями:
#1Б расписание на неделю
#1Б автобусы
#1Б подвоз
#1Б звонки
#1Б баланс карты (можно несколько файлов)
#1Б пополнение карты (можно несколько)`;
  await sendText(token, msg, text);
}
async function cmdPing(token, msg) {
  await sendText(token, msg, "pong ✅");
}
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") {
    await sendText(token, msg, "Отправьте эту команду в ЛИЧКУ боту.");
    return;
  }
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendText(token, msg, "Вы назначены учителем ✅");
}
async function cmdLinkGeneral(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) {
    await sendText(token, msg, "Доступ только учителю.");
    return;
  }
  const cls = parseClassFrom(args);
  if (!cls) {
    await sendText(token, msg, "Формат: /link_general 1Б");
    return;
  }
  ensureClass(state, cls);
  state.classes[cls].general_chat_id = msg.chat.id;
  await saveState(env, state);
  await sendText(token, msg, `Привязано: ОБЩИЙ чат для класса ${cls} ✅`);
}
async function cmdPersonaSet(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) {
    await sendText(token, msg, "Доступ только учителю.");
    return;
  }
  const n = (args || "").trim();
  if (!n) {
    await sendText(token, msg, "Формат: /persona_set Имя Отчество");
    return;
  }
  state.teacher_display_name = n;
  await saveState(env, state);
  await sendText(token, msg, `Имя учителя установлено: ${n} ✅`);
}
async function cmdSetDefaultClass(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) {
    await sendText(token, msg, "Доступ только учителю.");
    return;
  }
  const cls = parseClassFrom(args);
  if (!cls) {
    await sendText(token, msg, "Формат: /set_default_class 1Б");
    return;
  }
  ensureClass(state, cls);
  state.default_class = cls;
  await saveState(env, state);
  await sendText(token, msg, `Класс по умолчанию: ${cls} ✅`);
}
async function cmdPrefix(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) {
    await sendText(token, msg, "Доступ только учителю.");
    return;
  }
  const v = (args || "").toLowerCase().trim();
  if (!["on", "off"].includes(v)) {
    await sendText(token, msg, "Формат: /prefix on|off");
    return;
  }
  state.reply_prefix = v === "on";
  await saveState(env, state);
  await sendText(
    token,
    msg,
    `Подпись в ответах: ${state.reply_prefix ? "включена" : "выключена"} ✅`
  );
}
async function cmdCardMediaClear(env, token, msg, state, args) {
  if (state.teacher_id !== msg.from.id) {
    await sendText(token, msg, "Доступ только учителю.");
    return;
  }
  const [c, w] = (args || "").trim().split(/\s+/);
  const cls = parseClassFrom(c || "");
  const what = (w || "").toLowerCase();
  if (!cls || !["balance", "topup", "both", "all"].includes(what)) {
    await sendText(
      token,
      msg,
      "Формат: /card_media_clear 1Б balance|topup|both"
    );
    return;
  }
  ensureClass(state, cls);
  if (what === "balance" || what === "both" || what === "all")
    state.classes[cls].card_balance_media = [];
  if (what === "topup" || what === "both" || what === "all")
    state.classes[cls].card_topup_media = [];
  await saveState(env, state);
  await sendText(token, msg, `Очищено: ${cls}, ${what}.`);
}
async function cmdSchedule(env, token, msg, state) {
  const cls = pickClass(state, msg);
  if (!cls) return;
  const rec = state.classes[cls];
  if (rec?.schedule_file_id) {
    await sendMediaToChat(
      token,
      msg.chat.id,
      "sendDocument",
      rec.schedule_file_id,
      rec.schedule_caption || "",
      msg
    );
  }
}
async function cmdBuses(env, token, msg, state) {
  const cls = pickClass(state, msg);
  if (!cls) return;
  const rec = state.classes[cls];
  if (rec?.podvoz_file_id) {
    await sendMediaToChat(
      token,
      msg.chat.id,
      "sendDocument",
      rec.podvoz_file_id,
      rec.podvoz_caption || "",
      msg
    );
  } else if (rec?.bus_file_id) {
    await sendMediaToChat(
      token,
      msg.chat.id,
      "sendDocument",
      rec.bus_file_id,
      rec.bus_caption || "",
      msg
    );
  }
}

// ===== медиа от учителя
function getIncomingMedia(msg) {
  if (msg.photo?.length)
    return { type: "sendPhoto", file_id: msg.photo.at(-1).file_id };
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

  let saved = "";
  if (/расписан/.test(label)) {
    rec.schedule_file_id = media.file_id;
    rec.schedule_caption = caption;
    rec.last_update_iso = new Date().toISOString();
    saved = "расписание";
  } else if (/подвоз|пос[её]лок|поселок|посёлк/.test(label)) {
    rec.podvoz_file_id = media.file_id;
    rec.podvoz_caption = caption;
    saved = "подвоз";
  } else if (/автобус/.test(label)) {
    rec.bus_file_id = media.file_id;
    rec.bus_caption = caption;
    saved = "автобусы";
  } else if (/звонк/.test(label)) {
    rec.bells_file_id = media.file_id;
    rec.bells_caption = caption;
    saved = "звонки";
  } else if (/баланс.*карт|карт.*баланс/.test(label)) {
    rec.card_balance_media.push({
      type: media.type,
      file_id: media.file_id,
      caption,
    });
    saved = `balance — ${rec.card_balance_media.length}`;
  } else if (/попол/.test(label) || /topup/.test(label)) {
    rec.card_topup_media.push({
      type: media.type,
      file_id: media.file_id,
      caption,
    });
    saved = `topup — ${rec.card_topup_media.length}`;
  } else {
    return true;
  }
  await saveState(env, state);
  await sendText(token, msg, `Сохранено (${cls} — ${saved}).`);
  return true;
}

// ===== естественные сообщения (расширенные триггеры)
async function handleNaturalMessage(env, token, msg, state) {
  const t = norm(msg.text || "");
  if (!t) return false;

  const prefix = makePrefix(state, msg);
  const cls = pickClass(state, msg, msg.text);
  if (!cls) return false;
  const rec = state.classes[cls] || {};

  // NEW: Расписание уроков — реагируем, если встречается "расписан"/"расписание",
  // даже без слов "уроки/занятия/неделя/завтра".
  if (
    hasAny(t, ["расписан", "расписание"]) &&
    !hasAny(t, ["автобус", "подвоз", "звонк", "перемен"])
  ) {
    if (rec.schedule_file_id) {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} вот актуальное расписание. Если что-то изменится — сообщу заранее.`
        );
      await sendMediaToChat(
        token,
        msg.chat.id,
        "sendDocument",
        rec.schedule_file_id,
        rec.schedule_caption || "",
        msg
      );
      return true;
    }
  }

  // NEW: Автобусы / подвоз — любые формулировки про автобус/подвоз/посёлки
  if (
    hasAny(t, [
      "автобус",
      "автобусы",
      "подвоз",
      "поселок",
      "посёлк",
      "посёлков",
      "поселков",
      "во сколько автобус",
      "будет подвоз",
    ])
  ) {
    if (rec.podvoz_file_id) {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} вот актуальное расписание подвоза. Если что-то изменится — сообщу заранее.`
        );
      await sendMediaToChat(
        token,
        msg.chat.id,
        "sendDocument",
        rec.podvoz_file_id,
        rec.podvoz_caption || "",
        msg
      );
      return true;
    } else if (rec.bus_file_id) {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} вот актуальное расписание автобусов. Если что-то изменится — сообщу заранее.`
        );
      await sendMediaToChat(
        token,
        msg.chat.id,
        "sendDocument",
        rec.bus_file_id,
        rec.bus_caption || "",
        msg
      );
      return true;
    }
  }

  // NEW: Звонки / перемены — реагируем на «перемена», «когда перемена», «звонок/звонки»
  if (
    hasAny(t, [
      "перемен",
      "когда перемена",
      "звонок",
      "звонки",
      "расписание звонков",
      "во сколько заканч",
      "когда заканч",
    ])
  ) {
    if (rec.bells_file_id) {
      if (prefix)
        await sendText(token, msg, `${prefix} приложила расписание звонков.`);
      await sendMediaToChat(
        token,
        msg.chat.id,
        "sendDocument",
        rec.bells_file_id,
        rec.bells_caption || "",
        msg
      );
      return true;
    }
  }

  // Баланс карты
  if (
    (hasAny(t, ["баланс", "проверить баланс", "остаток", "сколько денег"]) &&
      hasAny(t, ["карта", "карты", "школьн", "питани"])) ||
    hasAny(t, [
      "баланс карты",
      "баланс школьной карты",
      "баланс питания",
      "как проверить баланс карты",
    ])
  ) {
    if (rec.card_balance_media?.length) {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} инструкция — как проверить баланс школьной карты.`
        );
      await sendMediaListToChat(token, msg, rec.card_balance_media, "");
      return true;
    }
  }

  // Пополнение карты
  if (
    (hasAny(t, ["пополнить", "пополнение", "зачислить"]) &&
      hasAny(t, ["карта", "карты", "школьн", "питани"])) ||
    hasAny(t, [
      "пополнение карты",
      "пополнить школьную карту",
      "как пополнить карту",
      "как пополнить баланс карты",
    ])
  ) {
    if (rec.card_topup_media?.length) {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} инструкция — как пополнить школьную карту.`
        );
      await sendMediaListToChat(token, msg, rec.card_topup_media, "");
      return true;
    }
  }

  // Болезнь / отсутствие
  const isSick = hasAny(t, [
    "заболел",
    "заболела",
    "болеет",
    "болею",
    "простыл",
    "простыла",
    "температур",
    "насморк",
    "кашель",
    "сопл",
  ]);
  const isAbsence = hasAny(t, [
    "не будет",
    "не придем",
    "не придём",
    "отсутств",
    "пропустит",
    "не сможем прийти",
    "пропускаем",
    "не пойдём",
    "не пойдем",
  ]);
  if (isSick || isAbsence) {
    if (isSick) {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} Выздоравливайте 🙌 Придите в школу со справкой от врача.`
        );
    } else {
      if (prefix)
        await sendText(
          token,
          msg,
          `${prefix} Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`
        );
    }
    if (state.teacher_id) {
      const who = msg.from?.first_name
        ? `${msg.from.first_name}${
            msg.from.last_name ? " " + msg.from.last_name : ""
          }`
        : "Родитель";
      const text = `🔔 Уведомление: ${who} написал(а) в чате ${cls}:\n«${msg.text}»`;
      await TG(env.BOT_TOKEN, "sendMessage", {
        chat_id: state.teacher_id,
        text,
      });
    }
    return true;
  }

  // Приветствия
  if (hasAny(t, ["привет", "здравствуйте", "добрый день", "доброе утро", "добрый вечер"])) {
    if (prefix) await sendText(token, msg, `${prefix} здравствуйте!`);
    return true;
  }

  return false;
}

// ===== роутер
async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ");

  switch (cmd) {
    case "/start":
      await cmdStart(env, token, msg, state);
      return true;
    case "/ping":
      await cmdPing(token, msg);
      return true;
    case "/iam_teacher":
      await cmdIamTeacher(env, token, msg, state);
      return true;
    case "/link_general":
      await cmdLinkGeneral(env, token, msg, state, args);
      return true;
    case "/persona_set":
      await cmdPersonaSet(env, token, msg, state, args);
      return true;
    case "/set_default_class":
      await cmdSetDefaultClass(env, token, msg, state, args);
      return true;
    case "/prefix":
      await cmdPrefix(env, token, msg, state, args);
      return true;
    case "/card_media_clear":
      await cmdCardMediaClear(env, token, msg, state, args);
      return true;
    case "/schedule":
      await cmdSchedule(env, token, msg, state);
      return true;
    case "/buses":
      await cmdBuses(env, token, msg, state);
      return true;
    default:
      return false;
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

export default {
  async fetch(request, env) {
    if (!env.BOT_TOKEN || !env.PUBLIC_URL) {
      return new Response("Need BOT_TOKEN and PUBLIC_URL", { status: 500 });
    }
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      const hook = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhook/${
        env.BOT_TOKEN
      }`;
      const res = await TG(env.BOT_TOKEN, "setWebhook", {
        url: hook,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
          "my_chat_member",
          "chat_member",
        ],
      });
      return new Response(JSON.stringify(res), {
        headers: { "content-type": "application/json" },
      });
    }

    if (
      url.pathname === `/webhook/${env.BOT_TOKEN}` &&
      request.method === "POST"
    ) {
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
