// The page model. Authored copy lives here; examples live in the repo's docs and
// are resolved by the renderer at build time. No markup in this file.

export const origin = 'https://jevlang.sh';
export const repo = 'https://github.com/TimMikeladze/JevLang';
export const cloudRepo = 'https://github.com/TimMikeladze/jevcloud';

export const meta = {
  name: 'JevLang',
  h1: 'Decide once, trust everywhere',
  lede:
    '`jevlang` is an open source policy engine for the decisions that used to live inside a prompt — routing, triage, approvals, guarding an agent\'s tools. Built on plain [TypeScript or Python](REPO), no runtime dependencies. Made by [linesofcode](https://x.com/linesofcode).',
  description:
    'JevLang is an open source policy engine for decisions that live inside a prompt: routing, triage, approvals and tool gates, journaled and replayable.',
  install: 'npm install github:TimMikeladze/JevLang',
  tagline: 'a policy engine for prompt-sized decisions',
  license: 'MIT',
};

// Which docs each demo quotes. `terminal` matches a `$ command` fence; `snippet`
// matches a fence containing the marker. Exactly one match, or the build fails.
export const sections = [
  {
    id: 'write-the-policy',
    h2: 'A policy, not a prompt',
    p: 'Declare each question once with `noul`, `choice` or `score`, then hand `definePolicy({ questions, route })` a list of clauses. A typo like `department.is(\'billling\')` is a construction-time error, and a route with a hole is refused before anything deploys. Below is the README\'s whole example, and the decision it really made.',
    demos: [
      { type: 'code', ref: { kind: 'snippet', marker: "const spam = noul('spam?'" }, label: 'README — Hello, world' },
      { type: 'terminal', ref: { kind: 'terminal', cmd: 'node examples/hello.mjs' } },
    ],
    doc: 'Hello, world',
  },
  {
    id: 'uncertainty-escalates',
    h2: 'Uncertainty escalates',
    p: 'Every question can carry a gate: `gate(department, 0.8, escalate(\'human-triage\', …))` sends the ticket to a person when confidence drops below the bar — by declaration, not by hoping the model says it is unsure. Clause order is policy, diffable in review.',
    demos: [
      { type: 'code', ref: { kind: 'snippet', marker: "const department = choice('department'" }, label: 'README — support routing' },
      { type: 'terminal', ref: { kind: 'terminal', cmd: 'node examples/ticket-router.mjs' }, figures: [
        { label: 'Gate bar in the captured run', from: /needed confidence >= ([\d.]+)/ },
      ] },
    ],
    doc: 'A real one: support routing',
  },
  {
    id: 'guard-an-agents-tools',
    h2: 'Guard an agent\'s tools',
    p: '`jevlang/gate` decides whether a tool call runs — `allow`, `deny` or `ask` — as a Claude Code or Codex PreToolUse hook, or an MCP server standing in front of another one. It fails closed: anything the policy cannot decide denies and says so, and hard rules like `Bash(rm *)` block before the model is ever called.',
    demos: [
      { type: 'code', ref: { kind: 'snippet', marker: "const effect = choice('effect'" }, label: 'README — tool gate' },
      { type: 'terminal', ref: { kind: 'terminal', cmd: 'node examples/tool-gate.mjs' } },
    ],
    doc: 'Guard an agent\'s tools',
  },
  {
    id: 'everything-else-in-the-box',
    h2: 'Everything else in the box',
    p: 'The core is small; the surface is what a production decision needs. `jevlang/provider` is the one call that leaves the machine — and a precheck that already decides makes no call at all. This table is read out of the README at build time.',
    demos: [
      { type: 'modules' },
    ],
    doc: 'Everything else in the box',
  },
  {
    id: 'same-engine-hosted',
    h2: 'Same engine, hosted',
    p: '`@jev/cloud` runs this engine for many tenants: deploy, promote, evaluate and replay over HTTP. Every route but `/healthz` takes `Authorization: Bearer jev_live_…`, and the organization comes from the credential, never the path. Deployments are immutable; `promote` with `expect` is the only thing that moves production.',
    demos: [
      { type: 'cloud-api' },
    ],
    doc: null,
  },
];

export const asides = [
  {
    before: 'same-engine-hosted',
    text: 'Want it deployed instead of embedded? `@jev/cloud` is the same decisions with identity, storage and a dashboard. It is a hosted product, not open source.',
  },
];

export const boundaries = {
  h2: 'Boundaries',
  columns: [
    {
      title: 'Holds',
      items: [
        'Decisions, wire questions, built state and reports match the Racket `jev` engine byte-for-byte, pinned by differential oracles.',
        '`npm test`: 97 tests, 0 failures, offline — the number is read out of the captured run below.',
        'Pure decisions, validation and replay work fully offline: no account, no network, no Racket.',
      ],
    },
    {
      title: 'Judgement',
      items: [
        'Cost estimates are fitted to your recorded usage, or a stated ~4-chars-per-token estimate when you have none.',
        '`calibrate` reports ECE and a reliability table, and tells you when you don\'t have enough labels to trust them.',
      ],
    },
    {
      title: 'Not here yet',
      items: [
        'Code lookup (`jev/code`), which needs an SGX executable.',
        'Compile-time conveniences: `include-questions`, `#:options-file`, `#:options`.',
        'Nothing published to npm yet — install from this repo. The names are settled and recorded.',
      ],
    },
  ],
};

export const start = {
  h2: 'Start',
  panels: [
    { title: 'Install', command: meta.install, kind: 'code' },
    { title: 'Verify', command: null, kind: 'terminal', ref: { kind: 'terminal', cmd: 'npm install' }, figures: [
      { label: 'Tests passing', from: /pass (\d+)/ },
      { label: 'Failures', from: /fail (\d+)/ },
    ] },
  ],
};

// One authored link table drives header and footer. `href: "repo"` follows the
// repo variable; `where` says which slots it appears in.
export const links = [
  { label: 'JevLang on GitHub', href: 'repo', icon: 'github', where: ['header', 'footer'] },
  { label: 'linesofcode on X', href: 'https://x.com/linesofcode', icon: 'x', where: ['header', 'footer'] },
  { label: 'Tim Mikeladze on LinkedIn', href: 'https://www.linkedin.com/in/tim-mikeladze', icon: 'linkedin', where: ['header', 'footer'] },
  { label: 'linesofcode on Discord', href: 'https://discord.com/users/linesofcode', icon: 'discord', where: ['footer'] },
];

export const nav = [
  { label: 'Home', href: '/' },
  { label: 'Reference', href: '/reference' },
];

export const footerColumns = [
  { title: 'JevLang', links: [
    { label: 'Home', href: '/' },
    { label: 'Reference', href: '/reference' },
    { label: 'GitHub', href: 'repo', external: true },
  ] },
  { title: 'Community', links: [
    { label: 'X', href: 'https://x.com/linesofcode', external: true },
    { label: 'GitHub', href: 'repo', external: true },
    { label: 'LinkedIn', href: 'https://www.linkedin.com/in/tim-mikeladze', external: true },
    { label: 'Discord', href: 'https://discord.com/users/linesofcode', external: true },
  ] },
];

export const credit =
  'Built by linesofcode — open source policy infrastructure for decisions that used to live in prompts.';

export const agentsMistakes = [
  'An ungated clause on a runtime question — the validator refuses it; declare a `gate` first.',
  'A non-exhaustive route — every option must land somewhere or carry `otherwise`.',
  'A mistyped option or fact name — construction fails with the nearest declared name as the fix.',
];
