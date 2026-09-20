// Isolated database schema. These fixtures never appear in customer accounts.
import pg from 'pg';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required for integration checks');
const root=new pg.Pool({connectionString:process.env.DATABASE_URL}),schema='verify_'+randomBytes(8).toString('hex');
await root.query('CREATE SCHEMA '+schema);
const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=url.toString();process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
const {q,initialize,pool,hash,encrypt}=await import('../server/db.mjs');
const {reserve,settle,backedCredit}=await import('../server/accounting.mjs');
const {reward}=await import('../server/auth.mjs');
const {rateLimit,concurrency,redis}=await import('../server/redis.mjs');
let server,upstream;
try{
await initialize();
const uid=randomUUID(),kid=randomUUID();
await q("UPDATE settings SET data=data || '{\"inventory\":10000000,\"baseTokensPerDollar\":100000,\"inventoryCostMicro\":0.001}'::jsonb");
await q("INSERT INTO users(id,x_id,username,purchased_micro,base_tokens) VALUES($1,$2,'integration-fixture',15,15)",[uid,uid]);
await q("INSERT INTO api_keys(id,user_id,name,hash,prefix) VALUES($1,$2,'test',$3,'test')",[kid,uid,hash('test-key')]);
const sharedIp=hash('shared-network'),sharedDevice=hash('shared-browser'),rewardUsers=[randomUUID(),randomUUID()];
for(const [index,rewardUser] of rewardUsers.entries())await q("INSERT INTO users(id,x_id,username,created_at,x_created_at,ip_hash,device_hash) VALUES($1,$2,$3,now()-interval '1 day',now()-interval '30 days',$4,$5)",[rewardUser,'reward-x-'+index,'reward-user-'+index,sharedIp,sharedDevice]);
assert.equal(await reward(rewardUsers[0]),true);assert.equal(await reward(rewardUsers[1]),true,'a distinct X account may claim from a shared browser and network');assert.equal(await reward(rewardUsers[0]),false,'the same X account cannot claim twice');
for(const rewardUser of rewardUsers){const rewarded=(await q('SELECT promo_tokens,promo_micro FROM users WHERE id=$1',[rewardUser])).rows[0];assert.equal(rewarded.promo_tokens,'1000000');assert.equal(rewarded.promo_micro,'1000000');}
console.log('PASS one signup reward per X identity, including shared devices and delayed repair');
const holderSettings=(await q('SELECT data FROM settings WHERE id=1')).rows[0].data;assert.equal(holderSettings.holderRewardsEnabled,true);assert.equal(holderSettings.holderRewardHoldSeconds,'43200');assert.equal(holderSettings.holderRewardMinTokens,'2000000');assert.equal(holderSettings.holderRewardBaseGrant,'500000');assert.equal(holderSettings.holderRewardBonusGrant,'5000000');
const holderWallet='0x1111111111111111111111111111111111111111';await q('INSERT INTO holder_wallet_links(user_id,wallet) VALUES($1,$2)',[rewardUsers[0],holderWallet]);await assert.rejects(q('INSERT INTO holder_wallet_links(user_id,wallet) VALUES($1,$2)',[rewardUsers[1],holderWallet]),error=>error.code==='23505');
await q('INSERT INTO holder_reward_claims(id,user_id,wallet,balance_wei,reward_tokens,reward_micro,snapshot_block,holding_since) VALUES($1,$2,$3,$4,2000000,2000000,67482869,now()-interval \'12 hours\')',[randomUUID(),rewardUsers[0],holderWallet,'1000000000000000000000000']);await assert.rejects(q('INSERT INTO holder_reward_claims(id,user_id,wallet,balance_wei,reward_tokens,reward_micro,snapshot_block,holding_since) VALUES($1,$2,$3,$4,2000000,2000000,67482870,now()-interval \'12 hours\')',[randomUUID(),rewardUsers[1],holderWallet,'1000000000000000000000000']),error=>error.code==='23505');
console.log('PASS holder reward defaults and one-claim-per-wallet constraints');
await q("UPDATE models SET enabled=true,verified=true,input_rate=1,output_rate=1,cached_rate=1,reasoning_rate=1,ratio=1 WHERE id='gpt-5.4-mini'");
const m=(await q("SELECT * FROM models WHERE id='gpt-5.4-mini'")).rows[0];
const ids=[randomUUID(),randomUUID()];const simultaneous=await Promise.allSettled(ids.map(r=>reserve(uid,kid,m,r,10n,10n)));
assert.equal(simultaneous.filter(r=>r.status==='fulfilled').length,1,'only one request can reserve the last balance');
const success=ids[simultaneous.findIndex(r=>r.status==='fulfilled')];await settle(success,{prompt_tokens:2,completion_tokens:3});await settle(success,{prompt_tokens:2,completion_tokens:3});
let u=(await q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];assert.equal(u.purchased_micro,'10');assert.equal(u.base_tokens,'10');
console.log('PASS concurrent reservation, exact reconciliation, idempotent settlement');
await q("UPDATE users SET promo_micro=3,promo_tokens=3,promo_expires=now()+interval '1 day' WHERE id=$1",[uid]);const promoModel={...m,promo:true};const pr=randomUUID();await reserve(uid,kid,promoModel,pr,8n,8n);await settle(pr,{prompt_tokens:3,completion_tokens:2});u=(await q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];assert.equal(u.promo_micro,'0');assert.equal(u.promo_tokens,'0');assert.equal(u.purchased_micro,'8');assert.equal(u.base_tokens,'8');console.log('PASS promotional credit consumed before purchased balance');
await q('UPDATE api_keys SET revoked=true WHERE id=$1',[kid]);await assert.rejects(reserve(uid,kid,m,randomUUID(),1n,1n),e=>e.code==='invalid_api_key');await q('UPDATE api_keys SET revoked=false WHERE id=$1',[kid]);
await q("UPDATE settings SET data=jsonb_set(data,'{globalDaily}','1')");await assert.rejects(reserve(uid,kid,m,randomUUID(),1n,1n),e=>e.code==='global_capacity_exhausted');await q("UPDATE settings SET data=jsonb_set(data,'{globalDaily}','100000000')");
const review=randomUUID();await reserve(uid,kid,m,review,5n,5n);await settle(review,null);u=(await q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];assert.equal(u.purchased_micro,'3');await settle(review,{prompt_tokens:0,completion_tokens:0});console.log('PASS revocation, global capacity and unresolved-usage reservation retention');
const adjust=async()=>{const client=await pool.connect();try{await client.query('BEGIN');await backedCredit(client,uid,1000n,1000n,'fixture-credit');await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}};await Promise.all([adjust(),adjust()]);u=(await q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];assert.equal(u.purchased_micro,'1008');assert.equal(u.base_tokens,'1008');console.log('PASS idempotent backed credit issuance');
if(process.env.REDIS_URL){const rk='integration:'+uid;await rateLimit(rk,1);await assert.rejects(rateLimit(rk,1),e=>e.code==='rate_limit_exceeded');const release=await concurrency(rk,'one',1);await assert.rejects(concurrency(rk,'two',1),e=>e.code==='concurrency_limit');await release();await redis('DEL','rate:'+rk,'concurrency:'+rk);console.log('PASS Redis request and concurrency limits');
const express=(await import('express')).default;const mock=express();mock.use(express.json());let received=null;mock.post('/chat/completions',(req,res)=>{received=req.body;if(req.body.stream){res.set('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({id:'fixture',choices:[{delta:{content:'fixture'}}]})+'\r');setTimeout(()=>res.end('\n\r\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:5,completion_tokens:3}})+'\r\n\r\ndata: [DONE]\r\n\r\n'),10);}else res.json({id:'fixture',choices:[{message:{role:'assistant',content:'fixture'}}],usage:{prompt_tokens:5,completion_tokens:3}});});upstream=await new Promise(resolve=>{const s=mock.listen(0,'127.0.0.1',()=>resolve(s))});
await q('DELETE FROM providers');await q("INSERT INTO providers(id,name,base_url,encrypted_key,verified_at) VALUES($1,'isolated-fixture',$2,$3,now())",[randomUUID(),'http://127.0.0.1:'+upstream.address().port,encrypt('fixture')]);await q('UPDATE users SET purchased_micro=100000,base_tokens=100000 WHERE id=$1',[uid]);await q("UPDATE models SET tools=true,json_format=true WHERE id=$1",[m.id]);const app=express();app.use(express.json());(await import('../server/gateway.mjs')).mountGateway(app);app.use((e,req,res,next)=>res.status(e.status||500).json({error:{code:e.code,message:e.message}}));server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});const endpoint='http://127.0.0.1:'+server.address().port;
const body={model:m.id,messages:[{role:'user',content:'fixture'}],max_completion_tokens:16,tools:[{type:'function',function:{name:'test_tool',parameters:{type:'object',properties:{}}}}]};const r=await fetch(endpoint+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-key','Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200,await r.text());assert.deepEqual(received.tools,body.tools);const stream=await fetch(endpoint+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-key','Content-Type':'application/json'},body:JSON.stringify({...body,stream:true})});assert.equal(stream.status,200);assert.match(await stream.text(),/\[DONE\]/);u=(await q('SELECT * FROM users WHERE id=$1',[uid])).rows[0];assert.equal(u.purchased_micro,'99984');assert.equal(u.base_tokens,'99984');console.log('PASS gateway non-streaming, SSE, tool passthrough and usage deduction with isolated fixture provider');
}
const solOrder=randomUUID(),solSig='CaseSensitiveSolanaSignature';
await q("INSERT INTO orders(id,user_id,chain_id,wallet,treasury,pay_usd,credit_micro,base_tokens,wei,quote_price,expires,tx_hash) VALUES($1,$2,0,'payer','treasury',5,10000000,100,'1234','100',now()+interval '10 minutes',$3)",[solOrder,uid,solSig]);
await assert.rejects(q("INSERT INTO orders(id,user_id,chain_id,wallet,treasury,pay_usd,credit_micro,base_tokens,wei,quote_price,expires,tx_hash) VALUES($1,$2,0,'payer','treasury',5,10000000,100,'1234','100',now()+interval '10 minutes',$3)",[randomUUID(),uid,solSig]),e=>e.code==='23505');
assert.equal((await q('SELECT tx_hash FROM orders WHERE id=$1',[solOrder])).rows[0].tx_hash,solSig);
console.log('PASS Solana signature case preservation and duplicate payment constraint');
console.log('ALL ISOLATED INTEGRATION CHECKS PASSED');
}finally{await new Promise(resolve=>server?server.close(resolve):resolve());await new Promise(resolve=>upstream?upstream.close(resolve):resolve());await pool.end();await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();}
