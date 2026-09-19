import {q,tx,fail} from './db.mjs';
export function integer(v){if(!Number.isSafeInteger(Number(v))||Number(v)<0)fail(400,'invalid_number','Expected a nonnegative safe integer.');return BigInt(v);}
export function ceilProduct(n,rate){const [whole,frac='']=String(rate).split('.');if(!/^\d+$/.test(whole)||!/^[0-9]*$/.test(frac))fail(503,'invalid_price','Model pricing is not configured.');const scale=10n**BigInt(frac.length),r=BigInt(whole+frac);return (BigInt(n)*r+scale-1n)/scale;}
export function promoEligible(m){return !!m.promo&&!/opus|astra|fable|kimi/i.test(m.id+' '+m.name);}
export function usageCost(usage,m){const input=integer(usage.prompt_tokens),output=integer(usage.completion_tokens),cached=integer(usage.prompt_tokens_details?.cached_tokens||0),reasoning=integer(usage.completion_tokens_details?.reasoning_tokens||0);if(cached>input||reasoning>output)fail(502,'invalid_usage','Upstream token details are inconsistent.');return {input:input-cached,cached,reasoning,output:output-reasoning,actual:input+output,weighted:ceilProduct(input+output,m.ratio),micro:ceilProduct(input-cached,m.input_rate)+ceilProduct(cached,m.cached_rate)+ceilProduct(output-reasoning,m.output_rate)+ceilProduct(reasoning,m.reasoning_rate)};}
export async function ledger(c,user,kind,delta,reference,metadata={}){await c.query('INSERT INTO ledgers(user_id,kind,delta,reference,metadata) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[user,kind,String(delta),reference,metadata]);}
export async function reserve(userId,keyId,m,requestId,maxMicro,maxWeighted){return tx(async c=>{
const settings=(await c.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data;
const currentModel=(await c.query('SELECT enabled,verified FROM models WHERE id=$1',[m.id])).rows[0];if(!currentModel?.enabled||!currentModel?.verified)fail(404,'model_not_found','This model is no longer enabled.');
if(settings.shutdown)fail(503,'circuit_breaker','The gateway is temporarily paused.');
const u=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
const k=(await c.query('SELECT * FROM api_keys WHERE id=$1 FOR UPDATE',[keyId])).rows[0];
if(!u||u.suspended||!k||k.revoked||(k.expires&&new Date(k.expires)<=new Date()))fail(401,'invalid_api_key','This API key is not active.');
if(k.allowed_models.length&&!k.allowed_models.includes(m.id))fail(403,'model_not_allowed','This key cannot access that model.');
await c.query('INSERT INTO daily_capacity(day) VALUES(CURRENT_DATE) ON CONFLICT DO NOTHING');
await c.query('INSERT INTO user_daily(user_id,day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING',[u.id]);
await c.query('INSERT INTO key_daily(key_id,day) VALUES($1,CURRENT_DATE) ON CONFLICT DO NOTHING',[k.id]);
const global=(await c.query('SELECT used FROM daily_capacity WHERE day=CURRENT_DATE')).rows[0];
const daily=(await c.query('SELECT * FROM user_daily WHERE user_id=$1 AND day=CURRENT_DATE',[u.id])).rows[0];
const kd=(await c.query('SELECT micro FROM key_daily WHERE key_id=$1 AND day=CURRENT_DATE',[k.id])).rows[0];
const month=(await c.query("SELECT COALESCE(sum(micro),0) micro FROM user_daily WHERE user_id=$1 AND day>=date_trunc('month',CURRENT_DATE)",[u.id])).rows[0];
const km=(await c.query("SELECT COALESCE(sum(micro),0) micro FROM key_daily WHERE key_id=$1 AND day>=date_trunc('month',CURRENT_DATE)",[k.id])).rows[0];
const userCap=BigInt(u.daily_limit||((Date.now()-new Date(u.created_at).getTime())<7*86400000?settings.newUserDaily:settings.userDaily));
if(BigInt(global.used)+maxWeighted>BigInt(settings.globalDaily)*9n/10n)fail(429,'global_capacity_exhausted','Daily platform capacity is currently exhausted.');
if(BigInt(daily.weighted)+maxWeighted>userCap)fail(429,'daily_limit_exceeded','Your daily token allowance is exhausted.');
if(u.monthly_limit_micro&&BigInt(month.micro)+maxMicro>BigInt(u.monthly_limit_micro))fail(402,'monthly_limit','Monthly spending limit reached.');
for(const [cap,spent,cost] of [[k.spending_cap,k.spent_micro,maxMicro],[k.token_cap,k.spent_tokens,maxWeighted],[k.daily_cap,kd.micro,maxMicro],[k.monthly_cap,km.micro,maxMicro]])if(cap!==null&&BigInt(spent)+cost>BigInt(cap))fail(402,'key_limit_exceeded','An API-key spending or token limit would be exceeded.');
const held=(await c.query("SELECT COALESCE(sum(max_weighted),0) n FROM reservations WHERE state IN ('reserved','review')")).rows[0];
if(BigInt(settings.inventory)<BigInt(held.n)+maxWeighted)fail(503,'inventory_exhausted','Provider inventory is insufficient for this request.');
const promoAllowed=promoEligible(m)&&u.promo_expires&&new Date(u.promo_expires)>new Date();
const pm=promoAllowed?(BigInt(u.promo_micro)<maxMicro?BigInt(u.promo_micro):maxMicro):0n;
const pt=promoAllowed?(BigInt(u.promo_tokens)<maxWeighted?BigInt(u.promo_tokens):maxWeighted):0n;
const bm=maxMicro-pm,bt=maxWeighted-pt;
if(BigInt(u.purchased_micro)<bm||BigInt(u.base_tokens)<bt)fail(402,'insufficient_balance','Insufficient dollar credit or base-token balance for the maximum request cost. Lower max_completion_tokens or add credit.');
await c.query('UPDATE users SET purchased_micro=purchased_micro-$2,promo_micro=promo_micro-$3,base_tokens=base_tokens-$4,promo_tokens=promo_tokens-$5 WHERE id=$1',[u.id,String(bm),String(pm),String(bt),String(pt)]);
await c.query('UPDATE api_keys SET spent_micro=spent_micro+$2,spent_tokens=spent_tokens+$3 WHERE id=$1',[k.id,String(maxMicro),String(maxWeighted)]);
await c.query('UPDATE daily_capacity SET used=used+$1 WHERE day=CURRENT_DATE',[String(maxWeighted)]);
await c.query('UPDATE user_daily SET weighted=weighted+$2,micro=micro+$3 WHERE user_id=$1 AND day=CURRENT_DATE',[u.id,String(maxWeighted),String(maxMicro)]);
await c.query('UPDATE key_daily SET micro=micro+$2 WHERE key_id=$1 AND day=CURRENT_DATE',[k.id,String(maxMicro)]);
await c.query('INSERT INTO reservations(id,user_id,key_id,model_id,purchased_micro,promo_micro,base_tokens,promo_tokens,max_micro,max_weighted,rates) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[requestId,u.id,k.id,m.id,String(bm),String(pm),String(bt),String(pt),String(maxMicro),String(maxWeighted),m]);
await ledger(c,u.id,'dollar',-bm,requestId+':reserve');await ledger(c,u.id,'promo-dollar',-pm,requestId+':reserve');await ledger(c,u.id,'raw-base',-bt,requestId+':reserve');await ledger(c,u.id,'promo-token',-pt,requestId+':reserve');await ledger(c,null,'capacity',maxWeighted,requestId+':reserve');return {promo:pm>0n};
});}
export async function settle(requestId,usage,{status=200,providerId=null,latency=0,errorCode=null}={}){return tx(async c=>{
const settings=(await c.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data;
const r=(await c.query('SELECT * FROM reservations WHERE id=$1 FOR UPDATE',[requestId])).rows[0];if(!r||!['reserved','review'].includes(r.state))return;
if(!usage){await c.query("UPDATE reservations SET state='review' WHERE id=$1",[requestId]);return;}
const actual=usageCost(usage,r.rates),mm=BigInt(r.max_micro),mw=BigInt(r.max_weighted);
if(actual.micro>mm||actual.weighted>mw){await c.query("UPDATE reservations SET state='review' WHERE id=$1",[requestId]);await c.query("UPDATE settings SET data=jsonb_set(data,'{shutdown}','true') WHERE id=1");return;}
const refundMicro=mm-actual.micro,refundTokens=mw-actual.weighted;
const purchasedRefund=refundMicro<BigInt(r.purchased_micro)?refundMicro:BigInt(r.purchased_micro),promoRefund=refundMicro-purchasedRefund;
const baseRefund=refundTokens<BigInt(r.base_tokens)?refundTokens:BigInt(r.base_tokens),promoTokenRefund=refundTokens-baseRefund;
await c.query('UPDATE users SET purchased_micro=purchased_micro+$2,promo_micro=promo_micro+$3,base_tokens=base_tokens+$4,promo_tokens=promo_tokens+$5 WHERE id=$1',[r.user_id,String(purchasedRefund),String(promoRefund),String(baseRefund),String(promoTokenRefund)]);
await c.query('UPDATE api_keys SET spent_micro=spent_micro-$2,spent_tokens=spent_tokens-$3 WHERE id=$1',[r.key_id,String(refundMicro),String(refundTokens)]);
await c.query('UPDATE daily_capacity SET used=used-$2 WHERE day=$1',[r.usage_day,String(refundTokens)]);
await c.query('UPDATE user_daily SET weighted=weighted-$3,micro=micro-$4 WHERE user_id=$1 AND day=$2',[r.user_id,r.usage_day,String(refundTokens),String(refundMicro)]);
await c.query('UPDATE key_daily SET micro=micro-$3 WHERE key_id=$1 AND day=$2',[r.key_id,r.usage_day,String(refundMicro)]);
const inventory=BigInt(settings.inventory)-actual.weighted;if(inventory<0n)fail(503,'inventory_invariant','Inventory reconciliation requires review.');settings.inventory=String(inventory);await c.query('UPDATE settings SET data=$1 WHERE id=1',[settings]);
await c.query("UPDATE reservations SET state='settled' WHERE id=$1",[requestId]);
await ledger(c,r.user_id,'dollar',purchasedRefund,requestId+':settle');await ledger(c,r.user_id,'promo-dollar',promoRefund,requestId+':settle');await ledger(c,r.user_id,'raw-base',baseRefund,requestId+':settle');await ledger(c,r.user_id,'promo-token',promoTokenRefund,requestId+':settle');await ledger(c,null,'weighted-inventory',-actual.weighted,requestId+':settle');await ledger(c,null,'capacity',-refundTokens,requestId+':settle');
await c.query('INSERT INTO requests(id,user_id,key_id,model_id,provider_id,status,input_tokens,cached_tokens,reasoning_tokens,output_tokens,actual_tokens,weighted_tokens,charged_micro,upstream_cost_micro,latency_ms,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING',[r.id,r.user_id,r.key_id,r.model_id,providerId,status,String(actual.input),String(actual.cached),String(actual.reasoning),String(actual.output),String(actual.actual),String(actual.weighted),String(actual.micro),String(ceilProduct(actual.weighted,settings.inventoryCostMicro||0)),Math.min(latency,2147483647),errorCode]);return actual;
});}
export const zeroUsage={prompt_tokens:0,completion_tokens:0};
export async function backedCredit(c,userId,micro,base,reference){const s=(await c.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data;
const liability=(await c.query('SELECT COALESCE(sum(base_tokens+promo_tokens),0) n FROM users')).rows[0];const reserved=(await c.query("SELECT COALESCE(sum(max_weighted),0) n FROM reservations WHERE state IN ('reserved','review')")).rows[0];const pending=(await c.query("SELECT COALESCE(sum(base_tokens),0) n FROM orders WHERE state='pending' AND id::text<>$1",[reference])).rows[0];
if(BigInt(liability.n)+BigInt(reserved.n)+BigInt(pending.n)+base>BigInt(s.inventory)*8n/10n)fail(409,'insufficient_backing','Insufficient uncommitted supplier inventory.');
const issued=await c.query("INSERT INTO ledgers(user_id,kind,delta,reference) VALUES($1,'dollar',$2,$3) ON CONFLICT DO NOTHING RETURNING id",[userId,String(micro),reference]);if(!issued.rowCount)return false;
await ledger(c,userId,'raw-base',base,reference);await c.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[userId,String(micro),String(base)]);return true;}
