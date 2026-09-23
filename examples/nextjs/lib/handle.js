// Shared POST handler: body { input, answers? }.
// With `answers` the model is skipped (tests, demos, replaying a recorded run);
// otherwise the provider named by JEV_PROVIDER answers the policy's questions:
// typesafe (default), gateway (Vercel AI Gateway), openai or anthropic.
import { evaluateWithProvider, JevError } from 'jevlang';
import { explainDecision } from 'jevlang/explain';
import { backend } from './backend.js';

const providerKeys = {
  typesafe: ['TYPESAFE_API_KEY'],
  gateway: ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
};
export const providerName = () => process.env.JEV_PROVIDER || 'typesafe';

// The first hop's address; Vercel sets x-forwarded-for.
const clientOf = request => (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';

// `onDecision` gets { policy, state, facts, decision } after a decision is made;
// the routes use it to record the decision without delaying the response.
export async function decideRequest(policy, request, { onDecision } = {}) {
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'body must be JSON' }, { status: 400 }); }
  const { input, answers } = body ?? {};
  if (!input || typeof input !== 'object') return Response.json({ error: 'body.input must be an object' }, { status: 400 });

  try {
    let decision;
    const { state, facts } = policy.buildState(input);
    if (answers) {
      decision = policy.decide(answers, { state, facts });
    } else {
      const provider = providerName();
      const keys = providerKeys[provider];
      if (!keys) return Response.json({ error: `JEV_PROVIDER=${provider} is not one of ${Object.keys(providerKeys).join(', ')}` }, { status: 500 });
      if (!keys.some(k => process.env[k])) {
        return Response.json({ error: `${keys[0]} is not set for JEV_PROVIDER=${provider}; pass \`answers\` to decide offline` }, { status: 503 });
      }
      // Only live model calls cost money, so only they are rate limited.
      if (!(await backend().limit(clientOf(request))).ok) {
        return Response.json({ error: 'too many live model calls; try again in a minute, or pass `answers`' }, { status: 429, headers: { 'retry-after': '60' } });
      }
      decision = await evaluateWithProvider(policy, input, { provider });
    }
    onDecision?.({ policy, state, facts, decision });
    return Response.json({
      action: decision.action,
      target: decision.target ?? null,
      reason: decision.reason ?? null,
      explanation: explainDecision(decision),
      fingerprint: policy.fingerprint(),
      decision,
    });
  } catch (error) {
    // A JevError is bad input or bad answers; anything else is the model call failing.
    const status = error instanceof JevError ? 400 : 502;
    return Response.json({ error: error.message }, { status });
  }
}
