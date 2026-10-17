# JevLang social image prompts

All seven PNGs were regenerated with the built-in image tool. The first-policy
card is shared with the website and guide. The other cards used their previous
image as the content reference and that card as the style reference.

## Build your first policy

See the [exact prompt](../../docs/images/agent-skills-prompt.md).

## jev-1.14/00-getting-started.png

```text
Rebuild this social infographic in the visual style of reference image 2: friendly white background, small jevlang. wordmark, dark charcoal headings, readable restrained blue/gray monospace code, pale gray or pale blue panels with thin soft borders, generous margins. No orange, black panels, neon colors, harsh oversized type, or ornamental numbering. Reference image 1 supplies the topic; reference 2 supplies only style. Produce 1536x1024 landscape. Use a purpose-first headline; footer jevlang.sh. All text accurate, legible and unclipped. Headline "Run a policy locally". Subtitle "Decide from supplied answers." Compact left column: label "Install", command "bun add jevlang"; label "Run", command "bun policy.mjs"; label "Output" with two lines "hold" and "inbox". Right larger panel label "Save as policy.mjs", exact code:
import { noul, definePolicy, rule, assign, hold } from 'jevlang';

const spam = noul('spam', 'Is this message spam?');
const policy = definePolicy({
  name: 'message-router',
  questions: [spam],
  route: {
    clauses: [rule(spam.yes(0.9), hold())],
    otherwise: assign('inbox'),
  },
});
console.log(policy.decide({ spam: { noul: 0.97 } }).action);
console.log(policy.decide({ spam: { noul: 0.05 } }).target);
Small sentence at bottom "Runs offline. No model or API key needed." Keep code indentation and braces exact. No extra commands or promotional text.
```

## archive/jev-1.14-native-python.png

```text
Rebuild this social infographic in the visual style of reference image 2: friendly white background, small jevlang. wordmark, dark charcoal headings, readable restrained blue/gray monospace code, pale gray or pale blue panels with thin soft borders, generous margins. No orange, black panels, neon colors, harsh oversized type, or ornamental numbering. Reference image 1 supplies the topic; reference 2 supplies only style. Produce 1536x1024 landscape. Use a purpose-first headline; footer jevlang.sh. All text accurate, legible and unclipped. Headline "Run a policy in Python". Subtitle "Make decisions with supplied answers." Two balanced panels. Left label "Define the policy" with exact code:
from jevlang import Policy, noul, rule, assign, hold

urgent = noul('urgent', 'Does this need urgent attention?')
policy = Policy(
    name='support-triage',
    questions=[urgent],
    route={
        'clauses': [
            rule(urgent.yes(0.9), assign('priority')),
        ],
        'otherwise': hold(),
    },
)
Right label "Decide offline" with exact code:
decision = policy.decide({
    'urgent': {'noul': 0.97}
})
print(decision['action'])
print(decision['target'])
Below that a small output area label "Output" with exact two lines "assign" and "priority". Footer note "Python 3.9+ · No third-party runtime dependencies". Do not introduce a package install command. Preserve code indentation.
```

## jev-1.14/03-client-controls.png

```text
Rebuild this social infographic in the visual style of reference image 2: friendly white background, small jevlang. wordmark, dark charcoal headings, readable restrained blue/gray monospace code, pale gray or pale blue panels with thin soft borders, generous margins. No orange, black panels, neon colors, harsh oversized type, or ornamental numbering. Reference image 1 supplies the topic; reference 2 supplies only style. Produce 1536x1024 landscape. Use a purpose-first headline; footer jevlang.sh. All text accurate, legible and unclipped. Headline "Control model requests". Subtitle "Set timeouts, retries, and cancellation." Main code panel with exact code:
import { jevCall } from 'jevlang';

const controller = new AbortController();
const pending = jevCall(state, questions, {
  model: 'jev-1.14.0',
  experimental: { longContext: true },
  compression: 'gzip',
  signal: controller.signal,
  timeoutSeconds: 10,
  retry: { maxRetries: 1 },
});

// Cancel when needed.
controller.abort();
Small right-hand callouts aligned to code: "Opt in to longer context" aligned to longContext; "Compress request bodies" aligned to compression; "Cancel requests and retry waits" aligned to signal. Thin blue connector lines, no diagrams otherwise. Small bottom note "state and questions are your request payload. Long context is experimental." Keep exact option names and braces. No added slogans.
```

## jev-1.14/04-record-replay.png

```text
Rebuild this social infographic in the visual style of reference image 2: friendly white background, small jevlang. wordmark, dark charcoal headings, readable restrained blue/gray monospace code, pale gray or pale blue panels with thin soft borders, generous margins. No orange, black panels, neon colors, harsh oversized type, or ornamental numbering. Reference image 1 supplies the topic; reference 2 supplies only style. Produce 1536x1024 landscape. Use a purpose-first headline; footer jevlang.sh. All text accurate, legible and unclipped. Headline "Record and replay decisions". Subtitle "Test a policy against saved answers." Two panels side by side. Left label "Record an image evaluation" with exact shell code (keep backslashes at line endings):
jev record policy.json input.json \
  --assets assets.json \
  --experimental-images \
  --embed-assets
Below code exact text "Calls the configured model." and "Save the returned fixture object in fixtures/run.json." Right panel label "Replay offline" with exact shell code:
jev replay policy.json fixtures
Below code exact text "Uses recorded answers without calling a model." and "Embedded assets allow image bytes to be verified." Lower small full-width panel label "Cache by image contents" with three clearly spaced rows: "Same bytes, renamed reference → cache hit"; "Changed image bytes → cache miss"; "Changed effective model → cache miss". Bottom note "Image fixtures retain digests, dimensions, flags, and model provenance." Do not invent results, commands, or stronger verification claims.
```

## jev-1.14/01-package-policy.png

```text
Rebuild this social infographic in the visual style of reference image 2: friendly white background, small jevlang. wordmark, dark charcoal headings, readable restrained blue/gray monospace code, pale gray or pale blue panels with thin soft borders, generous margins. No orange, black panels, neon colors, harsh oversized type, or ornamental numbering. Reference image 1 supplies the topic; reference 2 supplies only style. Produce 1536x1024 landscape. Use a purpose-first headline; footer jevlang.sh. All text accurate, legible and unclipped. Headline "Locate a package in a photo". Subtitle "Return coordinates or send the case for review." Two columns. Larger left panel labelled "Policy excerpt" with exact code:
const present = noul('present', 'Is there a package in photo?');
const parcel = box('parcel', 'Locate the package in photo');

const policy = definePolicy({
  name: 'locate-package',
  model: 'jev-1.14.0',
  typesafe: { experimental: { images: true } },
  state: { photo: { path: ['photo'] } },
  questions: [present, parcel],
  gates: [
    gate(parcel, 0.8, escalate('review'), { onRead: true }),
  ],
  route: {
    clauses: [
      rule(present.yes(0.9),
        assign('found', { data: parcel.value() })),
    ],
    otherwise: hold(),
  },
});
Right top panel labelled "Send an image" with exact code:
const ref = randomUUID();
const decision = await evaluateWithProvider(
  policy,
  { photo: ref },
  {
    assets: {
      [ref]: imageAsset(
        await readFile('delivery.png'),
        { format: 'png' }
      ),
    },
  }
);
Right lower panel "Example decision" with exact JSON (use data, NOT box):
{
  "action": "assign",
  "target": "found",
  "data": {
    "left": 0.44, "right": 0.84,
    "top": 0.25, "bottom": 0.82
  }
}
Small footer note "Coordinates are normalized. Images are experimental and opt-in." Keep all function names and balanced braces legible; compact code typography with enough whitespace. No invented full imports, no API-key claims, no image illustration needed.
```

## jev-1.14/support-ticket-example.png

```text
Rebuild this social infographic in the visual style of reference image 2: friendly white background, small jevlang. wordmark, dark charcoal headings, readable restrained blue/gray monospace code, pale gray or pale blue panels with thin soft borders, generous margins. No orange, black panels, neon colors, harsh oversized type, or ornamental numbering. Reference image 1 supplies the topic; reference 2 supplies only style. Produce 1536x1024 landscape. Use a purpose-first headline; footer jevlang.sh. All text accurate, legible and unclipped. Headline "Route support tickets". Subtitle "Send outages to on-call and uncertain tickets for review." Left slim column with three compact panels. "Install" then command "bun add jevlang". "Run with your ticket" then exact command:
TYPESAFE_API_KEY=your-key \
bun route-ticket.mjs \
  "Checkout is down. Every payment fails."
Small note "Requires a TypeSafe API key." Third label "Routing rules" with lines "Outage → on-call", "Routine → support", "Confidence < 0.85 → human-review". Larger right column label "Save as route-ticket.mjs" with exact code:
import {
  choice, definePolicy, gate, rule, assign,
  evaluateWithProvider,
} from 'jevlang';

const issue = choice('issue',
  'Does this ticket report an active service outage?',
  ['outage', 'routine']);
const policy = definePolicy({
  name: 'ticket-triage', model: 'jev-1.14.0',
  questions: [issue],
  state: { ticket: { path: ['ticket'] } },
  gates: [gate(issue, 0.85, assign('human-review'))],
  route: {
    clauses: [rule(issue.is('outage'), assign('on-call'))],
    otherwise: assign('support'),
  },
});
const ticket = process.argv[2];
const decision = await evaluateWithProvider(
  policy, { ticket }, { provider: 'typesafe' }
);
console.log(JSON.stringify({ queue: decision.target }));
Bottom quiet line "Returns the selected queue as JSON." Keep the code complete and legible. No slogans and no numbered badges. Friendly, clean, white, readable.
```

## Support-ticket correction

```text
Make two precise corrections to this image, preserving every other element, all colors, dimensions, and layout. In the code panel, the route object is missing its closing brace. Immediately after the line "otherwise: assign('support')," add an indented line "  }," and then leave the next line "});". The end of that block must read exactly:
    otherwise: assign('support'),
  },
});
Second, remove the duplicate "Requires a TypeSafe API key." sentence from the top-left Install panel. Keep the same sentence under the Run with your ticket panel. Keep all other text and code exactly unchanged. White background, 1536x1024.
```
