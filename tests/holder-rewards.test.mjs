import test from 'node:test';
import assert from 'node:assert/strict';
import {findContinuousHoldingBlock,grantForBalance,HOLDER_REWARD_DEFAULTS,HOLDER_TOKEN_DEPLOYMENT_BLOCK} from '../server/holder-rewards.mjs';

const unit=10n**18n;

test('holder reward grants only the configured tier',()=>{
 assert.equal(grantForBalance(999999n*unit),0n);
 assert.equal(grantForBalance(1000000n*unit),2000000n);
 assert.equal(grantForBalance(9999999n*unit),2000000n);
 assert.equal(grantForBalance(10000000n*unit),3000000n);
});

test('holder thresholds remain operator configurable',()=>{
 const custom={...HOLDER_REWARD_DEFAULTS,holderRewardMinTokens:'5',holderRewardBonusTokens:'9',holderRewardBaseGrant:'20',holderRewardBonusGrant:'30'};
 assert.equal(grantForBalance(4n*unit,custom),0n);
 assert.equal(grantForBalance(5n*unit,custom),20n);
 assert.equal(grantForBalance(9n*unit,custom),30n);
});

test('continuous holding begins at the latest upward threshold crossing',()=>{
 const events=[
  {blockNumber:10,logIndex:0,delta:2n*unit},
  {blockNumber:20,logIndex:0,delta:-15n*unit/10n},
  {blockNumber:30,logIndex:0,delta:2n*unit}
 ];
 assert.equal(findContinuousHoldingBlock(25n*unit/10n,events,unit),30);
});

test('same-block transfers use log order and deployment is the safe lower bound',()=>{
 const events=[
  {blockNumber:50,logIndex:1,delta:2n*unit},
  {blockNumber:50,logIndex:0,delta:-2n*unit}
 ];
 assert.equal(findContinuousHoldingBlock(2n*unit,events,unit),50);
 assert.equal(findContinuousHoldingBlock(2n*unit,[],unit),HOLDER_TOKEN_DEPLOYMENT_BLOCK);
 assert.equal(findContinuousHoldingBlock(unit-1n,events,unit),null);
});
