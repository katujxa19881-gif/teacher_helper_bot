// Cloudflare Worker: Telegram-бот "Учитель"
// Secrets / Vars / KV:
// - Secret: BOT_TOKEN
// - Var: PUBLIC_URL (без завершающего "/")
// - KV: KV_BOT
//
// В BotFather: /setprivacy -> Disable

const OK = (b="ok") => new Response(b,{status:200});
const NO = (c=404,b="not found") => new Response(b,{status:c});

/* ---------- Telegram API ---------- */
async function tg(method, token, payload){
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify(payload ?? {})
  });
  return res.json();
}
async function sendSafe(method, token, payload){
  try { return await tg(method, token, payload); }
  catch(e){ console.log("SEND ERROR", method, e?.message||String(e)); return null; }
}
async function sendToSameThread(method, token, msg, payload = {}){
  const p = { ...payload, chat_id: msg.chat.id };
  if ((msg.chat?.type==="supergroup" || msg.chat?.type==="group") && msg.is_topic_message && msg.message_thread_id){
    p.message_thread_id = msg.message_thread_id;
  }
  return sendSafe(method, token, p);
}

/* ---------- KV state ---------- */
async function loadState(env){
  const raw = await env.KV_BOT.get("state");
  if(!raw) return {
    teacher_id:null,
    teacher_display_name:"Ирина Владимировна",
    autoreply_enabled:true,
    forward_unknown_to_teacher:true,
    policy_absence:"Выздоравливайте 🙌 Придите в школу со справкой от врача.",
    classes:{},
    faq:[],
    teach:[]
  };
  try{
    const s = JSON.parse(raw)||{};
    s.teacher_display_name ||= "Ирина Владимировна";
    if (typeof s.autoreply_enabled==="undefined") s.autoreply_enabled = true;
    if (typeof s.forward_unknown_to_teacher==="undefined") s.forward_unknown_to_teacher = true;
    s.policy_absence ||= "Выздоравливайте 🙌 Придите в школу со справкой от врача.";
    s.classes ||= {};
    s.faq ||= [];
    s.teach ||= [];
    return s;
  }catch{
    return {
      teacher_id:null,
      teacher_display_name:"Ирина Владимировна",
      autoreply_enabled:true,
      forward_unknown_to_teacher:true,
      policy_absence:"Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes:{}, faq:[], teach:[]
    };
  }
}
async function saveState(env, state){ await env.KV_BOT.put("state", JSON.stringify(state)); }

function ensureClass(state, cls){
  if(!state.classes[cls]){
    state.classes[cls] = {
      general_chat_id:null,
      parents_chat_id:null,
      // единичные актуальные:
      schedule_file_id:null, schedule_caption:null, // уроки
      bells_file_id:null, bells_caption:null, // звонки
      bus_file_id:null, bus_caption:null, // автобусы
      pickup_times:null, // время «забирать»
      // медиатеки по темам:
      media:{} // { topic: [ {type, file_id, caption} ] }
    };
  }
}

/* ---------- utils ---------- */
const DAYS = ["ВС","ПН","ВТ","СР","ЧТ","ПТ","СБ"];
const DAYS_FULL = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
const TZ = "Europe/Kaliningrad";

function normalize(s=""){
  return s.toLowerCase()
    .replace(/ё/g,"е")
    .replace(/[^a-zа-я0-9\s#:+.()\-]/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function parseClassFrom(text=""){
  // по умолчанию 1Б если не найдено
  const m = text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i);
  return (m ? m[1].toUpperCase().replace(/\s+/g,"") : "1Б");
}
function extractLargestPhotoId(photos=[]){
  if(!photos?.length) return null;
  const by = [...photos].sort((a,b)=>(a.file_size||0)-(b.file_size||0));
  return by.at(-1)?.file_id || photos.at(-1)?.file_id || null;
}
function userDisplay(u){ if(!u) return ""; if(u.username) return `@${u.username}`; const n=[u.first_name,u.last_name].filter(Boolean).join(" ").trim(); return n||""; }
function addressPrefix(msg){ const d=userDisplay(msg.from||null); return d ? `${d}, ` : ""; }
function ctxKey(msg){ const chat=msg.chat.id; const th=(msg.is_topic_message && msg.message_thread_id)?msg.message_thread_id:0; return `ctx::${chat}::${th}`; }
async function rememberContext(env,msg,role,text){
  const key=ctxKey(msg); let arr=[];
  try{ arr=JSON.parse(await env.KV_BOT.get(key)||"[]")||[]; }catch{ arr=[]; }
  arr.push({t:Date.now(), role, text:(text||"").slice(0,800)});
  if(arr.length>10) arr=arr.slice(-10);
  await env.KV_BOT.put(key, JSON.stringify(arr));
}

/* ---------- class helpers ---------- */
function pickClassFromChat(state, chatId){
  for(const [k,v] of Object.entries(state.classes||{})){
    if (v.general_chat_id===chatId || v.parents_chat_id===chatId) return k;
  }
  return null;
}
const orderDays=["ПН","ВТ","СР","ЧТ","ПТ","СБ","ВС"];
function formatPickupWeek(m){ return orderDays.map(d=>`${d} — ${m?.[d]||"—"}`).join("\n"); }
function ruShortFromDate(d){ const idx = Number(new Date(d.toLocaleString("en-US",{timeZone:TZ})).getDay()); return DAYS[idx]; }
function todayRuShort(){ return ruShortFromDate(new Date()); }
function dayNameFull(short){ const i=DAYS.indexOf(short); return i>=0?DAYS_FULL[i]:short; }
function dayShortFromInput(s=""){
  const n=normalize(s);
  if(n==="сегодня") return todayRuShort();
  if(n==="завтра"){ const d=new Date(); d.setUTCMinutes(d.getUTCMinutes()+24*60); return ruShortFromDate(d); }
  const map={ "пн":"ПН","пон":"ПН","понедельник":"ПН","вт":"ВТ","вторник":"ВТ","ср":"СР","среда":"СР","чт":"ЧТ","четверг":"ЧТ","пт":"ПТ","пятница":"ПТ","сб":"СБ","суббота":"СБ","вс":"ВС","воскресенье":"ВС" };
  return map[n]||null;
}

/* ---------- TEACH (простой) ---------- */
function findTeachAnswer(state, question){
  const qn = normalize(question);
  for(const r of state.teach||[]){
    const pn = normalize(r.pat);
    if (pn && qn.includes(pn)) return r.ans;
  }
  return null;
}

/* ---------- NATURAL intents ---------- */
function extractTimeHHMM(text){ const m=text.match(/(\b[01]?\d|2[0-3]):([0-5]\d)\b/); return m?`${m[1].padStart(2,"0")}:${m[2]}`:null; }
function extractTimeFlexible(text){ const m=text.match(/\b([01]?\d|2[0-3])[.: \-]?([0-5]\d)\b/); return m?`${m[1].padStart(2,"0")}:${m[2]}`:null; }
function extractDelayMinutes(text){ const m=normalize(text).match(/\bна\s+(\d{1,2})\s*мин/); return m?parseInt(m[1],10):null; }

/* ---------- MEDIALIB (темы) ---------- */
function pushMedia(state, cls, topic, item){
  ensureClass(state, cls);
  const lib = state.classes[cls].media ||= {};
  const arr = lib[topic] ||= [];
  // антидубль по file_id
  if (!arr.some(x=>x.file_id===item.file_id)) arr.push(item);
}
function listMedia(state, cls){
  ensureClass(state, cls);
  const lib = state.classes[cls].media||{};
  return Object.fromEntries(Object.entries(lib).map(([k,v])=>[k, v.length]));
}
function delMedia(state, cls, topic, idx){
  ensureClass(state, cls);
  const lib = state.classes[cls].media||{};
  if(!lib[topic]) return false;
  if(idx==="all"){ delete lib[topic]; return true; }
  const i = Number(idx)-1;
  if(isNaN(i)||i<0||i>=lib[topic].length) return false;
  lib[topic].splice(i,1);
  if(!lib[topic].length) delete lib[topic];
  return true;
}
function clearMedia(state, cls){
  ensureClass(state, cls);
  state.classes[cls].media = {};
}

/* ---------- send media helpers ---------- */
async function sendMediaItems(token, msg, items){
  // Telegram альбом допускает только фото/видео — шлём по одному
  for(const it of items){
    if (it.type==="photo"){
      await sendToSameThread("sendPhoto", token, msg, { photo: it.file_id, caption: it.caption?.slice(0,1024) });
    } else if (it.type==="video"){
      await sendToSameThread("sendVideo", token, msg, { video: it.file_id, caption: it.caption?.slice(0,1024) });
    } else if (it.type==="document"){
      await sendToSameThread("sendDocument", token, msg, { document: it.file_id, caption: it.caption?.slice(0,1024) });
    } else if (it.type==="audio"){
      await sendToSameThread("sendAudio", token, msg, { audio: it.file_id, caption: it.caption?.slice(0,1024) });
    } else if (it.type==="voice"){
      await sendToSameThread("sendVoice", token, msg, { voice: it.file_id, caption: it.caption?.slice(0,1024) });
    }
  }
}

/* ---------- commands ---------- */
async function cmdStart(token, chatId){
  const text = [
    "Команды:",
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general <КЛАСС> — привязать этот чат как общий",
    "/link_parents <КЛАСС> — привязать этот чат как чат родителей",
    "/pickup_set <КЛАСС> ПН=13:30,ВТ=12:40,...",
    "/pickup_week [КЛАСС] — время забора на неделю",
    "/teach \"шаблон\" => \"ответ\"",
    "/teach_list, /teach_del <№>, /teach_clear",
    "/persona_set Имя Фамилия — подпись (можно выключить префикс)",
    "/forward_unknown on|off — пересылка неизвестных вопросов учителю",
    "",
    "Медиа-коллекции (карта/баланс):",
    "/media_list [КЛАСС], /media_del <тема> <№|all> [КЛАСС], /media_clear [КЛАСС]",
    "",
    "Загрузка от учителя в ЛС:",
    "∙ Фото расписания/звонков/автобусов — бот публикует актуальное в чаты.",
    "∙ «Карта/Баланс» — бот только сохраняет файлы по теме (без автопубликации)."
  ].join("\n");
  await sendSafe("sendMessage", token, { chat_id: chatId, text });
}
async function cmdPing(token, msg){ await sendToSameThread("sendMessage", token, msg, { text:"pong ✅" }); }
async function cmdIamTeacher(env, token, msg, state){
  if (msg.chat.type!=="private") return sendToSameThread("sendMessage", token, msg, { text:"Команда выполняется только в личке." });
  state.teacher_id = msg.from.id; await saveState(env, state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:"Вы назначены учителем ✅" });
}
async function cmdLink(token, msg, state, args, kind){
  const cls = parseClassFrom(args||"");
  ensureClass(state, cls);
  state.classes[cls][ kind==="link_general" ? "general_chat_id" : "parents_chat_id" ] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, { text:`Привязано: ${kind==="link_general"?"ОБЩИЙ":"РОДИТЕЛИ"} чат для ${cls} ✅` });
}

/* ---------- расписания / автобусы ---------- */
async function publishSingleFileToClassChats(token, state, cls, file_id, caption){
  const rec = state.classes[cls];
  const targets = [rec.general_chat_id, rec.parents_chat_id].filter(Boolean);
  for (const chatId of targets) await sendSafe("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
}
async function handleScheduleBusesUpload(env, token, msg, state, cls, caption, file_id){
  const n = normalize(caption);
  if (/звонк/.test(n)){ // звонки
    state.classes[cls].bells_file_id = file_id;
    state.classes[cls].bells_caption = caption;
    await saveState(env, state);
    await publishSingleFileToClassChats(token, state, cls, file_id, caption);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Звонки для ${cls} опубликованы ✅` });
    return true;
  }
  if (/(автобус|подвоз|bus)/.test(n)){ // автобусы
    state.classes[cls].bus_file_id = file_id;
    state.classes[cls].bus_caption = caption;
    await saveState(env, state);
    await publishSingleFileToClassChats(token, state, cls, file_id, caption);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Автобусы для ${cls} опубликованы ✅` });
    return true;
  }
  // иначе — расписание уроков
  state.classes[cls].schedule_file_id = file_id;
  state.classes[cls].schedule_caption = caption;
  await saveState(env, state);
  await publishSingleFileToClassChats(token, state, cls, file_id, caption);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Расписание для ${cls} опубликовано ✅` });
  return true;
}

/* ---------- загрузка медиа от учителя (ЛС) ---------- */
async function handleMediaFromTeacher(env, token, msg, state){
  if (msg.chat.type!=="private") return;
  if (!state.teacher_id || state.teacher_id!==msg.from.id){
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:"Только учитель может загружать (введите /iam_teacher в личке)." });
    return;
  }
  const caption = msg.caption || "";
  const cls = parseClassFrom(caption||""); // 1Б по умолчанию
  ensureClass(state, cls);

  // распознаём file_id + тип
  let file_id=null, type=null;
  if (msg.photo?.length){ file_id = extractLargestPhotoId(msg.photo); type="photo"; }
  else if (msg.video){ file_id = msg.video.file_id; type="video"; }
  else if (msg.document){ file_id = msg.document.file_id; type="document"; }
  else if (msg.audio){ file_id = msg.audio.file_id; type="audio"; }
  else if (msg.voice){ file_id = msg.voice.file_id; type="voice"; }
  if (!file_id){ await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:"Не удалось распознать вложение." }); return; }

  const n = normalize(caption);

  // Темы, которые копим (без автопубликации)
  if (/\b(попол|пополн|платеж.*карт|карта.*попол)/.test(n)){
    pushMedia(state, cls, "topup", { type, file_id, caption });
    await saveState(env, state);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Сохранено (${cls} — topup).` });
    return;
  }
  if (/\b(баланс|проверить.*баланс|остаток.*карт)/.test(n)){
    pushMedia(state, cls, "balance", { type, file_id, caption });
    await saveState(env, state);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Сохранено (${cls} — balance).` });
    return;
  }

  // Иначе — расписания/звонки/автобусы (автопубликация)
  await handleScheduleBusesUpload(env, token, msg, state, cls, caption, file_id);
}

/* ---------- natural replies & triggers ---------- */
function resolvePickupNatural(state, msg, freeText, teacherName){
  let cls = pickClassFromChat(state, msg.chat.id) || parseClassFrom(freeText||"");
  ensureClass(state, cls);
  const rec = state.classes[cls];
  if (!rec.pickup_times) return { ok:false, text:`Для ${cls} еще не задано время забора. Учитель: /pickup_set ${cls} ПН=13:30,ВТ=12:40,...` };
  let d = dayShortFromInput(freeText||"");
  if (!d){
    if (/завтра/.test(normalize(freeText||""))){ const now=new Date(); now.setUTCMinutes(now.getUTCMinutes()+24*60); d=ruShortFromDate(now); }
    else d=todayRuShort();
  }
  const t = rec.pickup_times[d];
  if (!t) return { ok:false, text:`${cls}: на ${dayNameFull(d)} время не задано.` };
  const pref = addressPrefix(msg);
  return { ok:true, text:`${pref}${teacherName}: ${cls}, ${dayNameFull(d)} — забираем в ${t}.` };
}

async function handleNaturalMessage(env, token, msg, state){
  if (state.autoreply_enabled===false) return false;
  const raw = (msg.text||"").trim();
  if (!raw) return false;
  const t = normalize(raw);
  const pref = addressPrefix(msg);

  await rememberContext(env, msg, "user", raw);

  // teach-правила
  const taught = findTeachAnswer(state, raw);
  if (taught){
    const txt = `${pref}${state.teacher_display_name}: ${taught}`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // привет/спасибо
  if (/(^| )(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер)( |!|$)/.test(t)){
    const txt = `${pref}${state.teacher_display_name}: здравствуйте!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }
  if (/(^| )(спасибо|благодарю)( |!|$)/.test(t)){
    const txt = `${pref}${state.teacher_display_name}: пожалуйста!`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    return true;
  }

  // Болезнь/отсутствие — без имени ребёнка
  if (/(заболел|заболела|болеет|температур|орви|грипп|насморк|сопл|кашля)/.test(t)){
    const txt = `${pref}${state.teacher_display_name}: Выздоравливайте 🙌 Придите в школу со справкой от врача.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text:`[Болезнь] ${msg.chat.title||msg.chat.id}:\n${raw}` });
    return true;
  }

  // «не будет / пропустит» без мед. слов
  if (/(не\s+будет|пропустит|не\s+прид[её]т|отсутству)/.test(t) && !/(забол|температур|орви|грипп|насморк|сопл|кашля)/.test(t)){
    const txt = `${pref}${state.teacher_display_name}: Приняла. Сообщите, пожалуйста, причину отсутствия в личные сообщения.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text:`[Отсутствие] ${msg.chat.title||msg.chat.id}:\n${raw}` });
    return true;
  }

  // Опоздаем/бежим/задержимся
  if (/(опаздыва|опозда|задержива|будем позже|бежим)/.test(t)){
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const delay = extractDelayMinutes(raw);
    const when = tm ? `к ${tm}` : (delay ? `на ~${delay} мин` : "немного");
    const txt = `${pref}${state.teacher_display_name}: Поняла, ждём ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text:`[Опоздание] ${msg.chat.title||msg.chat.id}:\n${raw}` });
    return true;
  }

  // Отпустить пораньше
  if (/(отпуст(и|ите)|уйд[её]м.*раньше|уйду.*раньше|заберу\s*в|забирать\s*в|забер[уё])/.test(t)){
    const tm = extractTimeHHMM(raw) || extractTimeFlexible(raw);
    const when = tm ? `в ${tm}` : "раньше обычного";
    const txt = `${pref}${state.teacher_display_name}: Хорошо, отпустим ${when}.`;
    await sendToSameThread("sendMessage", token, msg, { text: txt });
    await rememberContext(env, msg, "bot", txt);
    if (state.teacher_id) await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text:`[Отпустить] ${msg.chat.title||msg.chat.id}:\n${raw}` });
    return true;
  }

  // Во сколько заканчиваются уроки
  if (/(во сколько|до скольки|когда).*(заканч|кончат|окончан).*(урок)/.test(t)){
    const r = resolvePickupNatural(state, msg, raw, state.teacher_display_name);
    if (r.ok){
      await sendToSameThread("sendMessage", token, msg, { text:r.text });
      await rememberContext(env, msg, "bot", r.text);
    }
    return true; // по условию молчим, если не знаем
  }

  // «во сколько забирать»
  if (/(во сколько|когда).*(забир|забрать|забирать)/.test(t)){
    const r = resolvePickupNatural(state, msg, raw, state.teacher_display_name);
    await sendToSameThread("sendMessage", token, msg, { text:r.text });
    await rememberContext(env, msg, "bot", r.text);
    return true;
  }

  // Карта — комплект
  if (/(как.*попол|пополнить.*карт|пополнение карты)/.test(t)){
    const cls = pickClassFromChat(state, msg.chat.id) || "1Б";
    const items = (state.classes[cls]?.media?.topup || []).slice(0,20);
    if (items.length){ await sendMediaItems(token, msg, items); }
    return true;
  }
  // Баланс — комплект
  if (/(баланс.*карт|как проверить баланс)/.test(t)){
    const cls = pickClassFromChat(state, msg.chat.id) || "1Б";
    const items = (state.classes[cls]?.media?.balance || []).slice(0,20);
    if (items.length){ await sendMediaItems(token, msg, items); }
    return true;
  }

  // Расписание уроков — по фразам "какие уроки сегодня/завтра/в среду"
  const dayInText = /(сегодня|завтра|понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)/.test(t);
  if (/(какие|что за).*(урок|предмет)/.test(t) && (dayInText || /расписан/.test(t))){
    const cls = pickClassFromChat(state, msg.chat.id) || "1Б";
    const rec = state.classes[cls]||{};
    if (rec.schedule_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption||`Расписание ${cls}` });
    }
    return true;
  }
  // Любое «расписание ...» без слов про автобус/звонки — тоже шлём уроки
  if (/расписани[ея](?!.*(автобус|подвоз|звонк))/i.test(msg.text||"")){
    const cls = pickClassFromChat(state, msg.chat.id) || "1Б";
    const rec = state.classes[cls]||{};
    if (rec.schedule_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption||`Расписание ${cls}` });
    }
    return true;
  }

  // Автобусы / подвоз
  if (/(расписани.*автобус|подвоз)/.test(t)){
    const cls = pickClassFromChat(state, msg.chat.id) || "1Б";
    const rec = state.classes[cls]||{};
    if (rec.bus_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption||`Автобусы ${cls}` });
    }
    return true;
  }

  // Звонки
  if (/(расписани.*звонк|когда перемена|во сколько звонок)/.test(t)){
    const cls = pickClassFromChat(state, msg.chat.id) || "1Б";
    const rec = state.classes[cls]||{};
    if (rec.bells_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bells_file_id, caption: rec.bells_caption||`Звонки ${cls}` });
    }
    return true;
  }

  // Не знаем — молчим; при включённой пересылке отправляем учителю
  if (state.forward_unknown_to_teacher && state.teacher_id){
    await sendSafe("sendMessage", token, { chat_id: state.teacher_id, text:`[Вопрос] ${msg.chat.title||msg.chat.id}:\n${raw}` });
  }
  return true;
}

/* ---------- commands router ---------- */
async function handleCommand(env, token, msg, state){
  const text=(msg.text||"").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch(cmd){
    case "/start": await cmdStart(token, msg.chat.id); return true;
    case "/ping": await cmdPing(token, msg); return true;

    case "/iam_teacher": await cmdIamTeacher(env, token, msg, state); return true;
    case "/link_general": await cmdLink(token, msg, state, args, "link_general"); await saveState(env,state); return true;
    case "/link_parents": await cmdLink(token, msg, state, args, "link_parents"); await saveState(env,state); return true;

    case "/pickup_set": {
      const parts = args.trim().split(/\s+/);
      const cls = parseClassFrom(parts[0]||"");
      ensureClass(state, cls);
      const restS = args.trim().slice(args.indexOf(parts[0])+parts[0].length).trim();
      let mapping=null;
      if (restS.startsWith("{")){
        try{
          const obj=JSON.parse(restS); const m={};
          for(const[k,v]of Object.entries(obj||{})){
            const kk=(dayShortFromInput(k)||k.toString().toUpperCase().slice(0,2));
            if (DAYS.includes(kk)&&/^\d{1,2}:\d{2}$/.test(String(v))) m[kk]=String(v);
          }
          mapping=Object.keys(m).length?m:null;
        }catch{}
      } else {
        const out={}; const parts2=restS.split(/[;,]/).map(s=>s.trim()).filter(Boolean);
        for(const p of parts2){
          const [kr,vr]=p.split("=").map(s=>s.trim()); if(!kr||!vr) continue;
          const k=dayShortFromInput(kr)||kr.toUpperCase().slice(0,2);
          if(!DAYS.includes(k)) continue;
          if(!/^\d{1,2}:\d{2}$/.test(vr)) continue;
          out[k]=vr;
        }
        mapping=Object.keys(out).length?out:null;
      }
      if(!mapping){ await sendToSameThread("sendMessage", token, msg, { text:"Формат: /pickup_set 1Б ПН=13:30,ВТ=12:40,..." }); return true; }
      state.classes[cls].pickup_times = mapping; await saveState(env,state);
      await sendToSameThread("sendMessage", token, msg, { text:`Готово. ${cls}: ${Object.entries(mapping).map(([k,v])=>`${k}=${v}`).join(", ")}` });
      const rec=state.classes[cls];
      for(const chatId of [rec.general_chat_id, rec.parents_chat_id].filter(Boolean)){
        await sendSafe("sendMessage", token, { chat_id: chatId, text:`Обновлено время забора (${cls}):\n${formatPickupWeek(mapping)}` });
      }
      return true;
    }

    case "/pickup_week": {
      const cls = pickClassFromChat(state, msg.chat.id) || parseClassFrom(args||"");
      const rec = state.classes[cls]||{};
      if(!rec.pickup_times){ await sendToSameThread("sendMessage", token, msg, { text:"Нужно сначала задать через /pickup_set" }); }
      else { await sendToSameThread("sendMessage", token, msg, { text:`Время забора на неделю — ${cls}:\n${formatPickupWeek(rec.pickup_times)}` }); }
      return true;
    }

    case "/teach": {
      const isT = state.teacher_id && state.teacher_id===msg.from.id;
      if(!isT){ await sendToSameThread("sendMessage", token, msg, { text:"Только учитель может обучать ответы." }); return true; }
      const m = args.match(/"([^"]+)"\s*=>\s*"([^"]+)"/);
      if(!m){ await sendToSameThread("sendMessage", token, msg, { text:'Формат: /teach "шаблон" => "ответ"' }); return true; }
      const [_,pat,ans] = m; state.teach=state.teach||[]; state.teach.push({pat:pat.trim(), ans:ans.trim()});
      await saveState(env,state); await sendToSameThread("sendMessage", token, msg, { text:`Добавлено правило #${state.teach.length} ✅` }); return true;
    }
    case "/teach_list": {
      const list=state.teach||[]; if(!list.length){ await sendToSameThread("sendMessage", token, msg, { text:"Правила пусты." }); return true; }
      const out=list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,80)}"`).join("\n");
      await sendToSameThread("sendMessage", token, msg, { text: out.slice(0,4000) }); return true;
    }
    case "/teach_del": {
      const isT = state.teacher_id && state.teacher_id===msg.from.id;
      if(!isT){ await sendToSameThread("sendMessage", token, msg, { text:"Доступ только учителю." }); return true; }
      const idx=parseInt(args,10); const list=state.teach||[];
      if(isNaN(idx)||idx<1||idx>list.length){ await sendToSameThread("sendMessage", token, msg, { text:"Укажите номер правила: /teach_del 2" }); return true; }
      list.splice(idx-1,1); state.teach=list; await saveState(env,state);
      await sendToSameThread("sendMessage", token, msg, { text:"Удалено ✅" }); return true;
    }
    case "/teach_clear": {
      const isT = state.teacher_id && state.teacher_id===msg.from.id;
      if(!isT){ await sendToSameThread("sendMessage", token, msg, { text:"Доступ только учителю." }); return true; }
      state.teach=[]; await saveState(env,state); await sendToSameThread("sendMessage", token, msg, { text:"Все правила очищены ✅" }); return true;
    }
    case "/persona_set": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) {
        await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
        return true;
      }
      const name = args.trim();
      if (!name) {
        await sendToSameThread("sendMessage", token, msg, { text: "/persona_set Ирина Владимировна" });
        return true;
      }
      state.teacher_display_name = name;
      await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Теперь отвечаю как: ${name}` });
      return true;
    }
    case "/forward_unknown": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) {
        await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
        return true;
      }
      const v = (args || "").trim().toLowerCase();
      if (!["on", "off"].includes(v)) {
        await sendToSameThread("sendMessage", token, msg, { text: "Используйте: /forward_unknown on|off" });
        return true;
      }
      state.forward_unknown_to_teacher = (v === "on");
      await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Пересылать неизвестные вопросы учителю: ${state.forward_unknown_to_teacher ? "ДА" : "НЕТ"}` });
      return true;
    }

    // медиатеки
    case "/media_list": {
      const cls = parseClassFrom(args || "");
      const map = listMedia(state, cls);
      const lines = Object.keys(map).length ? Object.entries(map).map(([k, c]) => `∙ ${k}: ${c}`).join("\n") : "тем нет";
      await sendToSameThread("sendMessage", token, msg, { text: `Медиа-темы (${cls}):\n${lines}` });
      return true;
    }
    case "/media_del": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) {
        await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
        return true;
      }
      const m = args.split(/\s+/);
      const topic = (m[0] || "").trim();
      const which = (m[1] || "").trim();
      const cls = parseClassFrom(m.slice(2).join(" ") || "");
      if (!topic || !which) {
        await sendToSameThread("sendMessage", token, msg, { text: "Формат: /media_del <тема> <№|all> [КЛАСС]" });
        return true;
      }
      const ok = delMedia(state, cls, topic, which.toLowerCase());
      await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: ok ? "Удалено ✅" : "Ничего не найдено." });
      return true;
    }
    case "/media_clear": {
      const isT = state.teacher_id && state.teacher_id === msg.from.id;
      if (!isT) {
        await sendToSameThread("sendMessage", token, msg, { text: "Доступ только учителю." });
        return true;
      }
      const cls = parseClassFrom(args || "");
      clearMedia(state, cls);
      await saveState(env, state);
      await sendToSameThread("sendMessage", token, msg, { text: `Пользовательские медиа-коллекции очищены (${cls}) ✅` });
      return true;
    }

    default: return false;
  }
}

/* ---------- entry ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    if (url.pathname === "/") return OK("ok");

    // init webhook
    if (url.pathname === "/init" && (request.method === "GET" || request.method === "POST")) {
      if (!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, {
        url: `${env.PUBLIC_URL}/webhook/${token}`,
        allowed_updates: ["message", "edited_message", "callback_query", "channel_post", "my_chat_member", "chat_member"],
        max_connections: 40,
        drop_pending_updates: false
      });
      return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.pathname === `/webhook/${token}` && request.method === "POST") {
      let update;
      try { update = await request.json(); } catch { return NO(400, "bad json"); }
      const state = await loadState(env);

      // Текстовые команды / натуральные фразы
      if (update.message?.text) {
        const handled = await handleCommand(env, token, update.message, state);
        if (handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if (human) return OK();
        // молчим
        return OK();
      }

      // Медиа от учителя (ЛС)
      if (update.message && (update.message.photo?.length || update.message.video || update.message.document || update.message.audio || update.message.voice)) {
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      return OK();
    }

    return NO();
  }
};

  
