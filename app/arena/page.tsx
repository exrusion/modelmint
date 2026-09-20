'use client';

import Link from 'next/link';
import {useRef,useState} from 'react';
import styles from './arena.module.css';

type Turn={id:number;action:string;text:string;damage:number;hit:number;tokens:number;latency:string};

const ACTIONS=[
  {id:'PLASMA BURST',icon:'✦',copy:'High damage · high risk'},
  {id:'SHIELD PULSE',icon:'◇',copy:'Low damage · strong defense'},
  {id:'SIGNAL HACK',icon:'⌁',copy:'Balanced · disrupt the core'}
];

export default function Arena(){
  const [key,setKey]=useState(''),[models,setModels]=useState<string[]>([]),[model,setModel]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[started,setStarted]=useState(false);
  const [pilotHp,setPilotHp]=useState(100),[coreHp,setCoreHp]=useState(100),[turns,setTurns]=useState<Turn[]>([]);
  const lock=useRef(false);
  const finished=pilotHp<=0||coreHp<=0;

  async function api(path:string,body?:object){
    const response=await fetch(path,{method:body?'POST':'GET',credentials:'omit',cache:'no-store',headers:{Authorization:'Bearer '+key.trim(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error?.message||'The request failed. Check the key and its balance.');
    return data;
  }

  async function connect(){
    if(lock.current||!key.trim())return;
    lock.current=true;setBusy(true);setError('');
    try{
      const data=await api('/v1/models');
      const ids:string[]=(data.data||[]).map((item:{id:string})=>item.id).sort();
      if(!ids.length)throw new Error('This key has no enabled models.');
      setModels(ids);setModel(ids[0]);
    }catch(reason){setModels([]);setModel('');setError(reason instanceof Error?reason.message:'Could not connect.');}
    finally{lock.current=false;setBusy(false);}
  }

  function reset(){setPilotHp(100);setCoreHp(100);setTurns([]);setError('');setStarted(true);}

  async function play(action:string){
    if(lock.current||finished||!model)return;
    lock.current=true;setBusy(true);setError('');
    const next=turns.length+1;
    const seed=(next*17+action.length*13)%19;
    const damage=action==='PLASMA BURST'?16+seed%11:action==='SHIELD PULSE'?5+seed%6:11+seed%10;
    const hit=action==='PLASMA BURST'?7+seed%8:action==='SHIELD PULSE'?2+seed%4:4+seed%8;
    const nextCore=Math.max(0,coreHp-damage),nextPilot=Math.max(0,pilotHp-hit);
    const prompt=`You are the battle narrator for Router Arena, a clearly labelled demo game. In two short energetic sentences with no markdown, narrate turn ${next}. The pilot used ${action}. The enemy Router Core took ${damage} damage and has ${nextCore} HP. The pilot took ${hit} damage and has ${nextPilot} HP. Do not change these numbers.`;
    const start=performance.now();
    try{
      const data=await api('/v1/chat/completions',{model,messages:[{role:'user',content:prompt}],max_completion_tokens:100,stream:false});
      const text=data.choices?.[0]?.message?.content||`${action} crossed the routing grid. The core flickers as the next move comes online.`;
      setPilotHp(nextPilot);setCoreHp(nextCore);
      setTurns(previous=>[{id:next,action,text,damage,hit,tokens:data.usage?.total_tokens??0,latency:((performance.now()-start)/1000).toFixed(1)},...previous]);
    }catch(reason){setError(reason instanceof Error?reason.message:'Move failed. No game state was changed.');}
    finally{lock.current=false;setBusy(false);}
  }

  return <main className={styles.shell}>
    <header className={styles.header}><Link href="/" className={styles.brand}><span>R</span> ROUTER ARENA</Link><div className={styles.live}><i/> LIVE API GAME</div></header>
    <div className={styles.layout}>
      <aside className={styles.console}>
        <div className={styles.kicker}>01 / CONNECT</div><h1>Bring your<br/><em>own intelligence.</em></h1>
        <p>Paste a Routers key, choose any enabled model, then use it to fight the Router Core.</p>
        <label>ROUTERS API KEY<input type="password" autoComplete="off" spellCheck={false} placeholder="sk-router-••••••" value={key} disabled={busy} onChange={event=>{setKey(event.target.value);setModels([]);setModel('');setStarted(false);setTurns([]);setError('');}}/></label>
        {!models.length?<button className={styles.primary} disabled={busy||!key.trim()} onClick={connect}>{busy?'CONNECTING…':'CONNECT KEY'} <span>↗</span></button>:<>
          <div className={styles.connected}><i/> KEY CONNECTED · {models.length} MODELS</div>
          <label>CHOOSE MODEL<select value={model} disabled={busy} onChange={event=>setModel(event.target.value)}>{models.map(id=><option key={id}>{id}</option>)}</select></label>
          <button className={styles.primary} onClick={reset}>{started?'RESTART RUN':'ENTER ARENA'} <span>↗</span></button>
        </>}
        <div className={styles.security}><b>LOCAL SESSION ONLY</b><span>Your key stays in this tab’s memory. Refreshing clears it.</span></div>
        <Link href="/keys" className={styles.link}>Create a Routers key ↗</Link>
      </aside>

      <section className={styles.game} aria-live="polite">
        <div className={styles.gameTop}><span>DEMO // SECTOR 07</span><b>{model||'MODEL NOT CONNECTED'}</b><span>TURN {turns.length.toString().padStart(2,'0')}</span></div>
        <div className={styles.arena}>
          <div className={styles.scanlines}/><div className={`${styles.orbit} ${styles.one}`}/><div className={`${styles.orbit} ${styles.two}`}/>
          <div className={styles.player}><div className={styles.ship}>R</div><strong>YOU</strong></div>
          <div className={`${styles.core} ${coreHp<=0?styles.destroyed:''}`}><div><i/><i/><i/></div><strong>ROUTER CORE</strong></div>
          <div className={styles.healths}><Meter label="PILOT" value={pilotHp}/><Meter label="CORE" value={coreHp} enemy/></div>
          {!started&&<div className={styles.overlay}><span>{models.length?'SYSTEM READY':'AWAITING KEY'}</span><p>{models.length?'Enter the arena to begin.':'Connect a valid key to load your available models.'}</p></div>}
          {started&&finished&&<div className={styles.overlay}><span>{coreHp<=0?'ROUTE CAPTURED':'SIGNAL LOST'}</span><p>{coreHp<=0?'You defeated the Router Core.':'The core ended your run.'}</p><button onClick={reset}>PLAY AGAIN</button></div>}
        </div>
        <div className={styles.actions}>{ACTIONS.map(action=><button key={action.id} disabled={!started||busy||finished} onClick={()=>play(action.id)}><i>{action.icon}</i><span><b>{action.id}</b><small>{action.copy}</small></span></button>)}</div>
        {busy&&started&&<div className={styles.thinking}><i/><span>{model} is narrating the move…</span></div>}
        {error&&<div className={styles.error} role="alert">{error}</div>}
        <div className={styles.log}><div className={styles.logTitle}><span>BATTLE LOG</span><span>REAL MODEL RESPONSES</span></div>{turns.length?turns.map(turn=><article key={turn.id}><div><b>TURN {turn.id.toString().padStart(2,'0')}</b><span>{turn.action}</span></div><p>{turn.text}</p><small>-{turn.damage} CORE · -{turn.hit} PILOT · {turn.tokens} TOKENS · {turn.latency}s</small></article>):<div className={styles.empty}>Your model’s live responses will appear here after the first move.</div>}</div>
      </section>
    </div>
  </main>;
}

function Meter({label,value,enemy=false}:{label:string;value:number;enemy?:boolean}){return <div className={styles.meter}><div><span>{label}</span><b>{value} HP</b></div><i><span className={enemy?styles.enemyBar:''} style={{width:`${value}%`}}/></i></div>}
