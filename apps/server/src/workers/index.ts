import 'dotenv/config';
import './../lib/env'; // validate env at startup
import { runWorker } from './check-worker';
import { runIntegrationWorker } from './integration-worker';

console.log('[beacon-worker] starting check loop');
void runWorker().catch((err) => console.error('[beacon-worker] check loop crashed', err));

console.log('[beacon-worker] starting integration loop');
void runIntegrationWorker().catch((err) => console.error('[beacon-worker] integration loop crashed', err));
