// Three policies behind the API routes. The model only answers the questions;
// routing, thresholds and safety fallbacks live here as code you can review.
// Facts marked `local: true` come from your own systems — rules read them, the
// model never sees them.
import {
  choice, score, noul, definePolicy, gate, rule, all, any, compare, fact,
  assign, escalate, page,
} from 'jevlang';

// --- /api/maintenance: a tenant texts the building ---------------------------
// "smell gas in the hallway" at 3am and "paint chipping in bathroom" must not
// land in the same queue.

const issue = choice('issue', 'What is `message` reporting?', {
  'water-leak': 'Water leaking, dripping, flooding, or a burst pipe',
  'no-heat': 'No heat or no hot water',
  'no-power': 'Power out in the unit, or a dead breaker',
  lockout: 'Locked out, lost keys, or a broken lock',
  pests: 'Mice, roaches, bedbugs, or other pests',
  cosmetic: 'Paint, scuffs, squeaks, and other things that can wait',
  other: 'Something else',
});
const danger = noul('danger?', 'Could anyone be in physical danger right now?', {
  criteria: { true: 'Gas smell, smoke, sparks, carbon monoxide alarm, water near electrics, structural damage', false: 'Nothing suggests risk to people' },
});

export const maintenance = definePolicy({
  name: 'building-maintenance', version: '1', owner: 'property-ops',
  questions: [issue, danger],
  state: {
    message: { path: ['message'], default: '', maxChars: 1500 },
    hour: { path: ['hour'], local: true },
    'outside-temp-c': { path: ['outsideTempC'], default: 15, local: true },
  },
  stateOptions: { redact: ['emails', 'phones', 'cards', 'keys'] },
  gates: [gate(issue, 0.75, escalate('property-manager', { reason: 'not sure what the tenant is reporting' }), { onRead: true })],
  route: {
    clauses: [
      // Deliberately low bar: a false alarm costs a phone call, a miss costs a life.
      rule(danger.yes(0.3), page('emergency-oncall', { reason: 'possible danger: tell the tenant to get out and call 911' })),
      rule(all(issue.is('no-heat'), compare('lt', fact('outside-temp-c'), 5)), page('hvac-oncall', { reason: 'no heat in freezing weather' })),
      rule(all(issue.is('water-leak'), any(compare('gte', fact('hour'), 20), compare('lt', fact('hour'), 7))), page('plumber-oncall', { reason: 'after-hours leak' })),
      rule(issue.is('water-leak'), assign('plumber-today')),
      rule(issue.is('no-power'), assign('electrician-today')),
      rule(issue.is('no-heat'), assign('hvac-next-slot')),
      rule(issue.is('lockout'), assign('locksmith')),
      rule(issue.is('pests'), assign('pest-control-route')),
      rule(issue.is('cosmetic'), assign('maintenance-backlog')),
    ],
    otherwise: escalate('property-manager', { reason: 'no standing rule for this' }),
  },
});

// --- /api/reservation: a restaurant's SMS host --------------------------------
// Party size and free seats come from the booking system; the model reads intent
// and spots the allergy that has to reach the kitchen.

const intent = choice('intent', 'What does the guest want from `message`?', {
  book: 'Make a new reservation',
  change: 'Move or resize an existing reservation',
  cancel: 'Cancel a reservation',
  question: 'Hours, menu, parking, dress code, or another question',
  complaint: 'Unhappy about a past visit',
});
const allergy = noul('severe-allergy?', 'Does `message` mention a serious allergy or medical diet?', {
  criteria: { true: 'Anaphylaxis, EpiPen, celiac, severe nut or shellfish allergy', false: 'No medical dietary need, or only a preference' },
});

export const LARGE_PARTY = 8;

export const reservation = definePolicy({
  name: 'sms-host', version: '1', owner: 'front-of-house',
  questions: [intent, allergy],
  state: {
    message: { path: ['message'], default: '', maxChars: 800 },
    'party-size': { path: ['partySize'], default: 2, local: true },
    'seats-free': { path: ['seatsFree'], default: 0, local: true },
  },
  stateOptions: { redact: ['emails', 'phones', 'cards'] },
  gates: [gate(intent, 0.8, escalate('host-stand', { reason: 'not sure what the guest wants' }))],
  route: { clauses: [
    rule(intent.is('complaint'), escalate('manager', { reason: 'a person answers complaints' })),
    rule(all(intent.is('book'), compare('gt', fact('party-size'), LARGE_PARTY)), escalate('events-manager', { reason: 'large party, needs a set menu' })),
    rule(all(intent.is('book'), compare('lt', fact('seats-free'), fact('party-size'))), assign('offer-waitlist', { reason: 'fully booked at that time' })),
    rule(all(intent.is('book'), allergy.yes(0.5)), assign('confirm-and-alert-kitchen', { reason: 'serious allergy flagged on the ticket' })),
    rule(intent.is('book'), assign('confirm-booking')),
    rule(intent.is('change'), assign('reschedule-link')),
    rule(intent.is('cancel'), assign('cancel-and-release-table')),
    rule(intent.is('question'), assign('faq-reply')),
  ] },
});

// --- /api/doorstep: a courier asks where to leave a parcel ---------------------
// The driver types "nobody home, big dog in yard" into the app; the policy
// decides using package value and weather the driver never has to know.

const situation = choice('situation', "What is the courier's situation in `message`?", {
  'resident-there': 'Someone is there to take the parcel',
  'nobody-home': 'Nobody answers',
  'access-blocked': 'Gate code wrong, locked lobby, or no way to the door',
  'address-unclear': "Can't find the address or unit",
});
const unsafe = noul('unsafe?', 'Does `message` describe something unsafe for the courier?', {
  criteria: { true: 'Aggressive dog, ice, hostile person, dangerous stairs', false: 'Nothing unsafe mentioned' },
});

export const DOORSTEP_MAX_VALUE = 250;

export const doorstep = definePolicy({
  name: 'doorstep-dispatch', version: '1', owner: 'last-mile',
  questions: [situation, unsafe],
  state: {
    message: { path: ['message'], default: '', maxChars: 500 },
    'value-usd': { path: ['valueUsd'], local: true },
    raining: { path: ['raining'], default: false, local: true },
    'locker-nearby': { path: ['lockerNearby'], default: false, local: true },
  },
  gates: [gate(situation, 0.8, escalate('dispatch-desk', { reason: "unclear what's happening at the door" }), { onRead: true })],
  route: {
    clauses: [
      rule(unsafe.yes(0.5), assign('reattempt-tomorrow', { reason: 'unsafe for the courier' })),
      rule(situation.is('resident-there'), assign('hand-over')),
      rule(situation.is('address-unclear'), escalate('call-recipient', { reason: 'address unclear' })),
      rule(all(any(compare('gt', fact('value-usd'), DOORSTEP_MAX_VALUE), fact('raining'), situation.is('access-blocked')), fact('locker-nearby')),
        assign('parcel-locker', { reason: 'high value, rain, or no access: locker nearby' })),
      rule(any(compare('gt', fact('value-usd'), DOORSTEP_MAX_VALUE), situation.is('access-blocked')), assign('reattempt-tomorrow', { reason: 'cannot leave it safely' })),
      rule(situation.is('nobody-home'), assign('leave-at-door', { reason: 'low value, dry, accessible' })),
    ],
    otherwise: escalate('dispatch-desk'),
  },
});
