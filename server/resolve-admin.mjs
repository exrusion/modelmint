import {initialize,q} from './db.mjs';

const username=(process.env.ADMIN_X_USERNAME||'').trim().replace(/^@/,'');
if(!username){
 console.log('Admin X username resolution skipped.');
}else{
 await initialize();
 const matches=(await q('SELECT id,x_id,username FROM users WHERE lower(username)=lower($1)',[username])).rows;
 if(matches.length!==1){
  console.error(`ADMIN_X_RESOLUTION_FAILED ${JSON.stringify({username,matches:matches.length})}`);
  process.exitCode=1;
 }else{
  const account=matches[0];
  await q("UPDATE users SET role='admin' WHERE id=$1",[account.id]);
  await q("INSERT INTO audit(actor,action,target,details) VALUES($1,'admin.granted',$2,$3)",[account.id,account.x_id,{source:'verified X login',username:account.username}]);
  console.log(`ADMIN_X_RESOLVED ${JSON.stringify({username:account.username,xId:account.x_id})}`);
 }
}
