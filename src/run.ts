import { main } from './index.js';
main().catch(error => { console.error(error); process.exitCode = 1; });
