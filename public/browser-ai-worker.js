// Browser-only open-weight AI. This worker never contacts a paid chat API.
const candidates=[
 {id:'onnx-community/Qwen2.5-0.5B-Instruct',name:'Qwen 2.5 (браузер)'},
 {id:'onnx-community/SmolLM2-135M-Instruct-ONNX-MHA',name:'SmolLM2 (браузер)'}
];
let transformersModule=null;
let loaded=null;
async function getLibrary(){
 if(transformersModule)return transformersModule;
 let error;
 for(const url of [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.0.0',
  'https://esm.sh/@huggingface/transformers@4.0.0'
 ]){
  try{transformersModule=await import(url);return transformersModule}
  catch(e){error=e}
 }
 throw new Error('Не удалось загрузить библиотеку локального ИИ. Проверь интернет и блокировки CDN: '+(error?.message||''));
}
const send=(id,type,details={})=>postMessage({id,type,...details});
async function loadPipeline(id,candidate){
 const {pipeline}=await getLibrary();
 let lastError;
 const deviceOrder=self.navigator?.gpu?['webgpu','wasm']:['wasm'];
 for(const device of deviceOrder){
  try{
   send(id,'progress',{message:'Загружаю '+candidate.name+' ('+device+'). Первый запуск скачивает модель…'});
   const generator=await pipeline('text-generation',candidate.id,{
    dtype:'q4',device,progress_callback:progress=>{
     if(progress.status==='progress'&&Number.isFinite(progress.progress)){
      send(id,'progress',{message:'Загрузка '+candidate.name+': '+Math.round(progress.progress)+'%'});
     }else if(progress.status==='initiate'){
      send(id,'progress',{message:'Загружаю модель '+candidate.name+'…'});
     }
    }
   });
   return {generator,device};
  }catch(e){lastError=e}
 }
 throw lastError||new Error('Модель недоступна');
}
function resultText(result){
 let answer=result?.[0]?.generated_text;
 if(Array.isArray(answer))answer=answer.at(-1)?.content;
 if(typeof answer==='object')answer=answer?.content;
 return typeof answer==='string'?answer.trim():'';
}
async function processTask({id,messages,mode,language='auto'}){
 let failures=[];
 for(const model of candidates){
  try{
   if(!loaded||loaded.model.id!==model.id){
    if(loaded){try{await loaded.generator.dispose()}catch{}loaded=null}
    const {generator,device}=await loadPipeline(id,model);
    loaded={model,generator,device};
   }
   const languageRule=language==='ce'?'Отвечай на чеченском (нохчийн мотт), чеченской кириллицей.':language==='ru'?'Отвечай по-русски.':'Определи, пишет пользователь по-чеченски или по-русски, и отвечай на том же языке; перевод выполняй по запросу.';
   const system=(mode==='code'?
    'Ты Malik GPT. Давай реальный полный код в блоках Markdown с именами файлов. Не выдумывай действия.':
    'Ты Malik GPT, помощник на чеченском и русском языках. Отвечай полезно и честно.')+' '+languageRule;
   const dialog=[{role:'system',content:system},...messages.slice(-8).filter(m=>['user','assistant'].includes(m.role)).map(m=>({role:m.role,content:String(m.content||'').slice(0,2500)}))];
   send(id,'progress',{message:'Модель '+model.name+' отвечает на устройстве…'});
   const result=await loaded.generator(dialog,{max_new_tokens:mode==='code'?280:160,do_sample:false});
   const answer=resultText(result);
   if(!answer)throw new Error('пустой ответ');
   send(id,'done',{answer:answer.slice(0,24000),model:model.name});
   return;
  }catch(e){
   failures.push(model.name+': '+String(e?.message||e).slice(0,160));
   send(id,'progress',{message:'Переключаюсь на резервную браузерную модель…'});
   if(loaded){try{await loaded.generator.dispose()}catch{}loaded=null}
  }
 }
 send(id,'error',{error:'Не удалось запустить ИИ на этом устройстве. Проверь свободную память и интернет. '+failures.join('; ')});
}
self.onmessage=event=>{
 const message=event.data;
 if(!message||message.type!=='generate'||!Number.isSafeInteger(message.id))return;
 processTask(message).catch(e=>send(message.id,'error',{error:String(e?.message||e)}));
};
