import 'dotenv/config';
import './../lib/env'; // validate env at startup
import { runWorker } from './check-worker';

console.log('[beacon-worker] starting check loop');
void runWorker();
