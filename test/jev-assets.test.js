import test from 'node:test';
import assert from 'node:assert/strict';
import { imageAsset, inspectAssets, assetIdentity } from '../src/assets.js';

import { png } from './helpers/png.js';

test('portable images validate dimensions, references and content identity', () => {
  const a = imageAsset(png(), { format: 'png' });
  const first = inspectAssets({ photo: a }, { state: { image:'photo' }, questions:{} });
  assert.equal(first.photo.width,280);
  assert.equal(first.photo.height,280);
  assert.equal(first.photo.sha256.length,64);
  assert.deepEqual(assetIdentity({ image:'photo' }, {}, first), assetIdentity({ image:'renamed' }, {}, inspectAssets({ renamed:a }, { state:{ image:'renamed' }, questions:{} })));
  assert.throws(() => inspectAssets({ unused:a }, {state:'hello',questions:{}}), /unused|referenced/);
  assert.throws(() => imageAsset(png(279), {format:'png'}), /280/);
  assert.throws(() => inspectAssets({photo:{...a,data_base64:'data:image/png;base64,ABC'}}, {state:'photo',questions:{}}), /base64/);
  assert.throws(() => imageAsset(Buffer.from('invalid'), {format:'png'}), /PNG|image/);
});

test('references match strings but never object keys, and distinct contents do not share identity', () => {
  const a = imageAsset(png(), {format:'png'}), b=imageAsset(png(280,280,1),{format:'png'});
  assert.throws(() => inspectAssets({photo:a}, {state:{photo:'no image'},questions:{}}), /referenced/);
  const xs = inspectAssets({photo:a}, {state:'look at photo now',questions:{}});
  const ys = inspectAssets({photo:b}, {state:'look at photo now',questions:{}});
  assert.notDeepEqual(assetIdentity('look at photo now',{},xs),assetIdentity('look at photo now',{},ys));
  assert.throws(() => inspectAssets({['é'.repeat(513)]:a}, {state:'é'.repeat(513),questions:{}}), /1,024|1024/);
});

test('large valid images do not overflow the base64 validator stack',()=>{
 const bytes=png(1000,1000,null);assert.ok(bytes.length>2*1024*1024);
 assert.doesNotThrow(()=>imageAsset(bytes,{format:'png'}));
});
test('image placements cannot collide with a caller-written digest marker',()=>{
 const image=imageAsset(png(),{format:'png'}),assets={ref:image},inspected=inspectAssets(assets,{state:{a:'ref'},questions:{}}),marker=`<jev-image:${inspected.ref.sha256}>`;
 assert.notDeepEqual(assetIdentity({a:'ref',b:marker},{},inspected),assetIdentity({a:marker,b:'ref'},{},inspected));
});

test('incomplete JPEG frames cannot masquerade as valid images',()=>{
 assert.throws(()=>imageAsset(Buffer.from('ffd8ffc00008080118011800','hex'),{format:'jpg'}),/JPEG|incomplete/);
});

test('baseline and progressive JPEGs are accepted without a runtime decoder dependency',async()=>{
 const{readFile}=await import('node:fs/promises');
 for(const name of ['jev-baseline.jpg','jev-progressive.jpg']) { const bytes=await readFile(new URL('./fixtures/'+name,import.meta.url)); assert.doesNotThrow(()=>imageAsset(bytes,{format:'jpg'})); }
});
