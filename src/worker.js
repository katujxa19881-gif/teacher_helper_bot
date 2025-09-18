// Cloudflare Worker — Telegram-бот "Учитель"
// Vars/Bindings: KV_BOT, BOT_TOKEN (secret), PUBLIC_URL (text)

const OK = (b="ok") => new Response(b, { status: 200 });
const NO = (c=404, b="not found") => new Response(b, { status: c });

/* ------------ Telegram API helpers ------------ */
async function tg(method, token, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return r.json();
}
async function send(method, token, payload) {
  try {
    const res = await tg(method, token, payload);
    console.log("SEND", method, JSON.stringify(payload), "=>", JSON.stringify(res));
    return res;
  } catch (e) {
    console.log("SEND_ERR", method, e?.toString?.() || e);
    return null;
  }
}
function sameThreadPayload(msg, extra={}) {
  const p = { chat_id: msg.chat.id, ...extra };
  if ((msg.chat?.type === "supergroup" || msg.chat?.type === "group")
      && msg.is_topic_message && msg.message_thread_id) {
    p.message_thread_id = msg.message_thread_id;
  }
  return p;
}

/* ------------ KV state ------------ */
async function loadState(env) {
  const raw = await env.KV_BOT.get("state");
  if (!raw) {
    return {
      teacher_id: null,
      teacher_display_name: "Учитель",
      classes: {}, // "1Б": { general_chat_id, parents_chat_id, schedule_file_id, schedule_caption, pickup_times }
      autoreply_enabled: true,
      policy_absence: "Выздоравливайте 🙌 Придём с медсправкой."
    };
  }
  return JSON.parse(raw);
}
async function saveState(env, s) { await env.KV_BOT.put("state", JSON.stringify(s)); }
function ensureClass(state, cls) {
  if (!state.classes[cls]) state.classes[cls] = {
    general_chat_id: null,
    parents_chat_id: null,
    schedule_file_id: null,
    schedule_caption: null,
    pickup_times: null // { ПН:"12:30", ... }
  };
}

/* ------------ utils ------------ */
function normalize(s=""){return s.toLowerCase().replace(/[ё]/g,"е").replace(/[^\p{L}\p{N}\s#:+().-]/gu," ").replace(/\s+/g," ").trim();}
function parseClassFrom(text=""){const m=text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);return m?m[1].toUpperCase().replace(/\s+/g,"") : null;}
function largestPhotoId(photos){ if(!photos?.length) return null; return photos.sort((a,b)=>(a.file_size||0)-(b.file_size||0)).at(-1)?.file_id; }

const DAYS = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
const FULL = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
function todayShortTZ(tz="Europe/Kaliningrad"){
  const d = new Date(); const idx = Number(new Date(d.toLocaleString("en-US",{timeZone:tz})).getDay());
  return DAYS[idx];
}
function fullName(short){ const i=DAYS.indexOf(short); return i>=0?FULL[i]:short; }
function mapDay(s){
  const n = normalize(s);
  const map = {"пн":"ПН","понедельник":"ПН","вт":"ВТ","вторник":"ВТ","ср":"СР","среда":"СР","чт":"ЧТ","четверг":"ЧТ","пт":"ПТ","пятница":"ПТ","сб":"СБ","суббота":"СБ","вс":"ВС","воскресенье":"ВС","сегодня":todayShortTZ()};
  return map[n] || null;
}

/* ------------ commands ------------ */
async function cmdStart(token, chatId){
  const text = [
    "Привет! Я помощник классного руководителя.",
    "",
    "Команды:",
    "/schedule — показать расписание",
    "/pickup [день|класс] — во сколько забирать",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40 — задать график (учитель)",
    "/iam_teacher — назначить себя учителем (в личке)",
    "/link_general <КЛАСС> — привязать этот чат как общий",
  ].join("\n");
  await send("sendMessage", token, { chat_id: chatId, text });
}
async function cmdIamTeacher(env, token, msg, state){
  if (msg.chat.type !== "private") {
    return send("sendMessage", token, sameThreadPayload(msg, { text: "Команда выполняется в личке." }));
  }
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  return send("sendMessage", token, { chat_id: msg.chat.id, text: "Вы назначены учителем ✅" });
}
async function cmdLinkGeneral(env, token, msg, state, args){
  const cls = parseClassFrom(args);
  if (!cls) return send("sendMessage", token, sameThreadPayload(msg, { text: "Укажите класс: /link_general 1Б" }));
  ensureClass(state, cls);
  state.classes[cls].general_chat_id = msg.chat.id;
  await saveState(env, state);
  return send("sendMessage", token, sameThreadPayload(msg, { text: `Привязано: ОБЩИЙ чат для ${cls} ✅` }));
}
async function cmdSchedule(token, msg, state, args){
  let cls = Object.entries(state.classes).find(([k,v])=>v.general_chat_id===msg.chat.id)?.[0];
  if (!cls && msg.chat.type==="private") cls = parseClassFrom(args||"");
  if (!cls) return send("sendMessage", token, sameThreadPayload(msg, { text: "Этот чат не привязан. /link_general 1Б" }));
  const rec = state.classes[cls];
  if (!rec?.schedule_file_id) return send("sendMessage", token, sameThreadPayload(msg, { text: `Для ${cls} расписание не загружено.` }));
  return send("sendPhoto", token, sameThreadPayload(msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` }));
}
function parsePickup(str){
  const out={}; if(!str) return out;
  for(const part of str.split(/[;,]/).map(s=>s.trim()).filter(Boolean)){
    const [k0,v] = part.split("=").map(s=>s.trim());
    const k = (mapDay(k0) || k0?.toUpperCase()?.slice(0,2));
    if(DAYS.includes(k) && /^\d{1,2}:\d{2}$/.test(v)) out[k]=v;
  }
  return out;
}
async function cmdPickupSet(env, token, msg, state, args){
  if (state.teacher_id !== msg.from.id) return send("sendMessage", token, sameThreadPayload(msg, { text: "Доступ только учителю." }));
  const [first, ...restArr] = (args||"").trim().split(/\s+/);
  const cls = parseClassFrom(first||"");
  if(!cls) return send("sendMessage", token, sameThreadPayload(msg, { text: "Формат: /pickup_set 1Б ПН=12:30,ВТ=12:40" }));
  ensureClass(state, cls);
  const rest = args.slice(args.indexOf(first)+first.length).trim();
  let mapping={};
  if (rest.startsWith("{")) { try{ mapping = JSON.parse(rest);}catch{} }
  else mapping = parsePickup(rest);

  const cleaned={}; for(const [k,v] of Object.entries(mapping||{})){
    const kk = mapDay(k) || k.toUpperCase().slice(0,2);
    if(DAYS.includes(kk) && /^\d{1,2}:\d{2}$/.test(v)) cleaned[kk]=v;
  }
  if(!Object.keys(cleaned).length) return send("sendMessage", token, sameThreadPayload(msg, { text: "Не распознано. Пример: /pickup_set 1Б ПН=12:30,ВТ=12:40" }));
  state.classes[cls].pickup_times = cleaned;
  await saveState(env, state);
  return send("sendMessage", token, sameThreadPayload(msg, { text: `Готово. ${cls}: `+Object.entries(cleaned).map(([k,v])=>`${k}=${v}`).join(", ") }));
}
async function cmdPickup(token, msg, state, args){
  let cls = Object.entries(state.classes).find(([k,v])=>v.general_chat_id===msg.chat.id)?.[0];
  if (!cls && msg.chat.type==="private") cls = parseClassFrom(args||"");
  if (!cls) return send("sendMessage", token, sameThreadPayload(msg, { text: "Чат не привязан к классу. /link_general 1Б" }));
  const rec = state.classes[cls]; if (!rec?.pickup_times) return send("sendMessage", token, sameThreadPayload(msg, { text: `Для ${cls} время забора не задано.` }));
  let day = mapDay(args||"") || todayShortTZ();
  const t = rec.pickup_times[day];
  if(!t) return send("sendMessage", token, sameThreadPayload(msg, { text: `Для ${cls} на ${fullName(day)} времени нет.` }));
  return send("sendMessage", token, sameThreadPayload(msg, { text: `${cls}: ${fullName(day)} — забирать в ${t}` }));
}

/* ------------ natural replies ------------ */
async function handleNatural(token, msg, state){
  if (!state.autoreply_enabled) return false;
  const raw = (msg.text||"").trim(); if(!raw) return false;
  const t = normalize(raw);

  if (/(^| )(привет|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)){
    await send("sendMessage", token, sameThreadPayload(msg, { text: `${state.teacher_display_name}: здравствуйте!` }));
    return true;
  }
  if (/(опаздыва|опозда|задержива|будем позже|позже на)/.test(t)){
    await send("sendMessage", token, sameThreadPayload(msg, { text: `${state.teacher_display_name}: приняла, подождём.` }));
    return true;
  }
  if (/(заболел|заболела|болеет|не\s+будет|пропустит)/.test(t)){
    await send("sendMessage", token, sameThreadPayload(msg, { text: `${state.teacher_display_name}: ${state.policy_absence}` }));
    return true;
  }
  if (/(во сколько|сколько).*(забир|забирать|забрать)/.test(t)){
    await cmdPickup(token, msg, state, "");
    return true;
  }
  return false;
}

/* ------------ teacher photo -> schedule ------------ */
async function handlePhoto(env, token, msg, state){
  if (msg.chat.type !== "private") return;
  if (state.teacher_id !== msg.from.id) {
    return send("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать расписание. /iam_teacher" });
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption);
  if(!cls) return send("sendMessage", token, { chat_id: msg.chat.id, text: "Добавьте в подпись класс, например: #1Б расписание" });
  ensureClass(state, cls);
  const file_id = largestPhotoId(msg.photo);
  state.classes[cls].schedule_file_id = file_id;
  state.classes[cls].schedule_caption = caption || `Расписание ${cls}`;
  await saveState(env, state);

  const chats = [state.classes[cls].general_chat_id, state.classes[cls].parents_chat_id].filter(Boolean);
  if(!chats.length) return send("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено для ${cls}, но чаты не привязаны.` });
  for(const chatId of chats) await send("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
  return send("sendMessage", token, { chat_id: msg.chat.id, text: `Расписание ${cls} опубликовано ✅` });
}

/* ------------ router ------------ */
async function handleCommand(env, token, msg, state){
  const txt = (msg.text||"").trim();
  const [cmd, ...rest] = txt.split(/\s+/);
  const args = rest.join(" ").trim();

  switch(cmd){
    case "/start": return cmdStart(token, msg.chat.id);
    case "/iam_teacher": return cmdIamTeacher(env, token, msg, state);
    case "/link_general": return cmdLinkGeneral(env, token, msg, state, args);
    case "/schedule": return cmdSchedule(token, msg, state, args);
    case "/pickup_set": return cmdPickupSet(env, token, msg, state, args);
    case "/pickup": return cmdPickup(token, msg, state, args);
    default: return null;
  }
}

/* ------------ entry ------------ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    // health
    if (url.pathname === "/") return OK("ok");

    // set webhook
    if (url.pathname === "/init") {
      if (!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, {
        url: `${env.PUBLIC_URL}/webhook/${token}`,
        allowed_updates: ["message","edited_message","channel_post","callback_query","my_chat_member","chat_member"]
      });
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type":"application/json" }});
    }

    // webhook
    if (url.pathname === `/webhook/${token}` && request.method === "POST") {
      let update = null;
      try { update = await request.json(); }
      catch(e){ console.log("JSON_ERR", e?.toString?.()||e); return OK(); }

      try {
        const state = await loadState(env);

        if (update.message?.text) {
          const res = await handleCommand(env, token, update.message, state);
          if (!res) {
            const handled = await handleNatural(token, update.message, state);
            if (!handled) console.log("Natural: no match");
          }
          return OK();
        }

        if (update.message?.photo?.length) {
          await handlePhoto(env, token, update.message, state);
          return OK();
        }

        // callbacks и прочее — по мере надобности
        return OK();
      } catch (e) {
        console.log("WEBHOOK_ERR", e?.stack || e?.toString?.() || e);
        return OK(); // ВСЕГДА 200, чтобы Телеграм не считал это ошибкой
      }
    }

    return NO();
  }
};
