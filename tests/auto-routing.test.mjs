import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAutoStrategy,rankAutoModels,supportsAutoRequest} from '../server/auto-routing.mjs';

const model=(id,overrides={})=>({id,enabled:true,verified:true,auto_enabled:true,tools:true,vision:true,json_format:true,max_output:4096,max_context:128000,auto_quality:50,auto_estimated_micro:10,auto_latency:500,auto_samples:10,...overrides});

test('automatic routing rejects unknown strategies and missing capabilities',()=>{
 assert.equal(parseAutoStrategy('FASTEST'),'fastest');
 assert.throws(()=>parseAutoStrategy('random'),error=>error.code==='invalid_routing_strategy');
 assert.equal(supportsAutoRequest(model('text',{vision:false}),{vision:true,maxOutput:256,input:100}),false);
 assert.equal(supportsAutoRequest(model('small',{max_output:128}),{maxOutput:256,input:100}),false);
 assert.equal(supportsAutoRequest(model('ready'),{tools:true,vision:true,json:true,maxOutput:256,input:100}),true);
});

test('cheapest, fastest and best use deterministic transparent rankings',()=>{
 const models=[model('cheap',{auto_estimated_micro:2,auto_quality:30,auto_latency:900}),model('fast',{auto_estimated_micro:8,auto_quality:60,auto_latency:120}),model('best',{auto_estimated_micro:15,auto_quality:98,auto_latency:350})];
 assert.equal(rankAutoModels(models,{strategy:'cheapest'})[0].id,'cheap');
 assert.equal(rankAutoModels(models,{strategy:'fastest'})[0].id,'fast');
 assert.equal(rankAutoModels(models,{strategy:'best'})[0].id,'best');
 assert.equal(rankAutoModels(models,{strategy:'balanced'})[0].id,'fast');
});

test('fastest strategy does not treat insufficient history as a zero-latency result',()=>{
 const ranked=rankAutoModels([model('unknown',{auto_samples:2,auto_latency:10}),model('measured',{auto_samples:3,auto_latency:400})],{strategy:'fastest'});
 assert.equal(ranked[0].id,'measured');
});
