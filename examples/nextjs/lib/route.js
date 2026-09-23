// The two handlers every policy route exports.
import { after } from 'next/server';
import { decideRequest } from './handle.js';
import { backend, recordDecision, recentDecisions } from './backend.js';

export const policyRoute = policy => ({
  // Recorded after the response is sent: a store hiccup never delays or fails a decision.
  POST: request => decideRequest(policy, request, {
    onDecision: entry => after(() => recordDecision(entry).catch(error => console.error('decision log:', error.message))),
  }),
  GET: async () => Response.json({ backend: backend().name, decisions: await recentDecisions(policy.policy.name) }),
});
