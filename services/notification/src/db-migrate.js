import { migrate } from './db.js';
migrate().then(()=>console.log('migrated')).catch(e=>{console.error(e);process.exit(1)});
