import {
  findIncidentsNeedingOpenAlert, findIncidentsNeedingResolveAlert,
  markOpenNotifiedAndRecord, recordAlertFailed, recordAlertSent,
} from '../db/repositories/alerts';
import { alertsConfigured, openEmail, resolveEmail, sendEmail, type SendResult } from '../lib/email';

const POLL_INTERVAL_MS = 12_000;
const BATCH_LIMIT = 50;

type Send = (input: { to: string; subject: string; text: string }) => Promise<SendResult>;

// One reconcile pass. Exported for tests. Never throws per-target: one bad send
// or DB error is logged and the batch continues.
export async function processAlertsOnce(send: Send): Promise<void> {
  for (const t of await findIncidentsNeedingOpenAlert(BATCH_LIMIT)) {
    try {
      const res = await send({ to: t.toEmail, ...openEmail(t) });
      if (res.ok) await markOpenNotifiedAndRecord(t.incidentId);
      else await recordAlertFailed(t.incidentId, 'opened');
    } catch (err) {
      console.error('[beacon-alert] open alert failed', t.incidentId, err);
    }
  }
  for (const t of await findIncidentsNeedingResolveAlert(BATCH_LIMIT)) {
    try {
      const res = await send({ to: t.toEmail, ...resolveEmail(t) });
      if (res.ok) await recordAlertSent(t.incidentId, 'resolved');
      else await recordAlertFailed(t.incidentId, 'resolved');
    } catch (err) {
      console.error('[beacon-alert] resolve alert failed', t.incidentId, err);
    }
  }
}

export async function runAlertWorker(deps: { send?: Send } = {}): Promise<never> {
  const send = deps.send ?? sendEmail;
  let warnedDisabled = false;
  while (true) {
    try {
      if (!alertsConfigured()) {
        if (!warnedDisabled) {
          console.log('[beacon-alert] alerts disabled: email not configured (RESEND_API_KEY / ALERT_FROM_EMAIL)');
          warnedDisabled = true;
        }
      } else {
        warnedDisabled = false;
        await processAlertsOnce(send);
      }
    } catch (err) {
      // A whole-pass failure must never crash the loop.
      console.error('[beacon-alert] reconcile pass failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
