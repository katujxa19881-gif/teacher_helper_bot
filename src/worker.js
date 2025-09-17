// Cloudflare Worker: Telegram бот для расписания (фото)
// Хранение: KV (KV_BOT)

const RESP = (status, body="ok") => new Response(body, {status});

async function tg(apiMethod, token, payload) {
  const url = `https://api.telegram.org/bot${token}/${apiMethod}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return res.json();
}

function parseClassFrom(text="") {
  // #5А / 5A / 5 А → нормализуем
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return m ? m[1].toUpperCase().replace(/\s+/g,"") : null;
}

async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) return { teacher_id: null, classes: {} };
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
      last_update_iso: null
    };
  }
}

function extractLargestPhotoId(photos = []) {
  if (!photos.length) return null;
  const bySize = photos.sort((a,b) => (a.file_size||0) - (b.file_size||0));
  return bySize.at(-1)?.file_id || photos.at(-1)?.file_id || null;
}

async function handleCommand(env, update, token, state) {
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  if (cmd === "/start") {
    const help = [
      "Команды:",
      "/schedule — показать расписание",
      "/iam_teacher — назначить себя учителем (в ЛС)",
      "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
      "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
      "",
      "Учитель: пришлите фото расписания в ЛС с подписью вида: #5А расписание на неделю"
    ].join("\n");
    await tg("sendMessage", token, { chat_id: chatId, text: help });
    return true;
  }

  if (cmd === "/iam_teacher") {
    if (msg.chat.type !== "private") {
      await tg("sendMessage", token, { chat_id: chatId, text: "Команда выполняется только в личке." });
      return true;
    }
    state.teacher_id = msg.from.id;
    await saveState(env, state);
    await tg("sendMessage", token, { chat_id: chatId, text: "Вы назначены учителем ✅" });
    return true;
  }

  if (cmd === "/link_general" || cmd === "/link_parents") {
    const cls = parseClassFrom(args);
    if (!cls) {
      await tg("sendMessage", token, { chat_id: chatId, text: "Укажите класс, пример: /link_general 5А" });
      return true;
    }
    ensureClass(state, cls);
    if (cmd === "/link_general") state.classes[cls].general_chat_id = chatId;
    else state.classes[cls].parents_chat_id = chatId;
    await saveState(env, state);
    await tg("sendMessage", token, { chat_id: chatId, text: `Привязано: ${cmd === "/link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для класса ${cls} ✅` });
    return true;
  }

  if (cmd === "/schedule") {
    // 1) пытаемся угадать класс по привязке чата
    let cls = null;
    for (const [k, v] of Object.entries(state.classes)) {
      if (v.general_chat_id === chatId || v.parents_chat_id === chatId) { cls = k; break; }
    }
    // 2) если ЛС — просим указать класс, если не нашли
    if (!cls && msg.chat.type === "private") {
      const found = parseClassFrom(args);
      if (!found) {
        await tg("sendMessage", token, { chat_id: chatId, text: "Укажите класс: /schedule 5А" });
        return true;
      }
      cls = found;
    }
    if (!cls) {
      await tg("sendMessage", token, { chat_id: chatId, text: "Этот чат не привязан к классу. Выполните /link_general 5А или /link_parents 5А." });
      return true;
    }

    const rec = state.classes[cls];
    if (!rec || !rec.schedule_file_id) {
      await tg("sendMessage", token, { chat_id: chatId, text: `Для ${cls} расписание ещё не загружено.` });
      return true;
    }
    await tg("sendPhoto", token, { chat_id: chatId, photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
    return true;
  }

  return false;
}

async function handlePhotoFromTeacher(env, update, token, state) {
  const msg = update.message;
  if (msg.chat.type !== "private") return false;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать расписание. Введите /iam_teacher в личке." });
    return true;
  }

  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if (!cls) {
    await tg("sendMessage", token, { chat_id: msg.chat.id, text: "Добавьте в подпись класс, например: #5А расписание на неделю" });
    return true;
  }

  ensureClass(state, cls);
  const file_id = extractLargestPhotoId(msg.photo || []);
  state.classes[cls].schedule_file_id = file_id;
  state.classes[cls].schedule_caption = caption;
  state.classes[cls].last_update_iso = new Date().toISOString();
  await saveState(env, state);

  const rec = state.classes[cls];
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  if (targets.length === 0) {
    await tg("sendMessage", token, {
      chat_id: msg.chat.id,
      text: `Сохранено для ${cls}, но чаты не привязаны.\nЗайдите в нужный чат и выполните:\n/link_general ${cls}\n/link_parents ${cls}`
    });
    return true;
  }

  for (const chatId of targets) {
    await tg("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
  }
  await tg("sendMessage", token, { chat_id: msg.chat.id, text: `Расписание для ${cls} опубликовано в ${targets.length} чат(а/ов) ✅` });
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // healthcheck
    if (url.pathname === "/") return RESP(200, "ok");

    // вспомогательный маршрут для установки вебхука после деплоя
    if (url.pathname === "/init" && request.method === "POST") {
      if (!env.BOT_TOKEN || !env.PUBLIC_URL) return RESP(400, "Need BOT_TOKEN and PUBLIC_URL");
      const webhookUrl = `${env.PUBLIC_URL}/webhook/${env.BOT_TOKEN}`;
      const res = await tg("setWebhook", env.BOT_TOKEN, { url: webhookUrl });
      return new Response(JSON.stringify(res), {status:200, headers:{'content-type':'application/json'}});
    }

    // вебхук от Telegram
    if (url.pathname === `/webhook/${env.BOT_TOKEN}` && request.method === "POST") {
      const update = await request.json();
      const state = await loadState(env);

      // команды
      if (update.message?.text) {
        const handled = await handleCommand(env, update, env.BOT_TOKEN, state);
        if (handled) return RESP(200);
      }

      // фото от учителя
      if (update.message?.photo?.length) {
        const handled = await handlePhotoFromTeacher(env, update, env.BOT_TOKEN, state);
        if (handled) return RESP(200);
      }

      return RESP(200);
    }

    return RESP(404, "not found");
  }
};
