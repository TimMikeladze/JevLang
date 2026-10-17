import test from 'node:test';
import assert from 'node:assert/strict';
import { png } from './helpers/png.js';
import { imageAsset,box,noul,definePolicy,rule,gate,escalate,assign,hold,evaluateWithProvider,clientSettings,runPolicyProvider,fixtureFromRun,replay,compile,all,compare } from '../src/index.js';
import { ProviderRegistry,mergeProviderConfig,capabilities,provider,availability } from '../src/provider/index.js';
import { typesafeProvider } from '../src/evaluate.js';
const b=box('mug','mug in `photo`'),present=noul('present','Is a mug in `photo`?');
const make=(typesafe={experimental:{images:true}})=>definePolicy({name:'images',typesafe,questions:[present,b],gates:[gate(b,0.8,escalate('review'),{onRead:true})],route:{clauses:[rule(all(present.yes(0.9),compare('lt',b.left(),0.5)),assign('found',{data:b.value()}))],otherwise:hold()}});
const output={present:{type:'noul',noul:0.99},mug:{type:'box',box:{left:0.1,right:0.8,top:0.1,bottom:0.9},confidence:0.9}};
function setup(t){const old={...clientSettings};t.after(()=>Object.assign(clientSettings,old));let calls=0;const sent=[];Object.assign(clientSettings,{environment:()=>undefined,defaultModel:null,transport:async (p,opts)=>{calls++;sent.push([p,opts]);return{answers:output,model:p.model,usage:{input_tokens:99}};}});const registry=new ProviderRegistry();registry.register(typesafeProvider());const config=mergeProviderConfig({project:{provider:'typesafe'}});return{registry,config,sent,get calls(){return calls;}};}
test('image evaluation sends flags, keeps images out of generic prompts, and caches by contents and resolved model',async t=>{
 const s=setup(t),p=make(),cache=new Map(),a=imageAsset(png(),{format:'png'});
 const options={registry:s.registry,config:s.config,cache,assets:{'image-ref-a':a}};
 assert.equal((await evaluateWithProvider(p,{photo:'image-ref-a'},options)).target,'found');
 assert.equal(s.sent[0][1].headers['TypeSafe-Danger-Zone-Images'],'true');
 assert.equal((await evaluateWithProvider(p,{photo:'image-ref-b'},{...options,assets:{'image-ref-b':a}})).cached,true);
 assert.equal(s.calls,1);
 await evaluateWithProvider(p,{photo:'image-ref-a'},{...options,assets:{'image-ref-a':imageAsset(png(280,280,1),{format:'png'})}});
 assert.equal(s.calls,2);
 await evaluateWithProvider(p,{photo:'image-ref-a'},{...options,model:'jev-preview'});assert.equal(s.calls,3);
 await assert.rejects(evaluateWithProvider(p,{photo:'image-ref-a'},{...options,experimental:{images:false}}),/experimental.images/);
});
test('image/Box requests cannot fall back to a text-only provider',async t=>{
 const s=setup(t),registry=new ProviderRegistry();let ran=false;
 registry.register(provider({id:'text',caps:capabilities(),discover:async()=>availability('ready'),run:async()=>{ran=true;return{};}}));
 const p=make();await assert.rejects(evaluateWithProvider(p,{photo:'image-ref-a'},{registry,config:mergeProviderConfig({project:{provider:'text'}}),assets:{'image-ref-a':imageAsset(png(),{format:'png'})}}),/eligible|capability/);
 assert.equal(ran,false);
});
test('asset-aware fixture replay works without images and separates image verification',async t=>{
 const s=setup(t),p=make(),state={photo:'image-ref-a'},questions=p.questions(),assets={'image-ref-a':imageAsset(png(),{format:'png'})};
 const result=await runPolicyProvider(state,questions,{config:s.config,registry:s.registry,assets,experimental:{images:true}});
 const fixture=fixtureFromRun({name:'mug',policy:p,state,questions,result});
 assert.equal(fixture.fixture_version,4);assert.ok(fixture.assets['image-ref-a'].sha256);assert.equal(fixture.assets['image-ref-a'].data_base64,undefined);
 const row=replay(p,[fixture])[0];assert.equal(row.status,'unasserted');assert.equal(row.decisionVerified,true);assert.equal(row.assetsVerified,false);assert.equal(row.decision.target,'found');
 assert.equal(replay(p,[fixture],{assets})[0].assetsVerified,true);
});
test('static criterion images affect portable policy identity without changing text identities',()=>{
 const a=imageAsset(png(),{format:'png'}),c=imageAsset(png(280,280,1),{format:'png'});
 const p=make({experimental:{images:true},assets:{reference:a}}),q=make({experimental:{images:true},assets:{reference:c}});
 assert.notEqual(p.identity(),q.identity());assert.equal(compile(p.toJSON()).identity(),p.identity());
});

test('runtime long context reaches state construction and configured model changes invalidate cache',async t=>{
 const s=setup(t),q=noul('visible','yes?');
 const p=definePolicy({name:'long',questions:[q],route:{clauses:[],otherwise:hold()}});
 clientSettings.transport=async payload=>{s.sent.push([payload]);return {answers:{visible:{type:'noul',noul:0.9}},model:payload.model};};
 const cache=new Map();
 await evaluateWithProvider(p,'x'.repeat(140000),{registry:s.registry,config:s.config,experimental:{longContext:true},cache});
 assert.equal(s.sent.length,1);
 await evaluateWithProvider(p,'x'.repeat(140000),{registry:s.registry,config:mergeProviderConfig({project:{provider:'typesafe',model:'jev-preview'}}),experimental:{longContext:true},cache});
 assert.equal(s.sent.length,2);
});
test('asset references survive redaction and are never partially truncated',async t=>{
 const s=setup(t),q=noul('visible','Is there a mug in `photo`?');
 const p=definePolicy({name:'redact',questions:[q],state:{photo:{path:['photo']}},stateOptions:{redact:['emails'],maxChars:1000},typesafe:{experimental:{images:true}},route:{clauses:[],otherwise:hold()}});
 clientSettings.transport=async payload=>{s.sent.push([payload]);return{answers:{visible:{type:'noul',noul:0.9}},model:payload.model};};
 const ref='asset@example.com';await evaluateWithProvider(p,{photo:ref},{registry:s.registry,config:s.config,assets:{[ref]:imageAsset(png(),{format:'png'})}});
 assert.equal(s.sent[0][0].state.photo,ref);
});

test('cacheOnly can replay a durable answer without provider discovery or credentials',async t=>{
 const s=setup(t),p=make(),cache=new Map(),options={config:s.config,registry:s.registry,cache,assets:{'image-ref':imageAsset(png(),{format:'png'})}};
 await evaluateWithProvider(p,{photo:'image-ref'},options);
 const offline=new ProviderRegistry();const adapter=typesafeProvider();adapter.discover=async()=>{throw new Error('discovery must not run');};offline.register(adapter);
 clientSettings.transport=null;
 assert.equal((await evaluateWithProvider(p,{photo:'image-ref'},{...options,registry:offline,cacheOnly:true})).cached,true);
});

test('moving aliases expire instead of indefinitely reusing old model answers',async t=>{
 const s=setup(t),p=make(),cache=new Map(),a=imageAsset(png(),{format:'png'}),options={registry:s.registry,config:s.config,cache,assets:{'image-ref':a},model:'jev-preview',cacheMaxAgeSeconds:0};
 await evaluateWithProvider(p,{photo:'image-ref'},options);
 await evaluateWithProvider(p,{photo:'image-ref'},options);
 assert.equal(s.calls,2);
});

test('embedded static assets replay without duplicate-reference errors',async t=>{
 const s=setup(t),staticImage=imageAsset(png(),{format:'png'});
 const p=definePolicy({...make().toJSON(),typesafe:{experimental:{images:true},assets:{'image-ref':staticImage}}});
 const state={photo:'image-ref'},questions=p.questions();
 const result=await runPolicyProvider(state,questions,{registry:s.registry,config:s.config,assets:p.policy.typesafe.assets,experimental:{images:true}});
 const fixture=fixtureFromRun({name:'embedded',policy:p,state,questions,result,assets:p.policy.typesafe.assets,embedAssets:true});
 const row=replay(p,[fixture])[0];assert.equal(row.status,'unasserted');assert.equal(row.assetsVerified,true);
});

test('empty image references reject before redaction or capping can loop',()=>{
 const p=definePolicy({name:'empty-reference',questions:[present],stateOptions:{redact:['emails'],maxChars:100},route:{clauses:[],otherwise:hold()}});
 assert.throws(()=>p.buildState('hello',{assets:{'':{}}}),/reference.*nonblank|nonblank.*reference/);
});

test('v4 fixtures reject malformed manifests and cannot claim unproven decision identity',async t=>{
 const s=setup(t),p=make(),state={photo:'image-ref'},questions=p.questions(),assets={'image-ref':imageAsset(png(),{format:'png'})};
 const result=await runPolicyProvider(state,questions,{config:s.config,registry:s.registry,assets,experimental:{images:true}});
 const fixture=fixtureFromRun({name:'verify',policy:p,state,questions,result});
 assert.equal(replay(p,[{...fixture,assets:{bogus:{}}}])[0].status,'error');
 const unproven={...fixture};delete unproven.questions;delete unproven.questions_sha256;
 assert.equal(replay(p,[unproven])[0].decisionVerified,false);
});

test('fallback answers are not persisted under a recovered primary provider cache key',async()=>{
 const{ProviderError}=await import('../src/provider/index.js');const registry=new ProviderRegistry();let healthy=false,calls=0;
 for(const id of ['primary','backup'])registry.register(provider({id,caps:capabilities(),discover:async()=>availability('ready'),run:async(request,target)=>{
  if(id==='primary'){calls++;if(!healthy)throw new ProviderError('offline',{kind:'connection',retryable:true,target});}
  return{output:{ok:{type:'noul',noul:0.9}},target,model:target.model,usage:{},cost:{mode:'unreported',usd:null},requestId:null,attempts:[],exitStatus:0,changed:[]};
 }}));
 const p=definePolicy({name:'fallback',questions:[noul('ok','OK?')],route:{clauses:[],otherwise:hold()}}),cache=new Map(),config=mergeProviderConfig({project:{provider:'primary',fallback:['backup']}});
 assert.equal((await evaluateWithProvider(p,'x',{registry,config,cache})).provider,'backup');healthy=true;
 assert.equal((await evaluateWithProvider(p,'x',{registry,config,cache})).provider,'primary');assert.equal(calls,2);
});
