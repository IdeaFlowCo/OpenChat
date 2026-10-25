import type { Request, Response } from 'express';
import { getConnectorPrincipal } from '../lib/ideaflowConnector.js';
import { ConnectorTextSendError, sendConnectorText, type ConnectorTextTarget } from '../services/connectorTextSend.js';
import { publishConnectorText } from '../services/connectorTextEffects.js';

export async function handleConnectorText(req: Request, res: Response, target: ConnectorTextTarget): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  const principal = getConnectorPrincipal(req);
  if (!principal?.scopes.includes('openchat:write')) { res.status(404).json({ error: 'unavailable' }); return; }
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['content', 'clientRequestId', 'replyToId'].includes(key))) {
    res.status(400).json({ error: 'invalid_request' }); return;
  }
  try {
    const result = await sendConnectorText({ actorId: principal.id, target,
      requestId: body.clientRequestId, content: body.content, replyToId: body.replyToId,
      connectorLabel: principal.client });
    // Preserve `id` for existing conversation-tool consumers. Acceptance fields
    // are sufficient even after the original message was edited or deleted.
    res.status(result.receipt.replayed ? 200 : 201).json({ ...result.message,
      id: result.receipt.messageId, ...result.receipt });
    try { publishConnectorText(result, req.app.get('io')); }
    catch { console.warn('[connector-text] post-commit fanout unavailable'); }
  } catch (error) {
    if (error instanceof ConnectorTextSendError) {
      const status = error.code === 'unavailable' ? 404 : error.code === 'invalid_request' ? 400 : 409;
      res.status(status).json({ error: error.code });
    } else {
      // The transaction/response may have committed. Never claim non-delivery.
      res.status(503).json({ error: 'delivery_unconfirmed' });
    }
  }
}
