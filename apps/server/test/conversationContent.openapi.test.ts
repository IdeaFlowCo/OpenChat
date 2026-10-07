import express from 'express';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { expect, it } from 'vitest';
import { openapiSpec } from '../src/openapi.js';
const app = express(); app.get('/api/openapi.json', (_req, res) => res.json(openapiSpec));
const stamp = '2026-10-07T18:00:00Z';
const context = { id: 'post', createdAt: stamp, sourceAliases: ['post'], origin: 'context', visibility: 'conversation', provenance: 'context', context: {
  id: 'post', conversationId: 'room', authorId: 'owner', text: 'Shared request', kind: 'ask', lane: 'context', revision: 1, createdAt: stamp, updatedAt: stamp, clientRequestId: 'retry',
  intention: { intentId: 'intent', revision: 2, lifecycleState: 'open', sourceChanged: false },
} };
const stream = { id: 'entry', createdAt: stamp, sourceAliases: ['entry'], origin: 'stream', visibility: 'conversation', provenance: 'pinned', thought: {
  id: 'entry', text: 'Pinned shared entry', createdAt: stamp, updatedAt: stamp, hasSourceMessage: true, sourceMessageId: null, sourceConversationId: null, pinned: true, pinnedBy: 'owner',
} };
it('an OpenAPI consumer resolves and validates both discriminated response variants, private human rows and pagination', async () => {
  const response = await request(app).get('/api/openapi.json'); expect(response.status).toBe(200);
  const spec = response.body;
  const operation = spec.paths['/api/chat/conversations/{id}/content'].get;
  expect(operation.operationId).toBe('listConversationContent'); expect(operation.externalDocs.url).toBe('https://chat.ideaflow.app/agents/conversation-content');
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
  const validate = ajv.compile({ ...operation.responses['200'].content['application/json'].schema, components: spec.components });
  for (const page of [{ items: [] }, { items: [context, stream], nextCursor: 'opaque-next-page' }, { items: [{ ...stream, visibility: 'private', provenance: 'private_note' }] }]) expect(validate(page), JSON.stringify(validate.errors)).toBe(true);
  for (const page of [{ items: [{ ...context, visibility: 'private' }] }, { items: [{ ...stream, origin: 'message' }] }, { items: [{ ...stream, thought: { id: 'missing-body' } }] }, { items: [context], nextCursor: 7 }]) expect(validate(page)).toBe(false);
  expect(operation.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
});
it('schema query constraints allow the supported filters and reject malformed pagination inputs', async () => {
  const spec = (await request(app).get('/api/openapi.json')).body;
  const parameters = spec.paths['/api/chat/conversations/{id}/content'].get.parameters;
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile({ type: 'object', properties: Object.fromEntries(parameters.map((parameter: any) => [parameter.name, parameter.schema])), required: parameters.filter((parameter: any) => parameter.required).map((parameter: any) => parameter.name), additionalProperties: false });
  expect(validate({ id: 'room', filter: 'all', search: 'handoff', limit: 50, cursor: 'opaque' })).toBe(true);
  for (const query of [{ filter: 'all' }, { id: 'room', filter: 'messages' }, { id: 'room', limit: 101 }, { id: 'room', search: 'x'.repeat(201) }, { id: 'room', includePrivate: true }]) expect(validate(query)).toBe(false);
});
