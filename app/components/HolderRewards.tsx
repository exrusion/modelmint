'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useCallback,useEffect,useState} from 'react';

type Config={
 enabled:boolean;chainId:number;chainName:string;tokenAddress:string;tokenSymbol:string;
 holdSeconds:number;minimumTokens:string;bonusTokens:string;baseGrant:string;bonusGrant:string;
 expiryDays:number;claimed:number;explorer:string;
};
type RewardStatus={
 config:Config;status:'wallet_required'|'paused'|'below_minimum'|'holding'|'eligible'|'claimed';
 wallet?:string|null;balanceTokens?:string;remainingSeconds?:number;potentialRewardTokens?:string;
 eligibleRewardTokens?:string;rewardTokens?:string;holdingSince?:string;claimedAt?:string;
};
type WalletOption={info:{uuid:string;name:string;icon?:string};provider:{request:(args:{method:string;params?:unknown[]})=>Promise<any>}};
const FALLBACK_CONFIG:Config={enabled:true,chainId:4663,chainName:'Robinhood Chain',tokenAddress:'0xf1498261e22d5232361f5188b5238e495abdaecf',tokenSymbol:'ROUTERSMARKET',holdSeconds:43200,minimumTokens:'2000000',bonusTokens:'10000000',baseGrant:'500000',bonusGrant:'5000000',expiryDays:7,claimed:0,explorer:'https://robinhoodchain.blockscout.com/token/0xf1498261e22d5232361f5188b5238e495abdaecf'};

async function api(path:string,body?:Record<string,unknown>){
 const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Object.assign(new Error(data.error?.message||'Unable to complete this request.'),{status:response.status,code:data.error?.code});
 return data;
}
function compact(value?:string|number){return Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(Number(value||0));}
function balance(value?:string){return Number(value||0).toLocaleString('en-US',{maximumFractionDigits:2});}
function short(address?:string|null){return address?address.slice(0,7)+'…'+address.slice(-5):'';}
function duration(seconds:number){
 const safe=Math.max(0,Math.floor(seconds)),hours=Math.floor(safe/3600),minutes=Math.floor((safe%3600)/60),secs=safe%60;
 return `${String(hours).padStart(2,'0')}h ${String(minutes).padStart(2,'0')}m ${String(secs).padStart(2,'0')}s`;
}

export default function HolderRewards({standalone=false}:{standalone?:boolean}){
 const [config,setConfig]=useState<Config|null>(null),[status,setStatus]=useState<RewardStatus|null>(null);
 const [auth,setAuth]=useState<'checking'|'signed_in'|'signed_out'>('checking'),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [wallets,setWallets]=useState<WalletOption[]>([]),[selected,setSelected]=useState(''),[tick,setTick]=useState(0);

 const loadStatus=useCallback(async()=>{
  try{const data=await api('/api/holder-rewards/status');setStatus(data);setAuth('signed_in');setTick(0);return data;}
  catch(error:any){if(error.status===401){setStatus(null);setAuth('signed_out');return null;}throw error;}
 },[]);
 useEffect(()=>{let live=true;api('/api/holder-rewards/public').then(publicConfig=>{if(live)setConfig(publicConfig);}).catch((error:any)=>{if(live)setMessage(error.message);});loadStatus().catch((error:any)=>{if(live)setMessage(error.message);});return()=>{live=false};},[loadStatus]);
 useEffect(()=>{const announce=(event:Event)=>{const detail=(event as CustomEvent<WalletOption>).detail;if(!detail?.info?.uuid)return;setWallets(current=>current.some(item=>item.info.uuid===detail.info.uuid)?current:[...current,detail]);setSelected(current=>current||detail.info.uuid);};window.addEventListener('eip6963:announceProvider',announce);window.dispatchEvent(new Event('eip6963:requestProvider'));const injected=(window as any).ethereum;if(injected){const fallback={info:{uuid:'injected',name:'Browser wallet'},provider:injected};setWallets(current=>current.length?current:[fallback]);setSelected(current=>current||'injected');}return()=>window.removeEventListener('eip6963:announceProvider',announce);},[]);
 useEffect(()=>{if(status?.status!=='holding')return;const timer=setInterval(()=>setTick(value=>value+1),1000),refresh=setInterval(()=>loadStatus().catch(()=>{}),300000);return()=>{clearInterval(timer);clearInterval(refresh);};},[status?.status,loadStatus]);
 const remaining=Math.max(0,Number(status?.remainingSeconds||0)-tick);
 const activeConfig=status?.config||config||FALLBACK_CONFIG;

 async function verifyWallet(){
  const option=wallets.find(item=>item.info.uuid===selected)||wallets[0];
  if(!option){setMessage('Open this page in an EVM wallet browser or install a compatible browser wallet.');return;}
  setBusy(true);setMessage('Waiting for your wallet signature…');
  try{
   const accounts=await option.provider.request({method:'eth_requestAccounts'}),address=accounts?.[0];
   if(!address)throw new Error('The wallet did not return an address.');
   const challenge=await api('/api/holder-rewards/challenge',{address});
   const signature=await option.provider.request({method:'personal_sign',params:[challenge.message,address]});
   setMessage('Signature verified. Checking on-chain holding history…');
   const next=await api('/api/holder-rewards/verify',{nonce:challenge.nonce,signature});setStatus(next);setAuth('signed_in');setTick(0);setMessage('Wallet verified.');
  }catch(error:any){setMessage(error.message||'Wallet verification failed.');}finally{setBusy(false);}
 }
 async function claim(){setBusy(true);setMessage('Confirming eligibility at the latest finalized block…');try{const next=await api('/api/holder-rewards/claim',{});setStatus(next);setMessage(`${compact(next.rewardTokens)} API tokens were added to your Routers balance.`);}catch(error:any){setMessage(error.message);}finally{setBusy(false);}}
 async function checkAgain(){setBusy(true);setMessage('Checking Robinhood Chain…');try{await loadStatus();setTick(0);setMessage('Holding status refreshed.');}catch(error:any){setMessage(error.message);}finally{setBusy(false);}}

 return <section id="holder-rewards" className={`holder-rewards section page-width${standalone?' holder-rewards-standalone':''}`}>
  <div className="holder-reward-heading"><div><span className="eyebrow">HOLD. VERIFY. BUILD.</span><h2>Hold $ROUTERS.<br/>Claim up to <mark>5M tokens.</mark></h2></div><p>Keep the qualifying token balance on Robinhood Chain for 12 continuous hours. Then sign a free message and claim promotional API tokens.</p></div>
  <div className="holder-reward-shell">
   <div className="holder-reward-visual" aria-hidden="true"><div className="holder-orbit orbit-one"/><div className="holder-orbit orbit-two"/><span className="holder-node node-one"/><span className="holder-node node-two"/><span className="holder-node node-three"/><div className="holder-logo"><Image src="/routers-logo.webp" alt="" width={128} height={128}/></div><span className="holder-route route-one"/><span className="holder-route route-two"/><div className="holder-visual-copy"><small>ROBINHOOD CHAIN · 4663</small><strong>12H</strong><span>continuous hold</span></div></div>
   <div className="holder-reward-card">
    <div className="holder-live"><span><i/> {activeConfig?.enabled?'CLAIMS LIVE':'CLAIMS PAUSED'}</span>{activeConfig&&<a href={activeConfig.explorer} target="_blank" rel="noreferrer">View token contract ↗</a>}</div>
    <div className="holder-tiers"><div><span>Hold at least</span><strong>{compact(activeConfig?.minimumTokens)} $ROUTERS</strong><b>{compact(activeConfig?.baseGrant)} API tokens</b></div><div><span>Hold at least</span><strong>{compact(activeConfig?.bonusTokens)} $ROUTERS</strong><b>{compact(activeConfig?.bonusGrant)} API tokens</b></div></div>
    <div className={`holder-state ${status?.status||auth}`}>
     {auth==='checking'&&<><strong>Checking your Routers account…</strong><p>Loading reward eligibility.</p></>}
     {auth==='signed_out'&&<><strong>Sign in before you verify.</strong><p>Your X account and wallet each receive a single claim.</p><Link className="button lime" href="/signin">Sign in with X ↗</Link></>}
     {auth==='signed_in'&&status?.status==='wallet_required'&&<><strong>Verify the wallet holding $ROUTERS.</strong><p>You will sign a message only. This makes no transaction, spends no token and costs no gas.</p>{wallets.length>1&&<label>Wallet<select value={selected} onChange={event=>setSelected(event.target.value)}>{wallets.map(option=><option key={option.info.uuid} value={option.info.uuid}>{option.info.name}</option>)}</select></label>}<button className="button lime" disabled={busy} onClick={verifyWallet}>{busy?'Waiting for signature…':'Verify holder wallet ↗'}</button></>}
     {status?.status==='paused'&&<><strong>Claims are temporarily paused.</strong><p>Your verified wallet remains linked. No reward has been removed.</p></>}
     {status?.status==='below_minimum'&&<><div className="holder-wallet-line"><span>{short(status.wallet)}</span><b>{balance(status.balanceTokens)} $ROUTERS</b></div><strong>Build your qualifying balance.</strong><p>Hold at least {compact(activeConfig?.minimumTokens)} tokens continuously for 12 hours. Dropping below the tier restarts its timer.</p><button className="button" disabled={busy} onClick={checkAgain}>Check balance again ↗</button></>}
     {status?.status==='holding'&&<><div className="holder-wallet-line"><span>{short(status.wallet)}</span><b>{balance(status.balanceTokens)} $ROUTERS</b></div><strong>Your 12-hour clock is running.</strong><div className="holder-countdown">{duration(remaining)}</div><p>Keep this wallet at or above the current tier. It is tracking toward {compact(status.potentialRewardTokens)} promotional API tokens.</p><button className="button" disabled={busy} onClick={checkAgain}>Refresh on-chain status ↗</button></>}
     {status?.status==='eligible'&&<><div className="holder-wallet-line"><span>{short(status.wallet)}</span><b>{balance(status.balanceTokens)} $ROUTERS</b></div><strong>You are eligible for {compact(status.eligibleRewardTokens)} API tokens.</strong><p>The 12-hour period is verified. Claim once to add them to this Routers account.</p><button className="button lime" disabled={busy} onClick={claim}>{busy?'Confirming…':'Claim API tokens ↗'}</button></>}
     {status?.status==='claimed'&&<><div className="holder-claimed-mark">✓</div><strong>{compact(status.rewardTokens)} API tokens claimed.</strong><p>Added to your promotional balance. Create an API key or test an eligible model now.</p><div className="holder-claimed-actions"><Link className="button lime" href="/keys">Create API key ↗</Link><Link className="button" href="/playground">Open playground ↗</Link></div></>}
    </div>
    {message&&<p className="holder-message" role="status">{message}</p>}
    <p className="holder-rules">One claim per X account and wallet · {activeConfig?.expiryDays||7}-day reward expiry · Promotional models only · No token transfer or approval</p>
   </div>
  </div>
 </section>;
}
