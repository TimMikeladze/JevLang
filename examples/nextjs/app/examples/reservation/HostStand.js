'use client';
import { useState } from 'react';
import { useDecision, ModelPanel, DecisionCard, DecisionLog, PolicyCode } from '../../_kit/kit.js';

const presets = [
  { label: 'EpiPen booking', message: 'Hi! Table for 4 Saturday 7pm? My son carries an EpiPen for tree nuts.', party: 4, seats: 12,
    answers: { intent: { choice: 'book', confidence: 0.97 }, 'severe-allergy?': { noul: 0.96 } } },
  { label: 'Fully booked', message: 'Could we get a table for 6 tonight at 8?', party: 6, seats: 2,
    answers: { intent: { choice: 'book', confidence: 0.95 }, 'severe-allergy?': { noul: 0.01 } } },
  { label: 'Office party of 14', message: 'Looking to book for our team, 14 people, Friday the 12th', party: 14, seats: 40,
    answers: { intent: { choice: 'book', confidence: 0.93 }, 'severe-allergy?': { noul: 0.02 } } },
  { label: 'Cold food complaint', message: 'Our mains came out cold last night and nobody checked on us', party: 2, seats: 20,
    answers: { intent: { choice: 'complaint', confidence: 0.95 }, 'severe-allergy?': { noul: 0.0 } } },
  { label: 'Parking?', message: 'Is there parking nearby?', party: 2, seats: 20,
    answers: { intent: { choice: 'question', confidence: 0.96 }, 'severe-allergy?': { noul: 0.0 } } },
];

const replies = {
  'confirm-and-alert-kitchen': "You're booked! We've flagged the allergy on your ticket and the chef will come say hi.",
  'confirm-booking': "You're booked! See you then.",
  'offer-waitlist': "We're full at that time — want us to add you to the waitlist? Reply YES.",
  'events-manager': 'For groups that size our events manager will call you about a set menu.',
  manager: "I'm really sorry. Our manager will call you today.",
  'reschedule-link': 'Here is a link to change your booking: https://example.com/r/abc',
  'cancel-and-release-table': "Cancelled. Hope to see you another time!",
  'faq-reply': 'There is a public garage on Pine St, 2 min walk — we validate for 3 hours.',
  'host-stand': 'One of our hosts will reply in a moment.',
};

export default function HostStand({ questions, source }) {
  const [preset, setPreset] = useState(0);
  const [message, setMessage] = useState(presets[0].message);
  const [party, setParty] = useState(presets[0].party);
  const [seats, setSeats] = useState(presets[0].seats);
  const [answers, setAnswers] = useState(presets[0].answers);
  const [live, setLive] = useState(false);
  const { result, loading, run, version } = useDecision('reservation');

  const pick = i => {
    const p = presets[i];
    setPreset(i); setMessage(p.message); setParty(p.party); setSeats(p.seats); setAnswers(p.answers);
  };
  const reply = result && !result.error ? replies[result.target] ?? result.reason : null;
  const fill = Math.min(1, party / Math.max(seats, 1));

  return (
    <div className="shell shell--wide">
      <div className="page-head">
        <h1 className="page-title">Restaurant SMS host</h1>
        <p className="lede" style={{ marginBottom: 0 }}>Guests text the restaurant. Party size and free seats come from the booking system; the model reads intent and spots the allergy that has to reach the kitchen.</p>
      </div>
      <div className="grid side">
        <div>
          <div className="chips">
            {presets.map((p, i) => <button key={p.label} className="chip" aria-pressed={preset === i} onClick={() => pick(i)}>{p.label}</button>)}
          </div>
          <section className="card">
            <h2><span className="dots" aria-hidden="true"><i /><i /><i /></span><span className="name"><b>host stand</b> · incoming SMS</span></h2>
            <textarea aria-label="Guest message" rows={3} value={message} onChange={e => setMessage(e.target.value)} />
            <div className="row" style={{ marginTop: 12 }}>
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label htmlFor="party">Party size</label>
                <input id="party" type="number" min="1" max="40" value={party} onChange={e => setParty(Number(e.target.value))} />
              </div>
              <div className="field" style={{ flex: '2 1 200px' }}>
                <label htmlFor="seats">Seats free at that time: {seats}</label>
                <input id="seats" type="range" min="0" max="60" value={seats} onChange={e => setSeats(Number(e.target.value))} />
              </div>
            </div>
            <div className="label">Floor after seating this party</div>
            <div style={{ height: 10, borderRadius: 6, background: 'var(--bg)', overflow: 'hidden', margin: '4px 0 12px' }}>
              <div style={{ width: `${fill * 100}%`, height: '100%', background: party > seats ? 'var(--bad)' : 'var(--ok)' }} />
            </div>
            <button className="btn" onClick={() => run({ message, partySize: party, seatsFree: seats }, live ? null : answers)} disabled={loading || !message.trim()}>
              {loading ? 'Deciding…' : 'Handle message'}
            </button>
            {reply && (
              <div className="thread" style={{ minHeight: 0, paddingBottom: 0 }}>
                <div className="bubble them">{message}</div>
                <div className="bubble us">{reply}</div>
              </div>
            )}
          </section>
        </div>
        <div>
          <ModelPanel questions={questions} answers={answers} setAnswers={setAnswers} live={live} setLive={setLive} />
          <DecisionCard result={result} />
          <DecisionLog route="reservation" version={version} />
        </div>
        <div className="code-col">
          <PolicyCode source={source} result={result} route="reservation" />
        </div>
      </div>
    </div>
  );
}
