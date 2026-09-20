import {SOLANA_CHAIN,solAddress,solSignature,verifySolMessage,solRpc,checkSolNetwork,verifySolInvoice,solPaymentTransaction} from './solana.mjs';
import {JsonRpcProvider,verifyMessage,isAddress,parseEther,formatEther,formatUnits} from 'ethers';
import {q,tx,id,hash,secret,fail} from './db.mjs';
import {user} from './auth.mjs';
import {rateLimit} from './redis.mjs';
import {backedCredit} from './accounting.mjs';
export const chains=[{id:SOLANA_CHAIN,name:'Solana',symbol:'SOL',explorer:'https://solscan.io',env:'SOLANA_RPC_URL'},{id:1,name:'Ethereum',symbol:'ETH',explorer:'https://etherscan.io',env:'ETHEREUM_RPC_URL'},{id:4663,name:'Robinhood',symbol:'ETH',explorer:'https://robinhoodchain.blockscout.com',env:'ROBINHOOD_RPC_URL'}];
const providers=new Map();export function rpc(chain){const info=chains.find(x=>x.id===Number(chain));if(!info||!process.env[info.env])fail(503,'chain_unconfigured','Payment network is not configured.');if(!providers.has(info.id))providers.set(info.id,new JsonRpcProvider(process.env[info.env]));return providers.get(info.id);}
export async function verifyInvoice(order,receipt,transaction,block,finalized){if(!receipt||!transaction||!block||!finalized)fail(409,'payment_pending','Payment is awaiting on-chain finality.');if(receipt.status!==1)fail(400,'payment_failed','The transaction failed.');if(receipt.blockNumber>finalized.number)fail(409,'payment_pending','Payment is awaiting on-chain finality.');if((order.wallet!=='direct'&&transaction.from.toLowerCase()!==order.wallet.toLowerCase())||transaction.to?.toLowerCase()!==order.treasury.toLowerCase()||transaction.value!==BigInt(order.wei))fail(400,'payment_mismatch','Sender, receiving address or amount does not match the invoice.');const timestamp=block.timestamp*1000;if(timestamp<new Date(order.created_at).getTime()-15000||timestamp>new Date(order.expires).getTime())fail(400,'quote_expired','The payment was mined outside the quote window; contact support for review.');if(receipt.blockHash!==block.hash)fail(409,'payment_pending','Payment block is no longer canonical.');return true;}
async function settlePaidOrder(order,txHash){await tx(async c=>{await c.query('SELECT data FROM settings WHERE id=1 FOR UPDATE');const locked=(await c.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];if(!locked||locked.state==='paid')return;await c.query("UPDATE orders SET state='paid',tx_hash=$2,confirmed_at=now() WHERE id=$1",[order.id,order.chain_id===SOLANA_CHAIN?txHash:txHash.toLowerCase()]);await backedCredit(c,locked.user_id,BigInt(locked.credit_micro),BigInt(locked.base_tokens),locked.id);});}
async function recoverRecentSolanaPayments(){
 const treasury=process.env.SOLANA_TREASURY_ADDRESS;if(!solAddress(treasury||''))return;
 try{
  const c=solRpc(),signatures=await c.getSignaturesForAddress(new (await import('@solana/web3.js')).PublicKey(treasury),{limit:75},'finalized');
  for(const item of signatures){
   try{
    if(item.err)continue;
    const result=await c.getParsedTransaction(item.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    const instructions=result?.transaction?.message?.instructions||[];
    const memo=instructions.find(i=>String(i.programId)==='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')?.parsed;
    const orderId=typeof memo==='string'&&memo.startsWith('modelmint:')?memo.slice(10):'';
    let order=/^[0-9a-f-]{36}$/i.test(orderId)?(await q("SELECT * FROM orders WHERE id=$1 AND chain_id=$2 AND state='pending'",[orderId,SOLANA_CHAIN])).rows[0]:null;
    if(!order){
     const transfer=instructions.find(i=>String(i.programId)==='11111111111111111111111111111111'&&i.parsed?.type==='transfer'&&i.parsed.info.destination===treasury&&Number.isSafeInteger(i.parsed.info.lamports));
     if(transfer)order=(await q("SELECT * FROM orders WHERE chain_id=$1 AND treasury=$2 AND wei=$3 AND wallet='direct' AND state='pending' AND expires>now()-interval '20 minutes' ORDER BY created_at DESC LIMIT 1",[SOLANA_CHAIN,treasury,String(transfer.parsed.info.lamports)])).rows[0];
    }
    if(!order)continue;
    verifySolInvoice(order,result,item.signature);await settlePaidOrder(order,item.signature);
   }catch(error){console.error('Solana payment recovery item:',item.signature,error?.message||error);}
  }
 }catch(error){console.error('Solana payment recovery:',error?.message||error);}
}
const evmCursors=new Map();
async function recoverRecentEvmPayments(){
 for(const chain of chains.filter(x=>x.id!==SOLANA_CHAIN)){
  const pending=(await q("SELECT * FROM orders WHERE chain_id=$1 AND wallet='direct' AND state='pending' AND expires>now()-interval '20 minutes' ORDER BY created_at",[chain.id])).rows;
  if(!pending.length)continue;
  try{
   const p=rpc(chain.id),latest=await p.getBlockNumber(),finalized=Math.max(0,latest-(chain.id===1?2:1));
   let cursor=evmCursors.get(chain.id)??Math.max(0,finalized-64);cursor=Math.min(cursor,finalized);
   const end=Math.min(finalized,cursor+24);
   for(let number=cursor;number<=end;number++){
    const raw=await p.send('eth_getBlockByNumber',['0x'+number.toString(16),true]);
    if(!raw)continue;
    for(const transaction of raw.transactions||[]){
     const to=transaction.to?.toLowerCase(),value=BigInt(transaction.value||'0x0');
     const order=pending.find(o=>o.treasury.toLowerCase()===to&&BigInt(o.wei)===value);
     if(!order)continue;
     const receipt=await p.getTransactionReceipt(transaction.hash);if(!receipt||receipt.status!==1)continue;
     const block=await p.getBlock(number);await verifyInvoice(order,receipt,{...transaction,from:transaction.from,to:transaction.to,value},block,{number:finalized});
     await settlePaidOrder(order,transaction.hash);
    }
   }
   evmCursors.set(chain.id,end<finalized?end+1:Math.max(0,finalized-2));
  }catch(error){console.error('EVM payment recovery:',chain.id,error?.message||error);}
 }
}
export function mountPayments(app){
// Wallets can return before RPC finality. Reconcile memo-tagged treasury payments
// independently so closing the modal or browser can never strand paid credit.
setTimeout(()=>recoverRecentSolanaPayments(),3000).unref();
setInterval(()=>recoverRecentSolanaPayments(),30000).unref();
setTimeout(()=>recoverRecentEvmPayments(),5000).unref();
setInterval(()=>recoverRecentEvmPayments(),15000).unref();
app.post('/api/payments/solana/transaction',async(req,res)=>{const u=await user(req);await rateLimit('soltx:'+u.id,10,60);const order=(await q('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[req.body.orderId,u.id])).rows[0];if(!order||order.chain_id!==SOLANA_CHAIN||order.state!=='pending'||new Date(order.expires)<=new Date())fail(400,'invalid_invoice','Create a fresh Solana invoice.');res.json(await solPaymentTransaction(order));});
app.get('/api/payment/networks',(req,res)=>res.json(chains.map(({env,...c})=>({...c,configured:!!process.env[env]&&(c.id===SOLANA_CHAIN?solAddress(process.env.SOLANA_TREASURY_ADDRESS):isAddress(process.env.PAYMENT_TREASURY_ADDRESS||''))}))));
app.post('/api/wallet/challenge',async(req,res)=>{const u=await user(req);await rateLimit('wallet:'+u.id,10,600);const sol=req.body.chainId===SOLANA_CHAIN;if(!(sol?solAddress(req.body.address):isAddress(req.body.address)))fail(400,'invalid_address','Choose a valid wallet address.');const nonce=secret(),message=`${new URL(process.env.APP_URL).host} wants to link your wallet for ModelMint payments.\n\nAddress: ${req.body.address}\nAccount: ${u.id}\nNonce: ${nonce}\nExpires in 5 minutes.\nThis signature does not authorize a transaction.`;await q("INSERT INTO challenges(hash,user_id,kind,data,expires) VALUES($1,$2,'wallet',$3,now()+interval '5 minutes')",[hash(nonce),u.id,{message,address:req.body.address,sol}]);res.json({nonce,message});});
app.post('/api/wallet/verify',async(req,res)=>{const u=await user(req),{nonce,signature}=req.body;if(typeof nonce!=='string'||typeof signature!=='string')fail(400,'invalid_signature','Wallet signature is required.');const c=(await q("DELETE FROM challenges WHERE hash=$1 AND user_id=$2 AND kind='wallet' AND expires>now() RETURNING data",[hash(nonce),u.id])).rows[0];if(!c)fail(400,'challenge_expired','Wallet verification expired.');let signer;try{if(c.data.sol){if(!verifySolMessage(c.data.address,c.data.message,signature))throw new Error();signer=c.data.address;}else signer=verifyMessage(c.data.message,signature);}catch{fail(400,'invalid_signature','Invalid wallet signature.');}if((c.data.sol?signer:signer.toLowerCase())!==(c.data.sol?c.data.address:c.data.address.toLowerCase()))fail(400,'invalid_signature','Wallet does not match.');await q('UPDATE users SET '+(c.data.sol?'sol_wallet':'wallet')+'=$2 WHERE id=$1',[u.id,c.data.sol?signer:signer.toLowerCase()]);res.json({wallet:signer});});
app.post('/api/payments/quote',async(req,res)=>{const u=await user(req);await rateLimit('quote:'+u.id,10,60);const pay=Number(req.body.pay),chain=Number(req.body.chainId),sol=chain===SOLANA_CHAIN,direct=req.body.mode==='direct',wallet=direct?'direct':sol?u.sol_wallet:u.wallet,symbol=sol?'SOL':'ETH';if(!wallet)fail(400,'wallet_required','Connect and verify your wallet first.');if(![5,10,25,50].includes(pay)||!chains.some(c=>c.id===chain))fail(400,'invalid_package','Choose a supported package and network.');const treasury=sol?process.env.SOLANA_TREASURY_ADDRESS:process.env.PAYMENT_TREASURY_ADDRESS;if(!(sol?solAddress(treasury):isAddress(treasury||'')))fail(503,'treasury_unconfigured','Payment receiving wallet is not configured.');if(sol){await checkSolNetwork(solRpc());}else{const p=rpc(chain);if(Number((await p.getNetwork()).chainId)!==chain)fail(503,'rpc_mismatch','Payment network verification failed.');}
const priceResponse=await fetch('https://api.coinbase.com/v2/prices/'+symbol+'-USD/spot',{signal:AbortSignal.timeout(10000),cache:'no-store'});if(!priceResponse.ok)fail(503,'price_unavailable','Unable to obtain a current token price.');const priceData=await priceResponse.json(),price=priceData.data?.amount;if(!/^\d+(\.\d+)?$/.test(price||'')||Number(price)<=0||priceData.data?.base!==symbol||priceData.data?.currency!=='USD')fail(503,'price_unavailable','Token quote is unavailable.');const priceScaled=parseEther(price),wei=(BigInt(pay)*10n**BigInt(sol?27:36)+priceScaled-1n)/priceScaled;
const order=await tx(async c=>{const s=(await c.query('SELECT data FROM settings WHERE id=1 FOR UPDATE')).rows[0].data;if(!s.purchasing||s.shutdown||!s.baseTokensPerDollar)fail(503,'purchases_paused','Credit purchases are not open yet.');const liability=(await c.query('SELECT COALESCE(sum(base_tokens+promo_tokens),0) n FROM users')).rows[0];const held=(await c.query("SELECT COALESCE(sum(max_weighted),0) n FROM reservations WHERE state IN ('reserved','review')")).rows[0];const pending=(await c.query("SELECT COALESCE(sum(base_tokens),0) n FROM orders WHERE state='pending'")).rows[0];const base=BigInt(pay*2)*BigInt(s.baseTokensPerDollar);if(BigInt(liability.n)+BigInt(held.n)+BigInt(pending.n)+base>BigInt(s.inventory)*8n/10n)fail(409,'inventory_committed','Available credit capacity is committed. Try again later.');let invoiceWei=wei,allocated=!direct;if(direct){const step=sol?1n:1000000000n;for(let suffix=1n;suffix<1000n;suffix++){const candidate=wei+suffix*step;const used=(await c.query("SELECT 1 FROM orders WHERE chain_id=$1 AND wei=$2 AND wallet='direct' AND state='pending' AND expires>now()",[chain,String(candidate)])).rowCount;if(!used){invoiceWei=candidate;allocated=true;break;}}}if(!allocated)fail(503,'invoice_capacity','Direct payment invoices are temporarily busy. Try again shortly.');return (await c.query("INSERT INTO orders(id,user_id,chain_id,wallet,treasury,pay_usd,credit_micro,base_tokens,wei,quote_price,expires) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '10 minutes') RETURNING *",[id(),u.id,chain,wallet,treasury,pay,pay*2*1000000,String(base),String(invoiceWei),price])).rows[0];});const amount=formatUnits(order.wei,sol?9:18);res.json({...order,symbol,amount,eth:sol?undefined:amount,mode:direct?'direct':'wallet',paymentUri:sol?`solana:${treasury}?amount=${amount}`:`ethereum:${treasury}@${chain}?value=${order.wei}`});});
app.get('/api/payments/status/:id',async(req,res)=>{const u=await user(req);await rateLimit('payment-status:'+u.id,60,60);const order=(await q('SELECT id,state,tx_hash,expires FROM orders WHERE id=$1 AND user_id=$2',[req.params.id,u.id])).rows[0];if(!order)fail(404,'invoice_not_found','Invoice not found.');res.json(order);});
app.post('/api/payments/verify',async(req,res)=>{const u=await user(req);await rateLimit('payment:'+u.id,30,60);const {orderId,txHash}=req.body;if(!/^[0-9a-f-]{36}$/i.test(orderId||'')||typeof txHash!=='string')fail(400,'invalid_transaction','A valid invoice ID and transaction hash are required.');const order=(await q('SELECT * FROM orders WHERE id=$1 AND user_id=$2',[orderId,u.id])).rows[0];if(!order)fail(404,'invoice_not_found','Invoice not found.');if(order.state==='paid')return res.json({ok:true,state:'paid'});if(order.chain_id===SOLANA_CHAIN){if(!solSignature(txHash))fail(400,'invalid_transaction','Invalid Solana signature.');const c=solRpc();await checkSolNetwork(c);const result=await c.getParsedTransaction(txHash,{commitment:'finalized',maxSupportedTransactionVersion:0});verifySolInvoice(order,result,txHash);}else{if(!/^0x[0-9a-f]{64}$/i.test(txHash))fail(400,'invalid_transaction','Invalid transaction hash.');const p=rpc(order.chain_id);if(Number((await p.getNetwork()).chainId)!==order.chain_id)fail(503,'rpc_mismatch','Incorrect RPC network.');const [receipt,transaction,finalized]=await Promise.all([p.getTransactionReceipt(txHash),p.getTransaction(txHash),p.getBlock('finalized')]);const block=receipt?await p.getBlock(receipt.blockNumber):null;await verifyInvoice(order,receipt,transaction,block,finalized);}
await settlePaidOrder(order,txHash);res.json({ok:true,state:'paid'});});
}
