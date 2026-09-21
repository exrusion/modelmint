import {q,tx,encrypt,pool,initialize} from './db.mjs';

export const OPENROUTER_PROVIDER_ID='00000000-0000-4000-8000-000000000002';
const BASE='https://openrouter.ai/api/v1';
const blocked=/embed|moderation|image|audio|tts|realtime|search|guard/i;
const decimal=value=>{const n=Number(value);return Number.isFinite(n)&&n>=0?n:null;};
const rate=value=>Math.max(.01,(decimal(value)||0)*1_000_000*2.2).toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
const official=value=>((decimal(value)||0)*1_000_000).toFixed(8).replace(/0+$/,'').replace(/\.$/,'');
const family=id=>{const owner=String(id).split('/')[0].toLowerCase();return ({openai:'OpenAI',anthropic:'Anthropic',google:'Google',xai:'xAI','deepseek':'DeepSeek','qwen':'Qwen','meta-llama':'Meta','mistralai':'Mistral','cohere':'Cohere','perplexity':'Perplexity','moonshotai':'Moonshot','minimax':'MiniMax','nvidia':'NVIDIA'}[owner]||owner.replace(/(^|-)([a-z])/g,(_,dash,c)=>dash+c.toUpperCase()));};
export function normalizeOpenRouterModel(model){
 if(!model||typeof model.id!=='string'||blocked.test(model.id)||!Number.isInteger(model.context_length)||model.context_length<1024)return null;
 const modalities=model.architecture?.output_modalities||[];if(modalities.length&&!modalities.includes('text'))return null;
 const prompt=decimal(model.pricing?.prompt),completion=decimal(model.pricing?.completion);if(prompt===null||completion===null)return null;
 const parameters=model.supported_parameters||[],vision=(model.architecture?.input_modalities||[]).includes('image'),tools=parameters.includes('tools')||parameters.includes('tool_choice'),json=parameters.includes('response_format')||parameters.includes('structured_outputs');
 const outputRate=Number(rate(model.pricing.completion)),ratio=Math.max(.05,Math.min(10,outputRate/2.2||.05));
 return {id:model.id,name:String(model.name||model.id).slice(0,160),family:family(model.id),upstream:model.id,inputRate:rate(model.pricing.prompt),outputRate:rate(model.pricing.completion),cachedRate:rate(model.pricing.input_cache_read??model.pricing.prompt),reasoningRate:rate(model.pricing.completion),officialInput:official(model.pricing.prompt),officialOutput:official(model.pricing.completion),ratio:String(Number(ratio.toFixed(4))),context:Math.min(model.context_length,2_000_000),output:Math.min(Number(model.top_provider?.max_completion_tokens)||16384,model.context_length,262144),vision,tools,json,premium:outputRate>=6,quality:Math.max(45,Math.min(96,Math.round(62+Math.log10(Math.max(outputRate,.01)+1)*22)))};
}
async function catalogue(key){const response=await fetch(BASE+'/models',{headers:key?{Authorization:'Bearer '+key}:{},redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('openrouter_catalogue_http_'+response.status);const body=await response.json();if(!Array.isArray(body.data))throw Error('openrouter_catalogue_invalid');return body.data.map(normalizeOpenRouterModel).filter(Boolean);}
async function probe(key,model){try{const response=await fetch(BASE+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','HTTP-Referer':process.env.APP_URL||'https://routers.markets','X-Title':'Routers Markets model verification'},body:JSON.stringify({model:model.upstream,messages:[{role:'user',content:'Reply OK.'}],max_tokens:4,temperature:0}),redirect:'error',signal:AbortSignal.timeout(45000)});if(!response.ok){await response.body?.cancel();return false;}const body=await response.json(),usage=body.usage;return Boolean(body.choices?.[0]?.message)&&Number.isSafeInteger(usage?.prompt_tokens)&&Number.isSafeInteger(usage?.completion_tokens);}catch{return false;}}
export async function syncOpenRouterCatalogue(){
 const key=process.env.OPENROUTER_API_KEY||'',models=await catalogue(key);
 await tx(async c=>{for(const model of models.slice(0,400))await c.query(`INSERT INTO models(id,name,family,upstream_id,ratio,input_rate,output_rate,cached_rate,reasoning_rate,official_input_rate,official_output_rate,max_context,max_output,promo,vision,tools,json_format,premium,provider_ids,auto_enabled,auto_quality)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14,$15,$16,$17,ARRAY[$18::uuid],true,$19)
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,family=excluded.family,input_rate=excluded.input_rate,output_rate=excluded.output_rate,cached_rate=excluded.cached_rate,reasoning_rate=excluded.reasoning_rate,official_input_rate=excluded.official_input_rate,official_output_rate=excluded.official_output_rate,max_context=excluded.max_context,max_output=excluded.max_output,vision=excluded.vision,tools=excluded.tools,json_format=excluded.json_format,premium=excluded.premium,auto_quality=excluded.auto_quality
 WHERE models.provider_ids=ARRAY[$18::uuid]`,[model.id,model.name,model.family,model.upstream,model.ratio,model.inputRate,model.outputRate,model.cachedRate,model.reasoningRate,model.officialInput,model.officialOutput,model.context,model.output,model.vision,model.tools,model.json,model.premium,OPENROUTER_PROVIDER_ID,model.quality]);});
 if(!key)return {discovered:models.length,verified:0,configured:false};
 await q('UPDATE providers SET verified_at=now(),enabled=true WHERE id=$1',[OPENROUTER_PROVIDER_ID]);
 const live=Number((await q('SELECT count(*) n FROM models WHERE enabled AND verified AND $1=ANY(provider_ids)',[OPENROUTER_PROVIDER_ID])).rows[0].n);if(live>=100)return {discovered:models.length,verified:live,configured:true};
 const limit=Math.max(100,Math.min(180,Number(process.env.OPENROUTER_PROBE_LIMIT)||150)),candidates=models.slice(0,limit),verified=[];let cursor=0;
 async function worker(){while(cursor<candidates.length){const model=candidates[cursor++];if(await probe(key,model)){verified.push(model.id);console.log('OPENROUTER_MODEL_VERIFIED '+model.id);}}}
 await Promise.all(Array.from({length:10},worker));
 if(verified.length)await q('UPDATE models SET enabled=true,verified=true WHERE id=ANY($1) AND $2=ANY(provider_ids)',[verified,OPENROUTER_PROVIDER_ID]);
 const total=Number((await q('SELECT count(*) n FROM models WHERE enabled AND verified')).rows[0].n);if(total>=100)await q(`INSERT INTO product_updates(id,title,description,status,eta,link,position,published) VALUES('fc2b870e-05d4-4baf-8d12-210164800004','100+ verified AI models are live','Use one Routers API key and one OpenAI-compatible endpoint across more than 100 live models. Exact model requests stay exact, while routers/auto can route and safely fall back before output begins.','live','Live now','/models',0,true) ON CONFLICT(id) DO UPDATE SET description=excluded.description,status='live',published=true,updated_at=now()`);
 await q('INSERT INTO audit(action,target,details) VALUES($1,$2,$3)',['openrouter.catalogue.synced','OpenRouter',{discovered:models.length,verified:verified.length,totalActive:total}]);return {discovered:models.length,verified:verified.length,totalActive:total,configured:true};
}

if(process.argv[1]?.endsWith('/openrouter-catalogue.mjs')){try{await initialize();console.log('OPENROUTER_SYNC '+JSON.stringify(await syncOpenRouterCatalogue()));}catch(error){console.log('OPENROUTER_SYNC_SKIPPED '+String(error?.message||error).replace(/[^a-zA-Z0-9_-]/g,'_'));}finally{if(pool)await pool.end();}}
