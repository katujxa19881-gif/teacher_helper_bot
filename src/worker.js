/**
 * Telegram bot on Cloudflare Workers
 * Features:
 * - /init setWebhook
 * - /ping
 * - /iam_teacher in PM to appoint teacher
 * - Save media by captions like "#1Б подвоз", "#1Б расписание уроков", "#1Б баланс карты", "#1Б пополнение карты"
 *   Stores multiple files per key.
 * - Keyword router (RU) → sends stored media + teacher-style text
 * - Illness vs generic absence; forwards absence notice to teacher's PM
 * - If no match → NO REPLY (returns 200 with empty body)
 *
 * KV keys:
 *   TEACHER_ID                              -> string user id
 *   PERSONA_NAME                            -> string (default "Ирина Владимировна")
 *   CLASS_BY_CHAT:<chat_id>                 -> string class label, e.g., "1Б"
 *   MEDIA::<class>::<slug>                  -> JSON [{type,file_id,caption?}, ...]
 *
 * Bindings required:
 *   env.BOT_TOKEN (secret)
 *   env.PUBLIC_URL (plain)
 *   env.KV_BOT (KV namespace)
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/") {
        return json({ ok: true, result: "teacher-helper alive" });
      }

      if (url.pathname === "/init") {
        // set webhook
        const ok = await setWebhook(env);
        return json({ ok });
      }

      // Telegram webhook endpoint: /webhook/<token>
      if (url.pathname.startsWith("/webhook/")) {
        const tokenInPath = url.pathname.split("/webhook/")[1];
        if (!tokenInPath || !env.BOT_TOKEN || !tokenInPath.startsWith(env.BOT_TOKEN.slice(0, 10))) {
          // не светим токен, просто 200
          return json({ ok: true });
        }

        if (request.method !== "POST") return json({ ok: true });

        const update = await request.json().catch(() => ({}));
        // В логах оставим только тип
        console.log("UPDATE kind=", kindOf(update));

        // Обрабатываем только сообщения/редактированные
        const msg = update.message || update.edited_message;
        if (!msg) return OK();

        const ctxObj = await makeCtx(env, msg);

        // Commands
        if (msg.text?.startsWith("/")) {
          const handled = await handleCommand(env, ctxObj, msg.text.trim());
          return handled ? OK() : OK();
        }

        // Saving media by caption "#КЛАСС ключ"
        if (hasMedia(msg) && msg.caption) {
          const saved = await trySaveMediaByCaption(env, ctxObj, msg);
          if (saved) return OK();
        }

        // Natural language router (only in groups/supergroups/chats; and PM if user writes)
        const reacted = await handleNL(env, ctxObj, msg);
        // If nothing matched — NO reply
        return OK();
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("ERR", { status: 200 });
    }
  },
};

/* ----------------- helpers ----------------- */

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { "content-type": "application/json; charset=utf-8" } });
}
function OK() { return new Response("", { status: 200 }); }

async function setWebhook(env) {
  const url = `${env.PUBLIC_URL.replace(/\/+$/,'')}/webhook/${env.BOT_TOKEN}`;
  const res = await tg(env, "setWebhook", { url });
  console.log("setWebhook", await res.text());
  return true;
}

function kindOf(u) {
  if (u.message) return "message";
  if (u.edited_message) return "edited_message";
  if (u.my_chat_member) return "my_chat_member";
  return "other";
}

function hasMedia(m) {
  return Boolean(m.photo?.length || m.video || m.animation || m.document || m.voice || m.audio);
}

async function makeCtx(env, msg) {
  const chat_id = msg.chat.id;
  const from_id = msg.from?.id;
  const username = msg.from?.username ? `@${msg.from.username}` : null;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  // class label bound to chat
  let classLabel = await env.KV_BOT.get(`CLASS_BY_CHAT:${chat_id}`);
  const teacherId = await env.KV_BOT.get("TEACHER_ID");
  const persona = (await env.KV_BOT.get("PERSONA_NAME")) || "Ирина Владимировна";

  return { env, chat_id, from_id, username, isGroup, classLabel, teacherId, persona };
}

/* ---------- Commands ---------- */

async function handleCommand(env, ctx, text) {
  const cmd = text.split(/\s+/)[0];
  const args = text.slice(cmd.length).trim();

  if (cmd === "/ping") {
    await replyTeacher(ctx, "pong ✅");
    return true;
  }

  if (cmd === "/iam_teacher") {
    // назначить пользователя учителем — ТОЛЬКО в ЛС
    if (ctx.isGroup) {
      await replyTeacher(ctx, "Эта команда — только в личных сообщениях.");
      return true;
    }
    await env.KV_BOT.put("TEACHER_ID", String(ctx.from_id));
    await replyTeacher(ctx, "Вы назначены учителем ✅");
    return true;
  }

  // Админ (учитель) может привязывать класс к текущему чату:
  if (cmd === "/link_general") {
    if (String(ctx.from_id) !== String(ctx.teacherId)) return true;
    if (!ctx.isGroup) { await replyTeacher(ctx, "Команда работает в групповом чате."); return true; }
    if (!args) { await replyTeacher(ctx, "Укажите класс, пример: /link_general 1Б"); return true; }
    await env.KV_BOT.put(`CLASS_BY_CHAT:${ctx.chat_id}`, args);
    await sendText(ctx.chat_id, `${ctx.persona}: Привязано: ОБЩИЙ чат для класса ${escape(args)} ✅`, ctx.env);
    return true;
  }

  // /persona_set Имя Отчество
  if (cmd === "/persona_set") {
    if (String(ctx.from_id) !== String(ctx.teacherId)) return true;
    if (!args) { await replyTeacher(ctx, "Укажите подпись, например: /persona_set Ирина Владимировна"); return true; }
    await env.KV_BOT.put("PERSONA_NAME", args);
    await replyTeacher(ctx, `Подпись установлена: ${args}`);
    return true;
  }

  return false;
}

/* ---------- Media save by caption "#КЛАСС ключ" ---------- */

async function trySaveMediaByCaption(env, ctx, msg) {
  // Сохраняем, только если отправитель - учитель (в любом чате) ИЛИ любая ЛС боту (чтобы тебе было удобно)
  const allow =
    String(ctx.from_id) === String(ctx.teacherId) ||
    (msg.chat.type === "private");

  if (!allow) return false;

  const m = msg.caption.match(/#\s*([0-9А-ЯA-Zа-яёЁ]+)\s+(.+)/i);
  if (!m) return false;

  const classLabel = m[1].trim();
  const keyHuman = m[2].trim();
  const slug = slugify(keyHuman);

  const files = await env.KV_BOT.get(`MEDIA::${classLabel}::${slug}`, "json") || [];

  // extract file_id/type
  const item = extractFileItem(msg);
  if (!item) return false;

  files.push(item);
  await env.KV_BOT.put(`MEDIA::${classLabel}::${slug}`, JSON.stringify(files));

  // Подтверждение
  await sendText(ctx.chat_id, `Сохранено (${classLabel} — ${slug}).`, env);
  // Подсказываем подписать класс (если это не похоже на хештег с классом)
  if (!/#\s*[0-9А-ЯA-Zа-яёЁ]+\s*/.test(keyHuman)) {
    await sendText(ctx.chat_id, `Добавьте в подпись класс, например: #${classLabel} …`, env);
  }
  return true;
}

function extractFileItem(msg) {
  if (msg.photo?.length) {
    const fid = msg.photo.sort((a, b) => (a.file_size || 0) - (b.file_size || 0)).pop().file_id;
    return { type: "photo", file_id: fid };
  }
  if (msg.video) return { type: "video", file_id: msg.video.file_id };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id };
  if (msg.document) return { type: "document", file_id: msg.document.file_id };
  if (msg.voice) return { type: "voice", file_id: msg.voice.file_id };
  if (msg.audio) return { type: "audio", file_id: msg.audio.file_id };
  return null;
}

function slugify(s) {
  const map = { "ё": "е" };
  return s
    .toLowerCase()
    .replace(/[Ёё]/g, (ch) => map[ch])
    .replace(/[^a-z0-9а-я\s_-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .trim();
}

/* ---------- NLU / keyword router ---------- */

async function handleNL(env, ctx, msg) {
  const text = (msg.text || msg.caption || "").trim();
  if (!text) return false;

  // refresh class for this chat (fallback: if teacher writes in PM and gave a class in text like "#1Б ..." — мы не трогаем)
  if (!ctx.classLabel && ctx.isGroup) {
    ctx.classLabel = await env.KV_BOT.get(`CLASS_BY_CHAT:${ctx.chat_id}`);
  }

  const lower = normalize(text);

  // 1) Illness vs absence
  const illness = /(забол(ел|ела|ели)|боле(ет|ем)|температур|насморк|сопл|кашля?)/i.test(lower);
  const absence = /(не\s*будет|не\s*прид[её]т|отсутств|пропустит|пропуск)/i.test(lower);

  if (illness) {
    await say(ctx, `${ctx.persona}: Выздоравливайте 🙌 Придите в школу со справкой от врача.`, env);
    await notifyTeacher(env, ctx, msg, "Отсутствие по болезни");
    return true;
  }
  if (absence) {
    await say(ctx, `${ctx.persona}: Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`, env);
    await notifyTeacher(env, ctx, msg, "Отсутствие (не болезнь)");
    return true;
  }

  // 2) SCHEDULE (уроки/звонки/перемены)
  if (/(расписани|урок(и|ов)|завтра уроки|звонк|перемен|во сколько заканчива(ет|ются)|когда окончан|когда перемен)/i.test(lower)) {
    const keysTry = ["расписание уроков", "расписание", "звонки", "расписание звонков"];
    const sent = await sendMediaByKeys(env, ctx, keysTry, `@${msg.from?.username || ""} ${ctx.persona}: вот актуальное расписание. Если что-то изменится — сообщу заранее.`.replace("@ ", "@"));
    if (sent) return true;
    return false;
  }

  // 3) BUSES / ПОДВОЗ
  if (/(подвоз|автобус|автобусы|с пос[её]лк|рейс)/i.test(lower)) {
    const keysTry = ["подвоз", "автобусы", "расписание автобусов"];
    const sent = await sendMediaByKeys(env, ctx, keysTry, `${ctx.persona}: вот актуальное расписание. Если что-то изменится — сообщу заранее.`);
    if (sent) return true;
    return false;
  }

  // 4) PICKUP (когда забирать)
  if (/(во сколько забира|когда забира|когда уход|когда домой|когда забор)/i.test(lower)) {
    // если есть заготовка «когда забирать» — пришлём картинку; иначе короткий ответ
    const sent = await sendMediaByKeys(env, ctx, ["когда забирать", "забор", "уход домой"], `${ctx.persona}: вот подсказка по времени забора. Если появятся изменения — напишу заранее.`);
    if (sent) return true;
    await say(ctx, `${ctx.persona}: подскажу по времени забора. Если нужна картинка — пришлю.`, env);
    return true;
  }

  // 5) CARD balance / topup
  if (/(баланс.*карт|проверить.*баланс|сколько.*на.*карт|карта.*баланс)/i.test(lower)) {
    const sent = await sendMediaByKeys(env, ctx, ["баланс карты", "card_balance"], `${ctx.persona}: вот как проверить баланс школьной карты.`);
    return !!sent;
  }
  if (/(как.*пополн(ить|яю)|пополнени[ея].*карт|пополнить карту|оплата по реквизит|через сбер)/i.test(lower)) {
    const sent = await sendMediaByKeys(env, ctx, ["пополнение карты", "card_topup"], `${ctx.persona}: вот способы пополнения карты.`);
    return !!sent;
  }

  // 6) Домашка / «что задали»
  if (/(домашн|дз|что задали|д\/з)/i.test(lower)) {
    await say(ctx, `${ctx.persona}: уточняем у детей. Иногда дублирую ДЗ в чат после уроков. Если что-то потерялось — напишите, уточню.`, env);
    return true;
  }

  // Не распознали → молчим
  return false;
}

function normalize(t) {
  return t.toLowerCase().replace(/[ё]/g, "е").trim();
}

/* ---------- Sending helpers ---------- */

async function say(ctx, text, env) {
  return sendText(ctx.chat_id, text, env);
}

async function replyTeacher(ctx, text) {
  return sendText(ctx.chat_id, text, ctx.env);
}

async function notifyTeacher(env, ctx, msg, title) {
  if (!ctx.teacherId) return;
  const who = ctx.username ? `(${ctx.username})` : "";
  const chatRef = ctx.classLabel ? `Класс: ${ctx.classLabel}` : `Чат: ${ctx.chat_id}`;
  const txt =
    `🔔 ${title}\n` +
    `${chatRef}\n` +
    `Сообщение: "${(msg.text || msg.caption || "").slice(0, 400)}" ${who}`;
  await sendText(ctx.teacherId, txt, env);
}

async function sendText(chat_id, text, env) {
  await tg(env, "sendMessage", {
    chat_id,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function sendMediaByKeys(env, ctx, keysTry, fallbackText) {
  if (!ctx.classLabel) return false;
  for (const key of keysTry) {
    const slug = slugify(key);
    const arr = await env.KV_BOT.get(`MEDIA::${ctx.classLabel}::${slug}`, "json");
    if (arr && arr.length) {
      // если несколько — отправим по одному (mediaGroup для photo+video тоже ок, но у Telegram есть ограничения; делаем надёжно)
      for (const item of arr) {
        await sendSingleMedia(env, ctx.chat_id, item, fallbackText);
        // текст только на первом
        fallbackText = undefined;
      }
      return true;
    }
  }
  return false;
}

async function sendSingleMedia(env, chat_id, item, caption) {
  const base = { chat_id };
  if (caption) base.caption = caption;
  switch (item.type) {
    case "photo":
      await tg(env, "sendPhoto", { ...base, photo: item.file_id });
      break;
    case "video":
      await tg(env, "sendVideo", { ...base, video: item.file_id });
      break;
    case "animation":
      await tg(env, "sendAnimation", { ...base, animation: item.file_id });
      break;
    case "document":
      await tg(env, "sendDocument", { ...base, document: item.file_id });
      break;
    case "voice":
      await tg(env, "sendVoice", { ...base, voice: item.file_id });
      break;
    case "audio":
      await tg(env, "sendAudio", { ...base, audio: item.file_id });
      break;
    default:
      break;
  }
}

/* ---------- Telegram call ---------- */

function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
