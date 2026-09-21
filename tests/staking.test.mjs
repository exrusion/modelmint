import test from 'node:test';
import assert from 'node:assert/strict';
import {allocatePool} from '../server/staking.mjs';

test('staking pool is split exactly by verified weight',()=>{
 const allocations=allocatePool(1_000_000n,1_000_000n,[
  {userId:'a',wallet:'0xa',weight:1n,balance:1n},
  {userId:'b',wallet:'0xb',weight:3n,balance:3n}
 ]);
 assert.deepEqual(allocations.map(row=>[row.userId,row.credit,row.tokens]),[
  ['a',250_000n,250_000n],
  ['b',750_000n,750_000n]
 ]);
});

test('staking pool preserves every credit unit when division has a remainder',()=>{
 const allocations=allocatePool(10n,11n,[
  {userId:'a',wallet:'0xa',weight:1n,balance:1n},
  {userId:'b',wallet:'0xb',weight:1n,balance:1n},
  {userId:'c',wallet:'0xc',weight:1n,balance:1n}
 ]);
 assert.equal(allocations.reduce((sum,row)=>sum+row.credit,0n),10n);
 assert.equal(allocations.reduce((sum,row)=>sum+row.tokens,0n),11n);
});

test('zero-weight wallets do not receive staking rewards',()=>{
 const allocations=allocatePool(100n,100n,[
  {userId:'empty',wallet:'0x0',weight:0n,balance:0n},
  {userId:'holder',wallet:'0x1',weight:5n,balance:5n}
 ]);
 assert.equal(allocations.length,1);
 assert.equal(allocations[0].userId,'holder');
 assert.equal(allocations[0].credit,100n);
});
