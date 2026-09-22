export const AUTO_MODEL_ID='routers/auto';
export const AUTO_STRATEGIES=['balanced','cheapest','fastest','best'];
export const ROUTING_PROFILES={
 'routers/auto':{strategy:'balanced',label:'Auto'},
 'routers/balanced':{strategy:'balanced',label:'Balanced'},
 'routers/cheap':{strategy:'cheapest',label:'Cheap'},
 'routers/fast':{strategy:'fastest',label:'Fast'},
 'routers/best':{strategy:'best',label:'Best'},
 'routers/reasoning':{strategy:'best',label:'Reasoning',kind:'reasoning'},
 'routers/code':{strategy:'best',label:'Code',kind:'code'},
 'routers/vision':{strategy:'best',label:'Vision',kind:'vision'}
};
export const ROUTING_PROFILE_IDS=Object.keys(ROUTING_PROFILES);

export function routingProfile(value){return ROUTING_PROFILES[String(value||'')]||null;}

export function supportsRoutingProfile(model,profile){
 const kind=profile?.kind;if(!kind)return true;
 if(kind==='vision')return Boolean(model.vision);
 const identity=String(model.id||'')+' '+String(model.name||'')+' '+String(model.family||'');
 if(kind==='code')return /code|coder|codestral|devstral|starcoder|deepseek|qwen/i.test(identity);
 if(kind==='reasoning')return /reason|thinking|deepseek|\br1\b|\bo[134](?:\b|-)|qwq|gpt-5|gemini.*pro|claude.*(?:sonnet|opus)/i.test(identity);
 return true;
}

const finite=value=>Number.isFinite(Number(value))?Number(value):0;
const compareId=(a,b)=>String(a.id).localeCompare(String(b.id));

export function parseAutoStrategy(value){
 const strategy=String(value||'balanced').toLowerCase();
 if(!AUTO_STRATEGIES.includes(strategy))throw Object.assign(new Error('routing_strategy must be balanced, cheapest, fastest or best.'),{status:400,code:'invalid_routing_strategy'});
 return strategy;
}

export function supportsAutoRequest(model,{tools=false,vision=false,json=false,maxOutput=1,input=0}={}){
 return model.enabled!==false&&model.verified!==false&&model.auto_enabled!==false&&
  (!tools||model.tools)&&(!vision||model.vision)&&(!json||model.json_format)&&
  finite(model.max_output)>=maxOutput&&finite(model.max_context)>=input+maxOutput;
}

function normalize(value,min,max,fallback=.5){
 if(!Number.isFinite(value))return fallback;
 if(max<=min)return 1;
 return (value-min)/(max-min);
}

export function rankAutoModels(models,{strategy='balanced'}={}){
 const mode=parseAutoStrategy(strategy),prepared=models.map(model=>({
  ...model,
  auto_estimated_micro:Math.max(0,finite(model.auto_estimated_micro)),
  auto_quality:Math.max(0,Math.min(100,finite(model.auto_quality)||50)),
  auto_latency:finite(model.auto_samples)>=3&&finite(model.auto_latency)>0?finite(model.auto_latency):Number.POSITIVE_INFINITY
 }));
 const costs=prepared.map(x=>x.auto_estimated_micro),knownLatency=prepared.map(x=>x.auto_latency).filter(Number.isFinite),qualities=prepared.map(x=>x.auto_quality);
 const minCost=costs.length?Math.min(...costs):0,maxCost=costs.length?Math.max(...costs):0,minLatency=knownLatency.length?Math.min(...knownLatency):0,maxLatency=knownLatency.length?Math.max(...knownLatency):0,minQuality=qualities.length?Math.min(...qualities):0,maxQuality=qualities.length?Math.max(...qualities):0;
 for(const model of prepared){
  const costScore=1-normalize(model.auto_estimated_micro,minCost,maxCost),speedScore=Number.isFinite(model.auto_latency)?1-normalize(model.auto_latency,minLatency,maxLatency):.35,qualityScore=normalize(model.auto_quality,minQuality,maxQuality);
  model.auto_score=qualityScore*.40+costScore*.35+speedScore*.25;
 }
 return prepared.sort((a,b)=>{
  if(mode==='cheapest')return a.auto_estimated_micro-b.auto_estimated_micro||b.auto_quality-a.auto_quality||compareId(a,b);
  if(mode==='fastest')return a.auto_latency-b.auto_latency||a.auto_estimated_micro-b.auto_estimated_micro||b.auto_quality-a.auto_quality||compareId(a,b);
  if(mode==='best')return b.auto_quality-a.auto_quality||a.auto_estimated_micro-b.auto_estimated_micro||a.auto_latency-b.auto_latency||compareId(a,b);
  return b.auto_score-a.auto_score||b.auto_quality-a.auto_quality||a.auto_estimated_micro-b.auto_estimated_micro||compareId(a,b);
 });
}
