'use client';
// One guided flow for every example: a request comes in, the model answers the
// policy's questions, the policy decides, and you call it yourself. Each
// example page hands in its scenarios, facts and outcome copy; the policy
// source sits beside the flow with the deciding clause highlighted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { colour } from './highlight.js';

const toneOf = action => ({ assign: 'ok', escalate: 'warn', page: 'warn', hold: 'bad' }[action] ?? 'warn');

// Which lines of the policy source decided: $.gates[i], $.route.clauses[i] or $.route.otherwise.
function firedSpan(source, decisionSource) {
  if (!decisionSource) return null;
  const gate = decisionSource.match(/^\$\.gates\[(\d+)\]/);
  if (gate) return source.gates[Number(gate[1])] ?? null;
  const clause = decisionSource.match(/^\$\.route\.clauses\[(\d+)\]/);
  if (clause) return source.clauses[Number(clause[1])] ?? null;
  return decisionSource === '$.route.otherwise' ? source.otherwise : null;
}

function useDecide(route) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [recorded, setRecorded] = useState(0);
  const seq = useRef(0);
  const decide = async (input, answers, { preview = false } = {}) => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input, ...(answers ? { answers } : {}), ...(preview ? { preview: true } : {}) }),
      });
      const body = await res.json();
      // A slower, older request never overwrites a newer answer.
      if (mine === seq.current) setResult({ status: res.status, ...body });
    } catch (error) {
      if (mine === seq.current) setResult({ status: 0, error: error.message });
    } finally {
      if (mine === seq.current) setLoading(false);
      if (!preview) setRecorded(v => v + 1);
    }
  };
  return { result, loading, decide, recorded };
}

function Step({ n, title, hint, children, aside }) {
  return (
    <section className="step" aria-labelledby={`step-${n}`}>
      <div className="step-rail" aria-hidden="true"><span className="step-n">{n}</span></div>
      <div className="step-body">
        <header className="step-head">
          <div>
            <h2 id={`step-${n}`}>{title}</h2>
            {hint && <p className="step-hint">{hint}</p>}
          </div>
          {aside}
        </header>
        {children}
      </div>
    </section>
  );
}

function FactInput({ fact, value, onChange }) {
  const id = `fact-${fact.key}`;
  if (fact.type === 'bool') {
    return (
      <label className="fact fact--bool" htmlFor={id}>
        <span className="fact-label">{fact.label}</span>
        <span className="switch"><input id={id} type="checkbox" role="switch" checked={value} onChange={e => onChange(e.target.checked)} /><i aria-hidden="true" /></span>
      </label>
    );
  }
  return (
    <div className="fact">
      <label className="fact-label" htmlFor={id}>{fact.label}<b>{fact.format ? fact.format(value) : value}</b></label>
      <input id={id} type="range" min={fact.min} max={fact.max} step={fact.step ?? 1} value={value} onChange={e => onChange(Number(e.target.value))} />
    </div>
  );
}

function QuestionInput({ name, q, answer, set }) {
  const text = q.instructions.replaceAll('`', '');
  if (q.type === 'choice') {
    return (
      <div className="question">
        <p className="question-text"><span className="qname">{name}</span>{text}</p>
        <div className="options" role="radiogroup" aria-label={name}>
          {Object.entries(q.criteria).map(([k, v]) => (
            <button key={k} type="button" role="radio" aria-checked={answer.choice === k} title={v} onClick={() => set({ choice: k })}>{k}</button>
          ))}
        </div>
        <label className="meter">
          <span>confidence</span>
          <input type="range" min="0" max="1" step="0.01" value={answer.confidence} onChange={e => set({ confidence: Number(e.target.value) })} aria-label={`${name} confidence`} />
          <b>{answer.confidence.toFixed(2)}</b>
        </label>
      </div>
    );
  }
  return (
    <div className="question">
      <p className="question-text"><span className="qname">{name}</span>{text}</p>
      <label className="meter">
        <span>probability</span>
        <input type="range" min="0" max="1" step="0.01" value={answer.noul} onChange={e => set({ noul: Number(e.target.value) })} aria-label={`${name} probability`} />
        <b>{answer.noul.toFixed(2)}</b>
      </label>
    </div>
  );
}

function Outcome({ result, loading, outcomes, onShowClause }) {
  if (!result) return <div className="outcome outcome--empty">{loading ? 'Deciding…' : 'Pick a scenario to see the decision.'}</div>;
  if (result.error) {
    return (
      <div className="outcome tone-bad" role="status">
        <p className="outcome-kicker">{result.status === 429 ? 'rate limited' : `error ${result.status}`}</p>
        <p className="outcome-say">{result.error}</p>
      </div>
    );
  }
  const readings = result.decision?.readings ?? [];
  const say = outcomes[result.target] ?? result.reason ?? result.target;
  return (
    <div className={`outcome tone-${toneOf(result.action)}${loading ? ' is-stale' : ''}`} role="status" aria-live="polite">
      <p className="outcome-kicker"><span className="badge">{result.action}</span><code>{result.target}</code></p>
      <p className="outcome-say">{say}</p>
      {result.reason && <p className="outcome-why">because {result.reason}</p>}
      {readings.length > 0 && (
        <ul className="outcome-readings">
          {readings.map(r => (
            <li key={r.question}><span>{r.question}</span><b>{String(r.value)}</b>{r.confidence != null && <em>{Number(r.confidence).toFixed(2)}</em>}</li>
          ))}
        </ul>
      )}
      <button type="button" className="linkish" onClick={onShowClause}>
        decided by <code>{result.decision?.source}</code>{result.decision?.provider ? ` · answered by ${result.decision.model ?? result.decision.provider}` : ''} →
      </button>
    </div>
  );
}

function PolicyPanel({ source, result, route, flash }) {
  const span = result && !result.error ? firedSpan(source, result.decision?.source) : null;
  const ref = useRef(null);
  useEffect(() => {
    const box = ref.current, el = box?.querySelector('.fired');
    if (el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 3, behavior: 'smooth' });
  }, [span?.[0], flash]);
  return (
    <section className={`policy${flash ? ' is-flash' : ''}`} aria-label="Policy source">
      <div className="policy-bar">
        <span className="dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="name">lib/policies.js</span>
        <span className="route">POST /api/{route}</span>
      </div>
      <pre ref={ref} className="policy-code">
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

function RecentLog({ route, recorded, field = 'message' }) {
  const [state, setState] = useState({ decisions: null });
  useEffect(() => {
    let live = true;
    const load = () => fetch(`/api/${route}`, { cache: 'no-store' }).then(r => r.json())
      .then(d => live && setState(d)).catch(() => live && setState({ decisions: [] }));
    const t = setTimeout(load, recorded ? 700 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [route, recorded]);
  const decisions = state.decisions ?? [];
  return (
    <section className="log-panel">
      <h3>Recent decisions <span>{state.backend === 'upstash' ? 'Upstash Redis' : 'in memory'}</span></h3>
      {decisions.length === 0 ? <p className="muted">Nothing recorded yet. Press “Record this decision”.</p> : (
        <ol>
          {decisions.slice(0, 6).map(d => (
            <li key={d.at + d.decision.target}>
              <span className={`dot tone-${toneOf(d.decision.action)}`} aria-hidden="true" />
              <span className="msg">{d.state?.[field]}</span>
              <code>{d.decision.target}</code>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function CallIt({ route, input, answers, live }) {
  const [copied, setCopied] = useState(false);
  const body = JSON.stringify(live ? { input } : { input, answers });
  const cmd = `curl https://jevlang.sh/api/${route} \\\n  -H 'content-type: application/json' \\\n  -d '${body.replaceAll("'", "'\\''")}'`;
  const copy = () => navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); });
  return (
    <div className="callit">
      <div className="callit-bar"><span>shell</span><button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
      <pre>{cmd}</pre>
    </div>
  );
}

export default function Flow({ route, questions, source, example, prev, next }) {
  const { presets, facts, outcomes, messageLabel, toInput } = example;
  const [pick, setPick] = useState(0);
  const [message, setMessage] = useState(presets[0].message);
  const [values, setValues] = useState(presets[0].facts);
  const [answers, setAnswers] = useState(presets[0].answers);
  const [live, setLive] = useState(false);
  const [flash, setFlash] = useState(0);
  const { result, loading, decide, recorded } = useDecide(route);

  const input = useMemo(() => toInput(message, values), [message, values, toInput]);
  const choose = i => { setPick(i); setMessage(presets[i].message); setValues(presets[i].facts); setAnswers(presets[i].answers); };
  const setAnswer = (name, patch) => setAnswers(a => ({ ...a, [name]: { ...a[name], ...patch } }));

  // Playing the model costs nothing, so the decision follows every change.
  useEffect(() => {
    if (live || !message.trim()) return;
    const t = setTimeout(() => decide(input, answers, { preview: true }), 180);
    return () => clearTimeout(t);
  }, [input, answers, live]); // eslint-disable-line react-hooks/exhaustive-deps

  const showClause = () => {
    setFlash(f => f + 1);
    document.querySelector('.policy')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="shell shell--wide flow-page">
      <header className="flow-hero">
        <nav className="crumbs" aria-label="Examples">
          <span>Examples</span>
          {prev && <a href={prev.href}>← {prev.label}</a>}
          {next && <a href={next.href}>{next.label} →</a>}
        </nav>
        <h1>{example.title}</h1>
        <p className="lede">{example.lede}</p>
        <ul className="takeaways">{example.takeaways.map(t => <li key={t}>{t}</li>)}</ul>
      </header>

      <div className="flow-grid">
        <div className="flow">
          <Step n={1} title="A request comes in" hint="Pick a scenario or write your own. The facts on the right come from your systems.">
            <div className="scenarios" role="tablist" aria-label="Scenarios">
              {presets.map((p, i) => <button key={p.label} role="tab" aria-selected={pick === i} onClick={() => choose(i)}>{p.label}</button>)}
            </div>
            <div className="request">
              <label className="message">
                <span>{messageLabel}</span>
                <textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} />
              </label>
              <div className="facts">
                <p className="facts-note"><span className="lock" aria-hidden="true" />From your systems · never sent to the model</p>
                {facts.map(f => <FactInput key={f.key} fact={f} value={values[f.key]} onChange={v => setValues(s => ({ ...s, [f.key]: v }))} />)}
              </div>
            </div>
          </Step>

          <Step n={2} title="The model answers the policy's questions"
            hint={live ? 'The live model reads the message. Limited to a few calls an hour.' : 'You play the model: drag an answer and watch the decision change.'}
            aside={
              <div className="seg" role="group" aria-label="Who answers">
                <button aria-pressed={!live} onClick={() => setLive(false)}>You</button>
                <button aria-pressed={live} onClick={() => setLive(true)}>Live model</button>
              </div>
            }>
            {live ? (
              <div className="live-note">
                <p>The route sends only the message to the model. It answers {Object.keys(questions).length} questions; the policy does the rest.</p>
                <button className="btn" disabled={loading || !message.trim()} onClick={() => decide(input, null)}>{loading ? 'Asking the model…' : 'Ask the live model'}</button>
              </div>
            ) : (
              <div className="questions">
                {Object.entries(questions).map(([name, q]) => <QuestionInput key={name} name={name} q={q} answer={answers[name]} set={patch => setAnswer(name, patch)} />)}
              </div>
            )}
          </Step>

          <Step n={3} title="The policy decides" hint="Plain code picks the branch, and says which clause and which readings did it.">
            <Outcome result={result} loading={loading} outcomes={outcomes} onShowClause={showClause} />
            {!live && result && !result.error && (
              <button className="btn btn--ghost" disabled={loading} onClick={() => decide(input, answers)}>Record this decision</button>
            )}
          </Step>

          <Step n={4} title="Call it from your code" hint="The same route, the same answer. Drop the answers to let the model reply.">
            <CallIt route={route} input={input} answers={answers} live={live} />
          </Step>
        </div>

        <aside className="flow-side">
          <PolicyPanel source={source} result={result} route={route} flash={flash} />
          <RecentLog route={route} recorded={recorded} />
        </aside>
      </div>
    </div>
  );
}
