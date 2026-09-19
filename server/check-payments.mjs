import {solRpc,checkSolNetwork} from './solana.mjs';
if(process.env.SOLANA_RPC_URL){try{await checkSolNetwork(solRpc());console.log('Solana mainnet RPC verified.');}catch{console.log('Solana RPC could not be verified; check configuration before opening checkout.');}}
