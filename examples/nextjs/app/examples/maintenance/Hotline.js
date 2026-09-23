'use client';
import { useState } from 'react';
import { useDecision, ModelPanel, DecisionCard, DecisionLog, PolicyCode } from '../../_kit/kit.js';

const presets = [
  { label: 'Rotten-egg smell, 3am', message: 'Its 3am and the hallway outside 4B smells like rotten eggs. Is that normal??', hour: 3, temp: 2,
    answers: { issue: { choice: 'other', confidence: 0.6 }, 'danger?': { noul: 0.92 } } },
  { label: 'Ceiling drip, 11pm', message: "Water dripping from my bathroom ceiling, there's a puddle on the floor", hour: 23, temp: 12,
    answers: { issue: { choice: 'water-leak', confidence: 0.96 }, 'danger?': { noul: 0.12 } } },
  { label: 'Same drip, noon', message: "Water dripping from my bathroom ceiling, there's a puddle on the floor", hour: 12, temp: 12,
    answers: { issue: { choice: 'water-leak', confidence: 0.96 }, 'danger?': { noul: 0.12 } } },
  { label: 'No heat, −8°C', message: 'Radiators are ice cold and my kids are wearing coats inside', hour: 19, temp: -8,
    answers: { issue: { choice: 'no-heat', confidence: 0.97 }, 'danger?': { noul: 0.2 } } },
  { label: 'Chipped paint', message: 'Paint is peeling a bit above the shower, whenever you get a chance', hour: 10, temp: 18,
    answers: { issue: { choice: 'cosmetic', confidence: 0.94 }, 'danger?': { noul: 0.01 } } },
];

// What the building texts back, by target.
const replies = {
  'emergency-oncall': "Please leave the building now and call 911 from outside. We're paging the emergency on-call.",
  'hvac-oncall': 'We are paging our heating technician now. Someone will call you within the hour.',
  'plumber-oncall': 'Paging the after-hours plumber. If you can, turn off the valve under the sink and move valuables.',
  'plumber-today': 'A plumber will be there today. We will text you a time window.',
  'electrician-today': 'An electrician is booked for today.',
  'hvac-next-slot': 'Booked heating repair for the next available slot.',
  locksmith: 'A locksmith is on the way. Have your ID ready.',
  'pest-control-route': 'Added to this week’s pest control route.',
  'maintenance-backlog': 'Thanks! Logged for the next routine maintenance visit.',
  'property-manager': 'A property manager will get back to you shortly.',
};

const clock = h => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

export default function Hotline({ questions, source }) {
  const [preset, setPreset] = useState(0);
  const [message, setMessage] = useState(presets[0].message);
  const [hour, setHour] = useState(presets[0].hour);
  const [temp, setTemp] = useState(presets[0].temp);
  const [answers, setAnswers] = useState(presets[0].answers);
  const [live, setLive] = useState(false);
  const [thread, setThread] = useState([]);
  const { result, loading, run, version } = useDecision('maintenance');

  const pick = i => {
    const p = presets[i];
    setPreset(i); setMessage(p.message); setHour(p.hour); setTemp(p.temp); setAnswers(p.answers);
  };
  const send = async () => {
    setThread(t => [...t, { who: 'them', text: message }]);
    await run({ message, hour, outsideTempC: temp }, live ? null : answers);
  };
  const reply = result && !result.error ? replies[result.target] ?? result.reason : null;

  return (
    <div className="shell shell--wide">
      <div className="page-head">
        <h1 className="page-title">Tenant hotline</h1>
        <p className="lede" style={{ marginBottom: 0 }}>Tenants text one number. The policy decides who gets woken up. Time and outdoor temperature come from your systems and never reach the model.</p>
      </div>
      <div className="grid side">
        <div>
          <div className="chips">
            {presets.map((p, i) => <button key={p.label} className="chip" aria-pressed={preset === i} onClick={() => pick(i)}>{p.label}</button>)}
          </div>
          <div className="card">
            <div className="bar"><span className="dots" aria-hidden="true"><i /><i /><i /></span><span className="name"><b>Maple Court</b> · SMS · {clock(hour)} · {temp}°C outside</span></div>
            <div className="thread">
              {thread.length === 0 && <div className="bubble system">Pick a scenario or write your own, then send.</div>}
              {thread.map((m, i) => <div key={i} className={`bubble ${m.who}`}>{m.text}</div>)}
              {loading && <div className="bubble system">deciding…</div>}
              {reply && <div className="bubble us">{reply}</div>}
            </div>
            <div className="compose">
              <textarea aria-label="Tenant message" rows={2} value={message} onChange={e => setMessage(e.target.value)} />
              <button className="btn" onClick={send} disabled={loading || !message.trim()}>Send</button>
            </div>
          </div>
          <section className="card" style={{ marginTop: 16 }}>
            <h2><span className="name"><b>local facts</b> · never sent to the model</span></h2>
            <div className="field">
              <label htmlFor="hour">Time of day: {clock(hour)}</label>
              <input id="hour" type="range" min="0" max="23" value={hour} onChange={e => setHour(Number(e.target.value))} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="temp">Outside: {temp}°C</label>
              <input id="temp" type="range" min="-20" max="35" value={temp} onChange={e => setTemp(Number(e.target.value))} />
            </div>
          </section>
        </div>
        <div>
          <ModelPanel questions={questions} answers={answers} setAnswers={setAnswers} live={live} setLive={setLive} />
          <DecisionCard result={result} />
          <DecisionLog route="maintenance" version={version} />
        </div>
        <div className="code-col">
          <PolicyCode source={source} result={result} route="maintenance" />
        </div>
      </div>
    </div>
  );
}
