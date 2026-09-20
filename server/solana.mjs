import {Connection,PublicKey,Transaction,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {createPublicKey,verify} from 'node:crypto';
import bs58 from 'bs58';
import {fail} from './db.mjs';
export const SOLANA_CHAIN=0; // Internal payment-network identifier, never an EVM chain ID.
export const MEMO='MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export function solAddress(value){try{return typeof value==='string'&&new PublicKey(value).toBase58()===value;}catch{return false;}}
export function solSignature(value){try{return typeof value==='string'&&bs58.decode(value).length===64;}catch{return false;}}
export function verifySolMessage(address,message,signature){try{const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(address).toBuffer()]),format:'der',type:'spki'});return verify(null,Buffer.from(message),key,bs58.decode(signature));}catch{return false;}}
export function solRpc(){if(!process.env.SOLANA_RPC_URL)fail(503,'chain_unconfigured','Solana is not configured.');return new Connection(process.env.SOLANA_RPC_URL,{commitment:'finalized',confirmTransactionInitialTimeout:30000,disableRetryOnRateLimit:true,fetch:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)})});}
export async function checkSolNetwork(connection){if(await connection.getGenesisHash()!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')fail(503,'rpc_mismatch','Solana mainnet RPC required.');}
export function verifySolInvoice(order,result,signature){
 if(!result||!result.meta||!Number.isSafeInteger(result.blockTime))fail(409,'payment_pending','Payment is awaiting Solana finality.');
 if(result.meta.err!==null)fail(400,'payment_failed','The Solana transaction failed.');
 if(result.transaction.signatures?.[0]!==signature)fail(400,'payment_mismatch','Signature does not match.');
 const message=result.transaction.message,keys=message.accountKeys;
 const direct=order.wallet==='direct';
 if(!direct&&!keys.some(k=>k.signer&&String(k.pubkey)===order.wallet))fail(400,'payment_mismatch','The invoice wallet must sign the payment.');
 const instructions=message.instructions;
 const transfers=instructions.filter(i=>String(i.programId)==='11111111111111111111111111111111'&&i.parsed?.type==='transfer');
 const matching=transfers.filter(i=>(direct||i.parsed.info.source===order.wallet)&&i.parsed.info.destination===order.treasury&&Number.isSafeInteger(i.parsed.info.lamports)&&BigInt(i.parsed.info.lamports)===BigInt(order.wei));
 const memo=instructions.some(i=>String(i.programId)===MEMO&&i.parsed==='modelmint:'+order.id);
 const treasuryIndex=keys.findIndex(k=>String(k.pubkey)===order.treasury);
 const before=result.meta.preBalances?.[treasuryIndex],after=result.meta.postBalances?.[treasuryIndex];
 if(matching.length!==1||(!direct&&!memo)||!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||BigInt(after)-BigInt(before)<BigInt(order.wei))fail(400,'payment_mismatch','Recipient, amount or invoice reference does not match.');
 const time=result.blockTime*1000;if(time<new Date(order.created_at).getTime()-15000||time>new Date(order.expires).getTime())fail(400,'quote_expired','Payment was outside the quote window; contact support for review.');
 return true;
}
export async function solPaymentTransaction(order){const c=solRpc();await checkSolNetwork(c);const latest=await c.getLatestBlockhash('finalized');const wallet=new PublicKey(order.wallet);const t=new Transaction({feePayer:wallet,recentBlockhash:latest.blockhash});t.add(SystemProgram.transfer({fromPubkey:wallet,toPubkey:new PublicKey(order.treasury),lamports:BigInt(order.wei)}));t.add(new TransactionInstruction({programId:new PublicKey(MEMO),keys:[{pubkey:wallet,isSigner:true,isWritable:false}],data:Buffer.from('modelmint:'+order.id)}));return {transaction:t.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),lastValidBlockHeight:latest.lastValidBlockHeight};}
