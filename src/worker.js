/**
 * TEACHER HELPER — итоговая сборка (21.09)
 * Cloudflare Workers + Telegram Bot API
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") return json({ ok: true, result: "teacher-helper alive" });

    if (url.pathname === "/init") {
      const ok = await setWebhook(env);
      return json({ ok, webhook: `${env.PUBLIC_URL.replace(/\/+$/,'')}/webhook/${env.BOT_TOKEN}` });
    }

    if (url.pathname.startsWith("/webhook/")) {
      if (!env.BOT_TOKEN || !url.pathname.includes(env.BOT_TOKEN.slice(0, 8))) return OK();
      if (request.method !== "POST") return OK();

      const update = await request.json().catch(() => ({}));
      const msg = update.message || update.edited_message;
      if (!msg) return OK();

      const ctx = await buildCtx(env, msg);

      // команды
      if (msg.text?.startsWith("/")) {
        await handleCommand(ctx, msg.text.trim());
        return OK();
      }

      // сохранение медиа по подписи "#КЛАСС ..."
      if (hasMedia(msg) && msg.caption) {
        const saved = await saveMediaByCaption(ctx, msg);
        if (saved) return OK();
      }

      // роутер текста
      await handleTextRouter(ctx, msg);
      return OK();
    }

    return new Response("Not found", { status: 404 });
  },
};

/* =============== helpers =============== */

function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function OK() { return new Response("", { status: 200 }); }

async function setWebhook(env) {
  const url = `${env.PUBLIC_URL.replace(/\/+$/,'')}/webhook/${env.BOT_TOKEN}`;
  const res = await tg(env, "setWebhook", { url });
  console.log("setWebhook:", await res.text());
  return true;
}

function normalize(s) { return (s || "").toLowerCase().replace(/ё/g, "е").trim(); }
function hasMedia(m) { return Boolean(m.photo?.length || m.video || m.animation || m.document || m.voice || m.audio); }
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));}
function slugify(s){
  return s.toLowerCase().replace(/ё/g,"е").replace(/[^a-z0-9а-я\s_-]/g,"").replace(/\s+/g,"_").replace(/_+/g,"_").trim();
}
function slugifyShort(s){ return s.length>28 ? s.slice(0,28)+"…" : s; }

async function buildCtx(env, msg) {
  const teacherId = await env.KV_BOT.get("TEACHER_ID");
  const personaName = (await env.KV_BOT.get("PERSONA_NAME")) || "Ирина Владимировна";
  const personaEnabled = (await env.KV_BOT.get("PERSONA_ENABLED")) || "0"; // OFF по умолчанию
  const defaultClass = (await env.KV_BOT.get("DEFAULT_CLASS")) || "1Б";
  const autopublish = (await env.KV_BOT.get("AUTOPUBLISH_ON_SAVE")) || "1";

  const chat_id = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  let classLabel = await env.KV_BOT.get(`CLASS_BY_CHAT:${chat_id}`);
  if (!classLabel) classLabel = defaultClass;

  return { env, msg, chat_id, isGroup, classLabel, teacherId, personaName, personaEnabled, autopublish };
}
function personaPrefix(ctx){ return ctx.personaEnabled === "1" ? `${ctx.personaName}: ` : ""; }
function mention(msg){ const u = msg.from?.username; return u ? `@${u}, ` : ""; }

/* =============== commands =============== */

async function handleCommand(ctx, raw) {
  const [cmd, ...rest] = raw.split(/\s+/);
  const args = rest.join(" ").trim();

  if (cmd === "/ping") { await sendText(ctx.env, ctx.chat_id, "pong ✅"); return; }

  if (cmd === "/iam_teacher") {
    if (ctx.isGroup) { await sendText(ctx.env, ctx.chat_id, "Команда доступна в личных сообщениях."); return; }
    await ctx.env.KV_BOT.put("TEACHER_ID", String(ctx.msg.from?.id));
    await sendText(ctx.env, ctx.chat_id, "Вы назначены учителем ✅");
    return;
  }

  if (cmd === "/link_general") {
    if (String(ctx.msg.from?.id) !== String(ctx.teacherId)) return;
    if (!ctx.isGroup) { await sendText(ctx.env, ctx.chat_id, "Выполни команду в групповом чате."); return; }
    if (!args) { await sendText(ctx.env, ctx.chat_id, "Пример: /link_general 1Б"); return; }

    await ctx.env.KV_BOT.put(`CLASS_BY_CHAT:${ctx.chat_id}`, args);
    const key = `CHATS_BY_CLASS:${args}`;
    const arr = (await ctx.env.KV_BOT.get(key, "json")) || [];
    if (!arr.includes(String(ctx.chat_id))) arr.push(String(ctx.chat_id));
    await ctx.env.KV_BOT.put(key, JSON.stringify(arr));
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}Привязано: ОБЩИЙ чат для класса ${escapeHtml(args)} ✅`);
    return;
  }

  if (cmd === "/class_default") {
    if (String(ctx.msg.from?.id) !== String(ctx.teacherId)) return;
    if (!args) { await sendText(ctx.env, ctx.chat_id, "Пример: /class_default 1Б"); return; }
    await ctx.env.KV_BOT.put("DEFAULT_CLASS", args);
    await sendText(ctx.env, ctx.chat_id, `Класс по умолчанию: ${escapeHtml(args)}`);
    return;
  }

  if (cmd === "/persona_set") {
    if (String(ctx.msg.from?.id) !== String(ctx.teacherId)) return;
    if (!args) { await sendText(ctx.env, ctx.chat_id, "Пример: /persona_set Ирина Владимировна"); return; }
    await ctx.env.KV_BOT.put("PERSONA_NAME", args);
    await sendText(ctx.env, ctx.chat_id, `Подпись установлена: ${escapeHtml(args)}`);
    return;
  }

  // /persona и /prefix — одно и то же
  if (cmd === "/persona" || cmd === "/prefix") {
    if (String(ctx.msg.from?.id) !== String(ctx.teacherId)) return;
    const val = /on/i.test(args) ? "1" : /off/i.test(args) ? "0" : null;
    if (val === null) { await sendText(ctx.env, ctx.chat_id, `Используй: ${cmd} on | off`); return; }
    await ctx.env.KV_BOT.put("PERSONA_ENABLED", val);
    await sendText(ctx.env, ctx.chat_id, `Подпись учителя: ${val === "1" ? "включена" : "выключена"}`);
    return;
  }

  if (cmd === "/autopublish") {
    if (String(ctx.msg.from?.id) !== String(ctx.teacherId)) return;
    const val = /on/i.test(args) ? "1" : /off/i.test(args) ? "0" : null;
    if (val === null) { await sendText(ctx.env, ctx.chat_id, "Используй: /autopublish on | off"); return; }
    await ctx.env.KV_BOT.put("AUTOPUBLISH_ON_SAVE", val);
    await sendText(ctx.env, ctx.chat_id, `Автопубликация: ${val === "1" ? "включена" : "выключена"}`);
    return;
  }
}

/* =============== media save =============== */

function parseCaptionHashtag(caption) {
  // "#1Б пополнение карты через Сбербанк" или "#1Б topup — 2"
  const m = caption.match(/#\s*([0-9А-ЯA-Za-zа-яёЁ]+)\s+(.+)/i);
  if (!m) return null;
  const classLabel = m[1].trim();
  const keyHuman = m[2].trim();
  const slug = slugify(keyHuman);
  return { classLabel, keyHuman, slug };
}

function extractFileItem(msg) {
  if (msg.photo?.length) {
    const fid = msg.photo.sort((a,b)=>(a.file_size||0)-(b.file_size||0)).pop().file_id;
    return { type: "photo", file_id: fid };
  }
  if (msg.video) return { type: "video", file_id: msg.video.file_id };
  if (msg.animation) return { type: "animation", file_id: msg.animation.file_id };
  if (msg.document) return { type: "document", file_id: msg.document.file_id };
  if (msg.voice) return { type: "voice", file_id: msg.voice.file_id };
  if (msg.audio) return { type: "audio", file_id: msg.audio.file_id };
  return null;
}

async function saveMediaByCaption(ctx, msg) {
  const allow = String(msg.from?.id) === String(ctx.teacherId) || msg.chat.type === "private";
  if (!allow) return false;

  const parsed = parseCaptionHashtag(msg.caption);
  if (!parsed) return false;

  const { classLabel, keyHuman, slug } = parsed;
  const item = extractFileItem(msg);
  if (!item) return false;

  const kvKey = `MEDIA::${classLabel}::${slug}`;
  const arr = (await ctx.env.KV_BOT.get(kvKey, "json")) || [];
  arr.push(item);
  await ctx.env.KV_BOT.put(kvKey, JSON.stringify(arr));

  await sendText(ctx.env, ctx.chat_id, `Сохранено (${classLabel} — ${slugifyShort(slug)}).`);

  // автопубликация в привязанные чаты
  if (ctx.autopublish === "1") {
    const chats = (await ctx.env.KV_BOT.get(`CHATS_BY_CLASS:${classLabel}`, "json")) || [];
    for (const id of chats) {
      await sendMedia(ctx.env, id, item, `#${classLabel} ${keyHuman}`);
    }
  }
  return true;
}

/* =============== text router =============== */

async function handleTextRouter(ctx, msg) {
  const lower = normalize(msg.text || msg.caption || "");

  // болезнь
  const ill = /(забол(ел|ела|ели)|боле(ет|ем)|температур|насморк|сопл|каш(е|)л)/i.test(lower);
  if (ill) {
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}Выздоравливайте 🙌 Придите в школу со справкой от врача.`);
    await notifyTeacher(ctx, msg, "Отсутствие по болезни");
    return;
  }

  // нейтральное отсутствие
  const abs = /(не\s*будет|не\s*прид[её]т|отсутств|пропустит|пропуск)/i.test(lower);
  if (abs) {
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`);
    await notifyTeacher(ctx, msg, "Отсутствие (не болезнь)");
    return;
  }

  // опоздание / «к 8:45» / «бежим»
  if (/(опаздыва|задержим|задержива|будем позже|бежим)/i.test(lower) || /(?:к|в)\s*\d{1,2}[:.]\d{2}\b/.test(lower)) {
    const t = parseTime(lower);
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}Поняла, подождём${t ? `, ориентируюсь на ${t}` : ""}.`);
    await notifyTeacher(ctx, msg, `Опоздание${t ? ` (ориентир ${t})` : ""}`);
    return;
  }

  // ранний уход — «отпустите…», «после 2 урока», «в 10:30»
  if (/(отпустите|уйд[её]м раньше|заберу.*раньше|раньше обычного|после\s*\d+\s*урок|заберу в|заберу во|в\s*\d{1,2}[:.]\d{2})/i.test(lower)) {
    const t = parseTime(lower);
    const afterLesson = parseAfterLesson(lower);
    const extra = t ? `в ${t}` : afterLesson ? `после ${afterLesson} урока` : "";
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}Хорошо, отпущу${extra ? ` ${extra}` : ""}.`);
    await notifyTeacher(ctx, msg, `Просьба отпустить раньше ${extra || ""}`.trim());
    return;
  }

  // расписание уроков / звонки / перемены
  if (/(расписани|урок(и|ов)|звонк|перемен|во сколько заканчива(ет|ются)|когда перемен)/i.test(lower)) {
    const ok = await sendAllByKeys(ctx,
      ["расписание уроков", "звонки", "расписание звонков", "schedule", "bells"],
      `${mention(msg)}${personaPrefix(ctx)}вот актуальное расписание. Если что-то изменится — сообщу заранее.`);
    if (ok) return;
  }

  // подвоз / автобусы / посёлки
  if (/(подвоз|автобус|автобусы|с пос[её]лок|с поселк|поселков|рейс)/i.test(lower)) {
    const ok = await sendAllByKeys(ctx,
      ["подвоз", "автобусы", "расписание автобусов", "подвоз с поселков", "подвоз с посёлков", "buses"],
      `${personaPrefix(ctx)}вот актуальное расписание. Если что-то изменится — сообщу заранее.`);
    if (ok) return;
  }

  // когда забирать
  if (/(во сколько забира|когда забира|когда уход|когда домой|забор)/i.test(lower)) {
    const ok = await sendAllByKeys(ctx, ["когда забирать", "уход домой", "забор"], `${personaPrefix(ctx)}вот подсказка по времени забора. Если появятся изменения — напишу заранее.`);
    if (ok) return;
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}подскажу по времени забора. Если нужна картинка — пришлю.`);
    return;
  }

  // баланс карты
  if (/(баланс.*карт|проверить.*баланс|сколько.*на.*карт|карта.*баланс)/i.test(lower)) {
    const ok = await sendAllByKeys(ctx, ["баланс карты", "card_balance", "balance"], `${personaPrefix(ctx)}вот как проверить баланс школьной карты.`);
    if (ok) return;
  }

  // пополнение карты (несколько файлов: реквизиты, Сбербанк, и т.д.)
  if (/(как.*пополн(ить|яю)|пополнени[ея].*карт|пополнить карту|оплата по реквизит|через сбер|сбербанк|topup|card_topup)/i.test(lower)) {
    const ok = await sendAllByKeys(ctx,
      ["пополнение карты", "оплата по реквизитам", "пополнение карты через сбербанк", "topup", "card_topup", "requisites", "sberbank"],
      `${personaPrefix(ctx)}вот способы пополнения карты.`);
    if (ok) return;
  }

  // домашнее задание
  if (/(домашн|дз|что задали|д\/з)/i.test(lower)) {
    await sendText(ctx.env, ctx.chat_id, `${personaPrefix(ctx)}Уточняем у детей. Иногда дублирую ДЗ в чат после уроков. Если что-то потерялось — напишите, уточню.`);
    return;
  }

  // иначе — молчим
}

/* ===== send / notify ===== */

async function sendText(env, chat_id, text) {
  await tg(env, "sendMessage", {
    chat_id, text, parse_mode: "HTML", disable_web_page_preview: true,
  });
}

async function sendMedia(env, chat_id, item, caption) {
  const base = { chat_id };
  if (caption) base.caption = caption;
  switch (item.type) {
    case "photo": await tg(env, "sendPhoto", { ...base, photo: item.file_id }); break;
    case "video": await tg(env, "sendVideo", { ...base, video: item.file_id }); break;
    case "animation": await tg(env, "sendAnimation",{ ...base, animation: item.file_id }); break;
    case "document": await tg(env, "sendDocument", { ...base, document: item.file_id }); break;
    case "voice": await tg(env, "sendVoice", { ...base, voice: item.file_id }); break;
    case "audio": await tg(env, "sendAudio", { ...base, audio: item.file_id }); break;
  }
}

async function notifyTeacher(ctx, msg, title) {
  if (!ctx.teacherId) return;
  const who = msg.from?.username ? `@${msg.from.username}` : [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "родитель";
  const text =
    `🔔 ${title}\n` +
    `Класс: ${ctx.classLabel}\n` +
    `От: ${who}\n` +
    `Текст: "${(msg.text || msg.caption || "").slice(0, 400)}"`;
  await sendText(ctx.env, ctx.teacherId, text);
}

/**
 * Собирает все медиа по списку ключей (синонимов) и отправляет.
 * Возвращает true, если что-то нашлось.
 */
async function sendAllByKeys(ctx, keys, firstCaption) {
  const classLabel = ctx.classLabel;
  let any = false;
  const used = new Set();

  for (const k of keys) {
    const slug = slugify(k);
    if (used.has(slug)) continue;
    used.add(slug);

    const arr = await ctx.env.KV_BOT.get(`MEDIA::${classLabel}::${slug}`, "json");
    if (arr && arr.length) {
      let cap = firstCaption;
      for (const item of arr) {
        await sendMedia(ctx.env, ctx.chat_id, item, cap);
        cap = undefined; // подпись только к первому файлу
      }
      any = true;
    }
  }
  return any;
}

/* ============ parse utils ============ */

function parseTime(text) {
  const m = text.match(/(?:к|в)\s*(\d{1,2})[.: ]?(\d{2})\b/);
  if (!m) return null;
  const hh = String(Math.min(23, parseInt(m[1],10))).padStart(2,"0");
  const mm = String(Math.min(59, parseInt(m[2],10))).padStart(2,"0");
  return `${hh}:${mm}`;
}
function parseAfterLesson(text) {
  const m = text.match(/после\s*(\d{1,2})\s*урок/);
  if (!m) return null;
  return String(parseInt(m[1],10));
}

/* ============ Telegram HTTP ============ */

function tg(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
