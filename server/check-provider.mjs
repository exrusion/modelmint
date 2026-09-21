import {initialize,q,pool} from './db.mjs';
// Checks authentication without inference, logging credentials, or enabling unpriced models.
try {
  if (!process.env.UPSTREAM_API_KEY) console.log('Provider check: API key missing.');
  else {
    await initialize();
    const url = new URL((process.env.UPSTREAM_BASE_URL || 'https://api.relaymodels.com/v1').replace(/\/$/,'')+'/models');
    if (url.protocol !== 'https:') throw new Error('HTTPS required');
    const response = await fetch(url,{headers:{Authorization:'Bearer '+process.env.UPSTREAM_API_KEY},redirect:'error',signal:AbortSignal.timeout(15000)});
    if (!response.ok) console.log('Provider check: HTTP '+response.status+'.');
    else {
      const body=await response.json();
      if(!Array.isArray(body.data)||!body.data.every(m=>typeof m.id==='string')) throw new Error('Invalid catalogue');
      await q("UPDATE providers SET verified_at=now() WHERE id='00000000-0000-4000-8000-000000000001'");
      const catalogue=body.data.map(model=>{
        const safe={id:model.id};
        for(const key of ['owned_by','name','description','context_length','max_context','max_output','input_price','output_price','pricing','capabilities','architecture'])
          if(model[key]!==undefined)safe[key]=model[key];
        return safe;
      });
      console.log('UPSTREAM_CATALOGUE '+JSON.stringify(catalogue));
      console.log('Provider check: authentication verified; '+body.data.length+' model IDs discovered. Model pricing remains subject to verification.');
    }
  }
} catch { console.log('Provider check: unable to verify connectivity or catalogue.'); }
finally { if(pool) await pool.end(); }
