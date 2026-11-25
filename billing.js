// Malik GPT billing and usage module.
// Manual bank-transfer review only; no pretend automatic payment integration.
import crypto from 'node:crypto';

const DAY=24*60*60*1000;
const PLANS=Object.freeze({
  free:{key:'free',name:'Free',price:0,messages:30,files:5},
  pro:{key:'pro',name:'PRO',price:490,messages:150,files:50},
  max:{key:'max',name:'Максимум Malik',price:999,messages:500,files:200},
  ultra:{key:'ultra',name:'ULTRA',price:1799,messages:1000,files:400}
});
const paidPlans=['pro','max','ultra'];
const isoDay=(date=Date.now())=>new Date(date).toISOString().slice(0,10);
const safeReply=payload=>JSON.parse(JSON.stringify(payload));
const paymentPublic=p=>({id:p.id,plan:p.plan,amount:p.amount,status:p.status,createdAt:p.createdAt,
  reviewedAt:p.reviewedAt||null});
const isImageFormat=(mime,b)=>{
 if(mime==='image/jpeg')return b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255;
 if(mime==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/webp')return b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 return false;
};
export function installBilling({app,store,persist,userAuth,adminAuth,fail}){
 store.payments ||= [];
 store.fileUses ||= [];
 store.messageUses ||= [];
 const limits=()=>({
  ...PLANS,
  // Image generation isn't implemented in this repository. Do not sell non-working capacity.
  imagesConnected:false,
  ultraPlannedImageLimit:300
 });
 function entitlements(user){
  const current=Date.now();
  if(user.paidPlan&&PLANS[user.paidPlan]&&user.paidUntil>current)
   return {key:user.paidPlan,kind:'paid',expiresAt:user.paidUntil};
  const registered=Number(user.createdAt||0);
  const trialEnd=registered+3*DAY;
  if(registered>0&&!user.trialUsed&&current<trialEnd)
   return {key:'max',kind:'trial',expiresAt:trialEnd};
  return {key:'free',kind:'free',expiresAt:null};
 }
 function dailyUsage(user){
  const day=isoDay(),start=Date.parse(day+'T00:00:00.000Z');
  const historicalMessages=store.chats.filter(c=>c.userId===user.id)
   .reduce((count,c)=>count+c.messages.filter(m=>m.role==='user'&&Number(m.at||0)>=start).length,0);
  const ledger=store.messageUses.find(x=>x.userId===user.id&&x.day===day);
  const messages=Math.max(historicalMessages,ledger?.count||0);
  const files=store.fileUses.filter(x=>x.userId===user.id&&x.day===day).length;
  return {messages,files,day};
 }
 function billStatus(user){
  const grant=entitlements(user);
  const plan=PLANS[grant.key];
  const used=dailyUsage(user);
  return {plan:grant.key,name:plan.name,kind:grant.kind,expiresAt:grant.expiresAt,
   limits:{messages:plan.messages,files:plan.files},used,plans:limits(),
   payment:{
    configured:true,
    // Public payment destination requested by the shop owner. Render env overrides these defaults.
    card:process.env.PAYMENT_CARD||'2200701215592723',
    phone:process.env.PAYMENT_PHONE||'+7 938 024 76 77',
    receiver:process.env.PAYMENT_RECEIVER||null,
    bank:process.env.PAYMENT_BANK||'Т-Банк'
   }};
 }
 // Record successful sends separately so deleting a chat never resets the daily allowance.
 function recordMessage(user){
  const day=isoDay();
  let entry=store.messageUses.find(x=>x.userId===user.id&&x.day===day);
  if(entry)entry.count++;
  else{
   const existing=dailyUsage(user).messages; // route already appended the current user message
   store.messageUses.push({userId:user.id,day,count:existing});
  }
  store.messageUses=store.messageUses.filter(x=>x.day>=isoDay(Date.now()-2*DAY));
 }
 function requireMessageQuota(req,res,next){
  const status=billStatus(req.user);
  if(status.used.messages>=status.limits.messages)
   return fail(res,429,'Дневной лимит тарифа '+status.name+' исчерпан ('+status.limits.messages+' сообщений). Лимит обновится в 00:00 UTC. Тариф можно изменить в разделе «Тарифы».');
  next();
 }
 // These run before later route handlers, so limits are enforced on the server.
 app.post('/api/chats/:id/messages',userAuth,requireMessageQuota);
 app.post('/api/chats/:id/voice',userAuth,requireMessageQuota);
 app.get('/api/billing/status',userAuth,(req,res)=>res.json(safeReply(billStatus(req.user))));
 app.get('/api/billing/requests',userAuth,(req,res)=>{
  res.json({requests:store.payments.filter(p=>p.userId===req.user.id).map(paymentPublic).reverse()});
 });
 app.post('/api/uploads/use',userAuth,async(req,res,next)=>{
  try{
   const filename=String(req.body.name||'').slice(0,120);
   const bytes=Number(req.body.bytes);
   if(!filename||!Number.isSafeInteger(bytes)||bytes<1||bytes>120000)
    return fail(res,400,'Разрешены только текстовые файлы до 120 КБ.');
   const status=billStatus(req.user);
   if(status.used.files>=status.limits.files)
    return fail(res,429,'Лимит загрузок тарифа '+status.name+' исчерпан: '+status.limits.files+' файлов в сутки.');
   store.fileUses=store.fileUses.filter(x=>x.day>=isoDay(Date.now()-2*DAY));
   store.fileUses.push({userId:req.user.id,day:isoDay(),name:filename,at:Date.now()});
   await persist();
   res.json({ok:true,remaining:status.limits.files-status.used.files-1});
  }catch(e){next(e)}
 });
 const paymentAttempts=new Map();
 app.post('/api/billing/requests',userAuth,async(req,res,next)=>{
  try{
   const info=billStatus(req.user);
   const plan=String(req.body.plan||'').toLowerCase();
   if(!paidPlans.includes(plan))return fail(res,400,'Неизвестный платный тариф.');
   const mime=String(req.body.mime||'').toLowerCase();
   const encoded=String(req.body.receiptBase64||'');
   if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length>1.9*1024*1024)
    return fail(res,400,'Загрузи фото чека JPEG, PNG или WebP размером до 1,3 МБ.');
   const buffer=Buffer.from(encoded,'base64');
   if(buffer.length<100||buffer.length>1.3*1024*1024||!isImageFormat(mime,buffer))
    return fail(res,400,'Чек должен быть настоящим JPEG, PNG или WebP размером до 1,3 МБ.');
   const key=req.user.id,arr=(paymentAttempts.get(key)||[]).filter(t=>t>Date.now()-3600000);
   if(arr.length>=5)return fail(res,429,'Слишком много заявок. Повтори через час.');
   paymentAttempts.set(key,[...arr,Date.now()]);
   const pending=store.payments.filter(p=>p.userId===req.user.id&&p.status==='pending');
   if(pending.length>=3)return fail(res,409,'У тебя уже есть три заявки на рассмотрении.');
   const payment={id:crypto.randomUUID(),userId:req.user.id,plan,amount:PLANS[plan].price,
    status:'pending',createdAt:Date.now(),mime,receiptBase64:encoded};
   store.payments.push(payment);await persist();
   res.status(201).json({request:paymentPublic(payment),message:'Заявка отправлена на рассмотрение администратору.'});
  }catch(e){next(e)}
 });
 app.get('/api/admin/payments',adminAuth,(_req,res)=>{
  res.json({requests:store.payments.slice().reverse().map(p=>({
   ...paymentPublic(p),username:store.users.find(u=>u.id===p.userId)?.name||'Неизвестно',
   hasReceipt:Boolean(p.receiptBase64)
  }))});
 });
 app.get('/api/admin/payments/:id/receipt',adminAuth,(req,res)=>{
  const p=store.payments.find(x=>x.id===req.params.id);
  if(!p||!p.receiptBase64)return fail(res,404,'Чек не найден.');
  res.set('Cache-Control','private,no-store');
  res.set('X-Content-Type-Options','nosniff');
  res.type(p.mime);res.send(Buffer.from(p.receiptBase64,'base64'));
 });
 app.post('/api/admin/payments/:id/decision',adminAuth,async(req,res,next)=>{
  try{
   const p=store.payments.find(x=>x.id===req.params.id);
   if(!p)return fail(res,404,'Заявка не найдена.');
   if(p.status!=='pending')return fail(res,409,'Заявка уже рассмотрена, повторная активация запрещена.');
   const decision=String(req.body.decision||'');
   if(!['approve','reject'].includes(decision))return fail(res,400,'Выбери принять или отклонить.');
   const user=store.users.find(u=>u.id===p.userId);
   if(!user)return fail(res,404,'Пользователь не найден.');
   p.status=decision==='approve'?'approved':'rejected';p.reviewedAt=Date.now();
   if(decision==='approve'){
    user.paidPlan=p.plan;
    user.paidUntil=Date.now()+30*DAY; // paid plan replaces trial, never stacks with it
    user.trialUsed=true;
   }
   await persist();
   res.json({ok:true,request:paymentPublic(p)});
  }catch(e){next(e)}
 });
 return {entitlements,billStatus,recordMessage};
}
