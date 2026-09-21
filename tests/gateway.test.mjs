import test from 'node:test';
import assert from 'node:assert/strict';
import {retryableProviderFailure} from '../server/gateway.mjs';

test('provider failover retries transport failures and transient upstream statuses',()=>{
 assert.equal(retryableProviderFailure(null),true);
 for(const status of [401,403,404,408,425,429,500,502,503,504])assert.equal(retryableProviderFailure(status),true);
 for(const status of [400,409,422])assert.equal(retryableProviderFailure(status),false);
});
