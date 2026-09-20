'use client';

import Image from 'next/image';
import {type CSSProperties,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import styles from './router-walkthrough.module.css';

const TOTAL_SECONDS=50;

const stages=[
  {id:'intro',label:'INTRO',start:0,end:3},
  {id:'signin',label:'SIGN IN',start:3,end:8},
  {id:'credit',label:'CREDIT',start:8,end:15},
  {id:'pay',label:'PAY',start:15,end:20},
  {id:'models',label:'MODELS',start:20,end:29},
  {id:'dashboard',label:'DASHBOARD',start:29,end:38},
  {id:'connect',label:'CONNECT',start:38,end:45},
  {id:'final',label:'FINISH',start:45,end:50},
] as const;

const timeline=[
  {label:'SIGN IN',time:3},
  {label:'CREDIT',time:8},
  {label:'PAY',time:15},
  {label:'MODELS',time:20},
  {label:'CONNECT',time:38},
] as const;

const clamp=(value:number,min=0,max=1)=>Math.min(max,Math.max(min,value));
const ease=(value:number)=>1-Math.pow(1-clamp(value),3);

type PublicSignup={username:string;avatar_url?:string|null;created_at:string};

function SignupFeed(){
  const [signups,setSignups]=useState<PublicSignup[]>([]);
  useEffect(()=>{
    const controller=new AbortController();
    fetch('/api/public',{signal:controller.signal})
      .then(response=>response.ok?response.json():Promise.reject(new Error('Signup feed unavailable')))
      .then(data=>setSignups(Array.isArray(data.signups)?data.signups:[]))
      .catch(error=>{if(error.name!=='AbortError')setSignups([])});
    return()=>controller.abort();
  },[]);
  return <section className={styles.signupFeed} aria-labelledby="recent-signups-title"><div className={styles.signupHeading}><div><span>ROUTERS COMMUNITY</span><h2 id="recent-signups-title">Recent signups</h2></div><p><i/> LIVE</p></div>{signups.length?<div className={styles.signupGrid}>{signups.map(signup=><a href={`https://x.com/${signup.username}`} target="_blank" rel="noreferrer" key={`${signup.username}-${signup.created_at}`}><b><span>{signup.username.slice(0,1).toUpperCase()}</span><img src={signup.avatar_url||`https://unavatar.io/x/${encodeURIComponent(signup.username)}`} alt={`@${signup.username} profile`} loading="lazy" referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true}}/></b><span><strong>@{signup.username}</strong><small>Joined {new Date(signup.created_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</small></span><em>↗</em></a>)}</div>:<div className={styles.signupEmpty}>New Router builders will appear here.</div>}<p className={styles.signupPrivacy}>Public X handles and signup times only. Wallets, balances and API activity stay private.</p></section>;
}

type StageProps={active:boolean;children:React.ReactNode;className?:string};
export function WalkthroughStage({active,children,className=''}:StageProps){
  return <div className={`${styles.scene} ${active?styles.active:''} ${className}`} aria-hidden={!active}>{children}</div>;
}

export function DemoCursor({x,y,click=false}: {x:number;y:number;click?:boolean}){
  return <span className={`${styles.cursor} ${click?styles.cursorClick:''}`} style={{'--cursor-x':`${x}%`,'--cursor-y':`${y}%`} as CSSProperties}><i/></span>;
}

function DemoLogo({large=false}:{large?:boolean}){
  return <span className={`${styles.demoLogo} ${large?styles.demoLogoLarge:''}`}><Image src="/routers-logo.webp" width={96} height={96} alt=""/><strong>Routers</strong></span>;
}

function RoutingLines(){
  return <div className={styles.routingMap} aria-hidden="true"><svg viewBox="0 0 720 250" preserveAspectRatio="none"><path d="M94 124 C190 124 205 54 305 54 S455 124 530 124 S605 48 665 48"/><path d="M94 124 C190 124 220 198 310 198 S430 124 530 124 S605 204 665 204"/><path d="M94 124 C225 124 310 124 530 124"/></svg>{['GPT','Claude','Gemini','Grok','Qwen'].map((name,index)=><span key={name} style={{'--node-index':index} as CSSProperties}>{name}</span>)}</div>;
}

function IntroScene({active}:{active:boolean}){
  return <WalkthroughStage active={active} className={styles.introScene}><div className={styles.introContent}><span className={styles.demoPill}>DEMO WALKTHROUGH</span><DemoLogo large/><h3>More intelligence.<br/><em>Less spend.</em></h3><span className={styles.liveLine}><i/> DOUBLE CREDIT IS LIVE</span></div><RoutingLines/></WalkthroughStage>;
}

function SignInScene({active,progress}:{active:boolean;progress:number}){
  const success=progress>.66;
  return <WalkthroughStage active={active} className={styles.signinScene}><div className={styles.miniHeader}><DemoLogo/><span className={styles.demoSignIn}>Sign in</span></div><div className={`${styles.authDemo} ${success?styles.success:''}`}><span className={styles.sceneKicker}>FIRST-TIME SIGNUP REWARD</span>{success?<><span className={styles.successMark}>✓</span><h3>Welcome to Routers.</h3><p>1,000,000 demo base tokens added</p></>:<><span className={styles.xMark}>𝕏</span><h3>Sign up with X</h3><p>Get 1,000,000 base tokens free</p><span className={styles.xButton}>Continue with X <b>↗</b></span></>}</div><DemoCursor x={success?58:88} y={success?72:12} click={progress>.3&&progress<.5}/><span className={styles.demoCorner}>DEMO · No OAuth request is made</span></WalkthroughStage>;
}

export function CreditPurchaseScene({active,progress}:{active:boolean;progress:number}){
  const sweep=Math.min(3,Math.floor(clamp(progress/.58)*4));
  const selected=progress>.58?1:sweep;
  const count=ease((progress-.58)/.42);
  const cursorX=[24,42,60,78][selected];
  return <WalkthroughStage active={active} className={styles.creditScene}><div className={styles.purchaseCard}><div className={styles.purchaseHead}><strong>Buy API credit</strong><span>Pay as you go</span></div><p>Choose your credit</p><div className={styles.creditChoices}>{[10,20,50,100].map((amount,index)=><span className={selected===index?styles.selected:''} key={amount}><b>${amount}</b><small>CREDIT</small></span>)}</div><div className={styles.creditEquation}><span>You pay<strong>${Math.round(10*count)}</strong></span><b>→</b><span>You get<strong>${Math.round(20*count)}</strong></span></div><div className={styles.doubleCredit}><i>2×</i><span>usage credit on every top-up</span></div></div><DemoCursor x={cursorX} y={38} click={progress>.58&&progress<.73}/><span className={styles.demoCorner}>DEMO · Credit selection</span></WalkthroughStage>;
}

function NetworkScene({active,progress}:{active:boolean;progress:number}){
  const confirmed=progress>.62;
  return <WalkthroughStage active={active} className={styles.networkScene}><div className={styles.purchaseCard}><div className={styles.purchaseHead}><strong>Choose payment network</strong><span>Demo checkout</span></div><div className={styles.networkChoices}>{['Ethereum','Robinhood','Solana'].map(name=><span className={name==='Robinhood'?styles.selected:''} key={name}><i>◆</i>{name}</span>)}</div><div className={`${styles.walletConfirm} ${confirmed?styles.confirmed:''}`}>{confirmed?<><span className={styles.successMark}>✓</span><div><strong>Payment confirmed</strong><small>$20 API balance added</small></div></>:<><span className={styles.walletOrb}>◇</span><div><strong>Confirm demo payment</strong><small>No wallet is connected</small></div><span className={styles.loadingDots}>•••</span></>}</div><div className={styles.networkAmount}><span>You pay <b>$10</b></span><span>Robinhood</span><span>You get <b>$20</b></span></div></div><DemoCursor x={50} y={confirmed?68:38} click={progress>.25&&progress<.43}/><span className={styles.demoCorner}>DEMO · No funds are moved</span></WalkthroughStage>;
}

const modelNames=[['GPT','◎'],['Claude','✳'],['Grok','𝕏'],['Gemini','✦'],['DeepSeek','◒'],['Qwen','Q'],['Kimi','K'],['GLM','G']];
export function ModelRoutingScene({active,progress}:{active:boolean;progress:number}){
  return <WalkthroughStage active={active} className={styles.modelsScene}><div className={styles.modelsCopy}><span className={styles.sceneKicker}>ONE KEY. EVERY MODEL.</span><h3>Route to the right<br/>model in one call.</h3><ul><li>One API key</li><li>Every supported model</li><li>Automatic model routing</li></ul></div><div className={styles.modelCloud}>{modelNames.map(([name,mark],index)=><span className={progress>index*.055?styles.visible:''} style={{'--model-index':index} as CSSProperties} key={name}><i>{mark}</i><strong>{name}</strong></span>)}<svg viewBox="0 0 500 300" preserveAspectRatio="none" aria-hidden="true"><path d="M35 150 C130 150 110 42 238 48 C345 52 332 150 465 150"/><path d="M35 150 C130 150 115 258 238 252 C345 248 332 150 465 150"/><path d="M35 150 C160 150 330 150 465 150"/></svg><i className={styles.routeSpark} style={{left:`${4+clamp(progress)*88}%`,top:`${50+Math.sin(clamp(progress)*Math.PI*2)*20}%`}}/></div><span className={styles.demoCorner}>DEMO · Supported models</span></WalkthroughStage>;
}

export function DashboardScene({active,progress}:{active:boolean;progress:number}){
  const count=ease(progress/.45);
  return <WalkthroughStage active={active} className={styles.dashboardScene}><div className={styles.dashboardTop}><DemoLogo/><span>Demo workspace</span><i>● LIVE</i></div><div className={styles.dashboardGrid}><article className={styles.balanceCard}><small>DOLLAR BALANCE</small><strong>${(20*count).toFixed(2)}</strong><span>Available API credit</span></article><article><small>BASE TOKENS REMAINING</small><strong>{Math.round(1000000*count).toLocaleString()}</strong><span>Demo promotional tokens</span></article><article><small>REQUESTS TODAY</small><strong>{Math.round(18*count)}</strong><span>Across 4 models</span></article><article><small>TOKENS CONSUMED</small><strong>{Math.round(84210*count).toLocaleString()}</strong><span>Weighted usage today</span></article><article className={styles.capacityCard}><small>DAILY PLATFORM CAPACITY</small><div><span style={{width:`${Math.round(68*count)}%`}}/></div><b>{Math.round(68*count)}% available</b></article><article className={styles.keyCard}><small>MASKED DEMO KEY</small><code>sk-router-demo-••••••7x9K</code><span>Never expose a real secret</span></article></div><span className={styles.demoCorner}>DEMO · Deterministic workspace data</span></WalkthroughStage>;
}

export function MigrationScene({active,progress}:{active:boolean;progress:number}){
  const response='Routers connected. Streaming from Claude through one compatible endpoint.';
  const typed=response.slice(0,Math.round(response.length*clamp((progress-.48)/.42)));
  return <WalkthroughStage active={active} className={styles.migrationScene}><div className={styles.migrationCopy}><span className={styles.sceneKicker}>TWO-LINE MIGRATION</span><h3>Change two lines.<br/>Keep building.</h3><div className={styles.capabilities}>{['OpenAI-compatible','Streaming','Tool calls','Vision','Model routing'].map(item=><span key={item}>{item}</span>)}</div></div><div className={styles.codeDemo}><div className={styles.codeBar}><span>.env · Demo</span><i>•••</i></div><pre><em># Route your app through Routers</em>{'\n'}OPENAI_BASE_URL=<b>https://api.routers.markets/v1</b>{'\n'}OPENAI_API_KEY=<b>sk-router-demo-••••••7x9K</b></pre><div className={styles.requestDemo}><span><i/> 200 OK</span><p>{typed}<b className={styles.typeCursor}/></p></div></div><DemoCursor x={75} y={71} click={progress>.4&&progress<.5}/><span className={styles.demoCorner}>DEMO · Masked credential</span></WalkthroughStage>;
}

function FinalScene({active}:{active:boolean}){
  return <WalkthroughStage active={active} className={styles.finalScene}><RoutingLines/><div className={styles.finalContent}><DemoLogo large/><h3>Pay less.<br/><em>Route anywhere.</em></h3><div><span>Get 1M free tokens</span><span>Explore models</span></div><strong>routers.markets</strong><small>DEMO WALKTHROUGH COMPLETE</small></div></WalkthroughStage>;
}

export function ProgressTimeline({elapsed,onSeek}:{elapsed:number;onSeek:(seconds:number)=>void}){
  return <div className={styles.timeline}><span className={styles.progressTrack}><i style={{width:`${elapsed/TOTAL_SECONDS*100}%`}}/></span>{timeline.map((item,index)=>{const next=timeline[index+1]?.time??TOTAL_SECONDS;const current=elapsed>=item.time&&elapsed<next;return <button type="button" className={current?styles.current:''} aria-label={`Jump to ${item.label.toLowerCase()} stage`} aria-pressed={current} onClick={()=>onSeek(item.time)} key={item.label}><i/>{item.label}</button>})}</div>;
}

export default function RouterWalkthrough(){
  const rootRef=useRef<HTMLElement|null>(null);
  const elapsedRef=useRef(0);
  const playingRef=useRef(false);
  const resumeRef=useRef(false);
  const startedRef=useRef(false);
  const [elapsed,setElapsed]=useState(0);
  const [playing,setPlaying]=useState(false);
  const [reducedMotion,setReducedMotion]=useState(false);

  const setPlayback=useCallback((next:boolean)=>{playingRef.current=next;setPlaying(next)},[]);
  const seek=useCallback((seconds:number)=>{elapsedRef.current=seconds;setElapsed(seconds);setPlayback(!reducedMotion)},[reducedMotion,setPlayback]);
  const restart=useCallback(()=>{elapsedRef.current=0;setElapsed(0);setPlayback(!reducedMotion)},[reducedMotion,setPlayback]);
  const togglePlayback=useCallback(()=>{if(playingRef.current){setPlayback(false);return}if(elapsedRef.current>=TOTAL_SECONDS){elapsedRef.current=0;setElapsed(0)}setPlayback(!reducedMotion)},[reducedMotion,setPlayback]);

  useEffect(()=>{
    const media=window.matchMedia('(prefers-reduced-motion: reduce)');
    const update=()=>{setReducedMotion(media.matches);if(media.matches)setPlayback(false)};
    update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);
  },[setPlayback]);

  useEffect(()=>{
    const node=rootRef.current;if(!node)return;
    const observer=new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting&&!startedRef.current){startedRef.current=true;if(!reducedMotion)setPlayback(true)}},{threshold:.34});
    observer.observe(node);return()=>observer.disconnect();
  },[reducedMotion,setPlayback]);

  useEffect(()=>{
    if(!playing)return;
    let frame=0;let previous=performance.now();
    const tick=(now:number)=>{const delta=Math.min(100,now-previous);previous=now;const next=Math.min(TOTAL_SECONDS,elapsedRef.current+delta/1000);elapsedRef.current=next;setElapsed(next);if(next>=TOTAL_SECONDS){setPlayback(false);return}frame=requestAnimationFrame(tick)};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[playing,setPlayback]);

  useEffect(()=>{
    const onVisibility=()=>{if(document.hidden){resumeRef.current=playingRef.current;setPlayback(false)}else if(resumeRef.current&&!reducedMotion){resumeRef.current=false;setPlayback(true)}};
    document.addEventListener('visibilitychange',onVisibility);return()=>document.removeEventListener('visibilitychange',onVisibility);
  },[reducedMotion,setPlayback]);

  const activeIndex=useMemo(()=>elapsed>=TOTAL_SECONDS?stages.length-1:Math.max(0,stages.findIndex(stage=>elapsed>=stage.start&&elapsed<stage.end)),[elapsed]);
  const stage=stages[activeIndex]||stages[stages.length-1];
  const stageProgress=clamp((elapsed-stage.start)/(stage.end-stage.start));
  const sceneProps=(id:typeof stages[number]['id'])=>({active:stage.id===id,progress:stage.id===id?stageProgress:0});

  return <><section className={styles.walkthrough} ref={rootRef} aria-labelledby="router-walkthrough-title"><div className={styles.heading}><div><span>PRODUCT WALKTHROUGH</span><h2 id="router-walkthrough-title">See how Routers works</h2></div><p>One balance. Every model. Half the spend.</p></div><div className={styles.frame}><div className={styles.browserBar}><span className={styles.windowDots}><i/><i/><i/></span><span className={styles.address}><i/> routers.markets <b>DEMO</b></span><span className={styles.timer}>{Math.floor(elapsed).toString().padStart(2,'0')} / 50</span></div><div className={styles.viewport}><IntroScene active={stage.id==='intro'}/><SignInScene {...sceneProps('signin')}/><CreditPurchaseScene {...sceneProps('credit')}/><NetworkScene {...sceneProps('pay')}/><ModelRoutingScene {...sceneProps('models')}/><DashboardScene {...sceneProps('dashboard')}/><MigrationScene {...sceneProps('connect')}/><FinalScene active={stage.id==='final'}/></div><div className={styles.controls}><div className={styles.controlButtons}><button type="button" onClick={togglePlayback} aria-label={playing?'Pause walkthrough':'Play walkthrough'}>{playing?'Ⅱ':'▶'} <span>{playing?'Pause':'Play'}</span></button><button type="button" onClick={restart} aria-label="Restart walkthrough">↺ <span>Restart</span></button></div><ProgressTimeline elapsed={elapsed} onSeek={seek}/></div></div>{reducedMotion&&<p className={styles.reducedNote}>Automatic motion is paused because reduced motion is enabled. Use the timeline to explore each stage.</p>}</section><SignupFeed/></>;
}
