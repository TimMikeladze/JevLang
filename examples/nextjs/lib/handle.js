// Shared POST handler: body { input, answers? }.
// With `answers` the model is skipped (tests, demos, replaying a recorded run);
// otherwise the provider named by JEV_PROVIDER answers the policy's questions:
// typesafe (default), gateway (Vercel AI Gateway), openai or anthropic.
import { evaluateWithProvider, JevError } from 'jevlang';
import { explainDecision } from 'jevlang/explain';
import { vercelOidcToken } from 'jevlang/provider';
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
      // On Vercel the gateway's OIDC token arrives with the request, not as env.
      if (!keys.some(k => process.env[k]) && !(provider === 'gateway' && vercelOidcToken())) {
        return Response.json({ error: `${keys[0]} is not set for JEV_PROVIDER=${provider}; pass \`answers\` to decide offline` }, { status: 503 });
      }
      // In memory every instance counts on its own, so the caps would not hold
      // in production: live calls there need the shared Redis limits.
      if (backend().name === 'memory' && process.env.VERCEL_ENV === 'production') {
        return Response.json({ error: 'the live model is off until shared rate limits (Upstash Redis) are configured; pass `answers`' }, { status: 503 });
      }
      // Only live model calls cost money, so only they are rate limited.
      const allowed = await backend().limit(clientOf(request));
      if (!allowed.ok) {
        const [error, retry] = allowed.scope === 'site'
          ? ['the demo has used its live model calls for today; use the sliders, or pass `answers`', '3600']
          : ['you have used your live model calls for this hour; use the sliders, or pass `answers`', '3600'];
        return Response.json({ error }, { status: 429, headers: { 'retry-after': retry } });
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
