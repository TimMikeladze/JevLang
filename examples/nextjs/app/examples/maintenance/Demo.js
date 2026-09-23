'use client';
import Flow from '../../_kit/Flow.js';

const clock = h => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

const example = {
  title: 'Tenant hotline',
  lede: 'Tenants text one number. The policy decides who gets woken up — the model only reads the message; time and weather come from your systems.',
  takeaways: ['A low bar for danger: 0.3 pages on-call', 'Time and temperature never reach the model', 'Same leak, different hour, different person'],
  messageLabel: 'Tenant’s text',
  presets: [
    { label: 'Rotten-egg smell, 3am', message: 'Its 3am and the hallway outside 4B smells like rotten eggs. Is that normal??', facts: { hour: 3, outsideTempC: 2 },
      answers: { issue: { choice: 'other', confidence: 0.6 }, 'danger?': { noul: 0.92 } } },
    { label: 'Ceiling drip, 11pm', message: "Water dripping from my bathroom ceiling, there's a puddle on the floor", facts: { hour: 23, outsideTempC: 12 },
      answers: { issue: { choice: 'water-leak', confidence: 0.96 }, 'danger?': { noul: 0.12 } } },
    { label: 'Same drip, noon', message: "Water dripping from my bathroom ceiling, there's a puddle on the floor", facts: { hour: 12, outsideTempC: 12 },
      answers: { issue: { choice: 'water-leak', confidence: 0.96 }, 'danger?': { noul: 0.12 } } },
    { label: 'No heat, −8°C', message: 'Radiators are ice cold and my kids are wearing coats inside', facts: { hour: 19, outsideTempC: -8 },
      answers: { issue: { choice: 'no-heat', confidence: 0.97 }, 'danger?': { noul: 0.2 } } },
    { label: 'Chipped paint', message: 'Paint is peeling a bit above the shower, whenever you get a chance', facts: { hour: 10, outsideTempC: 18 },
      answers: { issue: { choice: 'cosmetic', confidence: 0.94 }, 'danger?': { noul: 0.01 } } },
  ],
  facts: [
    { key: 'hour', label: 'Time of day', min: 0, max: 23, format: clock },
    { key: 'outsideTempC', label: 'Outside', min: -20, max: 35, format: t => `${t}°C` },
  ],
  toInput: (message, f) => ({ message, hour: f.hour, outsideTempC: f.outsideTempC }),
  // What the building texts back, by target.
  outcomes: {
    'emergency-oncall': "Please leave the building now and call 911 from outside. We're paging the emergency on-call.",
    'hvac-oncall': 'We are paging our heating technician now. Someone will call you within the hour.',
    'plumber-oncall': 'Paging the after-hours plumber. If you can, turn off the valve under the sink.',
    'plumber-today': 'A plumber will be there today. We will text you a time window.',
    'electrician-today': 'An electrician is booked for today.',
    'hvac-next-slot': 'Booked heating repair for the next available slot.',
    locksmith: 'A locksmith is on the way. Have your ID ready.',
    'pest-control-route': 'Added to this week’s pest control route.',
    'maintenance-backlog': 'Thanks! Logged for the next routine maintenance visit.',
    'property-manager': 'A property manager will get back to you shortly.',
  },
};

export default function Demo(props) {
  return <Flow {...props} route="maintenance" example={example} next={{ href: '/examples/reservation', label: 'SMS host' }} />;
}
