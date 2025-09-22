// Cloudflare Worker: Телеграм-бот "Учитель" (чистая версия без FAQ-модуля)
// Secrets/Vars/KV:
// - BOT_TOKEN (secret)
// - PUBLIC_URL (plaintext, без завершающего "/")
// - KV_BOT (KV namespace)
//
// В BotFather: /setprivacy -> Disable

const OK = (b="ok") => new Response(b, {status:200});
const NO = (c=404,b="not found") => new Response(b, {status:c});

/* ---------- Telegram API ---------- */
async function tg(method, token, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify(payload ?? {})
  });
  return r.json();
}
async function sendSafe(method, token, payload) {
  try {
    const r = await tg(method, token, payload);
    console.log("SEND", method, JSON.stringify(payload).slice(0,500), "=>", JSON.stringify(r).slice(0,500));
    return r;
  } catch(e) {
    console.log("SEND ERROR", method, e?.message||String(e));
    return null;
  }
}
async function sendToSameThread(method, token, msg, payload={}) {
  const p={...payload, chat_id: msg.chat.id};
  if ((msg.chat?.type==="supergroup"||msg.chat?.type==="group") && msg.is_topic_message && msg.message_thread_id) {
    p.message_thread_id = msg.message_thread_id;
  }
  return sendSafe(method, token, p);
}

/* ---------- KV state ---------- */
async function loadState(env){
  const raw = await env.KV_BOT.get("state");
  if(!raw){
    return {
      teacher_id: null,
      prefix_enabled: false, // выключаем упоминание отправителя
      default_class: "1Б",
      classes: {}, // "1Б": {general_chat_id, parents_chat_id, media:{...}}
      teach: [] // [{pat, ans}]
    };
  }
  try {
    const s = JSON.parse(raw);
    s.prefix_enabled = !!s.prefix_enabled;
    s.default_class = s.default_class || "1Б";
    s.classes ||= {};
    s.teach ||= [];
    return s;
  } catch {
    return {
      teacher_id: null,
      prefix_enabled: false,
      default_class: "1Б",
      classes: {},
      teach: []
    };
  }
}
async function saveState(env, state){ await env.KV_BOT.put("state", JSON.stringify(state)); }

function ensureClass(state, cls){
  if(!state.classes[cls]){
    state.classes[cls] = {
      general_chat_id: null,
      parents_chat_id: null,
      media: {
        lessons: [], // расписание уроков (photo/video/document/animation)
        bells: [], // расписание звонков
        buses: [], // подвоз
        card_topup: [], // пополнение карты
        card_balance: [] // баланс карты
      }
    };
  }
}

/* ---------- Utils ---------- */
function normalize(s=""){
  return s.toLowerCase()
    .replace(/ё/g,"е")
    .replace(/[^a-zа-я0-9#\s:+().,-]/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function parseClassFrom(text=""){
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return m ? m[1].toUpperCase().replace(/\s+/g,"") : null;
}
function extractLargestPhotoId(photos=[]){
  if(!photos?.length) return null;
  const by=[...photos].sort((a,b)=>(a.file_size||0)-(b.file_size||0));
  return by.at(-1)?.file_id || photos.at(-1)?.file_id || null;
}
function userDisplay(u){
  if(!u) return "";
  if(u.username) return `@${u.username}`;
  const name=[u.first_name,u.last_name].filter(Boolean).join(" ").trim();
  return name||"";
}
function addressPrefix(state, msg){
  if(!state.prefix_enabled) return "";
  const d = userDisplay(msg.from||null);
  return d ? `${d}, ` : "";
}

/* ---------- Teach rules ---------- */
function findTeachAnswer(state, text){
  const qn = normalize(text);
  for(const r of state.teach||[]){
    const pn = normalize(r.pat||"");
    if(pn && qn.includes(pn)) return r.ans;
  }
  return null;
}

/* ---------- Media save/send ---------- */
function topicFromCaption(caption=""){
  const n = normalize(caption);
  if(/(расписан|урок)/.test(n) && !/(звонок|перемен)/.test(n)) return "lessons";
  if(/(звонок|перемен)/.test(n)) return "bells";
  if(/(автобус|подвоз)/.test(n)) return "buses";
  if(/(баланс.*карт|как проверить баланс|проверить баланс)/.test(n)) return "card_balance";
  if(/(пополни|пополнение.*карт|как пополнить карт)/.test(n)) return "card_topup";
  return null;
}
function mkFileItemFromMessage(msg){
  // Accept photo / video / animation / document
  if (msg.photo?.length){
    return {type:"photo", file_id: extractLargestPhotoId(msg.photo)};
  }
  if (msg.video){
    return {type:"video", file_id: msg.video.file_id};
  }
  if (msg.animation){
    return {type:"animation", file_id: msg.animation.file_id};
  }
  if (msg.document){
    return {type:"document", file_id: msg.document.file_id};
  }
  return null;
}
async function sendMediaList(token, msg, list=[] , captionFallback=""){
  // Отправляем по одному (разные типы медиа)
  if(!list?.length){
    if(captionFallback) await sendToSameThread("sendMessage", token, msg, {text: captionFallback});
    return;
  }
  for(const it of list){
    if(it.type==="photo") await sendToSameThread("sendPhoto", token, msg, {photo: it.file_id});
    else if(it.type==="video") await sendToSameThread("sendVideo", token, msg, {video: it.file_id});
    else if(it.type==="animation") await sendToSameThread("sendAnimation", token, msg, {animation: it.file_id});
    else if(it.type==="document") await sendToSameThread("sendDocument", token, msg, {document: it.file_id});
  }
}

/* ---------- Commands ---------- */
async function cmdStart(token, chatId){
  const text = [
    "Команды:",
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general <КЛАСС> — привязать ЭТОТ чат как общий",
    "/link_parents <КЛАСС> — привязать ЭТОТ чат как чат родителей",
    "/teach \"фраза\" => \"ответ\" — обучить быстрый ответ",
    "/teach_list, /teach_del <№>, /teach_clear",
    "/prefix on|off — включить/выключить обращение к пользователю в ответах",
    "",
    "Загрузка медиа (ЛС учителя), примеры подписей:",
    "#1Б расписание уроков",
    "#1Б расписание звонков",
    "#1Б автобусы (или: #1Б подвоз)",
    "#1Б пополнить карту / как пополнить карту",
    "#1Б баланс карты / как проверить баланс",
    "",
    "По запросам в группе бот отправляет актуальные материалы и отвечает на опоздания/отсутствия."
  ].join("\n");
  await sendSafe("sendMessage", token, {chat_id: chatId, text});
}
async function cmdPing(token, msg){ await sendToSameThread("sendMessage", token, msg, {text:"pong ✅"}); }
async function cmdIamTeacher(env, token, msg, state){
  if (msg.chat.type!=="private")
    return sendToSameThread("sendMessage", token, msg, {text:"Команда выполняется в личке."});
  state.teacher_id = msg.from.id;
  await saveState(env, state);
  await sendSafe("sendMessage", token, {chat_id: msg.chat.id, text:"Вы назначены учителем ✅"});
}
async function cmdLink(token, msg, state, args, kind){
  const cls = parseClassFrom(args) || state.default_class || "1Б";
  ensureClass(state, cls);
  state.classes[cls][kind==="link_general"?"general_chat_id":"parents_chat_id"] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, {text:`Привязано: ${kind==="link_general"?"ОБЩИЙ":"РОДИТЕЛИ"} чат для ${cls} ✅`});
}
async function cmdPrefix(env, token, msg, state, args){
  const isT = state.teacher_id && state.teacher_id===msg.from.id;
  if(!isT) return sendToSameThread("sendMessage", token, msg, {text:"Доступ только учителю."});
  const v=(args||"").trim().toLowerCase();
  if(!["on","off"].includes(v)) return sendToSameThread("sendMessage", token, msg, {text:"Используйте: /prefix on|off"});
  state.prefix_enabled = (v==="on");
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, {text:`Обращение к пользователю в ответах: ${state.prefix_enabled?"ВКЛ":"ВЫКЛ"}`});
}
async function cmdTeach(env, token, msg, state, args){
  const isT = state.teacher_id && state.teacher_id===msg.from.id;
  if(!isT) return sendToSameThread("sendMessage", token, msg, {text:"Только учитель может обучать ответы."});
  const m = args.match(/"([^"]+)"\s*=>\s*"([^"]+)"/);
  if(!m) return sendToSameThread("sendMessage", token, msg, {text:'Формат: /teach "шаблон" => "ответ"'});
  const [,pat,ans]=m;
  state.teach.push({pat:pat.trim(), ans:ans.trim()});
  await saveState(env, state);
  await sendToSameThread("sendMessage", token, msg, {text:`Добавлено правило #${state.teach.length} ✅`});
}
async function cmdTeachList(token, msg, state){
  const list = state.teach||[];
  if(!list.length) return sendToSameThread("sendMessage", token, msg, {text:"Правила пока пусты."});
  const out = list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,80)}"`).join("\n");
  await sendToSameThread("sendMessage", token, msg, {text: out.slice(0,4000)});
}
async function cmdTeachDel(env, token, msg, state, args){
  const isT = state.teacher_id && state.teacher_id===msg.from.id;
  if(!isT) return sendToSameThread("sendMessage", token, msg, {text:"Доступ только учителю."});
  const idx = parseInt(args,10);
  const list = state.teach||[];
  if(isNaN(idx)||idx<1||idx>list.length) return sendToSameThread("sendMessage", token, msg, {text:"Укажите номер: /teach_del 2"});
  list.splice(idx-1,1); state.teach=list; await saveState(env,state);
  await sendToSameThread("sendMessage", token, msg, {text:"Удалено ✅"});
}
async function cmdTeachClear(env, token, msg, state){
  const isT = state.teacher_id && state.teacher_id===msg.from.id;
  if(!isT) return sendToSameThread("sendMessage", token, msg, {text:"Доступ только учителю."});
  state.teach=[]; await saveState(env,state);
  await sendToSameThread("sendMessage", token, msg, {text:"Очищено ✅"});
}

/* ---------------- Фото/видео/документы от учителя ---------------- */
async function handleMediaFromTeacher(env, token, msg, state) {
  if (msg.chat.type !== "private") return;
  if (!state.teacher_id || state.teacher_id !== msg.from.id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Только учитель может загружать материалы. Введите /iam_teacher в личке." });
    return;
  }

  const caption = msg.caption || "";
  const cls = parseClassFrom(caption) || "1Б"; // класс по умолчанию
  ensureClass(state, cls);

  const file_id =
    extractLargestPhotoId(msg.photo || []) ||
    msg.video?.file_id ||
    msg.animation?.file_id ||
    msg.document?.file_id;

  if (!file_id) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: "Файл не распознан." });
    return;
  }

  // Определяем тему по подписи
  let topic = null;
  if (/автобус|bus/i.test(caption)) topic = "buses";
  else if (/звонок|перемен/i.test(caption)) topic = "bells";
  else if (/урок|расписан/i.test(caption)) topic = "schedule";
  else if (/баланс|пополни|карта/i.test(caption)) topic = "card_topup";

  const item = {
    type: msg.photo ? "photo" : msg.video ? "video" : msg.animation ? "animation" : "document",
    file_id,
    caption,
  };

  // Сохраняем в state
  if (topic === "buses") {
    state.classes[cls].bus_file_id = file_id;
    state.classes[cls].bus_caption = caption;
  } else if (topic === "schedule") {
    state.classes[cls].schedule_file_id = file_id;
    state.classes[cls].schedule_caption = caption;
    state.classes[cls].last_update_iso = new Date().toISOString();
  } else if (topic === "bells") {
    state.classes[cls].bells_file_id = file_id;
    state.classes[cls].bells_caption = caption;
  } else if (topic === "card_topup") {
    if (!state.classes[cls].media) state.classes[cls].media = {};
    if (!state.classes[cls].media.card_topup) state.classes[cls].media.card_topup = [];
    state.classes[cls].media.card_topup.push(item); // копим комплект
  }

  await saveState(env, state);

  // Чаты для публикации
  const rec = state.classes[cls];
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  if (!targets.length) {
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `Сохранено для ${cls}, но чаты не привязаны. /link_general ${cls} и /link_parents ${cls}` });
    return;
  }

  const cap = caption || "";

  if (topic === "card_topup") {
    // Для пополнения карты — публикуем ВСЕ скринкасты по теме
    const set = state.classes[cls].media.card_topup || [];
    for (const chatId of targets) {
      for (const it of set) {
        if (it.type === "photo")
          await sendSafe("sendPhoto", token, { chat_id: chatId, photo: it.file_id, caption: it.caption });
        else if (it.type === "video")
          await sendSafe("sendVideo", token, { chat_id: chatId, video: it.file_id, caption: it.caption });
        else if (it.type === "animation")
          await sendSafe("sendAnimation", token, { chat_id: chatId, animation: it.file_id, caption: it.caption });
        else if (it.type === "document")
          await sendSafe("sendDocument", token, { chat_id: chatId, document: it.file_id, caption: it.caption });
      }
    }
  } else {
    // Остальные темы — только последний загруженный файл
    for (const chatId of targets) {
      if (item.type === "photo")
        await sendSafe("sendPhoto", token, { chat_id: chatId, photo: item.file_id, caption: cap });
      else if (item.type === "video")
        await sendSafe("sendVideo", token, { chat_id: chatId, video: item.file_id, caption: cap });
      else if (item.type === "animation")
        await sendSafe("sendAnimation", token, { chat_id: chatId, animation: item.file_id, caption: cap });
      else if (item.type === "document")
        await sendSafe("sendDocument", token, { chat_id: chatId, document: item.file_id, caption: cap });
    }
  }

  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text: `${topic === "card_topup" ? "Скринкаст" : "Файл"} для ${cls} опубликован ✅` });
}
 
  /* ---------- Natural language handling ---------- */
function extractTimeHHMM(text){ const m=text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m?`${m[1].padStart(2,"0")}:${m[2]}`:null; }
function extractTimeFlexible(text){ const m=text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m?`${m[1].padStart(2,"0")}:${m[2]}`:null; }

async function tryBehavioralReplies(env, token, msg, state, t, raw){
  // Болезнь
  if (/(заболел|заболела|болеет|температур|насморк|сопл|кашл|орви|грипп)/.test(t)){
    const txt = `${addressPrefix(state,msg)}принято. Выздоравливайте 🙌 Придите в школу со справкой от врача.`;
    await sendToSameThread("sendMessage", token, msg, {text: txt});
    if(state.teacher_id) await sendSafe("sendMessage", token, {chat_id: state.teacher_id, text:`[Болезнь/отсутствие] ${raw}`});
    return true;
  }
  // Отсутствие не по болезни
  if (/(не\s*будет|пропустит|не\s*прид[её]м?|отсутствуй|отсутствовать)/.test(t)){
    const txt = `${addressPrefix(state,msg)}приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`;
    await sendToSameThread("sendMessage", token, msg, {text: txt});
    if(state.teacher_id) await sendSafe("sendMessage", token, {chat_id: state.teacher_id, text:`[Отсутствие] ${raw}`});
    return true;
  }
  // Опоздание
  if (/(опаздыва|опозда|задержива|будем позже|бежим)/.test(t)){
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const txt = `${addressPrefix(state,msg)}поняла, подождём ${tm?`к ${tm}`:"немного"}.`;
    await sendToSameThread("sendMessage", token, msg, {text: txt});
    if(state.teacher_id) await sendSafe("sendMessage", token, {chat_id: state.teacher_id, text:`[Опоздание] ${raw}`});
    return true;
  }
  // Ранний уход
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|после\s*\d+\s*урок)/.test(t)){
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const txt = `${addressPrefix(state,msg)}хорошо, отпустим ${tm?`в ${tm}`:"раньше обычного"}.`;
    await sendToSameThread("sendMessage", token, msg, {text: txt});
    if(state.teacher_id) await sendSafe("sendMessage", token, {chat_id: state.teacher_id, text:`[Ранний уход] ${raw}`});
    return true;
  }
  return false;
}

function detectTopicFromQuestion(text){
  const n = normalize(text);
  // порядок важен: уроки отдельно от звонков
  if (/(расписан.*урок|какие.*урок(и)?|что за предмет)/.test(n)) return "lessons";
  if (/(расписан.*звонок|когда.*перемен|во сколько заканчиваетс[яь]|во сколько.*урок)/.test(n)) return "bells";
  if (/(автобус|подвоз)/.test(n)) return "buses";
  if (/(как.*пополни.*карт|пополнени.*карт)/.test(n)) return "card_topup";
  if (/(баланс.*карт|как.*проверить.*баланс)/.test(n)) return "card_balance";
  return null;
}

async function handleNatural(env, token, msg, state){
  const raw = (msg.text||"").trim();
  if(!raw) return false;
  const t = normalize(raw);

  // Сначала teach-правила
  const taught = findTeachAnswer(state, raw);
  if(taught){
    await sendToSameThread("sendMessage", token, msg, {text: `${addressPrefix(state,msg)}${taught}`});
    return true;
  }

  // Поведенческие фразы (с пересылкой учителю)
  const handledBehavior = await tryBehavioralReplies(env, token, msg, state, t, raw);
  if(handledBehavior) return true;

  // Тематические материалы
  const cls = parseClassFrom(raw) || (state.classes && (Object.keys(state.classes).length ? null : null)) || state.default_class || "1Б";
  const useClass = cls || state.default_class || "1Б";
  ensureClass(state, useClass);

  const topic = detectTopicFromQuestion(raw);
  if(topic){
    const items = state.classes[useClass].media?.[topic] || [];
    if(items.length){
      // если спрашивают "сегодня/завтра уроки" — короткая фраза перед файлами
      if (topic==="lessons" && /(сегодня|завтра)/.test(t))
        await sendToSameThread("sendMessage", token, msg, {text:`${addressPrefix(state,msg)}вот актуальное расписание. Если что-то изменится — сообщу заранее.`});
      if (topic==="bells" && /(перемен|звонок|заканчива)/.test(t))
        await sendToSameThread("sendMessage", token, msg, {text:`${addressPrefix(state,msg)}прикладываю расписание звонков.`});
      if (topic==="buses")
        await sendToSameThread("sendMessage", token, msg, {text:`${addressPrefix(state,msg)}вот актуальное расписание подвоза. Если что-то изменится — сообщу заранее.`});

      await sendMediaList(token, msg, items);
      return true;
    }
  }

  // Если ничего не подходит — молчим
  return false;
}

/* ---------- Router ---------- */
async function handleCommand(env, token, msg, state){
  const text=(msg.text||"").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch(cmd){
    case "/start": await cmdStart(token, msg.chat.id); return true;
    case "/ping": await cmdPing(token, msg); return true;

    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); await saveState(env,state); return true;
    case "/link_general": await cmdLink(token, msg, state, args, "link_general"); await saveState(env,state); return true;
    case "/link_parents": await cmdLink(token, msg, state, args, "link_parents"); await saveState(env,state); return true;

    case "/prefix": await cmdPrefix(env, token, msg, state, args); return true;

    case "/teach": await cmdTeach(env, token, msg, state, args); return true;
    case "/teach_list": await cmdTeachList(token, msg, state); return true;
    case "/teach_del": await cmdTeachDel(env, token, msg, state, args); return true;
    case "/teach_clear": await cmdTeachClear(env, token, msg, state); return true;

    default: return false;
  }
}

/* ---------- Entry ---------- */
export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    if(url.pathname==="/") return OK("ok");

    // Быстрая установка/переустановка вебхука
    if(url.pathname==="/init" && (request.method==="GET"||request.method==="POST")){
      if(!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, {
        url: `${env.PUBLIC_URL}/webhook/${token}`,
        allowed_updates: ["message","edited_message","callback_query","channel_post","my_chat_member","chat_member"],
        max_connections: 40,
        drop_pending_updates: false
      });
      return new Response(JSON.stringify(res), {status:200, headers:{"content-type":"application/json"}});
    }

    if(url.pathname===`/webhook/${token}` && request.method==="POST"){
      let update;
      try { update = await request.json(); } catch { return NO(400,"bad json"); }

      const state = await loadState(env);

      // Текстовые сообщения
      if(update.message?.text){
        const handled = await handleCommand(env, token, update.message, state);
        if(handled) return OK();
        const human = await handleNatural(env, token, update.message, state);
        if(human) return OK();
        return OK(); // молчим
      }

      // Медиа от учителя в ЛС (photo/video/animation/document)
      if (update.message && (update.message.photo?.length || update.message.video || update.message.animation || update.message.document)){
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      return OK();
    }

    return NO();
  }
};
