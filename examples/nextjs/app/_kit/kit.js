'use client';
// Shared pieces for the three demos: calling a route, playing the model,
// showing a decision, and the decision log.
import { useCallback, useEffect, useRef, useState } from 'react';
import { colour } from './highlight.js';

// The jevlang.sh colours: green assign, amber escalate/page, red hold.
export const toneOf = action => ({ assign: 'ok', escalate: 'warn', page: 'warn', hold: 'bad' }[action] ?? 'warn');

export function useDecision(route) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);
  const run = useCallback(async (input, answers) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(answers ? { input, answers } : { input }),
      });
      setResult({ status: res.status, ...(await res.json()) });
    } catch (error) {
      setResult({ status: 0, error: error.message });
    } finally {
      setLoading(false);
      setVersion(v => v + 1);
    }
  }, [route]);
  return { result, loading, run, version };
}

// Default answers: the first option at high confidence, every yes/no at 0.
export const blankAnswers = questions => Object.fromEntries(Object.entries(questions).map(([name, q]) =>
  [name, q.type === 'choice' ? { choice: Object.keys(q.criteria)[0], confidence: 0.9 } : { noul: 0 }]));

// "You are the model": answer each question the policy would send.
export function ModelPanel({ questions, answers, setAnswers, live, setLive }) {
  const set = (name, value) => setAnswers({ ...answers, [name]: { ...answers[name], ...value } });
  return (
    <section className="card">
      <div className="bar">
        <span className="name"><b>Who answers</b> the questions</span>
        <div className="seg" role="group" aria-label="Who answers the questions">
          <button aria-pressed={!live} onClick={() => setLive(false)}>You</button>
          <button aria-pressed={live} onClick={() => setLive(true)}>Live model</button>
        </div>
      </div>
      {live ? (
        <p className="muted" style={{ margin: 0, fontSize: '.9rem' }}>The route sends the message to the TypeSafe model (needs <code>TYPESAFE_API_KEY</code>). Local facts stay on the server.</p>
      ) : Object.entries(questions).map(([name, q]) => (
        <div key={name} className="field">
          <label htmlFor={`q-${name}`}>{q.instructions.replaceAll('`', '')}</label>
          {q.type === 'choice' ? (
            <div className="row">
              <select id={`q-${name}`} style={{ flex: '1 1 160px', width: 'auto' }} value={answers[name].choice}
                onChange={e => set(name, { choice: e.target.value })}>
                {Object.entries(q.criteria).map(([k, v]) => <option key={k} value={k}>{k} — {v}</option>)}
              </select>
              <span className="mono" style={{ width: 90 }}>conf {answers[name].confidence.toFixed(2)}</span>
              <input aria-label={`${name} confidence`} type="range" min="0" max="1" step="0.01" style={{ flex: '1 1 120px', width: 'auto' }}
                value={answers[name].confidence} onChange={e => set(name, { confidence: Number(e.target.value) })} />
            </div>
          ) : (
            <div className="row">
              <span className="mono" style={{ width: 70 }}>p={answers[name].noul.toFixed(2)}</span>
              <input id={`q-${name}`} type="range" min="0" max="1" step="0.01" style={{ flex: 1, width: 'auto' }}
                value={answers[name].noul} onChange={e => set(name, { noul: Number(e.target.value) })} />
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

export function DecisionCard({ result }) {
  if (!result) return <section className="card"><h2><span className="name"><b>decision</b></span></h2><p className="muted" style={{ margin: 0 }}>Nothing decided yet.</p></section>;
  if (result.error) return <section className="card"><h2><span className="name"><b>decision</b></span></h2><span className="badge tone-bad">error {result.status}</span><pre className="mono">{result.error}</pre></section>;
  const readings = result.decision?.readings ?? [];
  return (
    <section className="card" aria-live="polite">
      <h2><span className="name"><b>decision</b></span></h2>
      <span className={`badge tone-${toneOf(result.action)}`}>{result.action}</span>
      <div className="verdict">{result.target ?? '—'}</div>
      {result.reason && <div className="muted">{result.reason}</div>}
      <div className="mono muted" style={{ marginTop: 6 }}>fired by {result.decision?.source}{result.decision?.model ? ` · ${result.decision.model}` : ''}</div>
      {readings.length > 0 && (
        <ul className="readings">
          {readings.map(r => (
            <li key={r.question}><span>{r.question}</span><span className="mono">{String(r.value)}{r.confidence != null ? ` · ${Number(r.confidence).toFixed(2)}` : ''}</span></li>
          ))}
        </ul>
      )}
      <details><summary>Explanation</summary><pre className="mono">{result.explanation}</pre></details>
    </section>
  );
}

// Recording runs after the response, so give the store a moment before re-reading.
export function DecisionLog({ route, version, field = 'message' }) {
  const [state, setState] = useState({ decisions: null });
  useEffect(() => {
    let live = true;
    const load = () => fetch(`/api/${route}`, { cache: 'no-store' }).then(r => r.json())
      .then(d => live && setState(d)).catch(() => live && setState({ decisions: [] }));
    const t = setTimeout(load, version ? 700 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [route, version]);
  const decisions = state.decisions;
  return (
    <section className="card">
      <h2><span className="name"><b>decision log</b> · {state.backend === 'upstash' ? 'Upstash Redis' : 'in memory'}</span><span className="bar-chip bar-chip--ok">stored</span></h2>
      {decisions == null ? <p className="muted" style={{ margin: 0 }}>Loading…</p>
        : decisions.length === 0 ? <p className="muted" style={{ margin: 0 }}>No decisions stored yet.</p>
        : (
          <ul className="log">
            {decisions.map(d => (
              <li key={d.at + d.decision.target}>
                <span className={`badge tone-${toneOf(d.decision.action)}`}>{d.decision.action}</span>
                <span><strong>{d.decision.target}</strong> <span className="when">{new Date(d.at).toLocaleTimeString()}</span></span>
                <span className="msg">{d.state?.[field]}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

// Which lines of the policy source decided: $.gates[i], $.route.clauses[i] or $.route.otherwise.
export function firedSpan(source, decisionSource) {
  if (!decisionSource) return null;
  const gate = decisionSource.match(/^\$\.gates\[(\d+)\]/);
  if (gate) return source.gates[Number(gate[1])] ?? null;
  const clause = decisionSource.match(/^\$\.route\.clauses\[(\d+)\]/);
  if (clause) return source.clauses[Number(clause[1])] ?? null;
  return decisionSource === '$.route.otherwise' ? source.otherwise : null;
}

export function PolicyCode({ source, result, route }) {
  const span = result && !result.error ? firedSpan(source, result.decision?.source) : null;
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current?.querySelector('.fired');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [span?.[0], result]);
  return (
    <section className="card code-panel" aria-label="Policy source">
      <div className="bar">
        <span className="dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="name">lib/policies.js · <b>POST /api/{route}</b></span>
        <span className="bar-chip">source</span>
      </div>
      <p className="code-note">
        {span ? <>Highlighted: <span className="mono">{result.decision.source}</span>, the clause that decided.</> : 'Run a scenario: the clause that decides lights up here.'}
      </p>
      <pre ref={ref} className="code mono">
        {source.lines.map((line, i) => {
          const fired = span && i >= span[0] && i <= span[1];
          return (
            <div key={i} className={fired ? 'fired' : undefined}>
              <span className="ln">{source.firstLine + i}</span><span className="src">{colour(line)}{'\n'}</span>
            </div>
          );
        })}
      </pre>
    </section>
  );
}
