import { choice, score, noul, rawQuestion, definePolicy, rule, gate, hold, assign, all, compare, record } from 'jevlang';

const q = choice('department', 'Which?', ['billing', 'technical']);
q.is('billing');
// @ts-expect-error misspelled options are rejected by the TypeScript API
q.is('billling');
const n = noul('refund', 'Refund?');
// @ts-expect-error noul answers do not have confidence
n.confidence();
// @ts-expect-error score accessors do not apply to choices
q.mostLikely(0);
const s = score('urgency', 'How urgent?', ['low', 'high']);
s.mostLikely('high');
// @ts-expect-error undeclared level
s.mostLikely('medium');
const p = definePolicy({ name: 'typed', questions: [q, n, s], gates: [gate(q, 0.8, hold()), gate(s, 0.8, hold())], route: { clauses: [rule(all(q.is('billing'), n.yes(0.8), compare('gte', s.value(), 1)), assign('billing'))], otherwise: hold() } });
p.decide({ department: { choice: 'billing', confidence: 0.9 }, refund: { noul: 0.9 }, urgency: { score: 1, confidence: 0.9 } });

const intent = choice('intent', 'What?', [
  { key: 'check-balance', description: 'Check a balance' },
  { name: 'approve-transfer', key: 'approve_transfer', description: 'Approve the transfer' },
]);
// An option is named by its code name or by the wire key it sends.
intent.is('approve-transfer');
intent.is('approve_transfer');
// @ts-expect-error a code name that was never declared
intent.is('approve-transfers');
const level = score('urgency2', 'How urgent?', [{ name: 'calm', level: 'No time pressure' }, { name: 'now', level: 'Needs it immediately' }]);
level.mostLikely('now');
level.mostLikely('No time pressure');
// @ts-expect-error an undeclared level name
level.mostLikely('later');
const sentiment = rawQuestion('sentiment', { type: 'noul', instructions: 'Upset?' });
// @ts-expect-error a raw question has no typed accessors
sentiment.is('a');
definePolicy({
  name: 'typed-names', questions: [intent, level, sentiment], extraBody: { trace: 'types' },
  gates: [gate(intent, 0.8, hold()), gate(level, 0.8, hold())],
  route: { clauses: [rule(intent.is('approve-transfer'), assign('desk', { data: record({ wire: intent.chosen(), upset: sentiment.raw() }) }))], otherwise: hold() },
});

// The bundled CLI adapters are typed providers, and the registry carries them.
import { claudeProvider, codexProvider, fxProvider, makeDefaultRegistry, type Provider } from '../src/provider/index.js';
const adapters: Provider[] = [claudeProvider(), codexProvider(), fxProvider()];
const ids: string[] = adapters.map(p => p.id);
const fromRegistry: Provider | null = makeDefaultRegistry({}).get('codex');
// @ts-expect-error a provider is not a string
const wrong: string = fromRegistry;
void ids;

// Serverless state: Redis adapters, rate limits and the HTTP providers.
import { upstash, redisJournal, redisStore, redisSessions } from 'jevlang/redis';
import { rateLimit, budget as budgetOf, makeDispatcher as makeDispatcherOf } from 'jevlang/dispatch';
import { gatewayProvider } from 'jevlang/provider';
const redis = upstash({ url: 'https://x', token: 't' });
const journal = redisJournal(redis);
const take = rateLimit(journal, 'api', { max: 10, per: 60 });
take('1.2.3.4').then(r => { const ok: boolean = r.ok; return ok; });
redisStore(redis, { ttl: 86400 });
redisSessions(redis);
makeDispatcherOf({}, { journal, stepLease: 300, scheduleLease: 60, budgets: [budgetOf('refunds', { max: 3, per: 86400, by: d => String(d.target) })] });
gatewayProvider({ model: 'anthropic/claude-haiku-4.5' });
// @ts-expect-error a rate limit needs a window
rateLimit(journal, 'api', { max: 10 });
