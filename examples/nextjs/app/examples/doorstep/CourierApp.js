'use client';
import { useState } from 'react';
import { useDecision, ModelPanel, DecisionCard, DecisionLog, toneOf, PolicyCode } from '../../_kit/kit.js';

const quick = [
  { label: 'No answer', message: 'No answer at the door', answers: { situation: { choice: 'nobody-home', confidence: 0.95 }, 'unsafe?': { noul: 0.02 } } },
  { label: 'Loose dog', message: 'Nobody home and a big dog is loose in the yard, growling', answers: { situation: { choice: 'nobody-home', confidence: 0.9 }, 'unsafe?': { noul: 0.9 } } },
  { label: 'Gate code wrong', message: 'Gate code 4411 does not work, cannot get to the building', answers: { situation: { choice: 'access-blocked', confidence: 0.93 }, 'unsafe?': { noul: 0.03 } } },
  { label: "Can't find unit", message: 'There is no unit 12B in this building', answers: { situation: { choice: 'address-unclear', confidence: 0.94 }, 'unsafe?': { noul: 0.01 } } },
  { label: 'Someone’s here', message: 'Neighbour answered, says she is the recipient', answers: { situation: { choice: 'resident-there', confidence: 0.85 }, 'unsafe?': { noul: 0.01 } } },
];

const instructions = {
  'hand-over': 'Hand it over',
  'leave-at-door': 'Leave at door',
  'parcel-locker': 'Take to locker',
  'reattempt-tomorrow': 'Keep it · retry tomorrow',
  'call-recipient': 'Call recipient',
  'dispatch-desk': 'Call dispatch',
};

export default function CourierApp({ questions, source }) {
  const [pick, setPick] = useState(0);
  const [message, setMessage] = useState(quick[0].message);
  const [answers, setAnswers] = useState(quick[0].answers);
  const [value, setValue] = useState(40);
  const [raining, setRaining] = useState(false);
  const [locker, setLocker] = useState(true);
  const [live, setLive] = useState(false);
  const { result, loading, run, version } = useDecision('doorstep');

  const choose = i => { setPick(i); setMessage(quick[i].message); setAnswers(quick[i].answers); };
  const ok = result && !result.error;

  return (
    <div className="shell shell--wide">
      <div className="page-head">
        <h1 className="page-title">Courier app</h1>
        <p className="lede" style={{ marginBottom: 0 }}>The driver says what&apos;s happening at the door. Parcel value, weather and nearby lockers come from dispatch — the driver never has to know the rules.</p>
      </div>
      <div className="grid side">
        <div>
          <section className="card">
            <h2><span className="dots" aria-hidden="true"><i /><i /><i /></span><span className="name"><b>courier</b> · stop 14 of 38 · parcel A7-2291</span></h2>
            <div className="row">
              <div className="field" style={{ flex: '1 1 140px' }}>
                <label htmlFor="value">Declared value (USD)</label>
                <input id="value" type="number" min="0" value={value} onChange={e => setValue(Number(e.target.value))} />
              </div>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={raining} onChange={e => setRaining(e.target.checked)} /> Raining</label>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={locker} onChange={e => setLocker(e.target.checked)} /> Locker within 500m</label>
            </div>
            <div className="label" style={{ marginBottom: 6 }}>What&apos;s happening?</div>
            <div className="chips">
              {quick.map((q, i) => <button key={q.label} className="chip" aria-pressed={pick === i} onClick={() => choose(i)}>{q.label}</button>)}
            </div>
            <textarea aria-label="Courier note" rows={2} value={message} onChange={e => setMessage(e.target.value)} />
            <p style={{ marginBottom: 0 }}>
              <button className="btn" style={{ width: '100%' }} disabled={loading || !message.trim()}
                onClick={() => run({ message, valueUsd: value, raining, lockerNearby: locker }, live ? null : answers)}>
                {loading ? 'Asking dispatch…' : 'What do I do?'}
              </button>
            </p>
          </section>
          {ok && (
            <div className={`banner tone-${toneOf(result.action === 'assign' && result.target === 'reattempt-tomorrow' ? 'hold' : result.action)}`}>
              <div className="big">{instructions[result.target] ?? result.target}</div>
              {result.reason && <div>{result.reason}</div>}
            </div>
          )}
        </div>
        <div>
          <ModelPanel questions={questions} answers={answers} setAnswers={setAnswers} live={live} setLive={setLive} />
          <DecisionCard result={result} />
          <DecisionLog route="doorstep" version={version} />
        </div>
        <div className="code-col">
          <PolicyCode source={source} result={result} route="doorstep" />
        </div>
      </div>
    </div>
  );
}
