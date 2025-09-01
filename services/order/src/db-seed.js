import { migrate } from './db.js';
migrate().then(()=>console.log('seeded (noop)')).catch(e=>{console.error(e);process.exit(1)});
