import test from 'node:test';
import assert from 'node:assert/strict';
import { policy as v2 } from '../examples/ticket-router-v2.js';
import { policy as ticket } from '../examples/ticket-router.js';

test('ticket-router v2 asks exactly what v1 asks, so one fixture serves both', () => {
  assert.deepEqual(v2.questions({ ticket: 't' }), ticket.questions({ ticket: 't' }));
  assert.equal(v2.identity(), ticket.identity());
});
