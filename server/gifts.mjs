import {q,tx,id,secret,hash,fail} from './db.mjs';
import {integer,ledger} from './accounting.mjs';
import {user} from './auth.mjs';
import {rateLimit} from './redis.mjs';

const giftKinds=new Set(['x','email','link']);
const giftTokenPattern=/^[A-Za-z0-9_-]{32,100}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const appBase=()=>String(process.env.APP_URL||'').replace(/\/$/,'');

export function giftCreditForTokens(value,baseTokensPerDollar){
 const tokens=integer(value),perDollar=integer(baseTokensPerDollar);
 if(tokens<=0n||perDollar<=0n)fail(503,'gifts_unconfigured','Gift pricing is not configured yet.');
 return (tokens*1000000n+perDollar-1n)/perDollar;
}

function handle(value){const normalized=String(value||'').trim().replace(/^@/,'').toLowerCase();if(!/^[a-z0-9_]{1,15}$/.test(normalized))fail(400,'invalid_recipient','Enter a valid X handle.');return normalized;}
function email(value){const normalized=String(value||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)||normalized.length>254)fail(400,'invalid_recipient','Enter a valid email address.');return normalized;}
function maskEmail(value){const [local,domain]=value.split('@');return (local.slice(0,1)||'*')+'***@'+domain;}
function claimUrl(token){const base=appBase();if(!base)fail(503,'gifts_unconfigured','Gift links are not configured yet.');return base+'/gift/'+token;}
function publicGift(row,direction='sent'){return {id:row.id,direction,state:row.state,recipientKind:row.recipient_kind,recipient:row.recipient_kind==='email'?row.recipient_hint:row.recipient_username?'@'+row.recipient_username:row.recipient_hint,sender:row.sender_username?'@'+row.sender_username:undefined,creditMicro:row.credit_micro,baseTokens:row.base_tokens,note:row.note,createdAt:row.created_at,expiresAt:row.expires_at,claimedAt:row.claimed_at,emailSent:row.email_sent};}

async function expirePending(client){
 const expired=(await client.query("SELECT * FROM credit_gifts WHERE state='pending' AND expires_at<=now() ORDER BY sender_user_id,id FOR UPDATE SKIP LOCKED LIMIT 100")).rows;
 if(!expired.length)return;
 const senders=[...new Set(expired.map(g=>g.sender_user_id))].sort();
 await client.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[senders]);
 for(const gift of expired){
  const changed=await client.query("UPDATE credit_gifts SET state='expired',cancelled_at=now() WHERE id=$1 AND state='pending' RETURNING id",[gift.id]);
  if(!changed.rowCount)continue;
  await client.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[gift.sender_user_id,gift.credit_micro,gift.base_tokens]);
  await ledger(client,gift.sender_user_id,'dollar',BigInt(gift.credit_micro),'gift:'+gift.id+':refund',{reason:'expired'});
  await ledger(client,gift.sender_user_id,'raw-base',BigInt(gift.base_tokens),'gift:'+gift.id+':refund',{reason:'expired'});
 }
}

export async function expireGiftReservations(){return tx(expirePending);}

async function deliverPendingHandleGifts(client,account){
 const target='@'+String(account.username||'').toLowerCase();
 const matches=(await client.query('SELECT count(*) n FROM users WHERE lower(username)=$1 AND suspended=false',[target.slice(1)])).rows[0];if(Number(matches.n)!==1)return;
 const gifts=(await client.query("SELECT * FROM credit_gifts WHERE state='pending' AND recipient_kind='x' AND lower(recipient_hint)=$1 AND expires_at>now() ORDER BY created_at,id FOR UPDATE SKIP LOCKED",[target])).rows;
 if(!gifts.length)return;
 await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[account.id]);
 for(const gift of gifts){
  if(gift.sender_user_id===account.id)continue;
  await client.query("UPDATE credit_gifts SET state='claimed',recipient_user_id=$2,claimed_at=now() WHERE id=$1",[gift.id,account.id]);
  await client.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[account.id,gift.credit_micro,gift.base_tokens]);
  await ledger(client,account.id,'dollar',BigInt(gift.credit_micro),'gift:'+gift.id+':in',{sender:gift.sender_user_id});
  await ledger(client,account.id,'raw-base',BigInt(gift.base_tokens),'gift:'+gift.id+':in',{sender:gift.sender_user_id});
  await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'gift.auto_claimed',$2,$3)",[account.id,gift.id,{kind:'x'}]);
 }
}

async function sendGiftEmail(to,{sender,baseTokens,url,delivered,note}){
 if(!process.env.RESEND_API_KEY||!process.env.MAIL_FROM)return false;
 const subject=delivered?'You received Routers API credit':'Routers API credit is waiting for you';
 const lines=[`@${sender} sent you ${Number(baseTokens).toLocaleString('en-US')} Routers API tokens.`,note?`Message: ${note}`:'',delivered?'The credit is already available in your Routers workspace.':`Claim it securely: ${url}`,'','Promotional balances cannot be gifted. This transfer uses purchased API credit and cannot be redeemed for cash.'].filter(Boolean);
 try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to:[to],subject,text:lines.join('\n')}),signal:AbortSignal.timeout(15000)});return response.ok;}catch{return false;}
}

export async function createGift(account,body={}){
 const kind=String(body.kind||'');if(!giftKinds.has(kind))fail(400,'invalid_gift_kind','Choose an X handle, email or claim link.');
 const note=String(body.note||'').trim();if(note.length>180)fail(400,'invalid_note','Keep the gift message under 180 characters.');
 let deliveryEmail=null,recipientHint='Anyone with this link',recipient=null;
 if(kind==='x'){const username=handle(body.recipient);recipientHint='@'+username;const matches=(await q('SELECT id,username FROM users WHERE lower(username)=$1 AND suspended=false ORDER BY created_at DESC LIMIT 2',[username])).rows;if(matches.length>1)fail(409,'ambiguous_recipient','This X handle cannot be matched safely. Use a private claim link instead.');recipient=matches[0]||null;}
 if(kind==='email'){deliveryEmail=email(body.recipient);recipientHint=maskEmail(deliveryEmail);recipient=(await q('SELECT id,username FROM users WHERE lower(email)=$1 AND email_verified=true AND suspended=false LIMIT 1',[deliveryEmail])).rows[0]||null;}
 if(recipient?.id===account.id||(kind==='email'&&account.email&&String(account.email).toLowerCase()===deliveryEmail))fail(400,'self_gift','Choose someone other than yourself.');
 const token=recipient?null:secret(),giftId=id();
 const result=await tx(async client=>{
  await expirePending(client);
  const settings=(await client.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data;
  if(settings.giftsEnabled!==true)fail(503,'gifts_paused','API credit gifts are temporarily paused.');
  const baseTokens=integer(body.baseTokens),minimum=BigInt(settings.giftMinTokens||100000),maximum=BigInt(settings.giftMaxTokens||50000000);
  if(baseTokens<minimum||baseTokens>maximum)fail(400,'invalid_gift_amount',`Choose between ${Number(minimum).toLocaleString('en-US')} and ${Number(maximum).toLocaleString('en-US')} API tokens.`);
  const creditMicro=giftCreditForTokens(baseTokens,settings.baseTokensPerDollar),lockIds=[account.id,...(recipient?[recipient.id]:[])].sort();
  const locked=(await client.query('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[lockIds])).rows,source=locked.find(item=>item.id===account.id),target=recipient?locked.find(item=>item.id===recipient.id):null;
  if(!source||source.suspended)fail(401,'authentication_required','Sign in to continue.');
  if(BigInt(source.purchased_micro)<creditMicro||BigInt(source.base_tokens)<baseTokens)fail(402,'insufficient_gift_balance','You need enough purchased API credit and purchased base tokens for this gift. Promotional rewards cannot be transferred.');
  const expiry=Math.max(1,Math.min(30,Number(settings.giftExpiryDays||7)));
  const state=target?'claimed':'pending';
  const gift=(await client.query("INSERT INTO credit_gifts(id,sender_user_id,recipient_user_id,recipient_kind,recipient_hint,claim_hash,credit_micro,base_tokens,note,state,expires_at,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+make_interval(days=>$11::int),CASE WHEN $10='claimed' THEN now() ELSE NULL END) RETURNING *",[giftId,account.id,target?.id||null,kind,recipientHint,token?hash(token):null,String(creditMicro),String(baseTokens),note||null,state,expiry])).rows[0];
  await client.query('UPDATE users SET purchased_micro=purchased_micro-$2,base_tokens=base_tokens-$3 WHERE id=$1',[account.id,String(creditMicro),String(baseTokens)]);
  await ledger(client,account.id,'dollar',-creditMicro,'gift:'+giftId+':out',{kind,recipient:recipientHint});
  await ledger(client,account.id,'raw-base',-baseTokens,'gift:'+giftId+':out',{kind,recipient:recipientHint});
  if(target){
   await client.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[target.id,String(creditMicro),String(baseTokens)]);
   await ledger(client,target.id,'dollar',creditMicro,'gift:'+giftId+':in',{sender:account.id});
   await ledger(client,target.id,'raw-base',baseTokens,'gift:'+giftId+':in',{sender:account.id});
  }
  await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'gift.created',$2,$3)",[account.id,giftId,{kind,state,baseTokens:String(baseTokens),creditMicro:String(creditMicro)}]);
  return gift;
 });
 const url=token?claimUrl(token):null;
 const emailSent=deliveryEmail?await sendGiftEmail(deliveryEmail,{sender:account.username,baseTokens:result.base_tokens,url,delivered:result.state==='claimed',note:result.note}):false;
 if(emailSent)await q('UPDATE credit_gifts SET email_sent=true WHERE id=$1',[result.id]);
 return {...publicGift({...result,email_sent:emailSent},'sent'),claimUrl:url};
}

export async function listGifts(account){return tx(async client=>{
 await expirePending(client);await deliverPendingHandleGifts(client,account);
 const settings=(await client.query('SELECT data FROM settings WHERE id=1')).rows[0].data;
 const rows=(await client.query(`SELECT g.*,sender.username sender_username,recipient.username recipient_username
 FROM credit_gifts g JOIN users sender ON sender.id=g.sender_user_id LEFT JOIN users recipient ON recipient.id=g.recipient_user_id
 WHERE g.sender_user_id=$1 OR g.recipient_user_id=$1 ORDER BY g.created_at DESC LIMIT 100`,[account.id])).rows;
 return {enabled:settings.giftsEnabled===true,minTokens:settings.giftMinTokens||'100000',maxTokens:settings.giftMaxTokens||'50000000',expiryDays:settings.giftExpiryDays||'7',baseTokensPerDollar:settings.baseTokensPerDollar,gifts:rows.map(row=>publicGift(row,row.sender_user_id===account.id?'sent':'received'))};
});}

export async function giftInfo(token){if(!giftTokenPattern.test(String(token||'')))fail(404,'gift_not_found','This gift link is invalid.');return tx(async client=>{
 await expirePending(client);
 const gift=(await client.query(`SELECT g.*,sender.username sender_username,sender.avatar_url sender_avatar
 FROM credit_gifts g JOIN users sender ON sender.id=g.sender_user_id WHERE g.claim_hash=$1`,[hash(token)])).rows[0];
 if(!gift)fail(404,'gift_not_found','This gift link is invalid.');
 return {id:gift.id,state:gift.state,recipientKind:gift.recipient_kind,recipient:gift.recipient_hint,creditMicro:gift.credit_micro,baseTokens:gift.base_tokens,note:gift.note,createdAt:gift.created_at,expiresAt:gift.expires_at,claimedAt:gift.claimed_at,sender:{username:gift.sender_username,avatarUrl:gift.sender_avatar}};
});}

export async function claimGift(account,token){if(!giftTokenPattern.test(String(token||'')))fail(404,'gift_not_found','This gift link is invalid.');return tx(async client=>{
 await expirePending(client);
 const gift=(await client.query('SELECT * FROM credit_gifts WHERE claim_hash=$1 FOR UPDATE',[hash(token)])).rows[0];
 if(!gift)fail(404,'gift_not_found','This gift link is invalid.');
 if(gift.state!=='pending')fail(409,'gift_unavailable',gift.state==='claimed'?'This gift has already been claimed.':'This gift is no longer available.');
 if(gift.sender_user_id===account.id)fail(400,'self_claim','The sender cannot claim their own gift.');
 if(gift.recipient_kind==='x'){if(gift.recipient_hint.toLowerCase()!=='@'+String(account.username).toLowerCase())fail(403,'wrong_recipient','Sign in with the X account named on this gift.');const matches=(await client.query('SELECT count(*) n FROM users WHERE lower(username)=$1 AND suspended=false',[String(account.username).toLowerCase()])).rows[0];if(Number(matches.n)!==1)fail(409,'ambiguous_recipient','This X handle cannot be matched safely. Ask the sender to cancel and use a private claim link.');}
 const recipient=(await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[account.id])).rows[0];if(!recipient||recipient.suspended)fail(401,'authentication_required','Sign in to continue.');
 await client.query("UPDATE credit_gifts SET state='claimed',recipient_user_id=$2,claimed_at=now() WHERE id=$1",[gift.id,account.id]);
 await client.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[account.id,gift.credit_micro,gift.base_tokens]);
 await ledger(client,account.id,'dollar',BigInt(gift.credit_micro),'gift:'+gift.id+':in',{sender:gift.sender_user_id});
 await ledger(client,account.id,'raw-base',BigInt(gift.base_tokens),'gift:'+gift.id+':in',{sender:gift.sender_user_id});
 await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'gift.claimed',$2,$3)",[account.id,gift.id,{kind:gift.recipient_kind}]);
 return {ok:true,id:gift.id,creditMicro:gift.credit_micro,baseTokens:gift.base_tokens};
});}

export async function cancelGift(account,giftId){if(!uuidPattern.test(String(giftId||'')))fail(404,'gift_not_found','Gift not found.');return tx(async client=>{
 await expirePending(client);
 const gift=(await client.query('SELECT * FROM credit_gifts WHERE id=$1 AND sender_user_id=$2 FOR UPDATE',[giftId,account.id])).rows[0];
 if(!gift)fail(404,'gift_not_found','Gift not found.');if(gift.state!=='pending')fail(409,'gift_unavailable','Only an unclaimed gift can be cancelled.');
 await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[account.id]);
 await client.query("UPDATE credit_gifts SET state='cancelled',cancelled_at=now() WHERE id=$1",[gift.id]);
 await client.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[account.id,gift.credit_micro,gift.base_tokens]);
 await ledger(client,account.id,'dollar',BigInt(gift.credit_micro),'gift:'+gift.id+':refund',{reason:'cancelled'});
 await ledger(client,account.id,'raw-base',BigInt(gift.base_tokens),'gift:'+gift.id+':refund',{reason:'cancelled'});
 await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'gift.cancelled',$2,'{}')",[account.id,gift.id]);return {ok:true};
});}

export function mountGiftCredit(app){
 app.get('/api/gifts',async(req,res)=>{const account=await user(req);await rateLimit('gifts:list:'+account.id,60,60);res.json(await listGifts(account));});
 app.post('/api/gifts',async(req,res)=>{const account=await user(req);await rateLimit('gifts:create:'+account.id,12,3600);res.json(await createGift(account,req.body));});
 app.get('/api/gifts/claim/:token',async(req,res)=>{await rateLimit('gift-info:'+hash(req.ip||''),60,60);res.json(await giftInfo(req.params.token));});
 app.post('/api/gifts/claim',async(req,res)=>{const account=await user(req);await rateLimit('gifts:claim:'+account.id,20,600);res.json(await claimGift(account,String(req.body.token||'')));});
 app.post('/api/gifts/:id/cancel',async(req,res)=>{const account=await user(req);await rateLimit('gifts:cancel:'+account.id,20,600);res.json(await cancelGift(account,req.params.id));});
}
