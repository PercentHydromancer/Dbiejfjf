import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { installBilling } from './billing.js';
import { fileURLToPath } from 'node:url';
const app=express();
app.set('trust proxy',1);
app.disable('x-powered-by');
app.use(express.json({limit:'3mb'}));
const root=path.dirname(fileURLToPath(import.meta.url));
const dbPath=path.join(process.env.DATA_DIR||path.join(root,'data'),'store.json');
const ollamaHosts=(process.env.OLLAMA_BASE_URLS||process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434').split(',').map(x=>x.trim().replace(/\/+$/,'')).filter(Boolean);
const localCompat=(process.env.LOCAL_OPENAI_BASE_URL||'').trim().replace(/\/+$/,'');
const localCompatModel=(process.env.LOCAL_OPENAI_MODEL||'local-model').trim();

const store={users:[],sessions:[],chats:[],notes:[],adminSessions:[]};
const pool=process.env.DATABASE_URL?new pg.Pool({connectionString:process.env.DATABASE_URL}):null;
const id=()=>crypto.randomUUID(),clock=()=>Date.now();
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const fail=(res,n,msg)=>res.status(n).json({error:msg});
let queued=Promise.resolve();
async function initializeStore(){
  let saved=null;
  if(pool){
    await pool.query('CREATE TABLE IF NOT EXISTS malik_store (id integer PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS malik_audio (id uuid PRIMARY KEY, user_id uuid NOT NULL, chat_id uuid NOT NULL, mime text NOT NULL, audio bytea NOT NULL)');
    const record=await pool.query('SELECT data FROM malik_store WHERE id=1');
    saved=record.rows[0]?.data||null;
  }
  if(!saved){
    try{saved=JSON.parse(await fs.readFile(dbPath,'utf8'))}
    catch(e){if(e.code!=='ENOENT')throw e}
  }
  if(saved&&typeof saved==='object'){
    for(const key of Object.keys(store))if(Array.isArray(saved[key]))store[key]=saved[key];
  }
  if(pool)await persist();
}
async function persist(){
  queued=queued.catch(e=>{console.error('Previous storage write failed:',e.message)}).then(async()=>{
    const snapshot=JSON.stringify(store);
    if(pool){
      await pool.query('INSERT INTO malik_store(id,data) VALUES(1,$1::jsonb) ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data',[snapshot]);
    }else{
      await fs.mkdir(path.dirname(dbPath),{recursive:true});
      const tmp=dbPath+'.'+process.pid+'.tmp';
      await fs.writeFile(tmp,snapshot,{mode:0o600});
      await fs.rename(tmp,dbPath);
    }
  });
  return queued;
}
function cookieNamed(req,name){
  const match=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='));
  return match?match.slice(name.length+1):'';
}
const cookie=req=>cookieNamed(req,'malik_session')||cookieNamed(req,'session');
function userAuth(req,res,next){const s=store.sessions.find(s=>s.hash===digest(cookie(req))&&s.until>clock());const u=s&&store.users.find(u=>u.id===s.userId);if(!u)return fail(res,401,'Сессия недействительна или истекла. Войдите снова. Если это происходит после деплоя Render, настройте DATABASE_URL (PostgreSQL) или постоянный диск.');req.user=u;next()}
const userView=u=>({id:u.id,name:u.name});
function loginCookie(req,res,u){const token=crypto.randomBytes(32).toString('hex');store.sessions.push({hash:digest(token),userId:u.id,until:clock()+2592000000});res.cookie('malik_session',token,{httpOnly:true,sameSite:'lax',secure:req.secure||req.headers['x-forwarded-proto']==='https',path:'/',maxAge:2592000000})}
function passwordHash(p,salt){return crypto.scryptSync(p,salt,64).toString('hex')}
const access=new Map();
function limit(req,res,next){const key=req.ip||'unknown',list=(access.get(key)||[]).filter(x=>x>clock()-600000);if(list.length>20)return fail(res,429,'Слишком много попыток. Попробуйте позже.');list.push(clock());access.set(key,list);if(access.size>5000)access.clear();next()}
app.post('/api/register',limit,async(req,res,next)=>{try{const name=String(req.body.name||'').trim(),pass=String(req.body.password||'');if(name.length<3||name.length>40||pass.length<8||pass.length>128)return fail(res,400,'Имя от 3 символов, пароль от 8 символов');if(store.users.some(u=>u.name.toLowerCase()===name.toLowerCase()))return fail(res,409,'Имя уже занято');const salt=crypto.randomBytes(16).toString('hex'),u={id:id(),name,salt,hash:passwordHash(pass,salt),createdAt:Date.now()};store.users.push(u);loginCookie(req,res,u);await persist();res.json({user:userView(u)})}catch(e){next(e)}});
app.post('/api/login',limit,async(req,res,next)=>{try{const name=String(req.body.name||'').trim(),pass=String(req.body.password||'');const u=store.users.find(u=>u.name.toLowerCase()===name.toLowerCase());if(!u||passwordHash(pass,u.salt)!==u.hash)return fail(res,401,'Неверные данные');loginCookie(req,res,u);await persist();res.json({user:userView(u)})}catch(e){next(e)}});
app.post('/api/logout',userAuth,async(req,res,next)=>{try{store.sessions=store.sessions.filter(s=>s.hash!==digest(cookie(req)));res.clearCookie('malik_session',{path:'/'});res.clearCookie('session',{path:'/'});await persist();res.json({ok:true})}catch(e){next(e)}});
app.get('/api/me',userAuth,(req,res)=>res.json({user:userView(req.user)}));
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'Malik GPT',storage:pool?'PostgreSQL':'local-file'}));

// Separate administrator session. No credentials or secret default is committed.
const adminConfigured=()=>Boolean(process.env.ADMIN_LOGIN&&process.env.ADMIN_PASSWORD&&process.env.ADMIN_PASSWORD.length>=12);
function secureEqual(a,b){
 const ah=crypto.createHash('sha256').update(String(a)).digest();
 const bh=crypto.createHash('sha256').update(String(b)).digest();
 return crypto.timingSafeEqual(ah,bh);
}
function adminAuth(req,res,next){
 if(!adminConfigured())return fail(res,503,'Админка не настроена. Установите ADMIN_LOGIN и ADMIN_PASSWORD (от 12 символов) в Render → Environment.');
 const token=cookieNamed(req,'malik_admin');
 const session=token&&store.adminSessions.find(x=>x.hash===digest(token)&&x.until>clock());
 if(!session)return fail(res,401,'Войдите в админку.');
 next();
}
app.get('/api/admin/status',(_req,res)=>res.json({configured:adminConfigured()}));
app.post('/api/admin/login',limit,async(req,res,next)=>{
 try{
  if(!adminConfigured())return fail(res,503,'Для входа администратора укажите ADMIN_LOGIN и ADMIN_PASSWORD (минимум 12 символов) в настройках Render.');
  const login=String(req.body.login||'').trim(),pass=String(req.body.password||'');
  if(!secureEqual(login,process.env.ADMIN_LOGIN)||!secureEqual(pass,process.env.ADMIN_PASSWORD))
    return fail(res,401,'Неверный логин или пароль администратора.');
  const token=crypto.randomBytes(32).toString('hex');
  store.adminSessions.push({hash:digest(token),until:clock()+8*3600000});
  store.adminSessions=store.adminSessions.filter(x=>x.until>clock()).slice(-100);
  res.cookie('malik_admin',token,{httpOnly:true,sameSite:'lax',secure:req.secure||req.headers['x-forwarded-proto']==='https',path:'/',maxAge:8*3600000});
  await persist();res.json({ok:true});
 }catch(e){next(e)}
});
app.get('/api/admin/overview',adminAuth,(_req,res)=>{
 const users=store.users.map(u=>({
  id:u.id,name:u.name,
  chats:store.chats.filter(c=>c.userId===u.id).length,
  notes:store.notes.filter(n=>n.userId===u.id).length
 }));
 const messages=store.chats.reduce((sum,c)=>sum+c.messages.length,0);
 res.json({users:users.length,chats:store.chats.length,notes:store.notes.length,messages,recentUsers:users.slice(-40).reverse()});
});
app.post('/api/admin/logout',adminAuth,async(req,res,next)=>{
 try{store.adminSessions=store.adminSessions.filter(x=>x.hash!==digest(cookieNamed(req,'malik_admin')));
  res.clearCookie('malik_admin',{path:'/'});await persist();res.json({ok:true});
 }catch(e){next(e)}
});

// Billing routes are registered before chat message endpoints to enforce quotas.
const billing=installBilling({app,store,persist,userAuth,adminAuth,fail});

async function jsonFromLocal(url,options={},timeoutMs=9000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{const r=await fetch(url,{...options,signal:controller.signal});
   if(!r.ok)throw Error('HTTP '+r.status);
   return await r.json();
 }finally{clearTimeout(timer)}
}
async function localSources(){
 const sources=[];
 for(const base of ollamaHosts){
   try{
     const data=await jsonFromLocal(base+'/api/tags');
     const available=(data.models||[]).map(m=>m.name).filter(Boolean);
     const preferred=(process.env.OLLAMA_MODELS||'').split(',').map(m=>m.trim()).filter(Boolean);
     const ordered=[...new Set([...preferred.filter(m=>available.includes(m)),...available])];
     for(const model of ordered)sources.push({type:'ollama',base,model});
   }catch{}
 }
 if(localCompat){
   try{
     const data=await jsonFromLocal(localCompat+'/models');
     const found=(data.data||[]).map(m=>m.id).filter(Boolean);
     const selected=found.includes(localCompatModel)?localCompatModel:(found[0]||localCompatModel);
     sources.push({type:'openai-local',base:localCompat,model:selected});
   }catch{
     // Some llama.cpp compatible servers do not provide GET /models.
     // Keep the explicitly configured source; generation will verify it.
     sources.push({type:'openai-local',base:localCompat,model:localCompatModel});
   }
 }
 return sources;
}
// OVHcloud anonymous LLMs: keyless sandbox, limited per model per public IP.
const KEYLESS_CLOUD_ENABLED=process.env.KEYLESS_CLOUD_ENABLED!=='false';
const ANONYMOUS_OVH_URL='https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const ANONYMOUS_OVH_MODELS=['Olala-v1.0-mini-7A1B','Olala-v1.0-summarise','Qwen3.6-27B'];
async function* aiFallbackSources(){
 if(KEYLESS_CLOUD_ENABLED){
  for(const model of ANONYMOUS_OVH_MODELS)yield {type:'ovh-anonymous',model,base:ANONYMOUS_OVH_URL};
 }
 for(const source of await localSources())yield source;
}
app.get('/api/ai-status',userAuth,async(_req,res)=>{
 const cloudModels=KEYLESS_CLOUD_ENABLED?ANONYMOUS_OVH_MODELS.map(m=>'OVHcloud: '+m):[];
 const locals=await Promise.race([localSources(),new Promise(resolve=>setTimeout(()=>resolve([]),800))]);
 const models=[...cloudModels,...locals.map(s=>(s.type==='ollama'?'Ollama: ':'Локальный сервер: ')+s.model)];
 res.json({ready:models.length>0,models,provider:'keyless cloud + local + browser Puter.js',
  message:KEYLESS_CLOUD_ENABLED?'Облачные ИИ без API-ключа добавлены. Доступность проверяется при генерации; лимиты провайдера сохраняются.':
    (models.length?'Подключены локальные модели':'Серверной модели нет; в браузере доступен резервный ИИ.')});
});
app.get('/api/chats',userAuth,(req,res)=>res.json({chats:store.chats.filter(c=>c.userId===req.user.id).sort((a,b)=>b.updated-a.updated).map(({id,title,updated})=>({id,title,updated}))}));
app.post('/api/chats',userAuth,async(req,res,next)=>{try{const c={id:id(),userId:req.user.id,title:'Новый чат',updated:clock(),messages:[]};store.chats.push(c);await persist();res.json({chat:c})}catch(e){next(e)}});
function owned(req,res){const c=store.chats.find(c=>c.id===req.params.id&&c.userId===req.user.id);if(!c)fail(res,404,'Чат не найден');return c}
app.get('/api/chats/:id',userAuth,(req,res)=>{const c=owned(req,res);if(c)res.json({chat:c})});
app.patch('/api/chats/:id',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;const title=String(req.body.title||'').trim().slice(0,80);if(!title)return fail(res,400,'Введите название');c.title=title;await persist();res.json({chat:c})}catch(e){next(e)}});
app.delete('/api/chats/:id',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;store.chats=store.chats.filter(x=>x.id!==c.id);await persist();res.json({ok:true})}catch(e){next(e)}});
app.post('/api/chats/:id/messages',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;const text=String(req.body.text||'').trim();if(!text||text.length>12000)return fail(res,400,'Сообщение должно быть от 1 до 12 000 символов');const m={id:id(),role:'user',content:text,mode:req.body.mode==='code'?'code':'chat',at:clock()};c.messages.push(m);billing.recordMessage(req.user);c.messages=c.messages.slice(-120);if(c.title==='Новый чат')c.title=text.slice(0,54);c.updated=clock();await persist();res.json({message:m})}catch(e){next(e)}});
// Persist a real response generated on the user's own device.
// No external API key, no server-side inference or pretend model response.
app.post('/api/chats/:id/browser-reply',userAuth,async(req,res,next)=>{
 try{
  const c=owned(req,res);if(!c)return;
  const last=[...c.messages].reverse().find(m=>m.role==='user');
  if(!last||last.voice)return fail(res,400,'Нет текстового сообщения для ответа.');
  const replyTo=String(req.body.replyTo||'');
  if(last.id!==replyTo)return fail(res,409,'Чат изменился. Повтори ответ на последнее сообщение.');
  const previous=c.messages.find(m=>m.replyTo===last.id);
  if(previous)return res.json({message:previous});
  const content=String(req.body.answer||'').trim();
  const model=String(req.body.model||'');
  if(!content||content.length>24000)return fail(res,400,'Некорректный ответ браузерной модели.');
  if(!['Qwen 2.5 (браузер)','SmolLM2 (браузер)','Puter GPT-5.4 nano','Puter Gemini Flash Lite','Puter Gemini 2.5 Flash'].includes(model))
   return fail(res,400,'Неизвестная браузерная модель.');
  const message={id:id(),role:'assistant',content,replyTo:last.id,model,at:clock()};
  c.messages.push(message);c.messages=c.messages.slice(-120);c.updated=clock();
  await persist();res.json({message});
 }catch(e){next(e)}
});
app.post('/api/chats/:id/reply',userAuth,async(req,res,next)=>{
 try{
  const c=owned(req,res);if(!c)return;
  const last=[...c.messages].reverse().find(m=>m.role==='user');
  if(!last)return fail(res,400,'Сначала отправьте сообщение');
  const previous=c.messages.find(m=>m.replyTo===last.id);
  if(previous)return res.json({message:previous});
  // No installation or API key is required for the default anonymous cloud route.
  const sys=last.mode==='code'
   ?'Ты Malik GPT, помощник по программированию. Отвечай по-русски. Если просят файлы, предоставляй ПОЛНЫЙ код каждого файла в отдельных Markdown блоках с именем: html filename=index.html, css filename=style.css, js filename=script.js. Не утверждай, что создал файлы на устройстве, если не создавал.'
   :'Ты Malik GPT, полезный русскоязычный помощник. Не выдумывай действия или инструменты.';
  const messages=[{role:'system',content:sys},...c.messages.slice(-20).map(m=>({role:m.role,content:m.content}))];
  let reason='Модели не ответили';
  for await(const source of aiFallbackSources()){
   const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),source.type==='ovh-anonymous'?16000:60000);
   const modelLabel=(source.type==='ovh-anonymous'?'OVHcloud: ':source.type==='ollama'?'Ollama: ':'Локальный сервер: ')+source.model;
   try{
    const endpoint=source.type==='ovh-anonymous'?source.base:source.type==='ollama'?source.base+'/api/chat':source.base+'/chat/completions';
    const body=source.type==='ollama'
      ?{model:source.model,stream:false,messages,options:{num_predict:last.mode==='code'?2400:1400}}
      :{model:source.model,stream:false,messages,max_tokens:last.mode==='code'?1600:1000};
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
      signal:ctrl.signal,body:JSON.stringify(body)});
    if(!response.ok){reason=modelLabel+' ответил HTTP '+response.status;await response.body?.cancel().catch(()=>{});continue}
    const result=await response.json();
    const content=source.type==='ollama'?result.message?.content:result.choices?.[0]?.message?.content;
    const answer=String(content||'').trim();
    if(!answer){reason=modelLabel+' вернул пустой ответ';continue}
    const message={id:id(),role:'assistant',content:answer.slice(0,110000),replyTo:last.id,model:modelLabel,at:clock()};
    c.messages.push(message);c.updated=clock();await persist();
    return res.json({message});
   }catch(e){reason=modelLabel+': '+(e.name==='AbortError'?'превышено время ответа':'ошибка связи');}
   finally{clearTimeout(timer)}
  }
  return fail(res,503,'Облачные ИИ без ключа и локальные модели не ответили. '+reason+'. Вопрос сохранён; браузер попробует запасной Puter.js.');
 }catch(e){next(e)}
});


// Voice notes are real recorded audio, not invented speech-to-text.
const audioTypes={ 'audio/webm':'webm','audio/mp4':'m4a','audio/ogg':'ogg','audio/wav':'wav','audio/mpeg':'mp3' };
const voiceThrottle=new Map();
function voiceRateLimit(req,res,next){
 const key=req.user.id,used=(voiceThrottle.get(key)||[]).filter(t=>t>clock()-3600000);
 if(used.length>=30)return fail(res,429,'Лимит: 30 голосовых сообщений в час.');
 used.push(clock());voiceThrottle.set(key,used);
 if(voiceThrottle.size>5000)voiceThrottle.clear();
 next();
}
app.post('/api/chats/:id/voice',userAuth,voiceRateLimit,async(req,res,next)=>{
 try{
  const chat=owned(req,res);if(!chat)return;
  const mime=String(req.body.mime||'').split(';')[0].toLowerCase();
  const base64=String(req.body.base64||'');
  const seconds=Number(req.body.duration);
  if(!audioTypes[mime]||!Number.isFinite(seconds)||seconds<0||seconds>95)
    return fail(res,400,'Неподдерживаемая запись или слишком большая длительность.');
  if(!base64||base64.length>2.8*1024*1024||!(/^[A-Za-z0-9+/]+={0,2}$/).test(base64))
    return fail(res,400,'Голосовое сообщение должно быть короче 90 секунд и до 2 МБ.');
  const audio=Buffer.from(base64,'base64');
  if(!audio.length||audio.length>2*1024*1024)return fail(res,400,'Аудио превышает 2 МБ.');
  // Check basic container signatures, not just user-provided MIME.
  const valid=mime==='audio/webm'?audio.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])):
    mime==='audio/ogg'?audio.toString('ascii',0,4)==='OggS':
    mime==='audio/wav'?audio.toString('ascii',0,4)==='RIFF':
    mime==='audio/mpeg'?(audio[0]===0xff||(audio.toString('ascii',0,3)==='ID3')):
    audio.toString('ascii',4,8)==='ftyp';
  if(!valid)return fail(res,400,'Не удалось проверить формат аудиозаписи.');
  const voiceId=id();
  if(pool){
    await pool.query('INSERT INTO malik_audio(id,user_id,chat_id,mime,audio) VALUES($1,$2,$3,$4,$5)',[voiceId,req.user.id,chat.id,mime,audio]);
  }else{
    const dir=path.join(path.dirname(dbPath),'audio');
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,voiceId+'.'+audioTypes[mime]),audio,{flag:'wx',mode:0o600});
  }
  const m={id:id(),role:'user',content:'🎤 Голосовое сообщение',mode:'chat',voice:{id:voiceId,mime,duration:Math.round(seconds)},at:clock()};
  chat.messages.push(m);billing.recordMessage(req.user);chat.messages=chat.messages.slice(-120);
  if(chat.title==='Новый чат')chat.title='Голосовое сообщение';
  chat.updated=clock();await persist();
  res.status(201).json({message:m});
 }catch(e){next(e)}
});
app.get('/api/chats/:id/audio/:voiceId',userAuth,async(req,res,next)=>{
 try{
  const chat=owned(req,res);if(!chat)return;
  const voice=chat.messages.find(m=>m.voice?.id===req.params.voiceId)?.voice;
  if(!voice)return fail(res,404,'Голосовое сообщение не найдено.');
  let buffer;
  if(pool){
    const record=await pool.query('SELECT audio FROM malik_audio WHERE id=$1 AND user_id=$2 AND chat_id=$3',[voice.id,req.user.id,chat.id]);
    buffer=record.rows[0]?.audio;
  }else{
    try{buffer=await fs.readFile(path.join(path.dirname(dbPath),'audio',voice.id+'.'+audioTypes[voice.mime]));}
    catch(e){if(e.code!=='ENOENT')throw e}
  }
  if(!buffer)return fail(res,404,'Файл аудио недоступен. На Render нужен постоянный диск либо DATABASE_URL.');
  res.set('Cache-Control','private, no-store');res.type(voice.mime);res.send(buffer);
 }catch(e){next(e)}
});

app.get('/api/notes',userAuth,(req,res)=>res.json({notes:store.notes.filter(n=>n.userId===req.user.id)}));
app.post('/api/notes',userAuth,async(req,res,next)=>{try{const title=String(req.body.title||'Заметка').slice(0,90),content=String(req.body.content||'').slice(0,30000);if(!content.trim())return fail(res,400,'Заметка пуста');const note={id:id(),userId:req.user.id,title,content,at:clock()};store.notes.push(note);await persist();res.json({note})}catch(e){next(e)}});
app.delete('/api/notes/:id',userAuth,async(req,res,next)=>{try{store.notes=store.notes.filter(n=>!(n.id===req.params.id&&n.userId===req.user.id));await persist();res.json({ok:true})}catch(e){next(e)}});
app.use(express.static(path.join(root,'public')));
app.use('/api',(_req,res)=>fail(res,404,'Маршрут не найден'));
app.use((err,req,res,next)=>{console.error(err);fail(res,500,'Ошибка сервера')});
await initializeStore();
app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Malik GPT started'+(pool?' with PostgreSQL':' with local file storage')));
