import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'600kb'}));
const root=path.dirname(fileURLToPath(import.meta.url));
const dbPath=path.join(process.env.DATA_DIR||path.join(root,'data'),'store.json');
const ollama=(process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434').replace(/\/+$/,'');
const store={users:[],sessions:[],chats:[],notes:[]};
const id=()=>crypto.randomUUID(),clock=()=>Date.now();
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const fail=(res,n,msg)=>res.status(n).json({error:msg});
let queued=Promise.resolve();
async function persist(){queued=queued.catch(()=>{}).then(async()=>{await fs.mkdir(path.dirname(dbPath),{recursive:true});const tmp=dbPath+'.tmp';await fs.writeFile(tmp,JSON.stringify(store),{mode:0o600});await fs.rename(tmp,dbPath)});await queued}
try{Object.assign(store,JSON.parse(await fs.readFile(dbPath,'utf8')))}catch(e){if(e.code!=='ENOENT')throw e}
const cookie=(req)=>((req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('session='))||'').slice(8);
function userAuth(req,res,next){const s=store.sessions.find(s=>s.hash===digest(cookie(req))&&s.until>clock());const u=s&&store.users.find(u=>u.id===s.userId);if(!u)return fail(res,401,'Требуется вход в аккаунт');req.user=u;next()}
const userView=u=>({id:u.id,name:u.name});
function loginCookie(req,res,u){const token=crypto.randomBytes(32).toString('hex');store.sessions.push({hash:digest(token),userId:u.id,until:clock()+2592000000});res.cookie('session',token,{httpOnly:true,sameSite:'lax',secure:req.secure||req.headers['x-forwarded-proto']==='https',maxAge:2592000000})}
function passwordHash(p,salt){return crypto.scryptSync(p,salt,64).toString('hex')}
const access=new Map();
function limit(req,res,next){const key=req.ip||'unknown',list=(access.get(key)||[]).filter(x=>x>clock()-600000);if(list.length>20)return fail(res,429,'Слишком много попыток. Попробуйте позже.');list.push(clock());access.set(key,list);if(access.size>5000)access.clear();next()}
app.post('/api/register',limit,async(req,res,next)=>{try{const name=String(req.body.name||'').trim(),pass=String(req.body.password||'');if(name.length<3||name.length>40||pass.length<8||pass.length>128)return fail(res,400,'Имя от 3 символов, пароль от 8 символов');if(store.users.some(u=>u.name.toLowerCase()===name.toLowerCase()))return fail(res,409,'Имя уже занято');const salt=crypto.randomBytes(16).toString('hex'),u={id:id(),name,salt,hash:passwordHash(pass,salt)};store.users.push(u);loginCookie(req,res,u);await persist();res.json({user:userView(u)})}catch(e){next(e)}});
app.post('/api/login',limit,async(req,res,next)=>{try{const name=String(req.body.name||'').trim(),pass=String(req.body.password||'');const u=store.users.find(u=>u.name.toLowerCase()===name.toLowerCase());if(!u||passwordHash(pass,u.salt)!==u.hash)return fail(res,401,'Неверные данные');loginCookie(req,res,u);await persist();res.json({user:userView(u)})}catch(e){next(e)}});
app.post('/api/logout',userAuth,async(req,res,next)=>{try{store.sessions=store.sessions.filter(s=>s.hash!==digest(cookie(req)));res.clearCookie('session');await persist();res.json({ok:true})}catch(e){next(e)}});
app.get('/api/me',userAuth,(req,res)=>res.json({user:userView(req.user)}));
app.get('/api/health',(_req,res)=>res.json({ok:true,service:'Malik GPT'}));
async function installed(){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),10000);try{const r=await fetch(ollama+'/api/tags',{signal:ctrl.signal});if(!r.ok)throw Error('Ollama '+r.status);const data=await r.json();return (data.models||[]).map(m=>m.name).filter(Boolean)}finally{clearTimeout(timer)}}
function modelOrder(models){const preferred=(process.env.OLLAMA_MODELS||'').split(',').map(s=>s.trim()).filter(Boolean);return [...new Set([...preferred.filter(m=>models.includes(m)),...models])]}
app.get('/api/ai-status',userAuth,async(req,res)=>{try{const names=modelOrder(await installed());res.json({ready:names.length>0,models:names,message:names.length?'Локальные модели доступны':'Модели не установлены. Выполните ollama pull qwen2.5:3b'})}catch{res.json({ready:false,models:[],message:'Ollama не запущена на сервере. См. README.'})}});
app.get('/api/chats',userAuth,(req,res)=>res.json({chats:store.chats.filter(c=>c.userId===req.user.id).sort((a,b)=>b.updated-b.updated).map(({id,title,updated})=>({id,title,updated}))}));
app.post('/api/chats',userAuth,async(req,res,next)=>{try{const c={id:id(),userId:req.user.id,title:'Новый чат',updated:clock(),messages:[]};store.chats.push(c);await persist();res.json({chat:c})}catch(e){next(e)}});
function owned(req,res){const c=store.chats.find(c=>c.id===req.params.id&&c.userId===req.user.id);if(!c)fail(res,404,'Чат не найден');return c}
app.get('/api/chats/:id',userAuth,(req,res)=>{const c=owned(req,res);if(c)res.json({chat:c})});
app.patch('/api/chats/:id',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;const title=String(req.body.title||'').trim().slice(0,80);if(!title)return fail(res,400,'Введите название');c.title=title;await persist();res.json({chat:c})}catch(e){next(e)}});
app.delete('/api/chats/:id',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;store.chats=store.chats.filter(x=>x.id!==c.id);await persist();res.json({ok:true})}catch(e){next(e)}});
app.post('/api/chats/:id/messages',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;const text=String(req.body.text||'').trim();if(!text||text.length>12000)return fail(res,400,'Сообщение должно быть от 1 до 12 000 символов');const m={id:id(),role:'user',content:text,mode:req.body.mode==='code'?'code':'chat',at:clock()};c.messages.push(m);c.messages=c.messages.slice(-120);if(c.title==='Новый чат')c.title=text.slice(0,54);c.updated=clock();await persist();res.json({message:m})}catch(e){next(e)}});
app.post('/api/chats/:id/reply',userAuth,async(req,res,next)=>{try{const c=owned(req,res);if(!c)return;const last=[...c.messages].reverse().find(m=>m.role==='user');if(!last)return fail(res,400,'Сначала отправьте сообщение');const previous=c.messages.find(m=>m.replyTo===last.id);if(previous)return res.json({message:previous});let models;try{models=modelOrder(await installed())}catch{return fail(res,503,'Локальный ИИ не запущен. Установите Ollama на сервере. Сообщение сохранено.')}if(!models.length)return fail(res,503,'Нет моделей. Выполните: ollama pull qwen2.5:3b');const sys=last.mode==='code'?'Ты Malik GPT, помощник по коду. Отвечай по-русски. Для создания файлов пиши полный код в Markdown блоках с именем файла, например html filename=index.html, css filename=style.css, js filename=script.js. Не обещай создать файл, если не вернул исходник.':'Ты Malik GPT. Отвечай на русском, помогай пользователю, не выдумывай действия и инструменты.';let reason='Нет доступного ответа';for(const model of models){const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),120000);try{const r=await fetch(ollama+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctrl.signal,body:JSON.stringify({model,stream:false,messages:[{role:'system',content:sys},...c.messages.slice(-20).map(m=>({role:m.role,content:m.content}))],options:{num_predict:last.mode==='code'?2400:1200}})});if(!r.ok){reason=model+': HTTP '+r.status;continue}const data=await r.json(),answer=String(data.message?.content||'').trim();if(!answer){reason=model+' вернула пустой ответ';continue}const message={id:id(),role:'assistant',content:answer.slice(0,110000),replyTo:last.id,model,at:clock()};c.messages.push(message);c.updated=clock();await persist();return res.json({message})}catch(e){reason=model+': '+(e.name==='AbortError'?'таймаут модели':'ошибка соединения')}finally{clearTimeout(timer)}}return fail(res,503,'Все локальные модели недоступны: '+reason+'. Сообщение сохранено.')}catch(e){next(e)}});
app.get('/api/notes',userAuth,(req,res)=>res.json({notes:store.notes.filter(n=>n.userId===req.user.id)}));
app.post('/api/notes',userAuth,async(req,res,next)=>{try{const title=String(req.body.title||'Заметка').slice(0,90),content=String(req.body.content||'').slice(0,30000);if(!content.trim())return fail(res,400,'Заметка пуста');const note={id:id(),userId:req.user.id,title,content,at:clock()};store.notes.push(note);await persist();res.json({note})}catch(e){next(e)}});
app.delete('/api/notes/:id',userAuth,async(req,res,next)=>{try{store.notes=store.notes.filter(n=>!(n.id===req.params.id&&n.userId===req.user.id));await persist();res.json({ok:true})}catch(e){next(e)}});
app.use(express.static(path.join(root,'public')));
app.use('/api',(_req,res)=>fail(res,404,'Маршрут не найден'));
app.use((err,req,res,next)=>{console.error(err);fail(res,500,'Ошибка сервера')});
app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Malik GPT started'));
