import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { doorstep } from '../../lib/policies.js';
import { policySource } from '../../lib/source.js';
import { colour } from '../_kit/highlight.js';
import { Icon, Mark } from '../_kit/icons.js';
import { exampleSource } from '../_kit/site.js';

// Everything shown in a frame is read from this example's own files or
// computed by the real policy at build time — nothing is retyped here.
const read = file => readFileSync(join(process.cwd(), file), 'utf8');
const jevVersion = JSON.parse(read('node_modules/jevlang/package.json')).version;
const nextVersion = JSON.parse(read('node_modules/next/package.json')).version;

const routeLines = route => {
  const { lines, firstLine } = policySource(route);
  const from = lines.findIndex(l => /^\s*route: \{/.test(l));
  return { lines: lines.slice(from, lines.findLastIndex(l => /^\}\);/.test(l)) + 1), first: firstLine + from };
};

function Code({ lines, first = 1 }) {
  return (
    <pre className="code">
      {lines.map((line, i) => <div key={i}><span className="ln">{first + i}</span><span className="src">{colour(line)}{'\n'}</span></div>)}
    </pre>
  );
}

function Frame({ name, chip, chipTone = '', children, dots = false }) {
  return (
    <figure className="card" style={{ margin: 0 }}>
      <div className="bar">
        {dots && <span className="dots" aria-hidden="true"><i /><i /><i /></span>}
        <span className="name">{name}</span>
        {chip && <span className={`bar-chip ${chipTone}`}>{chip}</span>}
      </div>
      {children}
    </figure>
  );
}

const demos = [
  { id: 'tenant-hotline', route: 'maintenance', href: '/examples/maintenance', title: 'Wake the right person',
    expl: <>Tenants text one number and <code>POST /api/maintenance</code> decides who gets paged. <code>danger?</code> pages on-call at <code>yes(0.3)</code> — a false alarm costs a call. Time and temperature are <code>local: true</code> facts.</> },
  { id: 'sms-host', route: 'reservation', href: '/examples/reservation', title: 'Allergies reach the kitchen',
    expl: <>A restaurant&apos;s SMS host behind <code>POST /api/reservation</code>. The model reads intent and flags <code>severe-allergy?</code>; party size and free seats come from the booking system and decide the waitlist.</> },
  { id: 'courier-app', route: 'doorstep', href: '/examples/doorstep', title: 'The driver never learns the rules',
    expl: <>A courier types what&apos;s happening; <code>POST /api/doorstep</code> answers door, locker or tomorrow. Parcel value, rain and a nearby locker are facts the rules read and the model never sees.</> },
];

// The part of lib/backend.js that picks Redis or memory.
const backendSource = read('lib/backend.js');
const backendLines = backendSource.slice(backendSource.indexOf('function create'), backendSource.indexOf('\n}\n', backendSource.indexOf('function create')) + 2).split('\n');

const sample = { message: 'No answer at the door, porch is covered', valueUsd: 480, raining: true, lockerNearby: true };
const built = doorstep.buildState(sample);

const boundaries = [
  { title: 'What holds', items: ['Every decision comes from a clause you can point at; the demos highlight it.', 'Facts marked local: true never leave the server.', 'Bad answers are a 400, not a guess.'] },
  { title: 'What is a judgement', items: ['The thresholds: 0.3 for danger, the $250 doorstep limit, parties over 8.', 'Which clause comes first. Order is policy.', '24 hours of retention, 20 live model calls per minute per client.'] },
  { title: 'What is not here yet', items: ['Replaying the journal against a changed policy.', 'Scheduled work: no route dispatches actions, so there is no runDue cron.', 'Auth on the demo routes.'] },
];

export default function Home() {
  return (
    <>
      <section className="hero shell">
        <Mark />
        <h1>Policy-backed API routes on Next.js</h1>
        <p className="lede">
          Three route handlers, each decided by a <a href="/">JevLang</a> policy. The model answers
          questions, <code>policy.decide</code> picks the branch, every decision lands in Upstash Redis, and live model
          calls are rate limited per client — the same code on one laptop or a thousand serverless instances.
        </p>
        <div className="actions">
          <span className="control"><code>npm run dev</code></span>
          <a className="control" href={exampleSource} target="_blank" rel="noopener"><Icon name="github" />Source <span className="ext">↗</span></a>
          <a className="control control--solid" href="/reference"><Icon name="book" />Documentation</a>
        </div>
        <p className="version">jevlang v{jevVersion} · Next.js {nextVersion}</p>
      </section>

      {demos.map((d, i) => {
        const { lines, first } = routeLines(d.route);
        return (
          <section key={d.id} id={d.id} aria-labelledby={`${d.id}-h`} className={`section${i % 2 ? '' : ' section--band'}`}>
            <div className="shell">
              <h2 id={`${d.id}-h`}>{d.title}</h2>
              <p className="expl">{d.expl} <a href={d.href}>Open the demo</a>.</p>
              <div className="demo" style={{ marginTop: '1.6rem' }}>
                <Frame dots name={<>lib/policies.js · <b>{d.route}</b> route</>} chip="source">
                  <Code lines={lines} first={first} />
                </Frame>
              </div>
            </div>
          </section>
        );
      })}

      <section id="local-facts" aria-labelledby="local-facts-h" className="section section--band">
        <div className="shell">
          <h2 id="local-facts-h">Facts stay on the server</h2>
          <p className="expl">Declare a state field with <code>local: true</code> and <code>buildState</code> keeps it out of what the model sees. The rules still read it through <code>fact()</code>. Below is the courier policy on a real request.</p>
          <div className="demo row" style={{ marginTop: '1.6rem', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <Frame name={<><b>state</b> · sent to the model</>} chip="computed" chipTone="bar-chip--live"><pre className="code code--plain" style={{ padding: '.8rem 1rem' }}>{JSON.stringify(built.state, null, 2)}</pre></Frame>
            </div>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <Frame name={<><b>facts</b> · read by the rules</>} chip="computed" chipTone="bar-chip--ok"><pre className="code code--plain" style={{ padding: '.8rem 1rem' }}>{JSON.stringify(built.facts, null, 2)}</pre></Frame>
            </div>
          </div>
        </div>
      </section>

      <section id="journal" aria-labelledby="journal-h" className="section">
        <div className="shell">
          <h2 id="journal-h">Shared state on Upstash, rate limits included</h2>
          <p className="expl"><code>jevlang/redis</code> gives a store and a journal on any Redis with <code>eval</code>. Records expire by TTL, so there is no cleanup cron; <code>rateLimit</code> caps live model calls per client across every instance. <code>recordDecision</code> runs inside <code>after()</code>, so a store hiccup never delays a response. With no Upstash env, both fall back to memory.</p>
          <div className="demo" style={{ marginTop: '1.6rem' }}>
            <Frame dots name={<b>lib/backend.js</b>} chip="source"><Code lines={backendLines} /></Frame>
          </div>
        </div>
      </section>

      <section id="boundaries" aria-labelledby="boundaries-h" className="section section--band">
        <div className="shell">
          <h2 id="boundaries-h">Boundaries</h2>
          <div className="row" style={{ marginTop: '1.6rem', alignItems: 'flex-start', gap: '2rem' }}>
            {boundaries.map(b => (
              <div key={b.title} style={{ flex: '1 1 260px', minWidth: 0 }}>
                <h3 style={{ font: '600 .95rem/1.3 var(--sans)', margin: '0 0 .6rem' }}>{b.title} <span className="muted mono">{b.items.length}</span></h3>
                <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '.4rem' }}>{b.items.map(t => <li key={t}>{t}</li>)}</ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="start" aria-labelledby="start-h" className="section">
        <div className="shell">
          <h2 id="start-h">Start</h2>
          <p className="expl">Install and run <code>next dev</code> on a free port (<code>npm run dev:redis</code> adds Redis and the Upstash REST proxy in Docker), then run the tests. For live answers set <code>TYPESAFE_API_KEY</code>, or <code>JEV_PROVIDER=gateway</code> with <code>AI_GATEWAY_API_KEY</code>, in <code>.env.local</code>.</p>
          <div className="row" style={{ marginTop: '1.6rem', alignItems: 'stretch' }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}><Frame name="$ install and run"><pre className="code code--plain" style={{ padding: '.8rem 1rem' }}>{'cd examples/nextjs\nnpm install\nnpm run dev'}</pre></Frame></div>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}><Frame name="$ verify"><pre className="code code--plain" style={{ padding: '.8rem 1rem' }}>{'npm test\nnpm run build'}</pre></Frame></div>
          </div>
        </div>
      </section>
    </>
  );
}
