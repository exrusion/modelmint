import {initialize,q,tx,pool} from './db.mjs';
import {JsonRpcProvider,isAddress} from 'ethers';
import {solRpc,checkSolNetwork,solAddress} from './solana.mjs';
// Owner-authorized catalogue expansion. Never enables a model until a live chat probe succeeds.
const action='launch.model-expansion.v2';
const cursorExtras=[
 ['k2.7-code-cursor','Kimi K2.7 Code (Cursor)','Moonshot',1.5],['glm-5.3-cursor','GLM 5.3 (Cursor)','Z.ai',1.9],['qwen3.8-max-cursor','Qwen 3.8 Max (Cursor)','Qwen',.3],
 ['grok-4.5-cursor','Grok 4.5 (Cursor)','xAI',.8],['composer-2.5-fast-cursor','Composer 2.5 Fast (Cursor)','Cursor',.5],['gpt-5.5-cursor','GPT-5.5 (Cursor)','OpenAI',3],
 ['k3-cursor','Kimi K3 (Cursor)','Moonshot',5.5],['grok-4.6-cursor','Grok 4.6 (Cursor)','xAI',.8],['deepseek-v4-pro-cursor','DeepSeek V4 Pro (Cursor)','DeepSeek',.6],
 ['opus-4-8-cursor','Claude Opus 4.8 (Cursor)','Anthropic',4],['sonnet-5-cursor','Claude Sonnet 5 (Cursor)','Anthropic',2],['gpt-5.6-sol-cursor','GPT-5.6 Sol (Cursor)','OpenAI',3],
 ['glm-5.2-cursor','GLM 5.2 (Cursor)','Z.ai',1.9],['muse-spark-1.2-cursor','Muse Spark 1.2 (Cursor)','Muse',.05],['gpt-5.6-luna-cursor','GPT-5.6 Luna (Cursor)','OpenAI',.22],
 ['glm-5-turbo-cursor','GLM 5 Turbo (Cursor)','Z.ai',1.38],['minimax-m3-cursor','MiniMax M3 (Cursor)','MiniMax',.45],['nemotron-3.5-lightning-cursor','Nemotron 3.5 Lightning (Cursor)','NVIDIA',.05],
 ['opus-5-cursor','Claude Opus 5 (Cursor)','Anthropic',4],['mimo-v2.5-pro-cursor','MiMo V2.5 Pro (Cursor)','MiMo',.3],['opus-4-6-cursor','Claude Opus 4.6 (Cursor)','Anthropic',4],
 ['glm-5.3-flash-cursor','GLM 5.3 Flash (Cursor)','Z.ai',.6],['qwen3.7-plus-cursor','Qwen 3.7 Plus (Cursor)','Qwen',.1],['qwen3.7-max-cursor','Qwen 3.7 Max (Cursor)','Qwen',.2],
 ['nemotron-3-ultra-cursor','Nemotron 3 Ultra (Cursor)','NVIDIA',.05],['mimo-v2.5-cursor','MiMo V2.5 (Cursor)','MiMo',.05],['gpt-5.4-mini-cursor','GPT-5.4 Mini (Cursor)','OpenAI',.8],
 ['opus-4-7-cursor','Claude Opus 4.7 (Cursor)','Anthropic',4],['gpt-5.6-terra-cursor','GPT-5.6 Terra (Cursor)','OpenAI',1.5],['gpt-5.4-cursor','GPT-5.4 (Cursor)','OpenAI',1.5],
 ['deepseek-v4-flash-cursor','DeepSeek V4 Flash (Cursor)','DeepSeek',.1],['sonnet-4-6-cursor','Claude Sonnet 4.6 (Cursor)','Anthropic',2]
];
const extra=[
 ['glm-5.2','GLM 5.2','Z.ai',1.9],['claude-fable-5-1','Claude Fable 5.1','Anthropic',8],['claude-fable-5','Claude Fable 5','Anthropic',8],
 ['claude-opus-5','Claude Opus 5','Anthropic',4],['claude-opus-4-8','Claude Opus 4.8','Anthropic',4],['claude-opus-4-7','Claude Opus 4.7','Anthropic',4],
 ['claude-opus-4-6','Claude Opus 4.6','Anthropic',4],...['3.8','3.7','3.6','3.5'].map(v=>['gemini-'+v+'-flash','Gemini '+v+' Flash','Google',1]),
 ['ox-alpha','OX Alpha','Relay',10],...cursorExtras
];
try{
await initialize();
if((await q('SELECT id FROM audit WHERE action=$1',[action])).rowCount){console.log('Model catalogue expansion already applied.');}
else{
 const headers={Authorization:'Bearer '+process.env.UPSTREAM_API_KEY,'Content-Type':'application/json'};
 const base=(process.env.UPSTREAM_BASE_URL||'https://api.relaymodels.com/v1').replace(/\/$/,'');
 const response=await fetch(base+'/models',{headers,redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('catalogue_unavailable');const catalogue=await response.json();if(!Array.isArray(catalogue.data))throw Error('invalid_catalogue');const ids=new Set(catalogue.data.map(x=>x.id));
 const models=(await q('SELECT * FROM models')).rows;
 const aliases={'qwen-3.7-plus':'qwen3.7-plus','qwen-3.7-max':'qwen3.7-max','qwen-3.8-max':'qwen3.8-max','claude-haiku-4.5':'claude-haiku-4-5','claude-sonnet-4.6':'claude-sonnet-4-6','claude-fable':'claude-fable-5','claude-opus':'claude-opus-4-8','gemini-flash':'gemini-3.8-flash'};
 for(const [id,name,family,ratio] of extra)if(!models.some(m=>m.id===id))models.push({id,name,family,ratio,premium:ratio>=3});
 const unique=[...new Set(models.map(m=>aliases[m.id]||m.id))].filter(id=>ids.has(id));const results=new Map();let position=0;
 async function worker(){while(position<unique.length){const model=unique[position++];let result={ok:false};try{const r=await fetch(base+'/chat/completions',{method:'POST',headers,redirect:'error',signal:AbortSignal.timeout(45000),body:JSON.stringify({model,max_completion_tokens:64,messages:[{role:'user',content:'Reply with OK.'}]})});result.status=r.status;if(r.ok){const v=await r.json();const u=v.usage;result.ok=!!v.choices?.[0]?.message&&Number.isSafeInteger(u?.prompt_tokens)&&Number.isSafeInteger(u?.completion_tokens)&&u.prompt_tokens>=0&&u.completion_tokens>=0;result.tokens=result.ok?u.prompt_tokens+u.completion_tokens:0;}}catch{result.error='request_failed';}results.set(model,result);console.log('MODEL_CHECK '+JSON.stringify({model,...result}));}}
 await Promise.all(Array.from({length:6},worker));
 let walletReady=false;
 if(process.env.SOLANA_RPC_URL&&solAddress(process.env.SOLANA_TREASURY_ADDRESS)){try{await checkSolNetwork(solRpc());walletReady=true;}catch{}}
 for(const [chain,env] of [[1,'ETHEREUM_RPC_URL'],[4663,'ROBINHOOD_RPC_URL']])if(process.env[env]&&isAddress(process.env.PAYMENT_TREASURY_ADDRESS||'')){const p=new JsonRpcProvider(process.env[env]);try{const n=await Promise.race([p.getNetwork(),new Promise((_,reject)=>setTimeout(()=>reject(Error('rpc_timeout')),15000))]);if(Number(n.chainId)===chain){walletReady=true;console.log('PAYMENT_NETWORK_VERIFIED '+chain);}}catch{console.log('PAYMENT_NETWORK_UNAVAILABLE '+chain);}finally{p.destroy();}}
 if(!walletReady||!process.env.X_CLIENT_ID||!process.env.X_CLIENT_SECRET)throw Error('checkout_configuration_incomplete');
 if(![...results.values()].some(r=>r.ok))throw Error('no_available_models');
 await tx(async c=>{
 const s=(await c.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data;
 if((await c.query('SELECT id FROM audit WHERE action=$1',[action])).rowCount)return;
 // The latest supplier dashboard reports a rounded 2,049M remaining. Keep a 1M reconciliation buffer.
 if(BigInt(s.inventory||0)===0n)s.inventory='2048000000';
 s.baseTokensPerDollar=1000000;s.inventoryCostKnown=false;s.purchasing=true;
 for(const m of models){const upstream=aliases[m.id]||m.id;const checked=results.get(upstream);const rate=String(m.ratio);const verified=!!checked?.ok;const advanced=upstream==='gpt-5.6-sol'&&verified;await c.query('INSERT INTO models(id,name,family,upstream_id,ratio,premium) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[m.id,m.name,m.family,upstream,rate,Number(rate)>=3]);await c.query('UPDATE models SET upstream_id=$2,input_rate=$3,output_rate=$3,cached_rate=$3,reasoning_rate=$3,verified=$4,enabled=$4,tools=$5,json_format=$5 WHERE id=$1',[m.id,upstream,rate,verified,advanced]);}
 await c.query('UPDATE settings SET data=$1 WHERE id=1',[s]);
 await c.query('INSERT INTO audit(action,target,details) VALUES($1,$2,$3)',[action,'platform',{offer:'Pay $10, receive $20 usage credit',baseTokensPerCreditDollar:1000000,inventorySource:'Owner-supplied supplier dashboard, 2049M rounded remaining; 1M buffer retained',supplierCost:'undisclosed; not required',checks:Object.fromEntries(results)}]);
 });
 console.log('CHECKOUT_OPEN '+JSON.stringify({verifiedModels:[...results.values()].filter(x=>x.ok).length,baseTokensPerCreditDollar:1000000,creditMultiplier:2}));
}
}catch(e){console.log('CHECKOUT_SETUP_FAILED '+(/^[a-z_]+$/.test(e.message)?e.message:'configuration_error'));process.exitCode=1;}
finally{if(pool)await pool.end();}
