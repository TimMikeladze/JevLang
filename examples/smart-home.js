// A smart-home assistant: a sentence in, device actions out.
//
// It shows typed actions checked at compile and decide time, a home whose rooms
// and doors arrive with the request (a family per room, a runtime choice of
// doors), an observed local fact that is never sent, one request that becomes a
// plan of several device actions, and the safety declarations on unlocking.
import {
  choice, noul, noulEach, definePolicy, gate, rule, all, not, compare, compute, choose, list, threshold, fact,
  variable, act, confirm, schedule, clarify, plan, planFor, branch, assign, hold, escalate,
} from '../src/index.js';

const category = choice('category', 'What kind of request is `request`?', {
  command: 'An instruction to change something in the home: lights, doors, temperature',
  conversation: 'Small talk, or a question that needs a spoken answer rather than a device change',
  other: 'Something that fits neither',
});
const lights = noul('lights?', 'Does `request` ask to change any lights?');
const doorAsked = noul('door?', 'Does `request` ask to lock or unlock a door?');
const temperature = noul('temperature?', 'Does `request` ask to make the home warmer or cooler?');

const lightsOnIn = noulEach('lights-on-in', { question: 'Does `request` ask to turn on the lights in this room (or in every room)?' }, 'rooms', { itemKey: 'room' });
const lightsOffIn = noulEach('lights-off-in', { question: 'Does `request` ask to turn off the lights in this room (or in every room)?' }, 'rooms', { itemKey: 'room' });

const door = choice('door', 'If `request` is about a door, which door?', { none: 'Another door, or no door is named' }, { optionsFrom: 'doors' });
const lockAction = choice('lock-action', 'If `request` is about a door, should it be locked or unlocked?', {
  lock: 'Lock it', unlock: 'Unlock it', other: 'Neither, or the request does not say',
});
const tempDirection = choice('temp-direction', 'If `request` is about temperature, which way should it go?', {
  warmer: 'Warmer', cooler: 'Cooler', other: 'Neither, or the request does not say',
});
const delay = choice('delay', 'When does `request` want it to happen?', {
  now: 'Now, or no time is given', ten_min: 'In about ten minutes', thirty_min: 'In about half an hour',
  one_hour: 'In about an hour', other: 'Some other time than these',
});

// The request counts as being about something only when the category is a command.
const commandAbout = q => all(category.is('command'), q.yes(threshold('asks-for')));
const roomsWhere = family => choose(category.is('command'), family.yesItems(threshold('room-named')), list());
const anyRoom = family => compare('gt', compute('length', roomsWhere(family)), 0);
// "in ten minutes": the model picks a phrase, the policy does the arithmetic.
// A time it cannot place is asked about rather than acted on now.
const whenAsked = d => branch(delay.is('now'), d,
  branch(delay.is('ten_min'), schedule(600, d),
    branch(delay.is('thirty_min'), schedule(1800, d),
      branch(delay.is('one_hour'), schedule(3600, d),
        clarify('When should it happen?', delay)))));
const openDoor = compute('contains', fact('open-doors'), door.chosen());

export const policy = definePolicy({
  name: 'smart-home', version: '2', owner: 'home', model: 'jev-1.13.0',
  questions: [category, lights, doorAsked, temperature, lightsOnIn, lightsOffIn, door, lockAction, tempDirection, delay],
  state: {
    request: { path: ['request'], default: '' },
    rooms: { path: ['rooms'], default: ['kitchen', 'living_room', 'bedroom'] },
    doors: { path: ['doors'], default: ['front', 'back', 'garage'] },
    // Observed by a sensor, never sent.
    'open-doors': { path: ['open-doors'], default: [], local: true },
  },
  thresholds: { 'asks-for': 0.7, 'room-named': 0.9 },
  actions: {
    'lights-on': { doc: "Turn a room's lights on", params: { room: { type: 'member-of', field: 'rooms' } }, undo: act('lights-off', { room: variable('room') }) },
    'lights-off': { doc: "Turn a room's lights off", params: { room: { type: 'member-of', field: 'rooms' } }, undo: act('lights-on', { room: variable('room') }) },
    'lock-door': { doc: 'Lock a door', params: { door: { type: 'member-of', field: 'doors' } }, timeout: 10 },
    'unlock-door': {
      doc: 'Unlock a door. A resident approves every unlock.',
      params: { door: { type: 'member-of', field: 'doors' } },
      confirm: true, minConfidence: 0.9, cooldown: 30, allow: ['owner', 'resident'], timeout: 10,
      undo: act('lock-door', { door: variable('door') }),
    },
    'nudge-thermostat': {
      doc: 'Move the set point one step warmer or cooler; the handler does the arithmetic',
      params: { direction: { type: 'one-of', values: ['warmer', 'cooler'] } }, cooldown: 60,
    },
  },
  gates: [
    gate(category, 0.6, escalate('ask-user', { reason: 'not sure what kind of request this is' }), { onRead: true }),
    gate(door, 0.8, escalate('ask-user', { reason: 'which door?' }), { onRead: true }),
    gate(lockAction, 0.8, escalate('ask-user', { reason: 'lock or unlock?' }), { onRead: true }),
    gate(tempDirection, 0.7, escalate('ask-user', { reason: 'warmer or cooler?' }), { onRead: true }),
    gate(delay, 0.7, escalate('ask-user', { reason: 'when?' }), { onRead: true }),
  ],
  route: {
    mode: 'all',
    clauses: [
      rule(anyRoom(lightsOnIn), whenAsked(planFor('r', roomsWhere(lightsOnIn), act('lights-on', { room: variable('r') })))),
      rule(anyRoom(lightsOffIn), whenAsked(planFor('r', roomsWhere(lightsOffIn), act('lights-off', { room: variable('r') })))),
      rule(all(commandAbout(lights), not(anyRoom(lightsOnIn)), not(anyRoom(lightsOffIn))), clarify('Which room?', lightsOnIn)),
      rule(all(commandAbout(doorAsked), not(door.is('none')), lockAction.is('lock'), openDoor),
        hold({ reason: 'that door is standing open; close it before locking' })),
      // Every matching clause runs, so this one excludes the case above.
      rule(all(commandAbout(doorAsked), not(door.is('none')), lockAction.is('lock'), not(openDoor)),
        whenAsked(act('lock-door', { door: door.chosen() }))),
      rule(all(commandAbout(doorAsked), not(door.is('none')), lockAction.is('unlock')),
        confirm(act('unlock-door', { door: door.chosen() }), { reason: "unlocking a door needs a resident's yes" })),
      rule(all(commandAbout(temperature), not(tempDirection.is('other'))),
        act('nudge-thermostat', { direction: tempDirection.value() })),
      rule(category.is('conversation'), assign('chat-model', { reason: 'conversation: hand it to a language model' })),
    ],
    otherwise: hold({ reason: 'nothing here the home can act on' }),
  },
});
