// Cloudflare Worker: Telegram-бот "Учитель"
// Secrets / Vars / KV:
// - Secret: BOT_TOKEN
// - Var: PUBLIC_URL (без завершающего "/")
// - KV: KV_BOT
//
// В BotFather: /setprivacy -> Disable

const OK = (b="ok") => new Response(b,{status:200});
const NO = (c=404,b="not found") => new Response(b,{status:c});

/* ------------ Telegram API ------------- */
async function tg(method, token, payload){
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:"POST",
    headers:{ "content-type":"application/json" },
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

/* ------------- KV state ---------------- */
async function loadState(env){
  const raw = await env.KV_BOT.get("state");
  if(!raw) return {
    teacher_id:null,
    teacher_display_name:"Ирина Владимировна",
    autoreply_enabled:true,
    forward_unknown_to_teacher:true,
    policy_absence:"Выздоравливайте 🙌 Придите в школу со справкой от врача.",
    classes:{},
    teach:[]
  };
  try {
    const s = JSON.parse(raw)||{};
    s.teacher_display_name ||= "Ирина Владимировна";
    s.autoreply_enabled ??= true;
    s.forward_unknown_to_teacher ??= true;
    s.policy_absence ||= "Выздоравливайте 🙌 Придите в школу со справкой от врача.";
    s.classes ||= {};
    s.teach ||= [];
    return s;
  } catch {
    return {
      teacher_id:null,
      teacher_display_name:"Ирина Владимировна",
      autoreply_enabled:true,
      forward_unknown_to_teacher:true,
      policy_absence:"Выздоравливайте 🙌 Придите в школу со справкой от врача.",
      classes:{},
      teach:[]
    };
  }
}
async function saveState(env,state){ await env.KV_BOT.put("state", JSON.stringify(state)); }

function ensureClass(state, cls){
  if(!state.classes[cls]){
    state.classes[cls] = {
      // привязки чатов
      general_chat_id:null,
      parents_chat_id:null,
      // актуальные картинки
      schedule_file_id:null, schedule_caption:null, // уроки
      bells_file_id:null,    bells_caption:null,    // звонки
      bus_file_id:null,      bus_caption:null,      // автобусы (городские)
      shuttle_file_id:null,  shuttle_caption:null,  // подвоз (школьные автобусы)
      // пользовательские подборки
      media:{} // { topic: [ {type, file_id, caption} ] }
    };
  }
}

/* ---------------- utils ---------------- */
const TZ="Europe/Kaliningrad";
function normalize(s=""){ return s.toLowerCase().replace(/ё/g,"е").replace(/\s+/g," ").trim(); }
function parseClassFrom(text=""){ const m=text.match(/#?\s*([0-9]{1,2}\s*[А-ЯA-Z])/i); return (m?m[1].toUpperCase().replace(/\s+/g,""):"1Б"); }
function extractLargestPhotoId(photos=[]){ if(!photos?.length)return null; const by=[...photos].sort((a,b)=>(a.file_size||0)-(b.file_size||0)); return by.at(-1)?.file_id||photos.at(-1)?.file_id||null; }
function userDisplay(u){ if(!u) return ""; if(u.username) return `@${u.username}`; const n=[u.first_name,u.last_name].filter(Boolean).join(" ").trim(); return n||""; }
function addressPrefix(msg){ const d = userDisplay(msg.from||null); return d ? `${d}, ` : ""; }

/* ---------------- TEACH ---------------- */
function findTeachAnswer(state, question){
  const qn = normalize(question);
  for(const r of state.teach || []){
    const pn = normalize(r.pat);
    if(pn && qn.includes(pn)) return r.ans;
  }
  return null;
}

/* -------- медиа-комплект -------- */
function pushMedia(state,cls,topic,item){
  ensureClass(state,cls);
  const lib = state.classes[cls].media ||= {};
  const arr = lib[topic] ||= [];
  if(!arr.some(x=>x.file_id===item.file_id)) arr.push(item);
}
async function sendMediaItems(token,msg,items){
  for(const it of items){
    const cap = it.caption?.slice(0,1024);
    if(it.type==="photo") await sendToSameThread("sendPhoto", token, msg, { photo: it.file_id, caption: cap });
    else if(it.type==="video") await sendToSameThread("sendVideo", token, msg, { video: it.file_id, caption: cap });
    else if(it.type==="document") await sendToSameThread("sendDocument", token, msg, { document: it.file_id, caption: cap });
  }
}

/* -------- загрузка от учителя -------- */
async function publishSingleFileToClassChats(token,state,cls,file_id,caption){
  const rec = state.classes[cls];
  for(const chatId of [rec.general_chat_id, rec.parents_chat_id].filter(Boolean)){
    await sendSafe("sendPhoto", token, { chat_id: chatId, photo: file_id, caption });
  }
}

// авто-распознавание что за картинка прислал учитель (в ЛС)
async function handleScheduleBusesUpload(env, token, msg, state, cls, caption, file_id){
  const n = normalize(caption);

  // звонки
  if(/звонк/.test(n)){
    state.classes[cls].bells_file_id=file_id;
    state.classes[cls].bells_caption=caption;
    await saveState(env,state);
    await publishSingleFileToClassChats(token,state,cls,file_id,caption);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Звонки для ${cls} опубликованы ✅` });
    return true;
  }

  // подвоз (школьные автобусы)
  if(/подвоз|школьн[а-я]*\s*автобус/.test(n)){
    state.classes[cls].shuttle_file_id=file_id;
    state.classes[cls].shuttle_caption=caption;
    await saveState(env,state);
    await publishSingleFileToClassChats(token,state,cls,file_id,caption);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Подвоз (школьные автобусы) для ${cls} опубликован ✅` });
    return true;
  }

  // городские автобусы
  if(/автобус|маршрут|bus/.test(n)){
    state.classes[cls].bus_file_id=file_id;
    state.classes[cls].bus_caption=caption;
    await saveState(env,state);
    await publishSingleFileToClassChats(token,state,cls,file_id,caption);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Автобусы (городские) для ${cls} опубликованы ✅` });
    return true;
  }

  // по умолчанию — расписание уроков
  state.classes[cls].schedule_file_id=file_id;
  state.classes[cls].schedule_caption=caption;
  await saveState(env,state);
  await publishSingleFileToClassChats(token,state,cls,file_id,caption);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Расписание уроков для ${cls} опубликовано ✅` });
  return true;
}

/* ---------- NATURAL DIALOG ------------ */
// ВАЖНО: «уроки» проверяем раньше «подвоз/автобусы», чтобы они не перехватывали
function isScheduleLessonsQuery(t){
  return /(какие|что за|расписан|урок|занят|предмет)/.test(t) &&
         !/(автобус|подвоз|маршрут)/.test(t);
}
function isShuttleQuery(t){
  return /(подвоз|школьн[а-я]*\s*автобус)/.test(t) &&
         !/(урок|занят|предмет|расписан.*урок)/.test(t);
}
function isBusQuery(t){
  return /(автобус|маршрут|расписан.*автобус|bus)/.test(t) &&
         !/(урок|занят|предмет)/.test(t);
}

async function handleNaturalMessage(env, token, msg, state){
  const raw = (msg.text||"").trim();
  if(!raw) return false;
  const t = normalize(raw);
  const pref = addressPrefix(msg);

  // TEACH токены-картинки (если захочешь, можно добавить правила с буквенными токенами)
  const taught = findTeachAnswer(state, raw);
  if(taught){
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: ${taught}` });
    return true;
  }

  // ---------- РАСПИСАНИЕ УРОКОВ ----------
  if(isScheduleLessonsQuery(t)){
    const cls = parseClassFrom(raw);
    const rec = state.classes[cls] || {};
    if(rec.schedule_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.schedule_file_id, caption: rec.schedule_caption || `Расписание ${cls}` });
    }
    return true;
  }

  // ---------- ПОДВОЗ ----------
  if(isShuttleQuery(t)){
    const cls = parseClassFrom(raw);
    const rec = state.classes[cls] || {};
    if(rec.shuttle_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.shuttle_file_id, caption: rec.shuttle_caption || `Подвоз — ${cls}` });
    } else if(rec.bus_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: (rec.bus_caption||`Автобусы — ${cls}`) + "\n(подвоз не загружен)" });
    }
    return true;
  }

  // ---------- АВТОБУСЫ ----------
  if(isBusQuery(t)){
    const cls = parseClassFrom(raw);
    const rec = state.classes[cls] || {};
    if(rec.bus_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bus_file_id, caption: rec.bus_caption || `Автобусы — ${cls}` });
    } else if(rec.shuttle_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.shuttle_file_id, caption: (rec.shuttle_caption||`Подвоз — ${cls}`) + "\n(городские автобусы не загружены)" });
    }
    return true;
  }

  // ---------- ЗВОНКИ ----------
  if(/звонок|перемен|расписан.*звонк/.test(t)){
    const cls = parseClassFrom(raw);
    const rec = state.classes[cls] || {};
    if(rec.bells_file_id){
      await sendToSameThread("sendPhoto", token, msg, { photo: rec.bells_file_id, caption: rec.bells_caption || `Звонки ${cls}` });
    }
    return true;
  }

  // ПРИВЕТ/СПАСИБО (мелочь, но полезно)
  if(/(^|\s)(привет|здравствуй|здравствуйте|добрый день|доброе утро|добрый вечер)(!|$|\s)/.test(t)){
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: здравствуйте!` });
    return true;
  }
  if(/(^|\s)(спасибо|благодарю)(!|$|\s)/.test(t)){
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: пожалуйста!` });
    return true;
  }

  // СКРИНКАСТЫ: «пополнить карту», «баланс»
  if(/попол|платеж|как.*пополни.*карт/.test(t)){
    const cls = parseClassFrom(raw);
    const items = (state.classes[cls]?.media?.topup || []);
    if(items.length) await sendMediaItems(token, msg, items);
    return true;
  }
  if(/баланс|остаток.*карт|как.*проверить.*баланс/.test(t)){
    const cls = parseClassFrom(raw);
    const items = (state.classes[cls]?.media?.balance || []);
    if(items.length) await sendMediaItems(token, msg, items);
    return true;
  }

  // Больничные и опоздания — очень короткие шаблоны
  if(/заболел|заболела|болеет|температур|орви|грипп/.test(t)){
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: ${state.policy_absence}` });
    return true;
  }
  if(/опаздыва|опозда|задержив/.test(t)){
    await sendToSameThread("sendMessage", token, msg, { text: `${pref}${state.teacher_display_name}: Поняла, ждём 🙌` });
    return true;
  }

  // неизвестное — по умолчанию молчим
  return false;
}

/* --------------- commands -------------- */
async function cmdStart(token, chatId){
  const text = [
    "Команды:",
    "/iam_teacher — назначить себя учителем (ЛС)",
    "/link_general <КЛАСС> — привязать этот чат как общий",
    "/link_parents <КЛАСС> — привязать этот чат как чат родителей",
    "/teach \"шаблон\" => \"ответ\"",
    "/teach_list, /teach_del <№>, /teach_clear",
    "/diag [КЛАСС] — проверка загруженных файлов",
    "",
    "Загрузка от учителя в ЛС:",
    "∙ Фото расписания/звонков/автобусов/подвоза — бот публикует в чаты.",
    "∙ Фото/видео «Карта/Баланс» — копится в медиа (без авто-публикации)."
  ].join("\n");
  await sendSafe("sendMessage", token, { chat_id: chatId, text });
}
async function cmdIamTeacher(env, token, msg, state){
  if(msg.chat.type!=="private"){
    await sendToSameThread("sendMessage", token, msg, { text:"Команда выполняется только в личке." });
    return true;
  }
  state.teacher_id = msg.from.id;
  await saveState(env,state);
  await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:"Вы назначены учителем ✅" });
  return true;
}
async function cmdLink(token,msg,state,args,kind){
  const cls = parseClassFrom(args||"");
  ensureClass(state,cls);
  state.classes[cls][kind==="link_general"?"general_chat_id":"parents_chat_id"] = msg.chat.id;
  await sendToSameThread("sendMessage", token, msg, { text:`Привязано: ${kind==="link_general"?"ОБЩИЙ":"РОДИТЕЛИ"} чат для ${cls} ✅` });
}

async function handleCommand(env, token, msg, state){
  const text = (msg.text||"").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  switch(cmd){
    case "/start": await cmdStart(token, msg.chat.id); return true;
    case "/iam_teacher": return await cmdIamTeacher(env, token, msg, state);
    case "/link_general": await cmdLink(token,msg,state,args,"link_general"); await saveState(env,state); return true;
    case "/link_parents": await cmdLink(token,msg,state,args,"link_parents"); await saveState(env,state); return true;

    case "/teach": {
      const m = args.match(/"([^"]+)"\s*=>\s*"([^"]+)"/);
      if(!m){
        await sendToSameThread("sendMessage", token, msg, { text:'Формат: /teach "шаблон" => "ответ"' });
        return true;
      }
      state.teach = state.teach || [];
      state.teach.push({ pat:m[1], ans:m[2] });
      await saveState(env,state);
      await sendToSameThread("sendMessage", token, msg, { text:`Добавлено правило #${state.teach.length} ✅` });
      return true;
    }
    case "/teach_list": {
      const list = state.teach || [];
      if(!list.length){ await sendToSameThread("sendMessage", token, msg, { text:"Правила пусты." }); return true; }
      const out = list.map((r,i)=>`${i+1}. "${r.pat}" => "${r.ans.slice(0,80)}"`).join("\n");
      await sendToSameThread("sendMessage", token, msg, { text: out.slice(0,4000) });
      return true;
    }
    case "/teach_del": {
      const idx = parseInt(args,10);
      const list = state.teach || [];
      if(isNaN(idx) || idx<1 || idx>list.length){
        await sendToSameThread("sendMessage", token, msg, { text:"Укажите номер правила: /teach_del 2" });
        return true;
      }
      list.splice(idx-1,1);
      state.teach=list; await saveState(env,state);
      await sendToSameThread("sendMessage", token, msg, { text:"Удалено ✅" });
      return true;
    }
    case "/teach_clear": {
      state.teach = []; await saveState(env,state);
      await sendToSameThread("sendMessage", token, msg, { text:"Все правила очищены ✅" });
      return true;
    }

    case "/diag": {
      const cls = parseClassFrom(args||"");
      ensureClass(state,cls);
      const rec = state.classes[cls];
      const yes = x => x ? "есть ✅" : "нет";
      const lines = [
        `Диагностика для ${cls}:`,
        `• расписание уроков: ${yes(rec.schedule_file_id)}`,
        `• звонки: ${yes(rec.bells_file_id)}`,
        `• автобусы/подвоз: автобусы:${yes(rec.bus_file_id)} подвоз:${yes(rec.shuttle_file_id)}`,
        `• teach правил: ${(state.teach||[]).length}`
      ].join("\n");
      await sendToSameThread("sendMessage", token, msg, { text: lines });
      return true;
    }

    default: return false;
  }
}

/* --------------- media from teacher --------------- */
async function handleMediaFromTeacher(env, token, msg, state){
  if(msg.chat.type!=="private") return;
  if(!state.teacher_id || state.teacher_id !== msg.from.id){
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:"Только учитель может загружать (введите /iam_teacher в личке)." });
    return;
  }

  const caption = msg.caption || "";
  const cls = parseClassFrom(caption || "");
  ensureClass(state, cls);

  let file_id=null, type=null;
  if(msg.photo?.length){ file_id=extractLargestPhotoId(msg.photo); type="photo"; }
  else if(msg.video){ file_id=msg.video.file_id; type="video"; }
  else if(msg.document){ file_id=msg.document.file_id; type="document"; }
  else if(msg.audio){ file_id=msg.audio.file_id; type="audio"; }
  if(!file_id){ await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:"Не удалось распознать вложение." }); return; }

  const n = normalize(caption);

  // тематические «карта/баланс» — копим, не публикуем
  if(/попол|оплат|платеж/.test(n) && /карт/.test(n)){
    pushMedia(state,cls,"topup",{type,file_id,caption});
    await saveState(env,state);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Сохранено (${cls} — topup).` });
    return;
  }
  if(/баланс|остаток/.test(n) && /карт/.test(n)){
    pushMedia(state,cls,"balance",{type,file_id,caption});
    await saveState(env,state);
    await sendSafe("sendMessage", token, { chat_id: msg.chat.id, text:`Сохранено (${cls} — balance).` });
    return;
  }

  // иначе — автоопределение и публикация
  await handleScheduleBusesUpload(env, token, msg, state, cls, caption, file_id);
}

/* ---------- entry ---------- */
export default {
  async fetch(request, env){
    const url = new URL(request.url);
    const token = env.BOT_TOKEN;

    if(url.pathname === "/") return OK("ok");

    // init webhook
    if(url.pathname === "/init" && (request.method==="GET" || request.method==="POST")){
      if(!token || !env.PUBLIC_URL) return NO(400, "Need BOT_TOKEN and PUBLIC_URL");
      const res = await tg("setWebhook", token, {
        url: `${env.PUBLIC_URL}/webhook/${token}`,
        allowed_updates: ["message","edited_message","callback_query","channel_post","my_chat_member","chat_member"],
        max_connections: 40,
        drop_pending_updates: false
      });
      return new Response(JSON.stringify(res), { status:200, headers:{ "content-type":"application/json" } });
    }

    if(url.pathname === `/webhook/${token}` && request.method==="POST"){
      let update;
      try{ update = await request.json(); }catch{ return NO(400,"bad json"); }
      const state = await loadState(env);

      // текст
      if(update.message?.text){
        const handled = await handleCommand(env, token, update.message, state);
        if(handled) return OK();
        const human = await handleNaturalMessage(env, token, update.message, state);
        if(human) return OK();
        return OK(); // молчим
      }

      // медиа от учителя (ЛС)
      if(update.message && (update.message.photo?.length || update.message.video || update.message.document || update.message.audio)){
        await handleMediaFromTeacher(env, token, update.message, state);
        return OK();
      }

      return OK();
    }

    return NO();
  }
};
