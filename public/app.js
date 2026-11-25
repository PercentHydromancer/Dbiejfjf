'use strict';
const $ = (s) => document.querySelector(s);
const state = { chatId: null, chats: [], busy: false, user: null, signup: false };
const extension = {html:'html',css:'css',js:'js',javascript:'js',json:'json',python:'py',py:'py',markdown:'md',md:'md',typescript:'ts',ts:'ts',xml:'xml',sql:'sql',sh:'sh',bash:'sh',jsx:'jsx',tsx:'tsx',php:'php',text:'txt'};
async function request(url,opts={}) {
 const r=await fetch('/api'+url,{credentials:'same-origin',...opts,headers:{'Content-Type':'application/json',...opts.headers}});
 const data=await r.json().catch(()=>({}));
 if(!r.ok)throw Error(data.error||'Ошибка HTTP '+r.status);
 return data;
}
function notice(msg) {const el=$('#notice');el.textContent=msg||'';el.hidden=!msg}
function showApp(user) {
 state.user=user;$('#username').textContent=user.name;$('.user-circle').textContent=user.name[0].toUpperCase();
 $('#auth').hidden=true;$('#app').hidden=false;
 refreshChats();refreshAI();
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
 }else bubble.textContent=m.content;
 row.append(bubble);
 if(m.role==='assistant'){
  const actions=document.createElement('div');actions.className='message-actions';
  actions.append(button('⧉ Копировать',()=>navigator.clipboard.writeText(m.content).then(()=>notice('Ответ скопирован')).catch(()=>notice('Не удалось скопировать')),'mini-btn'));
  row.append(actions);
 }
 $('#messages').append(row);scrollMessages();
}
async function refreshAI(){
 try {
  const status=await request('/ai-status');
  const badge=$('#aiBadge');badge.className='status '+(status.ready?'ready':'bad');
  badge.textContent=status.ready?'● '+status.models[0]:'● Ollama недоступна';
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
async function sendMessage(e){
 e?.preventDefault();if(state.busy)return;
 const text=$('#prompt').value.trim();if(!text)return;
 state.busy=true;$('#send').disabled=true;notice('');
 try {
  if(!state.chatId)await createChat();
  const id=state.chatId;
  await request('/chats/'+id+'/messages',{method:'POST',body:JSON.stringify({text,mode:$('#mode').value})});
  $('#prompt').value='';$('#prompt').style.height='';
  render({role:'user',content:text});
  await refreshChats();
  const pending={role:'assistant',content:'Думаю…'};
  const {message}=await request('/chats/'+id+'/reply',{method:'POST',body:'{}'});
  if(state.chatId===id)render(message);
 }catch(err){
  notice(err.message);
  if(state.chatId)showRetry();
 }finally{state.busy=false;$('#send').disabled=false}
}
function showRetry() {
 const noticeEl=$('#notice');
 const existing=noticeEl.querySelector('button');if(existing)return;
 const retry=button('↻ Повторить ответ',async()=>{
  retry.disabled=true;
  try{const id=state.chatId,{message}=await request('/chats/'+id+'/reply',{method:'POST',body:'{}'});
   notice('');const {chat}=await request('/chats/'+id);view(chat);
  }catch(e){notice(e.message);showRetry()}
 },'mini-btn');
 noticeEl.append(document.createTextNode(' '),retry);
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
  showApp(user);
 }catch(e){$('#authError').textContent=e.message}
});
$('#newChat').addEventListener('click',()=>createChat().catch(e=>notice(e.message)));
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
$('#attachText').addEventListener('click',()=>$('#localFile').click());
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
