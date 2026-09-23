'use client';
import Flow from '../../_kit/Flow.js';

const example = {
  title: 'Courier app',
  lede: 'The driver says what’s happening at the door. Parcel value, weather and nearby lockers come from dispatch — the driver never has to know the rules.',
  takeaways: ['Over $250 never waits on a doorstep', 'Anything unsafe means nobody risks it', 'Unsure what’s happening? Dispatch takes over'],
  messageLabel: 'Driver’s note',
  presets: [
    { label: 'No answer', message: 'No answer at the door', facts: { valueUsd: 40, raining: false, lockerNearby: true },
      answers: { situation: { choice: 'nobody-home', confidence: 0.95 }, 'unsafe?': { noul: 0.02 } } },
    { label: 'No answer, $480, rain', message: 'Nobody answering, porch is covered', facts: { valueUsd: 480, raining: true, lockerNearby: true },
      answers: { situation: { choice: 'nobody-home', confidence: 0.94 }, 'unsafe?': { noul: 0.03 } } },
    { label: 'Loose dog', message: 'Nobody home and a big dog is loose in the yard, growling', facts: { valueUsd: 40, raining: false, lockerNearby: true },
      answers: { situation: { choice: 'nobody-home', confidence: 0.9 }, 'unsafe?': { noul: 0.9 } } },
    { label: 'Gate code wrong', message: 'Gate code 4411 does not work, cannot get to the building', facts: { valueUsd: 40, raining: false, lockerNearby: false },
      answers: { situation: { choice: 'access-blocked', confidence: 0.93 }, 'unsafe?': { noul: 0.03 } } },
    { label: 'Someone’s here', message: 'Neighbour answered, says she is the recipient', facts: { valueUsd: 40, raining: false, lockerNearby: true },
      answers: { situation: { choice: 'resident-there', confidence: 0.85 }, 'unsafe?': { noul: 0.01 } } },
  ],
  facts: [
    { key: 'valueUsd', label: 'Declared value', min: 0, max: 1000, step: 10, format: v => `$${v}` },
    { key: 'raining', label: 'Raining', type: 'bool' },
    { key: 'lockerNearby', label: 'Locker within 500m', type: 'bool' },
  ],
  toInput: (message, f) => ({ message, valueUsd: f.valueUsd, raining: f.raining, lockerNearby: f.lockerNearby }),
  outcomes: {
    'hand-over': 'Hand it over.',
    'leave-at-door': 'Leave it at the door and take a photo.',
    'parcel-locker': 'Take it to the locker around the corner.',
    'reattempt-tomorrow': 'Keep it on the van. We’ll try again tomorrow.',
    'call-recipient': 'Call the recipient before you leave.',
    'dispatch-desk': 'Call dispatch — they’ll tell you what to do.',
  },
};

export default function Demo(props) {
  return <Flow {...props} route="doorstep" example={example} prev={{ href: '/examples/reservation', label: 'SMS host' }} />;
}
