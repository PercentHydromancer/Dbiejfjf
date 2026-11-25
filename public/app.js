'use strict';
const $ = (s) => document.querySelector(s);
const state = { chatId: null, chats: [], busy: false, user: null, signup: false };
const extension = {html:'html',css:'css',js:'js',javascript:'js',json:'json',python:'py',py:'py',markdown:'md',md:'md',typescript:'ts',ts:'ts',xml:'xml',sql:'sql',sh:'sh',bash:'sh',jsx:'jsx',tsx:'tsx',php:'php',text:'txt'};
async function request(url,opts={}) {
 const r=await fetch('/api'+url,{credentials:'same-origin',...opts,headers:{'Content-Type':'application/json',...opts.headers}});
 const data=await r.json().catch(()=>({}));
 if(!r.ok){
  if(r.status===401&&state.user&&!url.startsWith('/admin/')){
   state.user=null;state.chatId=null;$('#app').hidden=true;$('#auth').hidden=false;
   $('#authError').textContent='Вход завершён. Войдите снова. Если это произошло после обновления Render, настройте постоянную базу PostgreSQL.';
  }
  throw Error(data.error||'Ошибка HTTP '+r.status);
 }
 return data;
}
function notice(msg) {const el=$('#notice');el.textContent=msg||'';el.hidden=!msg}
function showApp(user) {
 state.user=user;$('#username').textContent=user.name;$('.user-circle').textContent=user.name[0].toUpperCase();
 $('#auth').hidden=true;$('#app').hidden=false;
 refreshChats().catch(e=>notice(e.message));refreshAI().catch(()=>{});
}
function openModal(title) {$('#modalTitle').textContent=title;$('#modalBody').replaceChildren();$('#modal').showModal()}
function button(text,fn,cls='action'){const el=document.createElement('button');el.type='button';el.className=cls;el.textContent=text;el.addEventListener('click',fn);return el}
function field(placeholder,value=''){const i=document.createElement('input');i.placeholder=placeholder;i.value=value;return i}
function paragraph(text,cls='muted'){const p=document.createElement('p');p.className=cls;p.textContent=text;return p}
function closeSidebar(){ $('#sidebar').classList.remove('open');$('#scrim').hidden=true }
function openSidebar(){ $('#sidebar').classList.add('open');$('#scrim').hidden=false }
function view(chat) {
 $('#welcome').hidden=Boolean(chat);$('#messages').hidden=!chat;$('#messages').replaceChildren();
 if(chat)chat.messages.forEach(render);
 scrollMessages();
}
function scrollMessages(){const el=$('#messages');el.scrollTop=el.scrollHeight}
function fileName(info,preceding,idx){
 const named=String(info).match(/(?:filename|file|path)\s*[:=]\s*([a-z0-9_-]+\.[a-z0-9]+)|(?:^|\s)([a-z0-9_-]+\.[a-z0-9]+)(?:\s|$)/i);
 const context=String(preceding).slice(-150).match(/([a-z0-9_-]+\.[a-z0-9]{1,12})[\s*:\x60]*$/i);
 let name=named?.[1]||named?.[2]||context?.[1];
 if(name&&/^[a-z0-9_-][a-z0-9_.-]{0,70}\.[a-z0-9]{1,12}$/i.test(name)&&!name.includes('..'))return name;
 const lang=String(info).trim().split(/\s/)[0].toLowerCase(),ext=extension[lang]||'txt';
 return ({html:'index.html',css:'style.css',js:'script.js',py:'main.py',json:'data.json'})[ext]||'file-'+(idx+1)+'.'+ext;
}
function parseFiles(answer){
 const text=String(answer),re=/\x60{3}([^\r\n]*)\r?\n([\s\S]*?)\x60{3}/g,files=[];
 let m;
 while((m=re.exec(text))&&files.length<25){
   if(m[2].length<1||m[2].length>1000000)continue;
   const name=fileName(m[1],text.slice(Math.max(0,m.index-150),m.index),files.length);
   let filename=name,n=2;
   while(files.some(f=>f.filename.toLowerCase()===filename.toLowerCase()))filename=name.replace(/(\.[^.]+)$/,'-'+n+++'$1');
   files.push({filename,code:m[2].replace(/^\n|\n$/g,'')});
 }
 return files;
}
function saveBlob(blob,name) {
 const uri=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=uri;a.download=name;document.body.append(a);a.click();a.remove();
 setTimeout(()=>URL.revokeObjectURL(uri),10000);
}
function downloadFile(file){saveBlob(new Blob([file.code],{type:'text/plain;charset=utf-8'}),file.filename)}
function crc(bytes) {let c=0xffffffff;for(const byte of bytes){c^=byte;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function downloadZip(files) {
 const encoder=new TextEncoder(),parts=[],centers=[];let offset=0;
 for(const file of files) {
  const name=encoder.encode(file.filename),data=encoder.encode(file.code),checksum=crc(data);
  const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,2048,true);
  v.setUint32(14,checksum,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);local.set(name,30);
  parts.push(local,data);
  const center=new Uint8Array(46+name.length),c=new DataView(center.buffer);
  c.setUint32(0,0x02014b50,true);c.setUint16(4,20,true);c.setUint16(6,20,true);c.setUint16(8,2048,true);c.setUint32(16,checksum,true);
  c.setUint32(20,data.length,true);c.setUint32(24,data.length,true);c.setUint16(28,name.length,true);c.setUint32(42,offset,true);center.set(name,46);
  centers.push(center);offset+=local.length+data.length;
 }
 const centralSize=centers.reduce((n,b)=>n+b.length,0),end=new Uint8Array(22),view=new DataView(end.buffer);
 view.setUint32(0,0x06054b50,true);view.setUint16(8,files.length,true);view.setUint16(10,files.length,true);
 view.setUint32(12,centralSize,true);view.setUint32(16,offset,true);
 saveBlob(new Blob([...parts,...centers,end],{type:'application/zip'}),'malik-gpt-project.zip');
}
function showCode(messageBubble,text) {
 const files=parseFiles(text),re=/\x60{3}([^\r\n]*)\r?\n([\s\S]*?)\x60{3}/g;
 let last=0,m,index=0;
 while((m=re.exec(text))) {
  if(m.index>last){const p=document.createElement('span');p.textContent=text.slice(last,m.index);messageBubble.append(p)}
  const block=document.createElement('div');block.className='code-block';
  const head=document.createElement('div');head.className='code-head';
  const filename=files[index]?.filename||m[1]||'Код',file=files[index++];
  const label=document.createElement('span');label.textContent=filename;
  const controls=document.createElement('div');
  controls.append(button('Копировать',()=>navigator.clipboard.writeText(m[2]).then(()=>notice('Код скопирован')).catch(()=>notice('Не удалось скопировать')),'mini-btn'));
  if(file)controls.append(button('↓ '+file.filename,()=>downloadFile(file),'mini-btn'));
  head.append(label,controls);
  const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=m[2].trim();pre.append(code);
  block.append(head,pre);messageBubble.append(block);last=re.lastIndex;
 }
 if(last<text.length){const p=document.createElement('span');p.textContent=text.slice(last);messageBubble.append(p)}
 if(files.length>1)messageBubble.append(button('📦 Скачать проект ZIP',()=>downloadZip(files),'download-all'));
}
function render(m){
 const row=document.createElement('div');row.className='message '+m.role;
 const bubble=document.createElement('div');bubble.className='message-bubble';
 if(m.role==='assistant'){
  row.append(paragraph('✦ Malik GPT'+(m.model?' · '+m.model:''),'message-label'));
  showCode(bubble,m.content);
 }else if(m.voice){
  const caption=document.createElement('div');
  caption.className='voice-caption';caption.textContent='🎤 Голосовое сообщение · '+(m.voice.duration||0)+' с';
  const audio=document.createElement('audio');audio.controls=true;audio.preload='none';
  audio.src='/api/chats/'+encodeURIComponent(state.chatId)+'/audio/'+encodeURIComponent(m.voice.id);
  audio.setAttribute('aria-label','Воспроизвести голосовое сообщение');
  bubble.append(caption,audio);
 }else bubble.textContent=m.content;
 row.append(bubble);
 if(m.role==='assistant'){
  const actions=document.createElement('div');actions.className='message-actions';
  actions.append(button('⧉ Копировать',()=>navigator.clipboard.writeText(m.content).then(()=>notice('Ответ скопирован')).catch(()=>notice('Не удалось скопировать')),'mini-btn'));
  if('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window){
   actions.append(button('🔊 Озвучить',()=>{
    const speaker=window.speechSynthesis;
    if(speaker.speaking){speaker.cancel();return}
    const utterance=new window.SpeechSynthesisUtterance(String(m.content).slice(0,3500));
    utterance.lang='ru-RU';utterance.rate=1;
    speaker.speak(utterance);
   },'mini-btn'));
  }
  row.append(actions);
 }
 $('#messages').append(row);scrollMessages();
}
async function refreshAI(){
 try {
  const status=await request('/ai-status');
  const badge=$('#aiBadge');badge.className='status '+(status.ready?'ready':'bad');
  state.serverAIReady=Boolean(status.ready);
  badge.textContent=status.ready?'● '+status.models[0]:'◌ ИИ в браузере · без ключа';
  badge.title=status.message;
 }catch{$('#aiBadge').textContent='Нет связи'}
}
async function refreshChats(){
 const data=await request('/chats');state.chats=data.chats;
 const list=$('#chatList');list.replaceChildren();
 const query=$('#searchChats').value.trim().toLowerCase();
 for(const c of state.chats.filter(c=>c.title.toLowerCase().includes(query))){
  const row=document.createElement('div');row.className='chat-entry'+(state.chatId===c.id?' active':'');
  row.append(button(c.title,()=>openChat(c.id),'chat-name'));
  row.append(button('⋯',()=>chatMenu(c),'chat-options'));
  list.append(row);
 }
}
async function createChat(){
 const {chat}=await request('/chats',{method:'POST',body:'{}'});
 state.chatId=chat.id;view(chat);await refreshChats();closeSidebar();notice('');
 $('#prompt').focus();
}
async function openChat(id){
 const {chat}=await request('/chats/'+encodeURIComponent(id));
 state.chatId=chat.id;view(chat);await refreshChats();closeSidebar();notice('');
}
function chatMenu(chat){
 openModal('Управление чатом');
 const input=field('Название',chat.title),body=$('#modalBody');body.append(input);
 body.append(button('Переименовать',async()=>{
  try{await request('/chats/'+chat.id,{method:'PATCH',body:JSON.stringify({title:input.value})});$('#modal').close();await refreshChats()}
  catch(e){body.append(paragraph(e.message,'error'))}
 }));
 body.append(button('Удалить чат',async()=>{
  if(!confirm('Удалить этот чат?'))return;
  await request('/chats/'+chat.id,{method:'DELETE'});$('#modal').close();
  if(state.chatId===chat.id){state.chatId=null;view(null)}
  await refreshChats();
 }));
}

let browserAIWorker=null;
let browserTaskNumber=0;
async function getBrowserAIResponse(messages,mode){
 if(typeof Worker==='undefined')throw Error('Этот браузер не поддерживает запуск локального ИИ.');
 // Run heavy model computations away from the UI thread.
 if(!browserAIWorker)browserAIWorker=new Worker('/browser-ai-worker.js?v=1',{type:'module'});
 const worker=browserAIWorker,id=++browserTaskNumber;
 return new Promise((resolve,reject)=>{
  const receive=event=>{
   const msg=event.data;
   if(msg?.id!==id)return;
   if(msg.type==='progress'){notice(msg.message);return}
   worker.removeEventListener('message',receive);
   worker.removeEventListener('error',fault);
   if(msg.type==='done')resolve({answer:msg.answer,model:msg.model});
   else reject(Error(msg.error||'Ошибка браузерной модели.'));
  };
  const fault=event=>{
   worker.removeEventListener('message',receive);
   worker.removeEventListener('error',fault);
   try{worker.terminate()}catch{}
   if(browserAIWorker===worker)browserAIWorker=null;
   reject(Error('Не удалось загрузить браузерный ИИ. Попробуй другой браузер или проверь интернет.'));
  };
  worker.addEventListener('message',receive);
  worker.addEventListener('error',fault);
  worker.postMessage({type:'generate',id,messages,mode});
 });
}
async function generateReplyWithFallback(chatId){
 // Prefer any actually running server model, then automatically use the browser.
 if(state.serverAIReady!==false){
  try{
   const result=await request('/chats/'+encodeURIComponent(chatId)+'/reply',{method:'POST',body:'{}'});
   return result.message;
  }catch(error){
   if(!state.user||!/(локальн|модел|недоступн|http 429|все.+источник|503|ИИ не запущен)/i.test(error.message))
    throw error;
   notice('Серверная модель недоступна. Пробую ИИ прямо в браузере…');
  }
 }
 const {chat}=await request('/chats/'+encodeURIComponent(chatId));
 const last=[...chat.messages].reverse().find(m=>m.role==='user');
 if(!last||last.voice)throw Error('Для браузерной модели нужно последнее текстовое сообщение.');
 const generated=await getBrowserAIResponse(chat.messages,last.mode||'chat');
 notice('Ответ получен от '+generated.model+'. Сохраняю в историю…');
 const {message}=await request('/chats/'+encodeURIComponent(chatId)+'/browser-reply',{
  method:'POST',body:JSON.stringify({replyTo:last.id,answer:generated.answer,model:generated.model})
 });
 return message;
}
async function sendMessage(e){
 e?.preventDefault();if(state.busy)return;
 const text=$('#prompt').value.trim();if(!text)return;
 state.busy=true;$('#send').disabled=true;notice('');
 try{
  if(!state.chatId)await createChat();
  const chatId=state.chatId;
  await request('/chats/'+encodeURIComponent(chatId)+'/messages',{method:'POST',
   body:JSON.stringify({text,mode:$('#mode').value})});
  $('#prompt').value='';$('#prompt').style.height='';
  render({role:'user',content:text});
  await refreshChats();
  const message=await generateReplyWithFallback(chatId);
  if(state.chatId===chatId)render(message);
  notice('');
 }catch(error){
  notice(error.message);
  if(state.user&&state.chatId)showRetry();
 }finally{state.busy=false;$('#send').disabled=false}
}
function showRetry(){
 const el=$('#notice');if(el.querySelector('button'))return;
 const retry=button('↻ Повторить ответ',async()=>{
  if(state.busy)return;
  state.busy=true;retry.disabled=true;$('#send').disabled=true;
  const id=state.chatId;
  try{
   const message=await generateReplyWithFallback(id);
   notice('');
   const {chat}=await request('/chats/'+encodeURIComponent(id));
   if(state.chatId===id)view(chat);
  }catch(e){notice(e.message);showRetry()}
  finally{state.busy=false;$('#send').disabled=false}
 },'mini-btn');
 el.append(document.createTextNode(' '),retry);
}
function starter(title){
 const escaped=title.replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
 return [
  {filename:'index.html',code:'<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escaped+'</title><link rel="stylesheet" href="style.css"></head><body><main><h1>'+escaped+'</h1><p>Страница готова к редактированию.</p><button id="action">Нажми меня</button><p id="output"></p></main><script src="script.js"></script></body></html>'},
  {filename:'style.css',code:'*{box-sizing:border-box}body{font-family:system-ui;background:#181818;color:#f7f7f7;min-height:100vh;display:grid;place-items:center;margin:0}main{padding:40px;border:1px solid #555;border-radius:20px;max-width:600px}button{padding:12px 20px;border:0;border-radius:10px;cursor:pointer}'},
  {filename:'script.js',code:"document.getElementById('action').addEventListener('click',()=>{document.getElementById('output').textContent='Всё работает!';});"}
 ];
}
function builder(){
 openModal('⌘ Создание файлов');
 const body=$('#modalBody');
 body.append(paragraph('Здесь можно создать настоящий проект без ИИ и сохранить HTML, CSS и JavaScript. Для индивидуального проекта используй режим «Код» с Ollama.'));
 const name=field('Название сайта','Мой сайт');body.append(name);
 const output=document.createElement('div');body.append(button('Создать проект',()=>{
  const files=starter(name.value.trim().slice(0,60)||'Мой сайт');
  output.replaceChildren();output.append(paragraph('Готовые файлы:'));
  const row=document.createElement('div');row.className='row-file';
  for(const f of files)row.append(button('↓ '+f.filename,()=>downloadFile(f)));
  output.append(row,button('📦 Скачать ZIP',()=>downloadZip(files)));
 }),output);
 const editorTitle=document.createElement('h3');editorTitle.textContent='Редактор текстового файла';body.append(editorTitle);
 const filename=field('Имя файла','index.html'),code=document.createElement('textarea');
 code.placeholder='Вставь свой HTML, CSS, JavaScript, Python или обычный текст…';code.rows=9;
 body.append(filename,code,button('↓ Скачать файл',()=>{
  const name=filename.value.trim();
  if(!/^[a-z0-9_-][a-z0-9_.-]{0,95}\.[a-z0-9]{1,12}$/i.test(name)||name.includes('..')){alert('Неверное имя файла');return}
  downloadFile({filename:name,code:code.value});
 }));
}
async function notes(){
 openModal('▤ Мои заметки');
 const body=$('#modalBody'),title=field('Название','Заметка'),content=document.createElement('textarea');
 content.placeholder='Текст заметки…';
 body.append(title,content,button('Сохранить заметку',async()=>{
  try{await request('/notes',{method:'POST',body:JSON.stringify({title:title.value,content:content.value})});notes()}
  catch(e){alert(e.message)}
 }));
 const {notes:all}=await request('/notes');
 for(const note of all.slice().reverse()){
  const box=document.createElement('div');box.style.cssText='border-top:1px solid #444;padding:12px 0';
  const heading=document.createElement('strong');heading.textContent=note.title;
  const text=document.createElement('p');text.textContent=note.content;text.style.whiteSpace='pre-wrap';
  box.append(heading,text,button('Удалить',async()=>{
   await request('/notes/'+note.id,{method:'DELETE'});notes()
  }));
  body.append(box);
 }
}
$('#authSwitch').addEventListener('click',()=>{
 state.signup=!state.signup;$('#authTitle').textContent=state.signup?'Создать аккаунт':'Добро пожаловать';
 $('#authSubmit').textContent=state.signup?'Зарегистрироваться':'Войти';
 $('#authSwitch').textContent=state.signup?'Уже есть аккаунт? Войти':'Создать аккаунт';
 $('#authError').textContent='';
});
$('#authForm').addEventListener('submit',async e=>{
 e.preventDefault();$('#authError').textContent='';
 try{
  const {user}=await request(state.signup?'/register':'/login',{method:'POST',body:JSON.stringify({name:$('#authName').value,password:$('#authPass').value})});
  // Verify that the browser actually stored the session cookie before showing the app.
  const checked=await request('/me');
  showApp(checked.user);
 }catch(e){$('#authError').textContent=e.message}
});

let recorder=null,voiceStream=null,voiceChunks=[],voiceStarted=0,voiceTimeout=null,voiceTicker=null;
function stopVoiceUI(){
 clearTimeout(voiceTimeout);clearInterval(voiceTicker);
 voiceTimeout=null;voiceTicker=null;
 const b=$('#voiceToggle');b.classList.remove('recording');b.textContent='🎙';b.title='Записать голосовое';b.disabled=false;
 $('#recordStatus').hidden=true;
}
function closeTools(){
 $('#toolMenu').hidden=true;
 $('#plusTools').setAttribute('aria-expanded','false');
}
async function voiceToggle(){
 closeTools();
 if(recorder?.state==='recording'){recorder.stop();return}
 if(state.busy)return notice('Подожди завершения текущей операции.');
 if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){
  return notice('Этот браузер не поддерживает запись голосовых сообщений. Попробуй Safari или Chrome через HTTPS.');
 }
 try{
  const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});
  const formats=['audio/mp4','audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'];
  const supported=formats.find(m=>MediaRecorder.isTypeSupported(m));
  if(!supported){stream.getTracks().forEach(t=>t.stop());return notice('Запись аудио не поддерживается этим браузером.')}
  voiceStream=stream;voiceChunks=[];
  recorder=new MediaRecorder(stream,{mimeType:supported,audioBitsPerSecond:32000});
  voiceStarted=Date.now();
  recorder.addEventListener('dataavailable',e=>{if(e.data?.size)voiceChunks.push(e.data)});
  recorder.addEventListener('stop',async()=>{
   const duration=(Date.now()-voiceStarted)/1000;
   const mime=recorder.mimeType.split(';')[0];
   const blob=new Blob(voiceChunks,{type:mime});
   voiceStream?.getTracks().forEach(t=>t.stop());voiceStream=null;recorder=null;stopVoiceUI();
   if(!blob.size)return notice('Пустая запись — попробуй ещё раз.');
   if(blob.size>2*1024*1024)return notice('Запись превышает 2 МБ. Запиши более короткое сообщение.');
   state.busy=true;$('#send').disabled=true;
   try{
    if(!state.chatId)await createChat();
    const arr=new Uint8Array(await blob.arrayBuffer());
    // Convert only a bounded 2 MB audio blob into base64.
    let binary='';for(let i=0;i<arr.length;i+=32768)binary+=String.fromCharCode(...arr.subarray(i,i+32768));
    const base64=btoa(binary),id=state.chatId;
    const {message}=await request('/chats/'+encodeURIComponent(id)+'/voice',{
     method:'POST',body:JSON.stringify({mime,base64,duration:Math.min(90,Math.round(duration))})
    });
    if(state.chatId===id)render(message);
    await refreshChats();notice('Голосовое сообщение сохранено. Его можно прослушать в чате.');
   }catch(e){notice('Не удалось сохранить запись: '+e.message)}
   finally{state.busy=false;$('#send').disabled=false}
  },{once:true});
  recorder.start(300);
  const b=$('#voiceToggle');b.classList.add('recording');b.textContent='■';b.title='Остановить и отправить запись';
  $('#recordStatus').hidden=false;
  $('#recordStatus').textContent='● Идёт запись. Нажми ■ для отправки. Максимум 90 секунд.';
  voiceTicker=setInterval(()=>{
   if(recorder?.state!=='recording')return;
   const elapsed=Math.floor((Date.now()-voiceStarted)/1000);
   $('#recordStatus').textContent='● Запись '+Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0')+' · нажми ■ для отправки';
  },1000);
  voiceTimeout=setTimeout(()=>{if(recorder?.state==='recording')recorder.stop()},85000);
 }catch(e){voiceStream?.getTracks().forEach(t=>t.stop());recorder=null;stopVoiceUI();notice('Нет доступа к микрофону: '+e.message)}
}
async function exportChat(){
 closeTools();
 if(!state.chatId)return notice('Сначала открой чат, который хочешь скачать.');
 try{
  const {chat}=await request('/chats/'+encodeURIComponent(state.chatId));
  const text=[chat.title,'',...chat.messages.map(m=>
   (m.role==='user'?'Пользователь':'Malik GPT')+': '+(m.voice?'[Голосовое сообщение — аудиозапись хранится в чате]':m.content))].join('\n\n');
  saveBlob(new Blob([text],{type:'text/plain;charset=utf-8'}),'malik-chat.txt');
 }catch(e){notice(e.message)}
}
async function openAdmin(){
 closeSidebar();
 openModal('⚙ Админ-панель');
 const body=$('#modalBody');
 try{
  const config=await request('/admin/status');
  if(!config.configured){
   body.append(paragraph('Админка пока не настроена. На Render → Environment установи ADMIN_LOGIN и ADMIN_PASSWORD (пароль не короче 12 символов), затем сделай Deploy. В GitHub пароль не добавляй.'));
   return;
  }
  await request('/admin/overview').then(showAdminStats).catch(()=>{
   body.replaceChildren();
   body.append(paragraph('Вход только для администратора. Учётная запись пользователя не заменяет админ-пароль.'));
   const login=field('Логин администратора'),pass=field('Пароль администратора');pass.type='password';
   const feedback=paragraph('');feedback.setAttribute('role','status');
   const submit=button('Войти в админку',async()=>{
    submit.disabled=true;feedback.textContent='';
    try{await request('/admin/login',{method:'POST',body:JSON.stringify({login:login.value,password:pass.value})});
     const stats=await request('/admin/overview');showAdminStats(stats);
    }catch(e){feedback.textContent=e.message}finally{submit.disabled=false}
   });
   body.append(login,pass,submit,feedback);
  });
 }catch(e){body.append(paragraph(e.message,'error'))}
}
function showAdminStats(stats){
 const body=$('#modalBody');body.replaceChildren();
 body.append(paragraph('Статистика проекта · данные только для администратора.'));
 const summary=document.createElement('div');summary.className='admin-stats';
 for(const [label,num] of [['Пользователи',stats.users],['Чаты',stats.chats],['Сообщения',stats.messages],['Заметки',stats.notes]]){
  const tile=document.createElement('div'),strong=document.createElement('strong');
  strong.textContent=String(num);tile.append(strong,paragraph(label));summary.append(tile);
 }
 body.append(summary);
 const heading=document.createElement('h3');heading.textContent='Аккаунты';body.append(heading);
 for(const u of stats.recentUsers||[]){
  const p=paragraph(u.name+' · чатов: '+u.chats+' · заметок: '+u.notes,'admin-user');
  body.append(p);
 }
 body.append(button('Выйти из админки',async()=>{
  try{await request('/admin/logout',{method:'POST',body:'{}'});$('#modal').close()}
  catch(e){body.append(paragraph(e.message,'error'))}
 }));
}

$('#newChat').addEventListener('click',()=>createChat().catch(e=>notice(e.message)));
$('#adminOpen').addEventListener('click',()=>openAdmin().catch(e=>notice(e.message)));
$('#adminFromAuth').addEventListener('click',()=>openAdmin().catch(e=>$('#authError').textContent=e.message));
$('#openBuilder').addEventListener('click',builder);
$('#openNotes').addEventListener('click',()=>notes().catch(e=>alert(e.message)));
$('#logout').addEventListener('click',async()=>{
 try{await request('/logout',{method:'POST',body:'{}'});location.reload()}catch(e){notice(e.message)}
});
$('#composer').addEventListener('submit',sendMessage);
$('#prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
$('#prompt').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,190)+'px'});
$('#aiBadge').addEventListener('click',async()=>{await refreshAI();openModal('Источники ИИ');try{
 const data=await request('/ai-status');
 $('#modalBody').append(paragraph(data.message));
 if(data.models.length)$('#modalBody').append(paragraph('Доступные модели: '+data.models.join(', ')));
 $('#modalBody').append(paragraph('Модели запускаются на сервере через Ollama, а не внутри браузера.'));
 }catch(e){$('#modalBody').append(paragraph(e.message))}
});
$('#menu').addEventListener('click',openSidebar);$('#closeSidebar').addEventListener('click',closeSidebar);
$('#scrim').addEventListener('click',closeSidebar);$('#closeModal').addEventListener('click',()=>$('#modal').close());
$('#searchChats').addEventListener('input',refreshChats);

$('#plusTools').addEventListener('click',()=>{
 const visible=!$('#toolMenu').hidden;
 $('#toolMenu').hidden=visible;
 $('#plusTools').setAttribute('aria-expanded',String(!visible));
});
$('#plusBuilder').addEventListener('click',()=>{closeTools();builder()});
$('#plusNotes').addEventListener('click',()=>{closeTools();notes().catch(e=>notice(e.message))});
$('#plusExport').addEventListener('click',exportChat);
$('#plusVoice').addEventListener('click',voiceToggle);

function startDictation(){
 closeTools();
 const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!Recognition)return notice('Голосовой ввод недоступен в этом браузере.');
 if(recorder?.state==='recording')return notice('Заверши запись голосового сообщения.');
 try{
  const recognition=new Recognition();
  recognition.lang='ru-RU';recognition.interimResults=true;recognition.continuous=false;
  const original=$('#prompt').value.trim(),prefix=original?original+' ':'';
  recognition.onresult=e=>{
   let transcript='';
   for(let i=0;i<e.results.length;i++)transcript+=e.results[i][0].transcript;
   $('#prompt').value=prefix+transcript.trim();
   $('#prompt').dispatchEvent(new Event('input'));
  };
  recognition.onerror=e=>{notice('Не удалось распознать речь: '+e.error)};
  recognition.onend=()=>{if(!recorder||recorder.state!=='recording')$('#recordStatus').hidden=true};
  $('#recordStatus').hidden=false;
  $('#recordStatus').textContent='Слушаю… говори. Распознанный текст появится в поле сообщения.';
  recognition.start();
 }catch(e){$('#recordStatus').hidden=true;notice('Не удалось запустить голосовой ввод: '+e.message)}
}
if(window.SpeechRecognition||window.webkitSpeechRecognition)$('#plusDictate').hidden=false;
$('#plusDictate').addEventListener('click',startDictation);

$('#voiceToggle').addEventListener('click',voiceToggle);
document.addEventListener('click',e=>{
 if(!e.target.closest('#toolMenu')&&!e.target.closest('#plusTools'))closeTools();
});
$('#attachText').addEventListener('click',()=>{closeTools();$('#localFile').click()});
$('#localFile').addEventListener('change',async e=>{
 const file=e.target.files?.[0];if(!file)return;
 if(file.size>120000){notice('Максимум 120 КБ текста для вставки в запрос.');return}
 const text=await file.text();
 $('#prompt').value+='Файл '+file.name+':\n'+text.slice(0,10000);
 $('#prompt').dispatchEvent(new Event('input'));$('#localFile').value='';
});
document.querySelectorAll('[data-prompt]').forEach(el=>el.addEventListener('click',()=>{
 $('#prompt').value=el.dataset.prompt;$('#mode').value='code';$('#prompt').focus();
}));
request('/me').then(({user})=>showApp(user)).catch(()=>{});
