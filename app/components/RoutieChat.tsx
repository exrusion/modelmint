'use client';

import Image from 'next/image';
import Link from 'next/link';
import {FormEvent,useEffect,useRef,useState} from 'react';
import styles from './routie-chat.module.css';

type Model={
  id:string;
  name:string;
  family:string;
  enabled?:boolean;
  verified?:boolean;
  promo?:boolean;
  vision?:boolean;
  tools?:boolean;
  json_format?:boolean;
  premium?:boolean;
  max_context?:number|string;
  ratio?:number|string;
  input_rate?:number|string;
  output_rate?:number|string;
  auto_quality?:number|string;
};

type Action={label:string;href:string};
type Pick={id:string;name:string;family:string;reason:string};
type Message={id:number;role:'assistant'|'user';text:string;actions?:Action[];picks?:Pick[]};
type Answer={text:string;actions?:Action[];picks?:Pick[]};

const quickQuestions=['Best model for coding','Cheapest live model','How do I get an API key?','How does Routers Auto work?'];
const initialMessage:Message={
  id:1,
  role:'assistant',
  text:'Hey, I’m Routie. Ask me how Routers works, or tell me what you’re building and I’ll suggest the best live models.'
};

const number=(value:unknown)=>Number(value||0);
const compact=(value:unknown)=>Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:1}).format(number(value));

function pickModels(question:string,models:Model[]):Pick[]{
  const q=question.toLowerCase();
  const wantsCheap=/cheap|lowest|budget|affordable|cost/.test(q);
  const wantsVision=/vision|image|photo|screenshot|ocr/.test(q);
  const wantsTools=/tool|function call|agent/.test(q);
  const wantsCode=/code|coding|developer|typescript|javascript|python|program/.test(q);
  const wantsLong=/long context|large context|document|pdf|book/.test(q);
  const wantsPremium=/premium/.test(q);
  let candidates=models.filter(model=>model.enabled&&model.verified);

  if(wantsVision&&candidates.some(model=>model.vision))candidates=candidates.filter(model=>model.vision);
  if(wantsTools&&candidates.some(model=>model.tools))candidates=candidates.filter(model=>model.tools);
  if(wantsPremium&&candidates.some(model=>model.premium))candidates=candidates.filter(model=>model.premium);

  const scored=candidates.map(model=>{
    const searchable=(model.id+' '+model.name+' '+model.family).toLowerCase();
    const cost=number(model.input_rate)+number(model.output_rate);
    let score=number(model.auto_quality)*2-number(model.ratio);
    if(wantsCheap)score-=cost*22+number(model.ratio)*5;
    if(wantsLong)score+=number(model.max_context)/10000;
    if(wantsCode){
      if(/code|coder/.test(searchable))score+=90;
      if(/gpt|claude|qwen|deepseek|kimi/.test(searchable))score+=34;
      if(model.tools)score+=12;
      if(model.json_format)score+=8;
    }
    if(wantsVision&&model.vision)score+=70;
    if(wantsTools&&model.tools)score+=55;
    if(/strongest|quality|best|reason|complex/.test(q))score+=number(model.auto_quality)*2;
    if(wantsPremium&&model.premium)score+=35;
    return {model,score,cost};
  }).sort((a,b)=>b.score-a.score||a.cost-b.cost);

  const selected:typeof scored=[];
  for(const item of scored){
    if(selected.length>=3)break;
    if(selected.some(current=>current.model.family===item.model.family)&&scored.length>3)continue;
    selected.push(item);
  }

  return selected.map(({model})=>{
    let reason='High current Routie quality score';
    if(wantsCheap)reason=`Low listed rates · ×${number(model.ratio)} base-token ratio`;
    else if(wantsVision)reason=`Vision enabled · ${compact(model.max_context)} context`;
    else if(wantsTools)reason=`Tool calling${model.json_format?' + JSON':''} enabled`;
    else if(wantsCode)reason=`Strong coding fit${model.tools?' · tools enabled':''}`;
    else if(wantsLong)reason=`${compact(model.max_context)} context window`;
    else if(number(model.auto_quality))reason=`Routie quality score ${number(model.auto_quality)}/100`;
    return {id:model.id,name:model.name,family:model.family,reason};
  });
}

function answer(question:string,models:Model[]):Answer{
  const q=question.toLowerCase().trim();
  const live=models.filter(model=>model.enabled&&model.verified);

  if(/hello|^hi\b|^hey\b|who are you|what can you do/.test(q))return {
    text:'I’m Routie, the Routers guide. I can explain pricing, payments, keys, rewards, privacy and Routers Auto, or recommend from the live model catalogue.',
    actions:[{label:'See live models',href:'/models'}]
  };
  if(/routers\/auto|routers auto|auto rout|automatic rout|fastest/.test(q))return {
    text:'Use the model ID routers/auto. Routie filters the verified models your key can use, then ranks them with balanced, cheapest, fastest or best. The real selected model is returned in the response and X-Routers-Model header. Exact model IDs are never silently swapped.',
    actions:[{label:'Explore Routers Auto',href:'/auto'},{label:'Read the docs',href:'/docs'}]
  };
  if(/gift|send.*credit|transfer.*credit/.test(q))return {
    text:'You can gift purchased API credit to an X handle, verified email or private claim link. Promotional credit cannot be transferred. Unclaimed gifts can be cancelled and expire after seven days.',
    actions:[{label:'Gift API credit',href:'/gifts'}]
  };
  if(/holder|2m|10m|token reward|\$routers/.test(q))return {
    text:'Hold 2M $ROUTERS for 12 continuous hours to claim 500K promotional API tokens, or 10M for 12 hours to claim 5M. Verification is a free wallet signature—no approval or transaction.',
    actions:[{label:'Check holder rewards',href:'/rewards'}]
  };
  if(/sign.?up|free token|1m token|new account/.test(q))return {
    text:'Eligible first-time users can sign in with X and receive 1M promotional base tokens for supported models. The reward is separate from purchased credit.',
    actions:[{label:'Sign in with X',href:'/signin'}]
  };
  if(/api key|base url|endpoint|connect.*app|integration|sdk/.test(q))return {
    text:'Sign in, open API keys and create a key. Keep it on your server, then use the OpenAI-compatible base URL https://routers.markets/v1. One key works across every enabled model available to it.',
    actions:[{label:'Create an API key',href:'/keys'},{label:'Open documentation',href:'/docs'}]
  };
  if(/wallet|pay to address|payment|top.?up|buy credit|solana|ethereum|robinhood/.test(q))return {
    text:'Choose a credit amount, then either pay with a wallet or use Pay to address—wallet connection is not required for direct payment. Routers supports SOL on Solana and ETH on Ethereum or Robinhood, and credits verified transfers automatically.',
    actions:[{label:'Buy API credit',href:'/pricing'}]
  };
  if(/price|pricing|double|\$10|\$20|subscription|cost of credit/.test(q))return {
    text:'Routers currently doubles every top-up: pay $10 and receive $20 in API usage credit, or pay $50 and receive $100. There is no subscription or setup fee. Each model has its own displayed token rates and base-token ratio.',
    actions:[{label:'See pricing',href:'/pricing'}]
  };
  if(/privacy|store.*prompt|prompt.*store|response.*store|data/.test(q))return {
    text:'Routers stores billing metadata such as model, token counts, cost, status and timing. It does not store your prompt or generated response text. The selected upstream provider still processes request content under its own policies.',
    actions:[{label:'Privacy policy',href:'/privacy'}]
  };
  if(/playground|test.*api|try.*model/.test(q))return {
    text:'Open the Playground, paste a Routers API key, choose any model available to that key and send a real request. Your key stays only in the active browser tab and is cleared on refresh.',
    actions:[{label:'Open Playground',href:'/playground'}]
  };
  if(/model|coding|code|vision|image|reason|cheap|budget|premium|context|agent|tool|json|write|research/.test(q)){
    if(!live.length)return {text:'The live model catalogue is still loading. Open Models to see every model that is currently enabled and verified.',actions:[{label:'Open Models',href:'/models'}]};
    if(/fastest/.test(q))return {text:'Model speed changes over time, so use routers/auto with the fastest strategy. It ranks compatible models using measured successful latency instead of a static claim.',actions:[{label:'Use Routers Auto',href:'/auto'}]};
    const picks=pickModels(q,live);
    return {
      text:`Based on the ${live.length} verified live models, these are the strongest matches for what you described. If you do not want to choose manually, use routers/auto with balanced.`,
      picks,
      actions:[{label:'Compare all models',href:'/models'},{label:'Try in Playground',href:'/playground'}]
    };
  }
  if(/what is routers|how.*work|about.*routers/.test(q))return {
    text:'Routers gives you one OpenAI-compatible endpoint, one API key and one balance across its verified model catalogue. You can select an exact model or use routers/auto to let Routie choose.',
    actions:[{label:'Read the docs',href:'/docs'}]
  };
  if(/support|help|contact|human|issue|problem/.test(q))return {
    text:'For an account or payment issue, keep your invoice ID or transaction hash and contact @RoutersMarket on X. Never post an API key, wallet seed phrase or other secret.',
    actions:[{label:'Open platform status',href:'/status'}]
  };
  return {
    text:'I can help with Routers pricing, payments, API keys, rewards, privacy, Routers Auto and live model recommendations. Try asking “best model for coding” or “how do I pay without connecting a wallet?”',
    actions:[{label:'Read the docs',href:'/docs'},{label:'Browse models',href:'/models'}]
  };
}

export default function RoutieChat({models=[]}:{models?:Model[]}){
  const [open,setOpen]=useState(false);
  const [draft,setDraft]=useState('');
  const [messages,setMessages]=useState<Message[]>([initialMessage]);
  const nextId=useRef(2);
  const inputRef=useRef<HTMLInputElement>(null);
  const logRef=useRef<HTMLDivElement>(null);
  const liveCount=models.filter(model=>model.enabled&&model.verified).length;

  useEffect(()=>{
    const openChat=()=>setOpen(true);
    const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false)};
    window.addEventListener('routers:open-routie',openChat);
    window.addEventListener('keydown',closeOnEscape);
    return()=>{window.removeEventListener('routers:open-routie',openChat);window.removeEventListener('keydown',closeOnEscape)};
  },[]);
  useEffect(()=>{if(open)setTimeout(()=>inputRef.current?.focus(),80)},[open]);
  useEffect(()=>{if(open)logRef.current?.scrollTo({top:logRef.current.scrollHeight,behavior:'smooth'})},[messages,open]);

  function ask(raw:string){
    const question=raw.trim();
    if(!question)return;
    const response=answer(question,models);
    const userId=nextId.current++;
    const answerId=nextId.current++;
    setMessages(current=>[...current,{id:userId,role:'user',text:question},{id:answerId,role:'assistant',...response}]);
    setDraft('');
  }
  function submit(event:FormEvent){event.preventDefault();ask(draft)}

  return <div className={styles.root}>
    {open&&<section id="routie-chat" className={styles.panel} role="dialog" aria-modal="false" aria-labelledby="routie-title">
      <header className={styles.header}>
        <span className={styles.avatar}><Image src="/routie-logo.png" alt="" width={58} height={58}/></span>
        <span><strong id="routie-title">Ask Routie</strong><small><i/> {liveCount?`${liveCount} live models loaded`:'Routers guide online'}</small></span>
        <button type="button" aria-label="Close Routie" onClick={()=>setOpen(false)}>×</button>
      </header>
      <div className={styles.log} ref={logRef} aria-live="polite">
        {messages.map(message=><article key={message.id} className={message.role==='user'?styles.user:styles.assistant}>
          <p>{message.text}</p>
          {message.picks&&<div className={styles.picks}>{message.picks.map((pick,index)=><div key={pick.id} className={styles.pick}>
            <span>{String(index+1).padStart(2,'0')}</span><div><strong>{pick.name}</strong><code>{pick.id}</code><small>{pick.family} · {pick.reason}</small></div>
          </div>)}</div>}
          {message.actions&&<div className={styles.actions}>{message.actions.map(action=><Link key={action.href} href={action.href}>{action.label} ↗</Link>)}</div>}
        </article>)}
        {messages.length===1&&<div className={styles.quick}>{quickQuestions.map(question=><button type="button" key={question} onClick={()=>ask(question)}>{question}</button>)}</div>}
      </div>
      <form className={styles.composer} onSubmit={submit}>
        <label htmlFor="routie-question">Ask about Routers or models</label>
        <div><input ref={inputRef} id="routie-question" value={draft} onChange={event=>setDraft(event.target.value)} maxLength={400} placeholder="What’s the best model for my app?"/><button type="submit" disabled={!draft.trim()} aria-label="Send question">↑</button></div>
        <small>Answers use the live Routers catalogue. Never share API keys or seed phrases.</small>
      </form>
    </section>}
    <button type="button" className={styles.launcher} aria-label={open?'Close Routie':'Ask Routie'} aria-expanded={open} aria-controls="routie-chat" onClick={()=>setOpen(value=>!value)}>
      <Image src="/routie-floating.png" alt="" width={1254} height={1254}/>
    </button>
  </div>;
}
