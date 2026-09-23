// The page model. Authored copy lives here; examples live in the repo's docs and
// are resolved by the renderer at build time. No markup in this file.
//
// A demo names what it shows: `source` a README `file=` block, `run` a `$`
// captured run, `diagram` a component that reads its numbers out of those. A
// reference that does not resolve — or resolves twice — fails the build.

export const origin = 'https://jevlang.sh';
export const repo = 'https://github.com/TimMikeladze/JevLang';
export const cloudRepo = 'https://github.com/TimMikeladze/jevcloud';
export const copyrightYear = 2026;

export const meta = {
  name: 'JevLang',
  h1: 'Typesafe policy for LLM decisions',
  lede:
    '`jevlang` is a typesafe policy engine for decisions an LLM used to make inside a prompt: routing, triage, approvals, guarding an agent\'s tools. You declare the questions the model answers and the rules that act on them, in plain [TypeScript](REPO). Mistakes are build errors, and every decision explains itself.',
  description:
    'jevlang is a typesafe policy engine for LLM decisions: the model answers small questions in TypeScript, your policy decides, and every decision explains itself.',
  install: 'bun add jevlang',
  tagline: 'a policy engine for prompt-sized decisions',
  license: 'MIT',
};

// Cloud's landing sections stay hidden for now; flip to bring back the hosted section and aside.
// The nav's Cloud link is independent of this: it always points at the sign-in page.
export const showCloud = false;

const allSections = [
  {
    id: 'how-it-works',
    h2: 'How one decision works',
    p: 'Your app sends a ticket. A model answers a few small questions about it — `noul`, `choice` or `score` — and `policy.decide()` turns those answers into an action. The model never picks the branch; your code does.',
    doc: 'A real one: support routing',
    demos: [
      { type: 'diagram', name: 'decision-flow', policy: 'support.js', run: 'node ask.js',
        ticket: { file: 'ask.js', from: /const ticket = "(.*)";/ } },
    ],
  },
  {
    id: 'quick-start',
    h2: 'Run it in one file',
    p: 'Run `bun add jevlang`, save the file as `policy.js`, and run it with `node policy.js`. It needs no model, account or network: `policy.decide()` reads the answers you hand it and returns the action.',
    doc: 'Hello, world',
    demos: [
      { type: 'steps', steps: [
        { title: 'Install the package', cmd: 'bun add jevlang' },
        { title: 'Save this as <code>policy.js</code>', file: 'policy.js' },
        { title: 'Run it', run: 'node policy.js' },
      ] },
    ],
  },
  {
    id: 'questions',
    h2: 'Three kinds of question',
    p: 'Declare what you want to know with `noul` for a yes/no, `choice` for one of several options, or `score` for a place on a scale. The model answers each with numbers, and `policy.decide()` refuses an answer that does not fit its question.',
    doc: 'Three kinds of question',
    demos: [
      { type: 'diagram', name: 'answer-shapes', policy: 'support.js', decide: 'decide.js', case: 'an angry refund request', table: 'Three kinds of question' },
      { type: 'table', name: 'kinds', table: 'Three kinds of question' },
    ],
  },
  {
    id: 'gates',
    h2: 'Low confidence escalates',
    p: 'Add `gate(department, 0.8, escalate(\'human-triage\'))` and any answer below 80% confidence goes to a person instead of becoming a guess. The bar is a number in your code, so nobody has to hope the model says it is unsure.',
    doc: 'A real one: support routing',
    demos: [
      { type: 'diagram', name: 'gate-meter', run: 'node decide.js', pass: 'a clear billing question', fail: 'unsure which team owns it' },
      { type: 'source', file: 'support.js' },
      { type: 'source', file: 'decide.js' },
      { type: 'run', run: 'node decide.js' },
    ],
  },
  {
    id: 'rules',
    h2: 'Rules run in order',
    p: 'Each `rule(when, action)` is checked from the top, and the first match decides — so clause order is policy you can review in a diff. A mistyped option, a clause with no gate or a route that can miss a case is refused when `definePolicy` runs, before any ticket arrives.',
    doc: 'Mistakes are build errors',
    demos: [
      { type: 'diagram', name: 'rule-ladder', policy: 'support.js' },
      { type: 'source', file: 'broken.js' },
      { type: 'run', run: 'node broken.js' },
    ],
  },
  {
    id: 'explain',
    h2: 'Every decision says why',
    p: '`explainDecision(decision)` prints the action, the rule that fired and every answer that rule read. Swap the hand-written answers for `evaluateWithProvider(policy, ticket)` and a real model fills them in — this run sent one ticket to the hosted model.',
    doc: 'A real one: support routing',
    demos: [
      { type: 'source', file: 'ask.js' },
      { type: 'annotated', run: 'node ask.js' },
    ],
  },
  {
    id: 'tool-gate',
    h2: 'Guard an agent\'s tools',
    p: '`jev gate hook` decides whether an agent\'s tool call runs — `allow`, `ask` or `deny` — as a Claude Code or Codex `PreToolUse` hook. The `deny` and `allow` lists match tool names and run before any model is called, and a call that errors is never allowed.',
    doc: 'Guard an agent\'s tools',
    demos: [
      { type: 'diagram', name: 'tool-ladder', policy: 'gate.js', options: 'gate-options.json' },
      { type: 'steps', steps: [
        { title: 'Save the policy as <code>gate.js</code> and run it', file: 'gate.js', run: 'node gate.js' },
        { title: 'Name the tools that need no judgement', file: 'gate-options.json' },
        { title: 'Add the hook to <code>.claude/settings.json</code>', file: '.claude/settings.json' },
        { title: 'Try it: a tool on each list, then one on neither', runs: ['"tool_name":"Read"', '"tool_name":"WebFetch"', '"tool_name":"Bash"'] },
      ] },
    ],
  },
  {
    id: 'anywhere',
    h2: 'Call it from anywhere',
    p: 'One policy has five doors: `policy.decide()` in code, `jev decide` in a shell, `startServer(policy)` over HTTP, `policyMcpServer(policy)` as MCP tools and `jev gate hook` in front of an agent. Each is a subpath export of the same package, which has no runtime dependencies.',
    doc: 'Call it from anywhere',
    demos: [
      { type: 'diagram', name: 'doors', list: 'Call it from anywhere' },
      { type: 'steps', steps: [
        { title: 'Save this as <code>serve.js</code> and start it', file: 'serve.js', run: 'node serve.js' },
        { title: 'Post it answers from any language; the response carries an <code>explain</code> string', run: 'curl -s http://127.0.0.1:8080/decide' },
      ] },
      { type: 'modules', title: 'Every export in the package' },
    ],
  },
  {
    id: 'same-engine-hosted',
    h2: 'Same engine, hosted',
    p: 'Jev Cloud runs this engine for many tenants over HTTP at [cloud.jevlang.sh](https://cloud.jevlang.sh): deploy, promote, evaluate. Every route takes `Authorization: Bearer jev_live_…`, and the organization comes from the credential, never the path. Deployments never change once published; `promote` with `expect` is the only thing that moves production.',
    doc: null,
    demos: [
      { type: 'diagram', name: 'lifecycle' },
      { type: 'cloud-api' },
    ],
  },
];

export const sections = showCloud ? allSections : allSections.filter((s) => s.id !== 'same-engine-hosted');

const allAsides = [
  {
    before: 'same-engine-hosted',
    text: 'Want it deployed instead of embedded? [Jev Cloud](https://cloud.jevlang.sh) runs the same decisions with identity, storage and a dashboard: organizations by default, keys shown once and stored hashed, every decision a trace. A hosted product, and not something you `bun add`.',
  },
];

export const asides = showCloud ? allAsides : allAsides.filter((a) => a.before !== 'same-engine-hosted');

// Three counted columns: what holds, what is a judgement, what is not here yet.
// `{name}` in an item is a figure read out of a captured run.
export const boundaries = {
  h2: 'What holds, and what doesn\'t',
  intro: 'Proven, judged and missing, in that order — the same honesty the engine ships with. The full evidence table is in [COMPATIBILITY.md](REPO/blob/main/COMPATIBILITY.md).',
  columns: [
    {
      title: 'What holds',
      items: [
        'Every example on this page that is not marked live is re-run by the test suite, and its output must match what the page shows.',
        'Decisions, wire questions, built state and reports are pinned by differential tests against the Racket reference, and recorded runs replay byte for byte.',
        '`bun test` here: {pass} pass, {skip} skip, {fail} fail, offline. The skips are the differential tests that need the Racket monorepo beside this package.',
        'Deciding, validating and replaying need no account and no network.',
      ],
      figures: {
        pass: { run: 'bun install', from: /(\d+) pass/ },
        skip: { run: 'bun install', from: /(\d+) skip/ },
        fail: { run: 'bun install', from: /(\d+) fail/ },
      },
    },
    {
      title: 'A judgement',
      items: [
        'Confidence is the model\'s own number. `calibrate` reports ECE and a reliability table over your labels, and says when you have too few to trust them.',
        'A gate bar like `0.8` is yours to choose. `tune` searches a grid over labelled cases, and under 200 labels it calls the result exploratory.',
        'Cost estimates are fitted to your recorded usage, or a stated ~4 characters per token when you have none.',
      ],
    },
    {
      title: 'Not here yet',
      items: [
        'Code lookup (`jev/code`) needs an SGX executable and is out of scope for now.',
        'A running JavaScript handler cannot be killed: past its timeout it is abandoned, and the error says it may have acted.',
        'The Python SDK decides but does not dispatch, because handlers are host functions.',
        'A stability run\'s statistics are ported; collecting the repeated provider calls is still yours.',
      ],
    },
  ],
};

export const start = {
  h2: 'Start',
  p: 'Install the package, or clone the repo and run the suite yourself. The Verify panel is a real run of that suite, read at build time.',
  install: ['bun add jevlang'],
  verify: { run: 'bun install', figures: [
    { label: 'Tests passing', from: /(\d+) pass/ },
    { label: 'Failures', from: /(\d+) fail/ },
  ] },
};

// One authored link table drives header and footer. `href: "repo"` follows the
// repo variable; `where` says which slots it appears in.
export const links = [
  { label: 'JevLang on GitHub', href: 'repo', icon: 'github', where: ['header', 'footer'] },
  { label: 'linesofcode on X', href: 'https://x.com/linesofcode', icon: 'x', where: ['header', 'footer'] },
  { label: 'Tim Mikeladze on LinkedIn', href: 'https://www.linkedin.com/in/tim-mikeladze', icon: 'linkedin', where: ['header', 'footer'] },
  { label: 'linesofcode on Discord', href: 'https://discord.com/users/linesofcode', icon: 'discord', where: ['footer'] },
];

const allNav = [
  { label: 'Home', href: '/' },
  { label: 'Reference', href: '/reference' },
  // The examples are pages of the Next.js app that serves this site; the nav
  // item is a dropdown, and there is no separate examples index.
  { label: 'Examples', href: '/examples', children: [
    { label: 'Tenant hotline', href: '/examples/maintenance' },
    { label: 'SMS host', href: '/examples/reservation' },
    { label: 'Courier app', href: '/examples/doorstep' },
  ] },
  // The hosted product's front door: its sign-in page, which links to sign-up.
  { label: 'Cloud', href: 'https://cloud.jevlang.sh/sign-in', external: true },
];

export const nav = allNav;

export const footerColumns = [
  { title: 'JevLang', links: [
    { label: 'Home', href: '/' },
    { label: 'Reference', href: '/reference' },
    { label: 'GitHub', href: 'repo', external: true },
    { label: 'linesofcode.dev', href: 'https://linesofcode.dev', external: true },
  ] },
  { title: 'Examples', links: [
    { label: 'Tenant hotline', href: '/examples/maintenance' },
    { label: 'SMS host', href: '/examples/reservation' },
    { label: 'Courier app', href: '/examples/doorstep' },
    { label: 'Source', href: 'https://github.com/TimMikeladze/JevLang/tree/main/examples/nextjs', external: true },
  ] },
  { title: 'Community', links: [
    { label: 'X', href: 'https://x.com/linesofcode', external: true },
    { label: 'GitHub', href: 'repo', external: true },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/tim-mikeladze', external: true },
    { label: 'Discord', href: 'https://discord.com/users/linesofcode', external: true },
  ] },
];


// The three mistakes that break a policy, each one a build or decide error the
// README shows a run of.
export const agentsMistakes = [
  'A clause on a model answer with no confidence gate — `definePolicy` refuses it; add a `gate`, or read confidence in the clause.',
  'A route that can miss a case — add `otherwise`, an unconditional clause, or a rule for every option of one `choice`.',
  'An answer that does not fit its question — `decide` needs one answer per question, and an option that was never declared is an error.',
];

export const agentsGateNote =
  '`deny` and `allow` lists on `jev gate hook` match tool names (`WebFetch`, `mcp__prod__*`), not command text such as `Bash(rm *)`; calls on neither list go to the policy.';

// The live examples: pages of the Next.js app (examples/nextjs) that serves
// this site. One entry drives the nav, llms.txt, AGENTS.md and index.md.
export const examplesSource = 'https://github.com/TimMikeladze/JevLang/tree/main/examples/nextjs';
export const examples = [
  { name: 'Tenant hotline', path: '/examples/maintenance', route: '/api/maintenance',
    summary: 'Tenants text one number; the policy decides who gets woken up. Time and outside temperature are local facts the model never sees; a 0.3 danger bar pages on-call.',
    input: { message: 'smells like gas in the hall', hour: 3, outsideTempC: 2 },
    answers: { issue: { choice: 'other', confidence: 0.6 }, 'danger?': { noul: 0.92 } } },
  { name: 'Restaurant SMS host', path: '/examples/reservation', route: '/api/reservation',
    summary: 'Guests text the restaurant; the model reads intent and flags serious allergies. Party size and free seats come from the booking system.',
    input: { message: 'Table for 4 Sat 7pm? My son carries an EpiPen', partySize: 4, seatsFree: 12 },
    answers: { intent: { choice: 'book', confidence: 0.97 }, 'severe-allergy?': { noul: 0.96 } } },
  { name: 'Courier app', path: '/examples/doorstep', route: '/api/doorstep',
    summary: 'A driver says what is happening at the door; parcel value, rain and a nearby locker decide door, locker or tomorrow. Anything unsafe means nobody risks it.',
    input: { message: 'Big dog loose in the yard, nobody answering', valueUsd: 120, raining: false, lockerNearby: true },
    answers: { situation: { choice: 'nobody-home', confidence: 0.93 }, 'unsafe?': { noul: 0.91 } } },
];

// Running on serverless, for the agent files: what a production deploy uses.
export const serverlessNotes = [
  '`jevlang/redis` — `redisJournal`, `redisStore`, `redisSessions` on any Redis with `eval(script, keys, args)`; `upstash()` is a dependency-free client (UPSTASH_REDIS_REST_URL/_TOKEN or KV_REST_API_URL/_TOKEN).',
  '`rateLimit(journal, name, { max, per })` from `jevlang/dispatch` — a sliding window per key on any journal; `budget(name, { max, per, by })` limits each customer inside dispatch.',
  'HTTP providers `gateway` (Vercel AI Gateway, OIDC on Vercel), `openai` and `anthropic` sit beside `typesafe`: `evaluateWithProvider(policy, input, { provider: \'gateway\' })`.',
  '`makeDispatcher(handlers, { journal, stepLease, scheduleLease })` re-delivers work a crashed instance left; call `runDue(dispatcher)` from a cron route.',
];
