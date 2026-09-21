'use client';

import Image from 'next/image';
import Link from 'next/link';
import {useCallback,useEffect,useMemo,useState} from 'react';

type WalletOption={info:{uuid:string;name:string};provider:{request:(args:{method:string;params?:unknown[]})=>Promise<any>}};
type Pool={purchaseCreditMicro:string;rewardCreditMicro:string;rewardBaseTokens:string;recipientCount:number;createdAt:string;buyer:string};
type Config={enabled:boolean;rewardPercent:number;chainId:number;chainName:string;tokenAddress:string;tokenSymbol:string;stakers:number;totalStakedTokens:string;distributedCreditMicro:string;distributedBaseTokens:string;recentPools:Pool[]};
type Status={config:Config;status:'not_staking'|'staking'|'stopped';wallet?:string;stakedTokens?:string;walletBalanceTokens?:string;effectiveStakeTokens?:string;startedAt?:string;lastRewardAt?:string;earnedCreditMicro:string;earnedBaseTokens:string;rewardCount:number;recent:Array<{rewardCreditMicro:string;rewardBaseTokens:string;purchaseCreditMicro:string;createdAt:string}>};

const FALLBACK:Config={enabled:true,rewardPercent:10,chainId:4663,chainName:'Robinhood Chain',tokenAddress:'0xf1498261e22d5232361f5188b5238e495abdaecf',tokenSymbol:'ROUTERS',stakers:0,totalStakedTokens:'0',distributedCreditMicro:'0',distributedBaseTokens:'0',recentPools:[]};
async function api(path:string,body?:Record<string,unknown>){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,cache:'no-store'}),data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(data.error?.message||'Unable to complete this request.'),{status:response.status});return data;}
function compact(value?:string|number){return Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(Number(value||0));}
function dollars(micro?:string|number){return '$'+(Number(micro||0)/1e6).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});}
function short(address?:string){return address?address.slice(0,7)+'…'+address.slice(-5):'';}

export default function StakingRewards({standalone=false}:{standalone?:boolean}){
 const [config,setConfig]=useState<Config>(FALLBACK),[status,setStatus]=useState<Status|null>(null),[auth,setAuth]=useState<'checking'|'in'|'out'>('checking');
 const [wallets,setWallets]=useState<WalletOption[]>([]),[selected,setSelected]=useState(''),[amount,setAmount]=useState('2000000'),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const load=useCallback(async(fresh=false)=>{try{const data=await api('/api/staking/status'+(fresh?'?fresh=1':''));setStatus(data);setConfig(data.config);setAuth('in');return data;}catch(error:any){if(error.status===401){setAuth('out');setStatus(null);return null;}throw error;}},[]);
 useEffect(()=>{let live=true;api('/api/staking/public').then(data=>{if(live)setConfig(data);}).catch(()=>{});load().catch((error:any)=>{if(live)setMessage(error.message);});return()=>{live=false};},[load]);
 useEffect(()=>{const announce=(event:Event)=>{const wallet=(event as CustomEvent<WalletOption>).detail;if(!wallet?.info?.uuid)return;setWallets(current=>current.some(item=>item.info.uuid===wallet.info.uuid)?current:[...current,wallet]);setSelected(current=>current||wallet.info.uuid);};window.addEventListener('eip6963:announceProvider',announce);window.dispatchEvent(new Event('eip6963:requestProvider'));const injected=(window as any).ethereum;if(injected){const fallback={info:{uuid:'injected',name:'Browser wallet'},provider:injected};setWallets(current=>current.length?current:[fallback]);setSelected(current=>current||'injected');}return()=>window.removeEventListener('eip6963:announceProvider',announce);},[]);
 const share=useMemo(()=>{const mine=Number(status?.effectiveStakeTokens||0),total=Number(config.totalStakedTokens||0);return total>0?Math.min(100,mine/total*100):0;},[status?.effectiveStakeTokens,config.totalStakedTokens]);

 async function activate(){
  const option=wallets.find(item=>item.info.uuid===selected)||wallets[0];if(!option){setMessage('Open this page in MetaMask, Trust Wallet or another compatible EVM wallet.');return;}
  if(!/^\d[\d,]*(\.\d{1,18})?$/.test(amount.trim())||Number(amount.replace(/,/g,''))<=0){setMessage('Enter a valid amount of $ROUTERS to stake.');return;}
  setBusy(true);setMessage('Waiting for your free wallet signature…');
  try{const accounts=await option.provider.request({method:'eth_requestAccounts'}),address=accounts?.[0];if(!address)throw new Error('The wallet did not return an address.');const challenge=await api('/api/staking/challenge',{address,amount});const signature=await option.provider.request({method:'personal_sign',params:[challenge.message,address]});setMessage('Checking your $ROUTERS balance on Robinhood Chain…');const next=await api('/api/staking/activate',{nonce:challenge.nonce,signature});setStatus(next);setConfig(next.config);setMessage('Staking is active. Future purchase pools will include your verified weight.');}catch(error:any){setMessage(error.message||'Unable to activate staking.');}finally{setBusy(false);}
 }
 async function refresh(){setBusy(true);setMessage('Refreshing your on-chain balance…');try{await load(true);setMessage('Stake weight refreshed.');}catch(error:any){setMessage(error.message);}finally{setBusy(false);}}
 async function stop(){setBusy(true);try{const next=await api('/api/staking/stop',{});setStatus(next);setConfig(next.config);setMessage('Staking stopped. Your tokens never left your wallet.');}catch(error:any){setMessage(error.message);}finally{setBusy(false);}}

 return <section className={`staking-section section page-width${standalone?' staking-standalone':''}`} id="staking">
  <div className="staking-heading"><div><span className="eyebrow">STAKE. SHARE. BUILD.</span><h2>Stake $ROUTERS.<br/>Share <mark>10% of purchases.</mark></h2></div><p>Every confirmed API-credit purchase creates a 10% reward pool. Active stakers receive API credit according to their verified share of the total stake.</p></div>
  <div className="staking-shell">
   <div className="staking-pulse">
    <div className="staking-rings" aria-hidden="true"><i/><i/><i/><Image className="staking-lock-art" src="/routers-staking-emblem.webp" width={768} height={768} alt=""/></div>
    <div className="staking-pool-stat"><span>LIVE PURCHASE SHARE</span><strong>{config.rewardPercent}%</strong><small>distributed as API credit</small></div>
    <div className="staking-network"><span><i/> {config.enabled?'REWARDS ACTIVE':'REWARDS PAUSED'}</span><a href={`https://robinhoodchain.blockscout.com/token/${config.tokenAddress}`} target="_blank" rel="noreferrer">Contract ↗</a></div>
   </div>
   <div className="staking-workspace">
    <div className="staking-metrics"><div><span>Total staked</span><strong>{compact(config.totalStakedTokens)}</strong><small>$ROUTERS</small></div><div><span>Stakers</span><strong>{config.stakers}</strong><small>active wallets</small></div><div><span>Credit shared</span><strong>{dollars(config.distributedCreditMicro)}</strong><small>{compact(config.distributedBaseTokens)} API tokens</small></div></div>
    <div className="staking-action">
     {auth==='checking'&&<><strong>Checking your staking position…</strong><p>Loading your Routers account.</p></>}
     {auth==='out'&&<><strong>Sign in to start staking.</strong><p>Your X account links reward credit to your Routers workspace.</p><Link className="button lime" href="/signin">Sign in with X ↗</Link></>}
     {auth==='in'&&(!status||status.status==='not_staking'||status.status==='stopped')&&<><strong>{status?.status==='stopped'?'Restart your stake.':'Choose your staking weight.'}</strong><p>No transfer and no token approval. Routers verifies that the selected amount remains in your wallet whenever a purchase settles.</p><label className="staking-amount"><span>$ROUTERS to stake</span><input inputMode="decimal" value={amount} onChange={event=>setAmount(event.target.value)} placeholder="2,000,000"/></label>{wallets.length>1&&<label className="staking-wallet"><span>Wallet</span><select value={selected} onChange={event=>setSelected(event.target.value)}>{wallets.map(wallet=><option value={wallet.info.uuid} key={wallet.info.uuid}>{wallet.info.name}</option>)}</select></label>}<button className="button lime" onClick={activate} disabled={busy||!config.enabled}>{busy?'Waiting for wallet…':'Start staking ↗'}</button></>}
     {status?.status==='staking'&&<><div className="staking-wallet-line"><span>{short(status.wallet)}</span><b>ACTIVE</b></div><div className="staking-position"><div><span>Your stake</span><strong>{compact(status.stakedTokens)}</strong></div><div><span>Verified weight</span><strong>{compact(status.effectiveStakeTokens)}</strong></div><div><span>Current pool share</span><strong>{share.toFixed(2)}%</strong></div></div><div className="staking-earned"><span>Earned from {status.rewardCount} purchase{status.rewardCount===1?'':'s'}</span><strong>{dollars(status.earnedCreditMicro)}</strong><small>{compact(status.earnedBaseTokens)} API tokens added automatically</small></div><div className="staking-actions"><button className="button lime" onClick={refresh} disabled={busy}>Refresh weight ↗</button><button className="staking-stop" onClick={stop} disabled={busy}>Stop staking</button></div></>}
    </div>
    {message&&<p className="staking-message" role="status">{message}</p>}
   </div>
  </div>
  <div className="staking-feed"><div><span className="eyebrow">RECENT REWARD POOLS</span><p>10% of credited API value, distributed at the finalized wallet snapshot.</p></div><div className="staking-feed-list">{config.recentPools?.length?config.recentPools.slice(0,4).map((pool,index)=><div className="staking-feed-row" key={pool.createdAt+index}><span><i/> @{pool.buyer} purchased {dollars(pool.purchaseCreditMicro)}</span><strong>{dollars(pool.rewardCreditMicro)} shared</strong><small>{pool.recipientCount} staker{pool.recipientCount===1?'':'s'}</small></div>):<div className="staking-feed-empty">The next confirmed API-credit purchase will create the first staking pool.</div>}</div></div>
  <p className="staking-rules">Rewards are API usage credit, not cash · Weight is capped by the wallet’s verified token balance · Selling or moving tokens reduces future rewards · No custody, approval or guaranteed return</p>
 </section>;
}
