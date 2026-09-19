import {initialize,q,pool} from './db.mjs';
import {createHash} from 'node:crypto';
// Explicit operator diagnostic. Sends small synthetic prompts only, stores billing metadata only.
const run='provider.live-check.v2';
try {
 await initialize();
 if(!process.env.UPSTREAM_API_KEY) throw new Error('key_missing');
 if((await q('SELECT id FROM audit WHERE action=$1 LIMIT 1',[run])).rowCount){console.log('Live provider checks already recorded.');}
 else {
  const base=(process.env.UPSTREAM_BASE_URL||'https://api.relaymodels.com/v1').replace(/\/$/,'');
  const headers={Authorization:'Bearer '+process.env.UPSTREAM_API_KEY,'Content-Type':'application/json'};
  const catalog=await fetch(base+'/models',{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!catalog.ok)throw new Error('catalogue_http_'+catalog.status);
  const {data}=await catalog.json();
  if(!Array.isArray(data))throw new Error('catalogue_invalid');
  const ids=data.map(m=>m.id).filter(x=>typeof x==='string');
  console.log('UPSTREAM_MODEL_IDS '+JSON.stringify(ids));
  console.log('UPSTREAM_MODEL_FIELDS '+JSON.stringify(Object.keys(data[0]||{})));
  const checks=[];
  async function check(label,body){
   if(!ids.includes(body.model)){checks.push({label,ok:false,error:'model_not_listed'});return;}
   const response=await fetch(base+'/chat/completions',{method:'POST',headers,body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(90000)});
   if(!response.ok){checks.push({label,ok:false,status:response.status});return;}
   let usage,ok=false;
   if(body.stream){const s=await response.text();let done=false,delta=false;for(const line of s.split('\n'))if(line.startsWith('data:')){const raw=line.slice(5).trim();if(raw==='[DONE]'){done=true;continue;}if(!raw)continue;const v=JSON.parse(raw);if(v.usage)usage=v.usage;if(v.choices?.some(c=>c.delta?.content))delta=true;}ok=done&&delta;}
   else {const v=await response.json();usage=v.usage;if(label==='tools'){const f=v.choices?.[0]?.message?.tool_calls?.[0]?.function;ok=f?.name==='verification_echo'&&JSON.parse(f.arguments)?.value==='ok';}else if(label==='json'){try{ok=JSON.parse(v.choices?.[0]?.message?.content||'').ok===true}catch{}}else ok=!!v.choices?.[0]?.message?.content;}
   ok=ok&&Number.isSafeInteger(usage?.prompt_tokens)&&Number.isSafeInteger(usage?.completion_tokens);
   checks.push({label,model:body.model,ok,usage});
  }
  const model='gpt-5.6-sol',common={model,max_tokens:512,messages:[{role:'user',content:'Reply with the single word OK.'}]};
  await check('nonstream',common);
  await check('model-switch',{...common,model:'claude-haiku-4-5'});
  await check('stream',{...common,stream:true,stream_options:{include_usage:true}});
  await check('tools',{...common,messages:[{role:'user',content:'Call verification_echo with value ok.'}],tools:[{type:'function',function:{name:'verification_echo',description:'Echo a verification value. No external action.',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}}],tool_choice:{type:'function',function:{name:'verification_echo'}}});
  await check('json',{...common,messages:[{role:'user',content:'Return JSON with ok true.'}],response_format:{type:'json_object'}});
  await q('INSERT INTO audit(actor,action,target,details) VALUES(NULL,$1,$2,$3)',[run,'RelayModels',{checks,catalogueCount:ids.length,keyFingerprint:createHash('sha256').update(process.env.UPSTREAM_API_KEY).digest('hex').slice(0,12)}]);
  for(const c of checks)console.log('LIVE_CHECK '+JSON.stringify(c));
 }
}catch(e){console.log('LIVE_CHECK_ERROR '+(String(e.message).match(/^[a-z_0-9]+$/)?.[0]||'verification_failed'));}
finally{if(pool)await pool.end()}
