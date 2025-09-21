// Cloudflare Worker — Telegram-бот для класса
// Bindings:
// - KV_BOT (KV Namespace)
// - BOT_TOKEN (Secret)
// - PUBLIC_URL (Text)

const OK = (body = "ok") => new Response(body, { status: 200 });
const NO = (code = 404, body = "not found") => new Response(body, { status: code });

/* ---------- Telegram API ---------- */
async function tg(method, token, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}
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
// Отправка в тот же чат/ту же тему
async function sendToSameThread(method, token, msg, payload = {}) {
  const p = { ...payload, chat_id: msg.chat.id };
  if ((msg.chat?.type === "supergroup" || msg.chat?.type === "group") && msg.is_topic_message && msg.message_thread_id) {
    p.message_thread_id = msg.message_thread_id;
  }
  return sendSafe(method, token, p);
}

/* ---------- KV state ---------- */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) {
    return {
      teacher_id: null,
      teacher_display_name: "Ирина Владимировна",
      autoreply_enabled: true,
      policy_absence: "Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes: {
        // "1Б": {...}
      },
      faq: [],
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

      // уроки
      schedule_file_id: null,
      schedule_caption: null,

      // автобусы (город/обычный)
      bus_file_id: null,
      bus_caption: null,

      // подвоз (посёлки)
      rural_bus_file_id: null,
      rural_bus_caption: null,

      // звонки
      rings_file_id: null,
      rings_caption: null,

      // карта: пополнение/баланс (может быть видео/док/фото)
      card_topup_file_id: null,
      card_topup_caption: null,
      card_balance_file_id: null,
      card_balance_caption: null,

      pickup_times: null, // {"ПН":"13:30",...}
      last_update_iso: null,
    };
  }
}

/* ---------- Utils ---------- */
function normalize(s = "") {
  return s.toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[^a-zа-я0-9\s#:+.()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseClassFrom(text = "") {
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return m ? m[1].toUpperCase().replace(/\s+/g, "") : null;
}
function extractLargestPhotoId(photos = []) {
  if (!photos?.length) return null;
  const bySize = [...photos].sort((a, b) => (a.file_size || 0) - (b.file_size || 0));
  return bySize.at(-1)?.file_id || photos.at(-1)?.file_id || null;
}
function pickClassFromChat(state, chatId) {
  for (const [k, v] of Object.entries(state.classes)) {
    if (v.general_chat_id === chatId || v.parents_chat_id === chatId) return k;
  }
  return null;
}

/* ---------- Time helpers ---------- */
const TZ = "Europe/Kaliningrad";
const DAYS = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
const DAYS_FULL = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
function ruShortFromDate(d) {
  const idx = Number(new Date(d.toLocaleString("en-US", { timeZone: TZ })).getDay());
  return DAYS[idx];
}
function todayRuShort() { return ruShortFromDate(new Date()); }
function dayNameFull(short) { const i = DAYS.indexOf(short); return i >= 0 ? DAYS_FULL[i] : short; }
function dayShortFromInput(s = "") {
  const n = normalize(s);
  if (n === "сегодня") return todayRuShort();
  if (n === "завтра") { const d = new Date(); d.setUTCMinutes(d.getUTCMinutes() + 24*60); return ruShortFromDate(d); }
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

/* ---------- Keyboards (FAQ) — базовые заготовки, если нужно будет вернуть в будущем ---------- */
function scoreMatch(text, kwList) {
  const t = " " + normalize(text) + " ";
  let score = 0;
  for (const kw of kwList || []) {
    const k = " " + normalize(kw) + " ";
    if (t.includes(k)) score += Math.min(k.length, 10);
  }
  return score;
}

/* ---------- Команды ---------- */
async function cmdStart(token, chatId) {
  const text = [
    "Команды:",
    "/ping — проверка связи",
    "/schedule — показать расписание",
    "/buses — автобусы (город/обычный)",
    "/rural_buses — подвоз с посёлков",
    "/rings — расписание звонков",
    "/pickup [день|класс] — во сколько забирать (по дням недели)",
    "/pickup_week [класс] — время забора на всю неделю",
    "",
    "Админ (учитель/родком):",
    "/iam_teacher — назначить себя учителем (ЛС боту)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40,... (добавь 'silent' в конце, чтобы не оповещать чаты)",
    "/persona_set Имя Отчество — подпись бота (по умолчанию: Ирина Владимировна)",
    "/autoreply on|off — автоответы «как учитель»",
    "/policy_absence_set Текст — шаблон для болезни",
    "",
    "Учитель: пришлите фото/видео в ЛС с подписью:",
    " #1Б расписание на неделю",
    " #1Б автобусы ...",
    " #1Б подвоз ...",
    " #1Б звонки ...",
    " #1Б пополнение карты ...",
    " #1Б баланс карты ...",
  ].join("\n");
  await sendSafe("sendMessage", token, { chat_id: chatId, text });
}
async function cmdPing(token, msg) {
  await sendToSameThread("sendMessage", token, msg, { text: "pong ✅" });
}
async function cmdIamTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") {
    await sendToSameThread("sendMessage", token, msg, { text: "Команда выполняется только в личке." });
    return;
  }
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Вы назначены учителем ✅" });
}
async function cmdLink(token, msg, state, args, kind) {
  const cls = parseClassFrom(args);
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: `Укажите класс, пример: /${kind} 1Б` }); return; }
  ensureClass(state, cls);
  state.classes[cls][kind === "link_general" ? "general_chat_id" : "parents_chat_id"] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, {
    text: `Привязано: ${kind === "link_general" ? "ОБЩИЙ" : "РОДИТЕЛИ"} чат для класса ${cls} ✅`,
  });
}
async function cmdSchedule(token, msg, state, args) {
  const cls = pickClassFromChat(state, msg.chat.id) || parseClassFrom(args || "");
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите класс: /schedule 1Б" }); return; }
  const rec = state.classes[cls];
  if (!rec?.schedule_file_id) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} расписание ещё не загружено.` }); return; }
  await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
}
async function cmdBuses(token, msg, state, args) {
  const cls = pickClassFromChat(state, msg.chat.id) || parseClassFrom(args || "");
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите класс: /buses 1Б" }); return; }
  const rec = state.classes[cls];
  if (!rec?.bus_file_id) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} автобусы ещё не загружены.` }); return; }
  await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы ${cls}` });
}
async function cmdRuralBuses(token, msg, state, args) {
  const cls = pickClassFromChat(state, msg.chat.id) || parseClassFrom(args || "");
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите класс: /rural_buses 1Б" }); return; }
  const rec = state.classes[cls];
  if (!rec?.rural_bus_file_id) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} подвоз ещё не загружен.` }); return; }
  await sendToSameThread("sendPhoto", token, msg, { photo: rec.rural_bus_file_id, caption: rec.rural_bus_caption || `Подвоз ${cls}` });
}
async function cmdRings(token, msg, state, args) {
  const cls = pickClassFromChat(state, msg.chat.id) || parseClassFrom(args || "");
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Укажите класс: /rings 1Б" }); return; }
  const rec = state.classes[cls];
  if (!rec?.rings_file_id) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} расписание звонков ещё не загружено.` }); return; }
  await sendToSameThread("sendPhoto", token, msg, { photo: rec.rings_file_id, caption: rec.rings_caption || `Звонки ${cls}` });
}

/* ---------- Pickup ---------- */
function parsePickupMapping(str) {
  const out = {};
  const parts = str.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
  for (const p of parts) {
    const [kRaw, vRaw] = p.split("=").map(s=>s.trim());
    if (!kRaw || !vRaw) continue;
    const k = dayShortFromInput(kRaw) || kRaw.toUpperCase().slice(0,2);
    if (!DAYS.includes(k)) continue;
    if (!/^\d{1,2}:\d{2}$/.test(vRaw)) continue;
    out[k] = vRaw;
  }
  return Object.keys(out).length ? out : null;
}
function formatPickupWeek(mapping) {
  const order = ["ПН","ВТ","СР","ЧТ","ПТ","СБ","ВС"];
  return order.map(d => `${d} — ${mapping?.[d] || "—"}`).join("\n");
}
async function cmdPickupSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) { await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." }); return; }

  const parts = args.trim().split(/\s+/);
  const cls = parseClassFrom(parts[0] || "");
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Формат: /pickup_set 1Б ПН=13:30,ВТ=12:40,..." }); return; }
  ensureClass(state, cls);

  const rest = args.trim().slice(args.indexOf(parts[0]) + parts[0].length).trim();
  let mapping = null;

  if (rest.startsWith("{")) {
    try {
      const obj = JSON.parse(rest);
      const m = {};
      for (const [k,v] of Object.entries(obj || {})) {
        const kk = dayShortFromInput(k) || k.toString().toUpperCase().slice(0,2);
        if (DAYS.includes(kk) && /^\d{1,2}:\d{2}$/.test(v)) m[kk]=v;
      }
      mapping = Object.keys(m).length ? m : null;
    } catch(e) { mapping = null; }
  } else {
    mapping = parsePickupMapping(rest);
  }

  if (!mapping) { await sendToSameThread("sendMessage", token, msg, { text: "Не удалось распознать времена. Пример: /pickup_set 1Б ПН=13:30,ВТ=12:40" }); return; }

  state.classes[cls].pickup_times = mapping;
  await saveState(env, state);

  const pretty = Object.entries(mapping).map(([k,v])=>`${k}=${v}`).join(", ");
  await sendToSameThread("sendMessage", token, msg, { text: `Готово. Время забора для ${cls}: ${pretty}` });

  const isSilent = /\bsilent\b/i.test(args);
  if (!isSilent) {
    const rec = state.classes[cls];
    const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
    const note = `Обновлено время забора (${cls}):\n` + formatPickupWeek(mapping);
    for (const chatId of targets) await sendSafe("sendMessage", token, { chat_id: chatId, text: note });
  }
}
async function cmdPickup(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  let day = null;

  if (args) {
    const maybeClass = parseClassFrom(args);
    if (maybeClass) cls = maybeClass;
    const maybeDay = dayShortFromInput(args) || (/сегодня/.test(normalize(args)) ? todayRuShort() : null);
    if (maybeDay) day = maybeDay;
  }
  if (!cls && msg.chat.type === "private") { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /pickup 1Б" }); return; }
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Чат не привязан к классу. /link_general 1Б" }); return; }

  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} ещё не задано время забора. Команда учителя: /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` }); return; }

  const d = day || todayRuShort();
  const t = rec.pickup_times[d];
  if (!t) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} на ${dayNameFull(d)} время не задано.` }); return; }
  await sendToSameThread("sendMessage", token, msg, { text: `${cls}: ${dayNameFull(d)} — забирать в ${t}` });
}
async function cmdPickupWeek(token, msg, state, args) {
  let cls = pickClassFromChat(state, msg.chat.id);
  if (!cls && msg.chat.type === "private") {
    const found = parseClassFrom(args || "");
    if (!found) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Укажите класс: /pickup_week 1Б" }); return; }
    cls = found;
  }
  if (!cls) { await sendToSameThread("sendMessage", token, msg, { text: "Чат не привязан к классу. /link_general 1Б" }); return; }

  const rec = state.classes[cls] || {};
  if (!rec.pickup_times) { await sendToSameThread("sendMessage", token, msg, { text: `Для ${cls} ещё не задано время забора. Команда учителя: /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` }); return; }

  const text = `Время забора на неделю — ${cls}:\n` + formatPickupWeek(rec.pickup_times);
  await sendToSameThread("sendMessage", token, msg, { text });
}

/* ---------- Персона/автоответы/политика ---------- */
async function cmdPersonaSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const name = args.trim();
  if (!name) return sendToSameThread("sendMessage", token, msg, { text: "Укажите отображаемое имя: /persona_set Ирина Владимировна" });
  state.teacher_display_name = name; await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Теперь отвечаю как: ${name}` });
}
async function cmdAutoReply(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const v = (args||"").trim().toLowerCase();
  if (!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, { text: "Используйте: /autoreply on|off" });
  state.autoreply_enabled = v === "on"; await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: `Автоответы: ${state.autoreply_enabled?"ВКЛ":"ВЫКЛ"}` });
}
async function cmdPolicyAbsenceSet(env, token, msg, state, args) {
  const isTeacher = state.teacher_id && state.teacher_id === msg.from.id;
  if (!isTeacher) return sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
  const txt = args.trim();
  if (!txt) return sendToSameThread("sendMessage", token, msg, { text: "Формат: /policy_absence_set Текст" });
  state.policy_absence = txt; await saveState(env, state);
  return sendToSameThread("sendMessage", token, msg, { text: "Политика ответа сохранена ✅" });
}

/* ---------- «Естественные» ответы (без команд) ---------- */
function hasAny(text, arr){ const t = normalize(text); return arr.some(k=>t.includes(normalize(k))); }
function mentionName(msg){ return msg?.from?.username ? `@${msg.from.username}, ` : ""; }

function extractTimeHHMM(text) { const m = text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractTimeFlexible(text) { const m = text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m ? `${m[1].padStart(2,"0")}:${m[2]}` : null; }
function extractDelayMinutes(text) { const m = normalize(text).match(/\bна\s+(\d{1,2})\s*мин/); return m ? parseInt(m[1], 10) : null; }
function guessChildName(text) {
  const m = text.match(/([А-ЯЁ][а-яё]+)(?=\s+(заболел|заболела|болеет|не\s+прид[её]т|опозда[её]т|опаздыва|задержива|уйд[её]т|отпуст|не\s+будет|пропустит))/i);
  return m ? m[1] : null;
}

async function handleNaturalMessage(env, token, msg, state) {
  const textRaw = (msg.text || "").trim();
  if (!textRaw) return false;
  const t = normalize(textRaw);
  const prefix = `${mentionName(msg)}${state.teacher_display_name}: `;

  // Привет/спасибо/пока
  if (state.autoreply_enabled) {
    if (/(^| )(привет|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}здравствуйте!` });
      return true;
    }
    if (/(^| )(спасибо|благодарю)( |!|$)/.test(t)) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}пожалуйста!` });
      return true;
    }
    if (/(^| )(пока|до свидания|досвидания|хорошего дня)( |!|$)/.test(t)) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}до свидания!` });
      return true;
    }
  }

  // ====== Медиа-ответы по ключевым словам ======
  const cls = pickClassFromChat(state, msg.chat.id);
  const rec = cls ? (state.classes[cls] || {}) : null;

  // Расписание уроков
  if (rec && hasAny(t, ["расписание уроков","расписание на неделю","какие завтра уроки","уроки на завтра","какие уроки"])) {
    if (rec.schedule_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}вот актуальное расписание. Если что-то изменится — дополню.` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
      return true;
    }
  }

  // Автобусы (город/обычный)
  if (rec && hasAny(t, ["автобус","автобусы","расписание автобусов"])) {
    if (rec.bus_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}вот актуальное расписание автобусов. Если будет изменение — сообщу заранее.` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы ${cls}` });
      return true;
    }
  }

  // Подвоз с посёлков
  if (rec && hasAny(t, ["подвоз","поселк","посёлк","с посёлков","с поселков","с деревни"])) {
    if (rec.rural_bus_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}вот актуальное расписание подвоза. Если что-то изменится — сообщу заранее.` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.rural_bus_file_id, caption: rec.rural_bus_caption || `Подвоз ${cls}` });
      return true;
    }
  }

  // Звонки / перемены / во сколько заканчивается 1/2/3 урок
  if (rec && (hasAny(t, ["звонки","расписание звонков","перемена","когда перемена","когда звонок"]) || /\b(1|2|3|4|5|6|7)\s*урок(а|ов|)\b.*(конча|заканч)/.test(t))) {
    if (rec.rings_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}вот график звонков. Если что-то поменяется — сообщу.` });
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.rings_file_id, caption: rec.rings_caption || `Звонки ${cls}` });
      return true;
    }
  }

  // Карта: пополнение
  if (rec && (hasAny(t, ["пополн","поплат","как положить","как зачислить"]) && hasAny(t, ["карта","школьн"])) ) {
    if (rec.card_topup_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}вот инструкция по пополнению карты. Если будут вопросы — напишите.` });
      await sendToSameThread("sendVideo", token, msg, { video: rec.card_topup_file_id, caption: rec.card_topup_caption || `Пополнение карты ${cls}` }).then(async r=>{
        if(!r || r?.ok===false) {
          // если это был не video (например документ или фото)
          await sendToSameThread("sendDocument", token, msg, { document: rec.card_topup_file_id, caption: rec.card_topup_caption || `Пополнение карты ${cls}` });
        }
      });
      return true;
    }
  }

  // Карта: баланс
  if (rec && (hasAny(t, ["баланс","остаток","сколько денег"]) && hasAny(t, ["карта","школьн"])) ) {
    if (rec.card_balance_file_id) {
      await sendToSameThread("sendMessage", token, msg, { text: `${prefix}вот как проверить баланс школьной карты.` });
      await sendToSameThread("sendVideo", token, msg, { video: rec.card_balance_file_id, caption: rec.card_balance_caption || `Баланс карты ${cls}` }).then(async r=>{
        if(!r || r?.ok===false) {
          await sendToSameThread("sendDocument", token, msg, { document: rec.card_balance_file_id, caption: rec.card_balance_caption || `Баланс карты ${cls}` });
        }
      });
      return true;
    }
  }

  // Болезнь / отсутствие
  const isIll = /(заболел|заболела|болеет|простуд|орви|температур|насморк|сопл|кашел)/.test(t);
  const isAbsent = /(не будет|пропустит|не прид[её]м|не придет|не прийдем|отсутств|пропуск)/.test(t);

  if (isIll) {
    const name = guessChildName(textRaw) || "Ребёнок";
    await sendToSameThread("sendMessage", token, msg, { text: `${prefix}${name}, ${state.policy_absence}` });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `🔔 Сообщение об болезни: из чата ${msg.chat.title || msg.chat.id}\n"${textRaw}"` });
    return true;
  }
  if (isAbsent) {
    await sendToSameThread("sendMessage", token, msg, { text: `${prefix}Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.` });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `🔔 Сообщение об отсутствии: из чата ${msg.chat.title || msg.chat.id}\n"${textRaw}"` });
    return true;
  }

  // Опоздание
  if (/(опаздыва|опозда|задержива|будем позже|буду позже|позже на)/.test(t)) {
    const tm = extractTimeHHMM(textRaw) || extractTimeFlexible(textRaw);
    const delay = extractDelayMinutes(textRaw);
    const when = tm ? `к ${tm}` : (delay ? `на ~${delay} мин` : "немного");
    await sendToSameThread("sendMessage", token, msg, { text: `${prefix}приняла, подождём ${when}.` });
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text: `Сообщение об опоздании:\n"${textRaw}"` });
    return true;
  }

  // Во сколько забирать — переиспользуем pickup, если задано
  if (/(во сколько|сколько)\s+(сегодня|сегоня)?.*(забир|забрать|забирать)/.test(t)) {
    if (cls && state.classes[cls]?.pickup_times) {
      await cmdPickup(token, msg, state, "");
      return true;
    }
  }

  // НИЧЕГО не знаем — молчим (не отвечаем).
  return false;
}

/* ---------- Загрузка медиа от учителя ---------- */
function hasWord(s, w){ return normalize(s).includes(normalize(w)); }

async function saveMediaRef(rec, kind, fileId, caption) {
  switch (kind) {
    case "schedule": rec.schedule_file_id = fileId; rec.schedule_caption = caption; break;
    case "buses": rec.bus_file_id = fileId; rec.bus_caption = caption; break;
    case "rural": rec.rural_bus_file_id = fileId; rec.rural_bus_caption = caption; break;
    case "rings": rec.rings_file_id = fileId; rec.rings_caption = caption; break;
    case "card_topup": rec.card_topup_file_id = fileId; rec.card_topup_caption = caption; break;
    case "card_balance": rec.card_balance_file_id = fileId; rec.card_balance_caption = caption; break;
  }
}

async function handleMediaFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;

  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать: введите /iam_teacher в личке." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if (!cls) { await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Добавьте в подпись класс, например: #1Б ..." }); return; }
  ensureClass(state, cls);
  const rec = state.classes[cls];

  // фото
  let fileId = null;
  if (msg.photo?.length) fileId = extractLargestPhotoId(msg.photo);
  // видео/анимация/документ
  if (!fileId && msg.video) fileId = msg.video.file_id;
  if (!fileId && msg.animation) fileId = msg.animation.file_id;
  if (!fileId && msg.document) fileId = msg.document.file_id;

  if (!fileId) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Не нашёл файла для сохранения (фото/видео/гиф/док)." });
    return;
  }

  // классификация по подписи
  const n = normalize(caption);
  let kind = null;
  if (hasWord(n, "расписание") && hasWord(n, "недел")) kind = "schedule";
  else if (hasWord(n, "подвоз")) kind = "rural";
  else if (hasWord(n, "звонк")) kind = "rings";
  else if (hasWord(n, "автобус")) kind = "buses";
  else if (hasWord(n, "пополн") && hasWord(n, "карт")) kind = "card_topup";
  else if (hasWord(n, "баланс") && hasWord(n, "карт")) kind = "card_balance";

  if (!kind) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Не распознал тип. Ключевые слова в подписи: «расписание на неделю», «автобусы», «подвоз», «звонки», «пополнение карты», «баланс карты»." });
    return;
  }

  await saveMediaRef(rec, kind, fileId, caption);
  await saveState(env, state);

  // публикация в привязанные чаты, если это «публичный» тип
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  const isPublic = ["schedule","buses","rural","rings"].includes(kind);
  if (!targets.length || !isPublic) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено (${cls} — ${kind}).${isPublic ? " Чаты не привязаны." : ""}` });
    return;
  }

  for (const chatId of targets) {
    if (["schedule","buses","rural","rings"].includes(kind)) {
      await sendSafe("sendPhoto", token, { chat_id: chatId, photo: fileId, caption });
    } else {
      await sendSafe("sendMessage", token, { chat_id: chatId, text: caption || "Материал сохранён." });
    }
  }
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Опубликовано в ${targets.length} чат(а/ов) ✅` });
}

/* ---------- Роутер команд ---------- */
async function handleCommand(env, token, msg, state) {
  const text = (msg.text || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch (cmd) {
    case "/start": await cmdStart(token, msg.chat.id); return true;
    case "/ping": await cmdPing(token, msg); return true;

    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); return true;
    case "/link_general": await cmdLink(token, msg, state, args, "link_general"); await saveState(env, state); return true;
    case "/link_parents": await cmdLink(token, msg, state, args, "link_parents"); await saveState(env, state); return true;

    case "/schedule": await cmdSchedule(token, msg, state, args); return true;
    case "/buses": await cmdBuses(token, msg, state, args); return true;
    case "/rural_buses": await cmdRuralBuses(token, msg, state, args); return true;
    case "/rings": await cmdRings(token, msg, state, args); return true;

    case "/pickup_set": await cmdPickupSet(env, token, msg, state, args); return true;
    case "/pickup": await cmdPickup(token, msg, state, args); return true;
    case "/pickup_week": await cmdPickupWeek(token, msg, state, args); return true;

    case "/persona_set": await cmdPersonaSet(env, token, msg, state, args); return true;
    case "/autoreply": await cmdAutoReply(env, token, msg, state, args); return true;
    case "/policy_absence_set": await cmdPolicyAbsenceSet(env, token, msg, state, args); return true;

    default: return false;
  }
}

/* ---------- Worker entry ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    if (url.pathname === "/") return OK("ok");

    if (url.pathname === "/init" && request.method === "GET") {
      if (!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, { url: `${env.PUBLIC_URL}/webhook/${token}`, allowed_updates: ["message","edited_message","callback_query","channel_post","my_chat_member","chat_member"] });
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.pathname === `/webhook/${token}` && request.method === "POST") {
      const update = await request.json();
      const state = await loadState(env);

      // Логи ключевых апдейтов
      if (update.message?.message_id) {
        console.log("UPDATE kind= message ids=", JSON.stringify({ chat: update.message.chat?.id, from: update.message.from?.id }));
      }

      // Команды/текст
      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();

        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();

        // ничего не знаем — молчим
        return OK();
      }

      // Медиа: фото/видео/док/гиф — только от учителя в ЛС
      if (update.message && (update.message.photo || update.message.video || update.message.animation || update.message.document)) {
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      // (на будущее) callback_query
      if (update.callback_query) {
        await sendSafe("answerCallbackQuery", token, { callback_query_id: update.callback_query.id });
        return OK();
      }

      return OK();
    }

    return NO();
  },
};
