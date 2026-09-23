import { test, expect } from 'bun:test';
import { maintenance, reservation, doorstep } from './policies.js';
import { decideRequest } from './handle.js';

const decide = (policy, input, answers) => {
  const { state, facts } = policy.buildState(input);
  return policy.decide(answers, { state, facts });
};
const post = body => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });

test('maintenance: danger pages on-call even when the issue is unclear', () => {
  const d = decide(maintenance, { message: 'smells like gas in the hall', hour: 3 }, {
    issue: { choice: 'other', confidence: 0.4 }, 'danger?': { noul: 0.35 },
  });
  expect([d.action, d.target]).toEqual(['page', 'emergency-oncall']);
});

test('maintenance: the same leak pages at night and waits for day', () => {
  const leak = { issue: { choice: 'water-leak', confidence: 0.95 }, 'danger?': { noul: 0.05 } };
  expect(decide(maintenance, { message: 'drip', hour: 23 }, leak).target).toBe('plumber-oncall');
  expect(decide(maintenance, { message: 'drip', hour: 11 }, leak).target).toBe('plumber-today');
  const heat = { issue: { choice: 'no-heat', confidence: 0.9 }, 'danger?': { noul: 0.05 } };
  expect(decide(maintenance, { message: 'cold', hour: 11, outsideTempC: -8 }, heat).target).toBe('hvac-oncall');
  expect(decide(maintenance, { message: 'cold', hour: 11, outsideTempC: 18 }, heat).target).toBe('hvac-next-slot');
});

test('reservation: allergy alerts the kitchen, full house waitlists, big party escalates', () => {
  const book = { intent: { choice: 'book', confidence: 0.95 }, 'severe-allergy?': { noul: 0.9 } };
  expect(decide(reservation, { message: 'x', partySize: 4, seatsFree: 10 }, book).target).toBe('confirm-and-alert-kitchen');
  expect(decide(reservation, { message: 'x', partySize: 4, seatsFree: 2 }, book).target).toBe('offer-waitlist');
  expect(decide(reservation, { message: 'x', partySize: 14, seatsFree: 40 }, book).target).toBe('events-manager');
});

test('doorstep: order facts stay local; value and weather pick the drop', () => {
  const home = { message: 'nobody home', valueUsd: 40, raining: false, lockerNearby: true };
  expect(doorstep.buildState(home).state).toEqual({ message: 'nobody home' });
  const nobody = { situation: { choice: 'nobody-home', confidence: 0.95 }, 'unsafe?': { noul: 0.05 } };
  expect(decide(doorstep, home, nobody).target).toBe('leave-at-door');
  expect(decide(doorstep, { ...home, raining: true }, nobody).target).toBe('parcel-locker');
  expect(decide(doorstep, { ...home, valueUsd: 900, lockerNearby: false }, nobody).target).toBe('reattempt-tomorrow');
  expect(decide(doorstep, home, { ...nobody, 'unsafe?': { noul: 0.8 } }).target).toBe('reattempt-tomorrow');
});

test('handler: decides offline, 400 on bad answers, 503 without a key', async () => {
  const input = { message: 'drip', hour: 12 };
  const ok = await decideRequest(maintenance, post({ input, answers: { issue: { choice: 'cosmetic', confidence: 0.9 }, 'danger?': { noul: 0 } } }));
  expect(ok.status).toBe(200);
  expect((await ok.json()).target).toBe('maintenance-backlog');
  const bad = await decideRequest(maintenance, post({ input, answers: { issue: { choice: 'nope', confidence: 0.9 }, 'danger?': { noul: 0 } } }));
  expect(bad.status).toBe(400);
  delete process.env.TYPESAFE_API_KEY;
  expect((await decideRequest(maintenance, post({ input }))).status).toBe(503);
});
