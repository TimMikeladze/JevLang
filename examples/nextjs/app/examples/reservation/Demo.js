'use client';
import Flow from '../../_kit/Flow.js';

const example = {
  title: 'Restaurant SMS host',
  lede: 'Guests text the restaurant. The model reads intent and spots the allergy that has to reach the kitchen; party size and free seats come from the booking system.',
  takeaways: ['An allergy always reaches the kitchen', 'Capacity comes from your system, not the model', 'Unsure about intent? A host answers'],
  messageLabel: 'Guest’s text',
  presets: [
    { label: 'EpiPen booking', message: 'Hi! Table for 4 Saturday 7pm? My son carries an EpiPen for tree nuts.', facts: { partySize: 4, seatsFree: 12 },
      answers: { intent: { choice: 'book', confidence: 0.97 }, 'severe-allergy?': { noul: 0.96 } } },
    { label: 'Fully booked', message: 'Could we get a table for 6 tonight at 8?', facts: { partySize: 6, seatsFree: 2 },
      answers: { intent: { choice: 'book', confidence: 0.95 }, 'severe-allergy?': { noul: 0.01 } } },
    { label: 'Office party of 14', message: 'Looking to book for our team, 14 people, Friday the 12th', facts: { partySize: 14, seatsFree: 40 },
      answers: { intent: { choice: 'book', confidence: 0.93 }, 'severe-allergy?': { noul: 0.02 } } },
    { label: 'Cold food complaint', message: 'Our mains came out cold last night and nobody checked on us', facts: { partySize: 2, seatsFree: 20 },
      answers: { intent: { choice: 'complaint', confidence: 0.95 }, 'severe-allergy?': { noul: 0 } } },
    { label: 'Parking?', message: 'Is there parking nearby?', facts: { partySize: 2, seatsFree: 20 },
      answers: { intent: { choice: 'question', confidence: 0.96 }, 'severe-allergy?': { noul: 0 } } },
  ],
  facts: [
    { key: 'partySize', label: 'Party size', min: 1, max: 30 },
    { key: 'seatsFree', label: 'Seats free at that time', min: 0, max: 60 },
  ],
  toInput: (message, f) => ({ message, partySize: f.partySize, seatsFree: f.seatsFree }),
  outcomes: {
    'confirm-and-alert-kitchen': "You're booked! We've flagged the allergy on your ticket and the chef will come say hi.",
    'confirm-booking': "You're booked! See you then.",
    'offer-waitlist': "We're full at that time — want us to add you to the waitlist? Reply YES.",
    'events-manager': 'For groups that size our events manager will call you about a set menu.',
    manager: "I'm really sorry. Our manager will call you today.",
    'reschedule-link': 'Here is a link to change your booking.',
    'cancel-and-release-table': 'Cancelled. Hope to see you another time!',
    'faq-reply': 'There is a public garage on Pine St, 2 min walk — we validate for 3 hours.',
    'host-stand': 'One of our hosts will reply in a moment.',
  },
};

export default function Demo(props) {
  return <Flow {...props} route="reservation" example={example}
    prev={{ href: '/examples/maintenance', label: 'Tenant hotline' }} next={{ href: '/examples/doorstep', label: 'Courier app' }} />;
}
