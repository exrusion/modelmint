import {q,fail,hash,decrypt,id} from './db.mjs';
import {rateLimit,concurrency,redis} from './redis.mjs';
import {reserve,settle,ceilProduct,zeroUsage,promoEligible} from './accounting.mjs';
import {AUTO_MODEL_ID,AUTO_STRATEGIES,parseAutoStrategy,rankAutoModels,supportsAutoRequest} from './auto-routing.mjs';

const RETRYABLE_UPSTREAM=new Set([401,403,404,408,425,429,500,502,503,504]);
export function retryableProviderFailure(status){return status===null||RETRYABLE_UPSTREAM.has(Number(status));}

export async function apiKey(req){
 const token=req.headers.authorization?.replace(/^Bearer /,'');
 if(!token)fail(401,'invalid_api_key','Provide a bearer API key.');
 const key=(await q('SELECT k.*,u.suspended,u.purchased_micro,u.base_tokens,u.promo_micro,u.promo_tokens,u.promo_expires FROM api_keys k JOIN users u ON u.id=k.user_id WHERE hash=$1',[hash(token)])).rows[0];
 if(!key||key.revoked||key.suspended||(key.expires&&new Date(key.expires)<new Date()))fail(401,'invalid_api_key','Invalid or revoked API key.');
 await rateLimit(key.id,key.rpm);
 return key;
}

function mediaRequest(messages){return messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type!=='text'));}
function conservativeInput(body,model,maximum,media){
 if(media)return Number(model.max_context)-maximum;
 return Buffer.byteLength(JSON.stringify({messages:body.messages,tools:body.tools,response_format:body.response_format}))+body.messages.length*128+1024;
}
function maximumCost(model,input,maximum){return ceilProduct(input,Math.max(Number(model.input_rate),Number(model.cached_rate)))+ceilProduct(maximum,Math.max(Number(model.output_rate),Number(model.reasoning_rate)))+4n;}
function availableToKey(key,model){return !key.allowed_models.length||key.allowed_models.includes(model.id);}
function hasPaidBalance(key){return BigInt(key.purchased_micro)>0n&&BigInt(key.base_tokens)>0n;}
function hasPromoBalance(key){return Boolean(key.promo_expires&&new Date(key.promo_expires)>new Date()&&BigInt(key.promo_micro)>0n&&BigInt(key.promo_tokens)>0n);}

async function autoCandidates(key,body,maximum,media,strategy){
 const rows=(await q(`SELECT m.*,COALESCE(s.samples,0)::int auto_samples,s.avg_latency auto_latency
  FROM models m LEFT JOIN (
   SELECT model_id,count(*) FILTER (WHERE status BETWEEN 200 AND 299) samples,round(avg(latency_ms) FILTER (WHERE status BETWEEN 200 AND 299)) avg_latency
   FROM requests WHERE created_at>now()-interval '7 days' GROUP BY model_id
  ) s ON s.model_id=m.id
  WHERE m.enabled AND m.verified AND m.auto_enabled`)).rows;
 const paid=hasPaidBalance(key),promo=hasPromoBalance(key),requirements={tools:Boolean(body.tools),vision:media,json:Boolean(body.response_format),maxOutput:maximum};
 return rankAutoModels(rows.filter(model=>{
  if(!availableToKey(key,model)||(!paid&&!(promo&&promoEligible(model))))return false;
  const input=conservativeInput(body,model,maximum,media);
  model.auto_input=input;
  model.auto_estimated_micro=Number(maximumCost(model,input,maximum));
  return supportsAutoRequest(model,{...requirements,input});
 }),{strategy});
}

function upstreamBody(body,model,maximum){
 const result={};
 for(const field of ['messages','temperature','top_p','stop','tools','tool_choice','parallel_tool_calls','response_format','seed','presence_penalty','frequency_penalty','logit_bias','logprobs','top_logprobs','reasoning_effort'])if(body[field]!==undefined)result[field]=body[field];
 result.model=model.upstream_id;result.stream=body.stream===true;result.max_completion_tokens=maximum;
 if(body.max_tokens!==undefined){delete result.max_completion_tokens;result.max_tokens=maximum;}
 if(result.stream)result.stream_options={include_usage:true};
 return result;
}

async function providersFor(model){
 return (await q('SELECT * FROM providers WHERE enabled AND verified_at IS NOT NULL ORDER BY priority,id')).rows.filter(provider=>!model.provider_ids.length||model.provider_ids.includes(provider.id));
}

function exposeSelection(res,requestId,model,strategy,fallbacks=0){
 res.setHeader('X-Request-Id',requestId);
 if(strategy){res.setHeader('X-Routers-Model',model.id);res.setHeader('X-Routers-Strategy',strategy);res.setHeader('X-Routers-Fallbacks',String(fallbacks));}
}

export function mountGateway(app){
 app.get('/v1/models',async(req,res)=>{
  const key=await apiKey(req),promoActive=hasPromoBalance(key),paidBalance=hasPaidBalance(key);
  const models=(await q('SELECT id,name,promo,premium,auto_enabled FROM models WHERE enabled AND verified ORDER BY family,name')).rows.filter(model=>availableToKey(key,model));
  const data=models.map(model=>{const free=promoActive&&promoEligible(model);return {id:model.id,object:'model',created:0,owned_by:'routers',promo_eligible:free,paid_credit_required:!free&&!paidBalance};});
  if(models.some(model=>model.auto_enabled&&(paidBalance||(promoActive&&promoEligible(model)))))data.unshift({id:AUTO_MODEL_ID,object:'model',created:0,owned_by:'routers',promo_eligible:promoActive,paid_credit_required:!promoActive&&!paidBalance,routing_strategies:AUTO_STRATEGIES});
  res.json({object:'list',data});
 });

 app.post('/v1/chat/completions',async(req,res)=>{
  const key=await apiKey(req),body=req.body;
  if(typeof body.model!=='string'||!Array.isArray(body.messages)||!body.messages.length)fail(400,'invalid_request_error','model and messages are required.');
  if(body.n&&body.n!==1)fail(400,'unsupported_parameter','Only n=1 is supported.');
  const automatic=body.model===AUTO_MODEL_ID,strategy=automatic?parseAutoStrategy(body.routing_strategy||req.headers['x-routers-strategy']):null;
  if(!automatic&&(body.routing_strategy!==undefined||req.headers['x-routers-strategy']!==undefined))fail(400,'invalid_routing_strategy','Routing strategies are available only with routers/auto.');
  const media=mediaRequest(body.messages),requestedMaximum=body.max_completion_tokens??body.max_tokens;
  let maximum=requestedMaximum===undefined?(automatic?1024:null):Number(requestedMaximum);
  if(automatic&&(!Number.isSafeInteger(maximum)||maximum<1))fail(400,'invalid_request_error','Invalid maximum output token count.');
  let candidates;
  if(automatic){
   candidates=await autoCandidates(key,body,maximum,media,strategy);
   if(!candidates.length)fail(404,'auto_model_unavailable','No verified model compatible with this request, key and balance is currently available.');
  }else{
   const model=(await q('SELECT * FROM models WHERE (id=$1 OR $1=ANY(aliases)) AND enabled AND verified',[body.model])).rows[0];
   if(!model)fail(404,'model_not_found','This model is not enabled or verified.');
   if(!availableToKey(key,model))fail(403,'model_not_allowed','This model is outside the API key allowlist.');
   if(maximum===null)maximum=Math.min(1024,Number(model.max_output));
   if(!Number.isSafeInteger(maximum)||maximum<1)fail(400,'invalid_request_error','Invalid maximum output token count.');
   if(body.tools&&!model.tools)fail(400,'unsupported_parameter','Tool calling is not verified for this model.');
   if(body.response_format&&!model.json_format)fail(400,'unsupported_parameter','JSON formats are not verified for this model.');
   if(media&&!model.vision)fail(400,'unsupported_parameter','Vision is not verified for this model.');
   const input=conservativeInput(body,model,maximum,media);
   if(maximum>model.max_output)fail(400,'invalid_request_error','Invalid maximum output token count.');
   if(input+maximum>model.max_context)fail(400,'context_length_exceeded','Request exceeds the conservative context budget.');
   model.auto_input=input;candidates=[model];
  }

  const requestId=req.requestId||id(),release=await concurrency(key.user_id,requestId,automatic?2:(candidates[0].premium?2:10));
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),120000);
  let started=false,lastError=null;
  res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
   candidateLoop:for(let index=0;index<candidates.length;index++){
    const model=candidates[index],attemptId=automatic?id():requestId,attemptStart=Date.now();
    let reserved=false,sent=false,providerId=null,usage=null;
    try{
     const input=model.auto_input??conservativeInput(body,model,maximum,media),maxMicro=maximumCost(model,input,maximum),weighted=ceilProduct(input+maximum,model.ratio);
     await reserve(key.user_id,key.id,model,attemptId,maxMicro,weighted);reserved=true;
     await redis('SET','reservation:'+attemptId,String(weighted),'EX',600);
     const providers=await providersFor(model);
     if(!providers.length)fail(503,'provider_unavailable','No verified upstream provider is configured.');
     const outgoing=upstreamBody(body,model,maximum);
     let response,lastStatus=503;
     for(const provider of providers){
      providerId=provider.id;
      try{response=await fetch(provider.base_url.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+decrypt(provider.encrypted_key),'Content-Type':'application/json','X-Request-Id':requestId},body:JSON.stringify(outgoing),redirect:'error',signal:controller.signal});}
      catch(error){if(controller.signal.aborted)throw error;lastStatus=502;response=null;sent=false;continue;}
      if(response.ok){sent=true;break;}
      lastStatus=response.status;sent=false;await response.body?.cancel();
      if(retryableProviderFailure(response.status))continue;
      fail(502,'upstream_error','The upstream rejected this request.');
     }
     if(!response?.ok){
      if(automatic&&index<candidates.length-1){
       await settle(attemptId,zeroUsage,{status:lastStatus,providerId,latency:Date.now()-attemptStart,errorCode:'auto_fallback'});reserved=false;lastError=Object.assign(new Error('A routed model was unavailable.'),{status:503,code:'provider_unavailable'});continue candidateLoop;
      }
      fail(503,'provider_unavailable','All configured providers rejected the request.');
     }
     exposeSelection(res,requestId,model,strategy,index);
     if(!outgoing.stream){
      const data=await response.json();if(data.error)fail(502,'upstream_error','The provider could not complete this request.');usage=data.usage||null;
      await settle(attemptId,usage,{providerId,latency:Date.now()-attemptStart});reserved=false;
      return res.json({...data,model:model.id});
     }
     res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();started=true;
     let buffer='',bytes=0,done=false;const decoder=new TextDecoder();
     for await(const chunk of response.body){
      bytes+=chunk.length;if(bytes>32*1024*1024)throw new Error('Upstream response exceeds limit');buffer+=decoder.decode(chunk,{stream:true});let boundary;
      while((boundary=/\r?\n\r?\n/.exec(buffer))){
       const frame=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
       const line=frame.split(/\r?\n/).filter(value=>value.startsWith('data:')).map(value=>value.slice(5).trimStart()).join('\n');
       if(line==='[DONE]'){done=true;continue;}
       if(line){const data=JSON.parse(line);if(data.usage)usage=data.usage;if(data.error)throw new Error('Upstream streaming error');if(data.model)data.model=model.id;res.write('data: '+JSON.stringify(data)+'\n\n');}
      }
     }
     await settle(attemptId,done?usage:null,{providerId,latency:Date.now()-attemptStart});reserved=false;
     if(!done||!usage)res.write('data: '+JSON.stringify({error:{message:'Usage reconciliation is pending.',type:'upstream_usage_missing',code:'upstream_usage_missing'}})+'\n\n');
     res.end('data: [DONE]\n\n');return;
    }catch(error){
     if(reserved)await settle(attemptId,sent?null:zeroUsage,{status:error.status||502,providerId,latency:Date.now()-attemptStart,errorCode:error.code||'upstream_failure'});
     if(automatic&&!sent&&!started&&index<candidates.length-1&&['insufficient_balance','provider_unavailable','model_not_found'].includes(error.code)){lastError=error;continue;}
     if(started){if(!res.destroyed)res.end('data: '+JSON.stringify({error:{message:'The upstream stream was interrupted.',type:'upstream_error',code:'upstream_error'}})+'\n\ndata: [DONE]\n\n');return;}
     throw error;
    }finally{await redis('DEL','reservation:'+attemptId).catch(()=>{});}
   }
   throw lastError||Object.assign(new Error('No compatible routed model completed the request.'),{status:503,code:'auto_model_unavailable'});
  }finally{clearTimeout(timeout);await release().catch(()=>{});}
 });

 app.post('/v1/messages',(req,res)=>res.status(501).json({error:{type:'not_implemented',message:'Native Anthropic compatibility is not yet verified. Use /v1/chat/completions.',code:'not_implemented'}}));
}
