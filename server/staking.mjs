import {Contract,JsonRpcProvider,formatUnits,getAddress,isAddress,parseUnits,verifyMessage} from 'ethers';
import {q,tx,id,secret,hash,fail,pool} from './db.mjs';
import {ledger} from './accounting.mjs';
import {user} from './auth.mjs';
import {rateLimit} from './redis.mjs';
const HOLDER_CHAIN_ID=4663;
const HOLDER_TOKEN_ADDRESS='0xf1498261e22d5232361f5188b5238e495abdaecf';
const HOLDER_TOKEN_DECIMALS=18;
const ERC20_ABI=['function balanceOf(address) view returns (uint256)'];
const DEFAULTS={stakingEnabled:true,stakingRewardBps:'1000'};
let provider;

function settings(data={}){return {...DEFAULTS,...data};}
function stakingRpc(){
 if(!process.env.ROBINHOOD_RPC_URL)fail(503,'staking_rpc_unconfigured','Robinhood Chain staking verification is not configured.');
 if(!provider)provider=new JsonRpcProvider(process.env.ROBINHOOD_RPC_URL);
 return provider;
}
function amountWei(value){
 const raw=String(value||'').trim().replace(/,/g,'');
 if(!/^\d+(\.\d{1,18})?$/.test(raw))fail(400,'invalid_stake','Enter a valid $ROUTERS amount.');
 const parsed=parseUnits(raw,HOLDER_TOKEN_DECIMALS);
 if(parsed<=0n)fail(400,'invalid_stake','Stake at least one token.');
 return parsed;
}
function shortDecimal(value){return formatUnits(BigInt(value||0),HOLDER_TOKEN_DECIMALS).replace(/\.0+$/,'');}

export function allocatePool(creditMicro,baseTokens,positions){
 const credit=BigInt(creditMicro),tokens=BigInt(baseTokens);
 const valid=positions.map(p=>({...p,weight:BigInt(p.weight)})).filter(p=>p.weight>0n);
 const total=valid.reduce((sum,p)=>sum+p.weight,0n);
 if(!total||(!credit&&!tokens))return [];
 const rows=valid.map(p=>{
  const creditProduct=credit*p.weight,tokenProduct=tokens*p.weight;
  return {...p,credit:creditProduct/total,tokens:tokenProduct/total,creditRemainder:creditProduct%total,tokenRemainder:tokenProduct%total};
 });
 const topUp=(key,remainder,totalValue)=>{
  let left=BigInt(totalValue)-rows.reduce((sum,row)=>sum+row[key],0n);
  const ranked=[...rows].sort((a,b)=>a[remainder]===b[remainder]?String(a.userId).localeCompare(String(b.userId)):a[remainder]>b[remainder]?-1:1);
  for(let index=0;left>0n&&index<ranked.length;index++,left--)ranked[index][key]++;
 };
 topUp('credit','creditRemainder',credit);topUp('tokens','tokenRemainder',tokens);
 return rows.map(({creditRemainder,tokenRemainder,...row})=>row);
}

async function publicStats(){
 const s=settings((await q('SELECT data FROM settings WHERE id=1')).rows[0]?.data);
 const [positions,rewards,purchases,recent]=await Promise.all([
  q("SELECT count(*) stakers,COALESCE(sum(stated_wei),0) total FROM staking_positions WHERE active=true"),
  q('SELECT COALESCE(sum(reward_credit_micro),0) credit,COALESCE(sum(reward_base_tokens),0) tokens FROM staking_reward_pools'),
  q('SELECT COALESCE(sum(purchase_credit_micro),0) credit FROM staking_reward_pools'),
  q(`SELECT p.purchase_credit_micro,p.reward_credit_micro,p.reward_base_tokens,p.recipient_count,p.created_at,u.username
     FROM staking_reward_pools p JOIN orders o ON o.id=p.order_id JOIN users u ON u.id=o.user_id
     ORDER BY p.created_at DESC LIMIT 8`)
 ]);
 return {enabled:s.stakingEnabled===true,rewardPercent:Number(s.stakingRewardBps||1000)/100,chainId:HOLDER_CHAIN_ID,chainName:'Robinhood Chain',tokenAddress:HOLDER_TOKEN_ADDRESS,tokenSymbol:'ROUTERS',stakers:Number(positions.rows[0].stakers),totalStakedTokens:shortDecimal(positions.rows[0].total),distributedCreditMicro:String(rewards.rows[0].credit),distributedBaseTokens:String(rewards.rows[0].tokens),qualifyingPurchaseCreditMicro:String(purchases.rows[0].credit),recentPools:recent.rows.map(row=>({purchaseCreditMicro:row.purchase_credit_micro,rewardCreditMicro:row.reward_credit_micro,rewardBaseTokens:row.reward_base_tokens,recipientCount:row.recipient_count,createdAt:row.created_at,buyer:row.username}))};
}

async function status(account,{fresh=false}={}){
 const config=await publicStats(),position=(await q('SELECT * FROM staking_positions WHERE user_id=$1',[account.id])).rows[0];
 const earned=(await q('SELECT COALESCE(sum(reward_credit_micro),0) credit,COALESCE(sum(reward_base_tokens),0) tokens,count(*) rewards FROM staking_reward_allocations WHERE user_id=$1',[account.id])).rows[0];
 const recent=(await q(`SELECT a.reward_credit_micro,a.reward_base_tokens,a.created_at,p.purchase_credit_micro
   FROM staking_reward_allocations a JOIN staking_reward_pools p ON p.id=a.pool_id WHERE a.user_id=$1 ORDER BY a.created_at DESC LIMIT 10`,[account.id])).rows;
 if(!position)return {config,status:'not_staking',earnedCreditMicro:String(earned.credit),earnedBaseTokens:String(earned.tokens),rewardCount:Number(earned.rewards),recent};
 let balance=BigInt(position.verified_balance_wei),snapshotBlock=position.last_snapshot_block;
 if(fresh){
  const rpc=stakingRpc(),network=await rpc.getNetwork();if(Number(network.chainId)!==HOLDER_CHAIN_ID)fail(503,'staking_rpc_mismatch','Robinhood staking verification is temporarily unavailable.');
  snapshotBlock=Math.max(1,(await rpc.getBlockNumber())-1);balance=BigInt(await new Contract(HOLDER_TOKEN_ADDRESS,ERC20_ABI,rpc).balanceOf(position.wallet,{blockTag:snapshotBlock}));
  await q('UPDATE staking_positions SET verified_balance_wei=$2,last_snapshot_block=$3,updated_at=now() WHERE user_id=$1',[account.id,String(balance),snapshotBlock]);
 }
 const stated=BigInt(position.stated_wei),weight=balance<stated?balance:stated;
 return {config,status:position.active?'staking':'stopped',wallet:position.wallet,stakedTokens:shortDecimal(stated),walletBalanceTokens:shortDecimal(balance),effectiveStakeTokens:shortDecimal(weight),startedAt:position.activated_at,lastRewardAt:position.last_reward_at,snapshotBlock,earnedCreditMicro:String(earned.credit),earnedBaseTokens:String(earned.tokens),rewardCount:Number(earned.rewards),recent};
}

async function verifiedWeights(){
 const rows=(await q("SELECT user_id,wallet,stated_wei FROM staking_positions WHERE active=true ORDER BY user_id LIMIT 1000")).rows;
 const rpc=stakingRpc(),network=await rpc.getNetwork();if(Number(network.chainId)!==HOLDER_CHAIN_ID)throw new Error('staking_rpc_mismatch');
 const snapshotBlock=Math.max(1,(await rpc.getBlockNumber())-1),token=new Contract(HOLDER_TOKEN_ADDRESS,ERC20_ABI,rpc);
 const balances=await Promise.all(rows.map(async row=>{try{return BigInt(await token.balanceOf(row.wallet,{blockTag:snapshotBlock}));}catch{return 0n;}}));
 return {snapshotBlock,positions:rows.map((row,index)=>({userId:row.user_id,wallet:row.wallet,balance:balances[index],weight:balances[index]<BigInt(row.stated_wei)?balances[index]:BigInt(row.stated_wei)})).filter(row=>row.weight>0n)};
}

export async function distributeStakingReward(orderId){
 const existing=await q('SELECT id FROM staking_reward_pools WHERE order_id=$1',[orderId]);if(existing.rowCount)return false;
 const order=(await q("SELECT * FROM orders WHERE id=$1 AND state='paid'",[orderId])).rows[0];if(!order)return false;
 const s=settings((await q('SELECT data FROM settings WHERE id=1')).rows[0]?.data);if(s.stakingEnabled!==true)return false;
 const bps=BigInt(s.stakingRewardBps||1000),rewardCredit=BigInt(order.credit_micro)*bps/10000n,rewardTokens=BigInt(order.base_tokens)*bps/10000n;
 const {snapshotBlock,positions}=await verifiedWeights(),allocations=allocatePool(rewardCredit,rewardTokens,positions),poolId=id();
 const distributedCredit=allocations.reduce((sum,row)=>sum+row.credit,0n),distributedTokens=allocations.reduce((sum,row)=>sum+row.tokens,0n);
 return tx(async client=>{
  const lockedOrder=(await client.query("SELECT * FROM orders WHERE id=$1 AND state='paid' FOR UPDATE",[orderId])).rows[0];if(!lockedOrder)return false;
  const currentSettings=settings((await client.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data);if(currentSettings.stakingEnabled!==true)return false;
  const inserted=await client.query('INSERT INTO staking_reward_pools(id,order_id,purchase_credit_micro,reward_credit_micro,reward_base_tokens,total_weight_wei,recipient_count,snapshot_block) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(order_id) DO NOTHING RETURNING id',[poolId,orderId,String(lockedOrder.credit_micro),String(distributedCredit),String(distributedTokens),String(positions.reduce((sum,row)=>sum+row.weight,0n)),allocations.length,snapshotBlock]);
  if(!inserted.rowCount)return false;
  if(allocations.length){
   const liability=(await client.query('SELECT COALESCE(sum(base_tokens+promo_tokens),0) n FROM users')).rows[0],reserved=(await client.query("SELECT COALESCE(sum(max_weighted),0) n FROM reservations WHERE state IN ('reserved','review')")).rows[0],gifts=(await client.query("SELECT COALESCE(sum(base_tokens),0) n FROM credit_gifts WHERE state='pending'")).rows[0];
   if(BigInt(liability.n)+BigInt(reserved.n)+BigInt(gifts.n)+distributedTokens>BigInt(currentSettings.inventory)*9n/10n)throw Object.assign(new Error('staking_reward_capacity'),{code:'staking_reward_capacity'});
  }
  for(const allocation of allocations){
   await client.query('INSERT INTO staking_reward_allocations(pool_id,user_id,wallet,weight_wei,reward_credit_micro,reward_base_tokens) VALUES($1,$2,$3,$4,$5,$6)',[poolId,allocation.userId,allocation.wallet,String(allocation.weight),String(allocation.credit),String(allocation.tokens)]);
   await client.query('UPDATE users SET purchased_micro=purchased_micro+$2,base_tokens=base_tokens+$3 WHERE id=$1',[allocation.userId,String(allocation.credit),String(allocation.tokens)]);
   await client.query('UPDATE staking_positions SET verified_balance_wei=$2,last_snapshot_block=$3,last_reward_at=now() WHERE user_id=$1',[allocation.userId,String(allocation.balance),snapshotBlock]);
   await ledger(client,allocation.userId,'staking-dollar',allocation.credit,`staking:${orderId}:${allocation.userId}`,{orderId,rewardBps:String(bps),snapshotBlock});
   await ledger(client,allocation.userId,'staking-token',allocation.tokens,`staking:${orderId}:${allocation.userId}`,{orderId,rewardBps:String(bps),snapshotBlock});
  }
  return true;
 });
}

export async function distributePendingStakingRewards(){
 const orders=(await q("SELECT o.id FROM orders o LEFT JOIN staking_reward_pools p ON p.order_id=o.id CROSS JOIN settings s WHERE o.state='paid' AND p.id IS NULL AND o.confirmed_at>=COALESCE((s.data->>'stakingStartedAt')::timestamptz,now()) ORDER BY o.confirmed_at LIMIT 20")).rows;
 for(const order of orders)try{await distributeStakingReward(order.id);}catch(error){console.error('Staking reward distribution:',order.id,error?.message||error);}
}

export function mountStaking(app){
 if(pool){setTimeout(()=>distributePendingStakingRewards(),8000).unref();setInterval(()=>distributePendingStakingRewards(),60000).unref();}
 app.get('/api/staking/public',async(req,res)=>{try{res.json(await publicStats());}catch(error){if(error.code==='database_unconfigured')return res.json({enabled:false,rewardPercent:10,chainId:HOLDER_CHAIN_ID,chainName:'Robinhood Chain',tokenAddress:HOLDER_TOKEN_ADDRESS,tokenSymbol:'ROUTERS',stakers:0,totalStakedTokens:'0',distributedCreditMicro:'0',distributedBaseTokens:'0',recentPools:[]});throw error;}});
 app.get('/api/staking/status',async(req,res)=>{const account=await user(req);await rateLimit('staking-status:'+account.id,30,60);res.json(await status(account,{fresh:req.query.fresh==='1'}));});
 app.post('/api/staking/challenge',async(req,res)=>{const account=await user(req);await rateLimit('staking-challenge:'+account.id,8,600);const address=String(req.body.address||'');if(!isAddress(address))fail(400,'invalid_address','Choose a valid EVM wallet address.');const wallet=getAddress(address).toLowerCase(),stated=amountWei(req.body.amount),nonce=secret(),message=`routers.markets staking registration\n\nWallet: ${wallet}\nStake weight: ${formatUnits(stated,HOLDER_TOKEN_DECIMALS)} $ROUTERS\nToken: ${HOLDER_TOKEN_ADDRESS}\nChain: Robinhood Chain (4663)\nAccount: ${account.id}\nNonce: ${nonce}\nExpires in 5 minutes.\n\nThis signature is free. Your tokens remain in your wallet and no approval is granted.`;await q("INSERT INTO challenges(hash,user_id,kind,data,expires) VALUES($1,$2,'staking-wallet',$3,now()+interval '5 minutes')",[hash(nonce),account.id,{message,wallet,statedWei:String(stated)}]);res.json({nonce,message,chainId:HOLDER_CHAIN_ID});});
 app.post('/api/staking/activate',async(req,res)=>{const account=await user(req);await rateLimit('staking-activate:'+account.id,8,600);const nonce=String(req.body.nonce||''),signature=String(req.body.signature||'');const challenge=(await q("DELETE FROM challenges WHERE hash=$1 AND user_id=$2 AND kind='staking-wallet' AND expires>now() RETURNING data",[hash(nonce),account.id])).rows[0];if(!challenge)fail(400,'challenge_expired','Staking verification expired. Start again.');let signer;try{signer=verifyMessage(challenge.data.message,signature).toLowerCase();}catch{fail(400,'invalid_signature','The wallet signature could not be verified.');}if(signer!==challenge.data.wallet)fail(400,'invalid_signature','The signature does not match the selected wallet.');const rpc=stakingRpc(),network=await rpc.getNetwork();if(Number(network.chainId)!==HOLDER_CHAIN_ID)fail(503,'staking_rpc_mismatch','Robinhood staking verification is temporarily unavailable.');const snapshotBlock=Math.max(1,(await rpc.getBlockNumber())-1),balance=BigInt(await new Contract(HOLDER_TOKEN_ADDRESS,ERC20_ABI,rpc).balanceOf(signer,{blockTag:snapshotBlock})),stated=BigInt(challenge.data.statedWei);if(balance<stated)fail(409,'insufficient_token_balance','The verified wallet does not hold the selected staking amount.');try{await q(`INSERT INTO staking_positions(user_id,wallet,stated_wei,verified_balance_wei,last_snapshot_block) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE SET wallet=excluded.wallet,stated_wei=excluded.stated_wei,verified_balance_wei=excluded.verified_balance_wei,last_snapshot_block=excluded.last_snapshot_block,active=true,activated_at=CASE WHEN staking_positions.active THEN staking_positions.activated_at ELSE now() END,updated_at=now()`,[account.id,signer,String(stated),String(balance),snapshotBlock]);}catch(error){if(error?.code==='23505')fail(409,'wallet_already_staking','This wallet is already registered to another Routers account.');throw error;}await q("INSERT INTO audit(actor,action,target,details) VALUES($1,'staking.activated',$2,$3)",[account.id,signer,{statedWei:String(stated),snapshotBlock}]);res.json(await status(account));});
 app.post('/api/staking/stop',async(req,res)=>{const account=await user(req);await rateLimit('staking-stop:'+account.id,5,600);await q('UPDATE staking_positions SET active=false,updated_at=now() WHERE user_id=$1',[account.id]);await q("INSERT INTO audit(actor,action,target,details) VALUES($1,'staking.stopped',$2,'{}')",[account.id,'staking']);res.json(await status(account));});
}
