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
    '`jevlang` is a typesafe policy engine for decisions an LLM used to make inside a prompt: routing, triage, approvals, guarding an agent\'s tools. Declare the questions and the rules in plain [TypeScript](REPO), and every decision explains itself. Embed it, or deploy the same policy to [Jev Cloud](https://cloud.jevlang.sh) for traces, gated promotion and a spend cap.',
  description:
    'jevlang is a typesafe policy engine for LLM decisions: the model answers small questions, your policy decides. Embed it, or run it hosted on Jev Cloud.',
  install: 'bun add jevlang',
  tagline: 'a policy engine for prompt-sized decisions',
  license: 'MIT',
};

// The hero's live console: this policy, deciding the tickets this file decides.
export const hero = { policy: 'support.js', decide: 'decide.js', run: 'node decide.js' };

export const sections = [
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
  // The hosted product. Snippets are README blocks; tables and figures come
  // from docs/cloud-api.md, the vendored jevcloud-next README sections.
  {
    id: 'cloud',
    h2: 'Same engine, hosted',
    p: '[Jev Cloud](https://cloud.jevlang.sh) runs this package for many tenants, and `jevlang/cloud` is its client: one `fetch`, no dependency, no engine logic. `jc.evaluate(project, input)` returns the decision `policy.decide()` would make, with the rate limit, spend cap and trace applied on the server.',
    doc: 'The hosted product: `jevlang/cloud`',
    demos: [
      { type: 'snippet', marker: "import { cloud } from 'jevlang/cloud';", name: 'app.js' },
    ],
  },
  {
    id: 'promote',
    h2: 'Promote behind a replay gate',
    p: '`jev deploy` publishes a policy artifact that never changes, and `jev promote` is the only thing that moves production. `--expect` names the version you believe is live, so two promotions cannot both win; `--gate` replays real production traces against the candidate and refuses when too many decide differently.',
    doc: 'The hosted product: `jevlang/cloud`',
    demos: [
      { type: 'diagram', name: 'lifecycle' },
      { type: 'snippet', marker: 'jev deploy support policy.json', name: 'shell' },
    ],
  },
  {
    id: 'managed-state',
    h2: 'Managed state, same interface',
    p: '`jc.journal(project)` is a `Journal`, the interface `redisJournal` and `dbJournal` already satisfy. Hand it to `makeDispatcher` and idempotency, cooldowns, budgets and scheduled work are shared by every instance, with no Redis of your own to run.',
    doc: 'The hosted product: `jevlang/cloud`',
    demos: [
      { type: 'snippet', marker: "journal: jc.journal('support')", name: 'dispatch.js' },
    ],
  },
  {
    id: 'bring-your-own',
    h2: 'Bring your own everything',
    p: 'Model keys, the model endpoint, state, traces and handlers each have a managed and a bring-your-own option, chosen per environment on the same code path: your own Anthropic key, any OpenAI-compatible URL, your Upstash or Postgres, your own runner beside `http` and `webhook`. Usage on your own key is never marked up, and the hard spend cap still applies to it.',
    doc: null,
    demos: [
      { type: 'cloud-table', heading: 'Bring your own everything' },
    ],
  },
  {
    id: 'isolation',
    h2: 'Tenants isolated by construction',
    p: 'The organization comes from the `Authorization: Bearer jev_live_…` key, never from the path, so a wrong tenant gets the same 404 an unknown project does. Row-level security on `org_id` is the second wall, and the negatives are tested.',
    doc: null,
    demos: [
      { type: 'cloud-list', heading: 'Isolation, by construction' },
    ],
  },
  {
    id: 'cloud-api',
    h2: 'One HTTP API',
    p: 'Every route sits under `/api/v1`, and a key carries the scopes `evaluate`, `dispatch`, `deploy` or `read`. `Idempotency-Key` makes a retry return the first answer instead of paying or acting twice, and a `jev_pub_…` key is safe in a browser behind an origin allowlist.',
    doc: null,
    demos: [
      { type: 'cloud-api' },
    ],
  },
  {
    id: 'plans',
    h2: 'Free to start',
    p: 'Signing in at [cloud.jevlang.sh](https://cloud.jevlang.sh/sign-in) creates an organization you own; invite people with one of six roles. The plans are defined once, in a config the [`/pricing`](https://cloud.jevlang.sh/pricing) page, the limits and the tests all read.',
    doc: null,
    demos: [
      { type: 'plans', heading: 'Billing', rows: [
        { plan: /Three plans — (Free),/, terms: '$0', how: 'No card; the free limits apply' },
        { plan: /, (Pro) \(/, terms: /Pro \((\$[\d]+\/seat\/month)\)/, how: /Pro is\s+(Stripe-hosted Checkout at the member count)/ },
        { plan: /\), (Team) —/, how: /Team is (a conversation and a `mailto:`)/ },
      ] },
    ],
  },
];

export const asides = [
  {
    before: 'cloud',
    text: 'Want it deployed instead of embedded? [Jev Cloud](https://cloud.jevlang.sh) is the hosted product, not something you `bun add`: organizations, keys, traces and a review queue around the same decisions.',
  },
];

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
  // Hidden unless the cloud-nav Vercel flag is on (docs/cloud-nav-flag.md).
  { label: 'Cloud', href: 'https://cloud.jevlang.sh/sign-in', external: true, flag: 'cloud-nav' },
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
  { title: 'Jev Cloud', links: [
    { label: 'Sign in', href: 'https://cloud.jevlang.sh/sign-in', external: true },
    { label: 'Pricing', href: 'https://cloud.jevlang.sh/pricing', external: true },
    { label: 'The API', href: '/#cloud-api' },
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
