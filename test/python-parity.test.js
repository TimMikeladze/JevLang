import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile } from '../src/engine.js';
import { inspectAssets, assetManifest, assetIdentity } from '../src/assets.js';
import { answerCacheKey } from '../src/evaluate.js';

// Identical checked-in fixture also lives in the native Python test suite.
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/jev114-shared.json', import.meta.url), 'utf8'));
test('Python shared Jev 1.14 golden: decisions, manifests, identity and cache keys', () => {
  const policy = compile(fixture.policy), questions = policy.questions(fixture.state);
  const images = inspectAssets(fixture.assets, {state: fixture.state, questions});
  assert.deepEqual(assetManifest(images), fixture.manifest);
  assert.deepEqual(assetIdentity(fixture.state, questions, images), fixture.identity);
  assert.equal(policy.identity(), fixture.policyIdentity);
  assert.equal(answerCacheKey(fixture.state, questions, {provider:'typesafe',model:'jev-1.14.0',effort:null}, {assets:fixture.assets,experimental:{images:true}}), fixture.cacheKey);
  fixture.answers.forEach((answers, i) => assert.deepEqual(policy.decide(answers), fixture.decisions[i]));
});
