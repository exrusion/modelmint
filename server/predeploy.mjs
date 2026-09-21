import {spawnSync} from 'node:child_process';
// Explicit subprocesses: deployment command runners need not interpret shell operators.
for (const script of ['tests/database.integration.mjs','server/check-provider.mjs','server/verify-live.mjs','server/check-payments.mjs','server/open-checkout.mjs','server/openrouter-catalogue.mjs']) {
 const result=spawnSync(process.execPath,[script],{stdio:'inherit',env:process.env});
 if(result.error||result.status!==0) process.exit(result.status||1);
}
