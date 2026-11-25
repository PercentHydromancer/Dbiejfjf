'use strict';
/* Malik GPT subscriptions: show only server-enforced benefits. No fake card payment. */
(()=>{
 const get=id=>document.getElementById(id);
 let current=null;
 const money=n=>new Intl.NumberFormat('ru-RU').format(n)+' ₽';
 const txt=(tag,text,cls)=>{
  const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;
 };
 const btn=(label,callback,cls='billing-action')=>{
  const e=txt('button',label,cls);e.type='button';e.addEventListener('click',callback);return e;
 };
 const api=async(endpoint,options={})=>{
  const r=await fetch('/api'+endpoint,{credentials:'same-origin',...options,
   headers:{'Content-Type':'application/json',...options.headers}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(data.error||'HTTP '+r.status);
  return data;
 };
 function mountModal(title){
  get('modalTitle').textContent=title;
  get('modalBody').replaceChildren();
  if(!get('modal').open)get('modal').showModal();
  return get('modalBody');
 }
 const formats=new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short'});
 function humanDate(ts){return ts?formats.format(new Date(ts)):'—'}
 const subtitle=(s)=>txt('p',s,'billing-muted');
 const niceLabel={free:'Free',pro:'PRO',max:'Максимум Malik',ultra:'ULTRA'};
 function trialSummary(x){
  if(x.kind==='trial')return 'Пробный период «Максимум Malik» до '+humanDate(x.expiresAt);
  if(x.kind==='paid')return 'Подписка действует до '+humanDate(x.expiresAt);
  return 'Бесплатный тариф без списаний';
 }
 async function refreshStatus(){
  try{
   current=await api('/billing/status');
   const pill=get('billingBadge');
   if(pill){
    pill.hidden=false;
    pill.textContent=current.kind==='trial'?'MAX · Пробный':current.name;
    pill.title=trialSummary(current);
   }
   return current;
  }catch{
   const pill=get('billingBadge');if(pill)pill.hidden=true;
   return null;
  }
 }
 async function open(){
  const root=mountModal('✦ Тарифы Malik GPT');
  root.append(subtitle('Лимиты на 24 часа по UTC. Фактическая скорость и доступность облачных ИИ зависят от их провайдеров.'));
  try{
   const status=await refreshStatus();
   if(!status)throw Error('Войди в аккаунт, чтобы посмотреть тарифы.');
   const active=txt('div','','billing-active');
   active.append(txt('strong','Твой тариф: '+status.name+(status.kind==='trial'?' · Пробный':'')));
   active.append(subtitle(trialSummary(status)));
   const usage=txt('div','','billing-usage');
   usage.append(txt('span','Сообщения: '+status.used.messages+' / '+status.limits.messages));
   usage.append(txt('span','Файлы: '+status.used.files+' / '+status.limits.files));
   active.append(usage);root.append(active);
   const grid=txt('div','','billing-grid');
   for(const key of ['free','pro','max','ultra']){
    const plan=status.plans[key];
    const card=txt('section','','billing-card'+(status.plan===key?' selected':''));
    card.append(txt('h3',plan.name));
    card.append(txt('div',plan.price?money(plan.price)+' / месяц':'0 ₽ навсегда','billing-price'));
    card.append(txt('p',plan.messages+' сообщений / сутки'));
    card.append(txt('p',plan.files+' текстовых файлов / сутки'));
    if(key==='ultra')card.append(subtitle('300 генераций изображений обсуждались для ULTRA, но генерация пока не подключена и недоступна.'));
    if(status.plan===key)card.append(txt('span','Текущий тариф','billing-current'));
    else if(key!=='free'){
     const act=btn('Оформить',()=>openPayment(key));
     if(!status.payment.configured){act.disabled=true;act.title='Реквизиты ещё не настроены администратором'}
     card.append(act);
    }else card.append(subtitle('Автоматически после пробного периода или окончания подписки.'));
    grid.append(card);
   }
   root.append(grid);

   root.append(btn('Мои заявки на оплату',showMyPayments,'billing-secondary'));
  }catch(e){root.append(txt('p',e.message,'billing-error'))}
 }
 function openPayment(key){
  if(!current?.payment?.configured)return;
  const plan=current.plans[key],root=mountModal('Оплата тарифа '+plan.name);
  root.append(subtitle('Тариф '+plan.name+' · '+money(plan.price)+' за 30 дней. Оплата вручную: переведи точную сумму, затем загрузи фото чека. Деньги не списываются сайтом автоматически.'));
  const details=txt('div','','billing-details');
  details.append(txt('strong','Перевод напрямую в Т-Банк'));
  if(current.payment.receiver)details.append(txt('p','Получатель: '+current.payment.receiver));
  if(current.payment.bank)details.append(txt('p','Банк: '+current.payment.bank));
  if(current.payment.card)details.append(txt('p','Карта: '+current.payment.card));
  if(current.payment.phone)details.append(txt('p','Телефон для перевода: '+current.payment.phone));
  root.append(details);
  root.append(subtitle('После перевода прикрепи чек ниже (JPEG, PNG или WebP до 1,3 МБ), затем нажми «Я оплатил». Администратор сверит поступление платежа и примет или отклонит заявку.'));
  root.append(txt('strong','Прикрепить чек:'));
  const file=txt('input','');
  file.type='file';file.accept='image/jpeg,image/png,image/webp';
  file.className='billing-file';
  const err=txt('p','','billing-error');root.append(file,err);
  const submit=btn('Я оплатил',async()=>{
   err.textContent='';
   const uploaded=file.files?.[0];
   if(!uploaded){err.textContent='Сначала выбери фото чека.';return}
   if(uploaded.size>1.3*1024*1024){err.textContent='Фото чека больше 1,3 МБ. Уменьши его.';return}
   if(!['image/jpeg','image/png','image/webp'].includes(uploaded.type)){
    err.textContent='Поддерживаются только JPEG, PNG, WebP.';return;
   }
   submit.disabled=true;
   try{
    const base64=await new Promise((resolve,reject)=>{
     const reader=new FileReader();
     reader.onerror=()=>reject(Error('Не удалось прочитать файл.'));
     reader.onload=()=>resolve(String(reader.result||'').split(',')[1]);
     reader.readAsDataURL(uploaded);
    });
    const result=await api('/billing/requests',{method:'POST',
     body:JSON.stringify({plan:key,mime:uploaded.type,receiptBase64:base64})});
    const body=mountModal('Заявка отправлена');
    body.append(txt('p',result.message));
    body.append(subtitle('Статус: на рассмотрении. Администратор активирует тариф после проверки поступления перевода.'));
    body.append(btn('Проверить статус',showMyPayments));
   }catch(e){err.textContent=e.message}
   finally{submit.disabled=false}
  });
  root.append(submit,btn('Назад к тарифам',open,'billing-secondary'));
 }
 async function showMyPayments(){
  const root=mountModal('Мои заявки');
  root.append(subtitle('Тариф активируется только после проверки оплаты администратором.'));
  try{
   const {requests}=await api('/billing/requests');
   if(!requests.length)root.append(subtitle('Пока нет заявок.'));
   for(const p of requests){
    const row=txt('div','','billing-payment-row');
    const statuses={pending:'На рассмотрении',approved:'Подтверждена',rejected:'Отклонена'};
    row.append(txt('strong',niceLabel[p.plan]+' · '+money(p.amount)));
    row.append(txt('p',(statuses[p.status]||p.status)+' · '+humanDate(p.createdAt)));
    root.append(row);
   }
   root.append(btn('К тарифам',open,'billing-secondary'));
  }catch(e){root.append(txt('p',e.message,'billing-error'))}
 }
 async function showAdminPayments(){
  const root=mountModal('Админ · Заявки на оплату');
  root.append(subtitle('Проверяй реальное поступление денег по выписке банка. Фото чека само по себе не является подтверждением оплаты.'));
  try{
   const {requests}=await api('/admin/payments');
   if(!requests.length)root.append(subtitle('Заявок пока нет.'));
   const statuses={pending:'На рассмотрении',approved:'Подтверждена',rejected:'Отклонена'};
   for(const p of requests){
    const row=txt('div','','billing-payment-row');
    row.append(txt('strong',p.username+' · '+niceLabel[p.plan]+' · '+money(p.amount)));
    row.append(txt('p',(statuses[p.status]||p.status)+' · '+humanDate(p.createdAt)));
    if(p.hasReceipt){
     const view=btn('Открыть чек',()=>window.open('/api/admin/payments/'+encodeURIComponent(p.id)+'/receipt','_blank','noopener'),'billing-secondary');
     row.append(view);
    }
    if(p.status==='pending'){
     const decide=async decision=>{
      if(!window.confirm(decision==='approve'?'Ты проверил поступление денег в банке? Подтвердить оплату и включить тариф?':'Отклонить заявку?'))return;
      try{
       await api('/admin/payments/'+encodeURIComponent(p.id)+'/decision',{
        method:'POST',body:JSON.stringify({decision})
       });
       await showAdminPayments();await refreshStatus();
      }catch(e){window.alert(e.message)}
     };
     row.append(btn('Принять',()=>decide('approve')));
     row.append(btn('Отклонить',()=>decide('reject'),'billing-secondary'));
    }
    root.append(row);
   }
  }catch(e){root.append(txt('p',e.message,'billing-error'))}
 }
 window.MalikBilling={open,refreshStatus,showAdminPayments};
 const openButton=get('openPlans'),headerButton=get('headerPlans'),pill=get('billingBadge');
 openButton?.addEventListener('click',open);
 headerButton?.addEventListener('click',open);
 pill?.addEventListener('click',open);
})();
