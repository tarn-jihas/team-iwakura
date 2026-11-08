import type { IncomingMessage, ServerResponse } from 'node:http';
import { Collector, CollectorError } from '../modules/fulfillment/collector.js';

/** Mount this route within the monolith's HTTP server. */
export function collectorRoute(collector: Collector, onSignal:() => void = () => undefined):
  (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return async (request, response) => {
    if (request.url !== '/api/recovery/collector' || request.method !== 'POST') return false;
    const send = (status:number, payload:unknown): void => {
      response.writeHead(status, { 'Content-Type':'application/json', 'Cache-Control':'no-store' });
      response.end(JSON.stringify(payload));
    };
    try {
      const length = request.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > 20 * 1024)) {
        request.resume(); send(413, { error:'Collector envelope too large' }); return true;
      }
      const chunks:Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.byteLength;
        if (size > 20 * 1024) { request.resume(); send(413,{ error:'Collector envelope too large' }); return true; }
        chunks.push(bytes);
      }
      let envelope:unknown;
      try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(Buffer.concat(chunks))); }
      catch { send(400, { error:'Invalid collector envelope' }); return true; }
      const receipt = await collector.collect(envelope, request.headers['x-reconcile-signature']);
      if (!receipt.duplicate && envelope && typeof envelope === 'object' && 'event' in envelope) {
        const event = envelope.event;
        if (event && typeof event === 'object' && 'kind' in event
            && (event.kind === 'source_entitlement_observed' || (event.kind === 'handler_completed'
              && 'details' in event && event.details && typeof event.details === 'object'
              && 'outcome' in event.details && event.details.outcome === 'failed'))) {
          try { onSignal(); } catch { /* The saved event remains available for the next pass. */ }
        }
      }
      send(200, receipt);
    } catch (error) {
      if (!response.headersSent) send(error instanceof CollectorError ? error.status : 500,
        { error:error instanceof CollectorError ? error.message : 'Collector unavailable' });
    }
    return true;
  };
}
