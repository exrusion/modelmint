import {Contract,formatUnits,getAddress,id as eventId,isAddress,zeroPadValue,verifyMessage} from 'ethers';
import {q,tx,id as uuid,secret,hash,fail} from './db.mjs';
import {user} from './auth.mjs';
import {rpc} from './payments.mjs';
import {ledger} from './accounting.mjs';
import {rateLimit} from './redis.mjs';

export const HOLDER_CHAIN_ID=4663;
export const HOLDER_TOKEN_ADDRESS='0xf1498261e22d5232361f5188b5238e495abdaecf';
export const HOLDER_TOKEN_DEPLOYMENT_BLOCK=67482869;
export const HOLDER_TOKEN_DECIMALS=18;

export const HOLDER_REWARD_DEFAULTS={
 holderRewardsEnabled:true,
 holderRewardHoldSeconds:'43200',
 holderRewardMinTokens:'2000000',
 holderRewardBonusTokens:'10000000',
 holderRewardBaseGrant:'500000',
 holderRewardBonusGrant:'5000000',
 holderRewardExpiryDays:'7'
};

const ERC20_ABI=['function balanceOf(address) view returns (uint256)'];
const TRANSFER_TOPIC=eventId('Transfer(address,address,uint256)');
const cache=new Map();

function wholeTokenWei(value){return BigInt(String(value))*10n**BigInt(HOLDER_TOKEN_DECIMALS);}
function topicAddress(address){return zeroPadValue(address,32).toLowerCase();}
function addressFromTopic(topic){return ('0x'+String(topic).slice(-40)).toLowerCase();}
function safeSettings(data={}){return {...HOLDER_REWARD_DEFAULTS,...data};}
function secondsBetween(from,to=Date.now()){return Math.max(0,Math.floor((to-new Date(from).getTime())/1000));}

export function grantForBalance(balance,settings=HOLDER_REWARD_DEFAULTS){
 const s=safeSettings(settings),value=BigInt(balance);
 if(value>=wholeTokenWei(s.holderRewardBonusTokens))return BigInt(s.holderRewardBonusGrant);
 if(value>=wholeTokenWei(s.holderRewardMinTokens))return BigInt(s.holderRewardBaseGrant);
 return 0n;
}

export function findContinuousHoldingBlock(currentBalance,events,threshold,deploymentBlock=HOLDER_TOKEN_DEPLOYMENT_BLOCK){
 let balance=BigInt(currentBalance),minimum=BigInt(threshold);
 if(balance<minimum)return null;
 const ordered=[...events].sort((a,b)=>b.blockNumber-a.blockNumber||b.logIndex-a.logIndex);
 for(const event of ordered){
  const delta=BigInt(event.delta),previous=balance-delta;
  if(balance>=minimum&&previous<minimum)return event.blockNumber;
  balance=previous;
 }
 return deploymentBlock;
}

async function rewardSettings(client=null){
 const result=client?await client.query('SELECT data FROM settings WHERE id=1'):await q('SELECT data FROM settings WHERE id=1');
 return safeSettings(result.rows[0]?.data);
}

export function publicHolderRewardConfig(settings=HOLDER_REWARD_DEFAULTS,claimed=0){
 const s=safeSettings(settings);
 return {
  enabled:s.holderRewardsEnabled===true,
  chainId:HOLDER_CHAIN_ID,
  chainName:'Robinhood Chain',
  tokenAddress:HOLDER_TOKEN_ADDRESS,
  tokenSymbol:'ROUTERSMARKET',
  holdSeconds:Number(s.holderRewardHoldSeconds),
  minimumTokens:String(s.holderRewardMinTokens),
  bonusTokens:String(s.holderRewardBonusTokens),
  baseGrant:String(s.holderRewardBaseGrant),
  bonusGrant:String(s.holderRewardBonusGrant),
  expiryDays:Number(s.holderRewardExpiryDays),
  claimed:Number(claimed||0),
  explorer:`https://robinhoodchain.blockscout.com/token/${HOLDER_TOKEN_ADDRESS}`
 };
}

async function directionalLogs(provider,walletTopic,position,toBlock){
 const logs=[];let from=HOLDER_TOKEN_DEPLOYMENT_BLOCK,span=50000;
 while(from<=toBlock){
  const end=Math.min(toBlock,from+span-1);
  try{
   const topics=position==='from'?[TRANSFER_TOPIC,walletTopic]:[TRANSFER_TOPIC,null,walletTopic];
   logs.push(...await provider.getLogs({address:HOLDER_TOKEN_ADDRESS,fromBlock:from,toBlock:end,topics}));
   from=end+1;
  }catch(error){
   if(span<=2000)throw error;
   span=Math.max(2000,Math.floor(span/2));
  }
 }
 return logs;
}

async function walletEvents(provider,wallet,toBlock){
 const padded=topicAddress(wallet);
 const [outgoing,incoming]=await Promise.all([
  directionalLogs(provider,padded,'from',toBlock),
  directionalLogs(provider,padded,'to',toBlock)
 ]);
 const seen=new Set(),events=[];
 for(const log of [...outgoing,...incoming]){
  const key=`${log.transactionHash}:${log.index}`;
  if(seen.has(key))continue;seen.add(key);
  const from=addressFromTopic(log.topics[1]),to=addressFromTopic(log.topics[2]),value=BigInt(log.data);
  let delta=0n;if(to===wallet)delta+=value;if(from===wallet)delta-=value;
  events.push({blockNumber:log.blockNumber,logIndex:Number(log.index||0),delta});
 }
 return events;
}

async function inspectWallet(address,settings,{fresh=false}={}){
 const wallet=getAddress(address).toLowerCase(),s=safeSettings(settings);
 const key=[wallet,s.holderRewardMinTokens,s.holderRewardBonusTokens].join(':');
 const cached=cache.get(key);if(!fresh&&cached&&Date.now()-cached.at<60000)return cached.value;
 const provider=rpc(HOLDER_CHAIN_ID),network=await provider.getNetwork();
 if(Number(network.chainId)!==HOLDER_CHAIN_ID)fail(503,'holder_rpc_mismatch','Robinhood holder verification is temporarily unavailable.');
 const latest=await provider.getBlockNumber(),snapshotBlock=Math.max(HOLDER_TOKEN_DEPLOYMENT_BLOCK,latest-1);
 const token=new Contract(HOLDER_TOKEN_ADDRESS,ERC20_ABI,provider);
 const balance=BigInt(await token.balanceOf(wallet,{blockTag:snapshotBlock}));
 const minimum=wholeTokenWei(s.holderRewardMinTokens),bonus=wholeTokenWei(s.holderRewardBonusTokens);
 let minimumSince=null,bonusSince=null;
 if(balance>=minimum){
  const events=await walletEvents(provider,wallet,snapshotBlock);
  const minimumBlock=findContinuousHoldingBlock(balance,events,minimum);
  const bonusBlock=balance>=bonus?findContinuousHoldingBlock(balance,events,bonus):null;
  const blocks=[minimumBlock,bonusBlock].filter((value,index,array)=>value!==null&&array.indexOf(value)===index);
  const timestamps=new Map(await Promise.all(blocks.map(async block=>{const data=await provider.getBlock(block);if(!data)fail(503,'holder_history_unavailable','Unable to verify the holding-period start block.');return [block,new Date(data.timestamp*1000).toISOString()];})));
  minimumSince=minimumBlock===null?null:timestamps.get(minimumBlock);
  bonusSince=bonusBlock===null?null:timestamps.get(bonusBlock);
 }
 const value={wallet,balance,balanceWei:String(balance),balanceTokens:formatUnits(balance,HOLDER_TOKEN_DECIMALS),snapshotBlock,minimumSince,bonusSince};
 cache.set(key,{at:Date.now(),value});return value;
}

async function rewardStatus(account,{fresh=false}={}){
 const settings=await rewardSettings(),config=publicHolderRewardConfig(settings);
 const claim=(await q('SELECT wallet,reward_tokens,reward_micro,balance_wei,snapshot_block,holding_since,claimed_at FROM holder_reward_claims WHERE user_id=$1',[account.id])).rows[0];
 if(claim)return {config,status:'claimed',wallet:claim.wallet,rewardTokens:claim.reward_tokens,rewardMicro:claim.reward_micro,balanceTokens:formatUnits(claim.balance_wei,HOLDER_TOKEN_DECIMALS),snapshotBlock:claim.snapshot_block,holdingSince:claim.holding_since,claimedAt:claim.claimed_at};
 const link=(await q('SELECT wallet,verified_at FROM holder_wallet_links WHERE user_id=$1',[account.id])).rows[0];
 if(!link)return {config,status:'wallet_required',wallet:null};
 if(!config.enabled)return {config,status:'paused',wallet:link.wallet,verifiedAt:link.verified_at};
 let snapshot;try{snapshot=await inspectWallet(link.wallet,settings,{fresh});}catch(error){if(error.status)throw error;console.error('Holder reward RPC:',error?.message||error);fail(503,'holder_rpc_unavailable','Robinhood holder verification is temporarily unavailable. Try again shortly.');}
 const hold=Number(settings.holderRewardHoldSeconds),now=Date.now();
 const minimumHeld=snapshot.minimumSince?secondsBetween(snapshot.minimumSince,now):0;
 const bonusHeld=snapshot.bonusSince?secondsBetween(snapshot.bonusSince,now):0;
 const minimumGrant=BigInt(settings.holderRewardBaseGrant),bonusGrant=BigInt(settings.holderRewardBonusGrant);
 let eligibleGrant=0n,holdingSince=null;
 if(snapshot.bonusSince&&bonusHeld>=hold){eligibleGrant=bonusGrant;holdingSince=snapshot.bonusSince;}
 else if(snapshot.minimumSince&&minimumHeld>=hold){eligibleGrant=minimumGrant;holdingSince=snapshot.minimumSince;}
 const potentialGrant=grantForBalance(snapshot.balance,settings);
 const tierSince=potentialGrant===bonusGrant?snapshot.bonusSince:snapshot.minimumSince;
 const tierHeld=potentialGrant===bonusGrant?bonusHeld:minimumHeld;
 return {config,status:eligibleGrant>0n?'eligible':potentialGrant>0n?'holding':'below_minimum',wallet:link.wallet,verifiedAt:link.verified_at,balanceWei:snapshot.balanceWei,balanceTokens:snapshot.balanceTokens,snapshotBlock:snapshot.snapshotBlock,holdingSince:tierSince,heldSeconds:tierHeld,remainingSeconds:potentialGrant>0n?Math.max(0,hold-tierHeld):hold,eligibleRewardTokens:String(eligibleGrant),potentialRewardTokens:String(potentialGrant),claimHoldingSince:holdingSince};
}

async function issueReward(account,status){
 const reward=BigInt(status.eligibleRewardTokens||0);if(reward<=0n)fail(409,'holder_not_eligible','This wallet has not completed the required holding period.');
 return tx(async client=>{
  const settings=await rewardSettings(client);if(settings.holderRewardsEnabled!==true)fail(409,'holder_rewards_paused','Holder rewards are currently paused.');
  const existing=(await client.query('SELECT * FROM holder_reward_claims WHERE user_id=$1 OR wallet=$2 FOR UPDATE',[account.id,status.wallet])).rows[0];if(existing)return existing;
  const held=(await client.query("SELECT COALESCE(sum(max_weighted),0) n FROM reservations WHERE state IN ('reserved','review')")).rows[0];
  const pending=(await client.query("SELECT COALESCE(sum(base_tokens),0) n FROM orders WHERE state='pending'")).rows[0];
  const gifts=(await client.query("SELECT COALESCE(sum(base_tokens),0) n FROM credit_gifts WHERE state='pending'")).rows[0];
  const liabilities=(await client.query('SELECT COALESCE(sum(base_tokens+promo_tokens),0) n FROM users')).rows[0];
  if(BigInt(liabilities.n)+BigInt(held.n)+BigInt(pending.n)+BigInt(gifts.n)+reward>BigInt(settings.inventory)*8n/10n)fail(409,'insufficient_backing','Holder rewards are temporarily at capacity. Try again later.');
  const rewardMicro=reward,claimId=uuid(),expiry=Math.max(1,Number(settings.holderRewardExpiryDays||7));
  const inserted=await client.query('INSERT INTO holder_reward_claims(id,user_id,wallet,balance_wei,reward_tokens,reward_micro,snapshot_block,holding_since) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *',[claimId,account.id,status.wallet,status.balanceWei,String(reward),String(rewardMicro),status.snapshotBlock,status.claimHoldingSince]);
  if(!inserted.rowCount)return (await client.query('SELECT * FROM holder_reward_claims WHERE user_id=$1 OR wallet=$2',[account.id,status.wallet])).rows[0];
  await client.query('UPDATE users SET promo_tokens=promo_tokens+$2,promo_micro=promo_micro+$3,promo_expires=GREATEST(COALESCE(promo_expires,now()),now()+make_interval(days=>$4::int)) WHERE id=$1',[account.id,String(reward),String(rewardMicro),expiry]);
  await ledger(client,account.id,'promo-token',reward,'holder-reward:'+status.wallet,{chainId:HOLDER_CHAIN_ID,token:HOLDER_TOKEN_ADDRESS});
  await ledger(client,account.id,'promo-dollar',rewardMicro,'holder-reward:'+status.wallet,{chainId:HOLDER_CHAIN_ID,token:HOLDER_TOKEN_ADDRESS});
  await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'holder_reward.claimed',$2,$3)",[account.id,status.wallet,{rewardTokens:String(reward),balanceTokens:status.balanceTokens,snapshotBlock:status.snapshotBlock}]);
  return inserted.rows[0];
 });
}

export function mountHolderRewards(app){
 app.get('/api/holder-rewards/public',async(req,res)=>{try{const [settings,claims]=await Promise.all([rewardSettings(),q('SELECT count(*) n FROM holder_reward_claims')]);res.json(publicHolderRewardConfig(settings,claims.rows[0].n));}catch(error){if(error.code==='database_unconfigured')return res.json(publicHolderRewardConfig());throw error;}});
 app.get('/api/holder-rewards/status',async(req,res)=>{const account=await user(req);await rateLimit('holder-status:'+account.id,30,60);res.json(await rewardStatus(account));});
 app.post('/api/holder-rewards/challenge',async(req,res)=>{const account=await user(req);await rateLimit('holder-challenge:'+account.id,8,600);if((await q('SELECT 1 FROM holder_reward_claims WHERE user_id=$1',[account.id])).rowCount)fail(409,'reward_already_claimed','This account has already claimed its holder reward.');const address=String(req.body.address||'');if(!isAddress(address))fail(400,'invalid_address','Choose a valid EVM wallet address.');const wallet=getAddress(address).toLowerCase(),nonce=secret(),message=`routers.markets wants to verify this wallet for the $ROUTERS holder reward.\n\nWallet: ${wallet}\nToken: ${HOLDER_TOKEN_ADDRESS}\nChain: Robinhood Chain (4663)\nAccount: ${account.id}\nNonce: ${nonce}\nExpires in 5 minutes.\n\nThis signature is free and does not authorize a transaction.`;await q("INSERT INTO challenges(hash,user_id,kind,data,expires) VALUES($1,$2,'holder-wallet',$3,now()+interval '5 minutes')",[hash(nonce),account.id,{message,wallet}]);res.json({nonce,message,chainId:HOLDER_CHAIN_ID});});
 app.post('/api/holder-rewards/verify',async(req,res)=>{const account=await user(req);await rateLimit('holder-verify:'+account.id,8,600);const nonce=String(req.body.nonce||''),signature=String(req.body.signature||'');if(!nonce||!signature)fail(400,'invalid_signature','Wallet signature is required.');const challenge=(await q("DELETE FROM challenges WHERE hash=$1 AND user_id=$2 AND kind='holder-wallet' AND expires>now() RETURNING data",[hash(nonce),account.id])).rows[0];if(!challenge)fail(400,'challenge_expired','Wallet verification expired. Start again.');let signer;try{signer=verifyMessage(challenge.data.message,signature).toLowerCase();}catch{fail(400,'invalid_signature','The wallet signature could not be verified.');}if(signer!==challenge.data.wallet)fail(400,'invalid_signature','The signature does not match the selected wallet.');const ownClaim=(await q('SELECT wallet FROM holder_reward_claims WHERE user_id=$1',[account.id])).rows[0];if(ownClaim)fail(409,'reward_already_claimed','This account has already claimed its holder reward.');const conflict=(await q('SELECT user_id FROM holder_wallet_links WHERE wallet=$1 AND user_id<>$2 UNION ALL SELECT user_id FROM holder_reward_claims WHERE wallet=$1 AND user_id<>$2 LIMIT 1',[signer,account.id])).rows[0];if(conflict)fail(409,'wallet_already_linked','This wallet is already linked to another Routers account.');try{await tx(async client=>{await client.query('INSERT INTO holder_wallet_links(user_id,wallet,verified_at) VALUES($1,$2,now()) ON CONFLICT(user_id) DO UPDATE SET wallet=excluded.wallet,verified_at=excluded.verified_at',[account.id,signer]);await client.query("INSERT INTO audit(actor,action,target,details) VALUES($1,'holder_wallet.verified',$2,$3)",[account.id,signer,{chainId:HOLDER_CHAIN_ID,token:HOLDER_TOKEN_ADDRESS}]);});}catch(error){if(error?.code==='23505')fail(409,'wallet_already_linked','This wallet is already linked to another Routers account.');throw error;}res.json(await rewardStatus(account,{fresh:true}));});
 app.post('/api/holder-rewards/claim',async(req,res)=>{const account=await user(req);await rateLimit('holder-claim:'+account.id,5,3600);const status=await rewardStatus(account,{fresh:true});if(status.status==='claimed')return res.json(status);if(status.status!=='eligible')fail(409,'holder_not_eligible','Keep the required balance for 12 continuous hours before claiming.');const claim=await issueReward(account,status);res.json({config:status.config,status:'claimed',wallet:claim.wallet,rewardTokens:claim.reward_tokens,rewardMicro:claim.reward_micro,balanceTokens:formatUnits(claim.balance_wei,HOLDER_TOKEN_DECIMALS),snapshotBlock:claim.snapshot_block,holdingSince:claim.holding_since,claimedAt:claim.claimed_at});});
}
