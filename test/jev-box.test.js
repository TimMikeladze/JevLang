import test from 'node:test';
import assert from 'node:assert/strict';
import { box,noul,definePolicy,gate,escalate,rule,assign,hold,all,compare,literal,expression,compile,validateAnswers,questionsAnswerSchema } from '../src/index.js';
import { explainDecision } from '../src/explain.js';
import { checkRequestBudget } from '../src/budgets.js';
const coordinates={left:0.1,right:0.8,top:0.2,bottom:0.9};
const present=noul('present','Is the mug in `photo`?');
const mug=box('mug','the mug in `photo`');
const make=()=>definePolicy({name:'box',questions:[present,mug],gates:[gate(mug,0.8,escalate('review'),{onRead:true})],route:{clauses:[rule(all(present.yes(0.9),compare('lt',mug.left(),0.5)),assign('found',{data:mug.value()}))],otherwise:hold()}});
const answers=(probability=0.99,confidence=0.95)=>({present:{type:'noul',noul:probability},mug:{type:'box',box:coordinates,confidence}});
test('Box coordinates survive offline compilation, decisions and traces',()=>{
 const p=make(), q=compile(p.toJSON());
 assert.deepEqual(q.questions().mug,{type:'box',instructions:'the mug in `photo`'});
 const d=q.decide(answers());assert.deepEqual(d.data,coordinates);
 assert.match(explainDecision(d),/left.*0.1/);
 const schema=questionsAnswerSchema(q.questions()).properties.mug;
 assert.equal(schema.properties.box.properties.left.minimum,0);
 assert.throws(()=>definePolicy({name:'bad',questions:[mug],route:{clauses:[rule(compare('gt',mug.left(),0.1),hold())],otherwise:hold()}}),/confidence gate/);
});
test('unreported Box confidence trips a gate and missing target short circuits coordinate reads',()=>{
 assert.equal(make().decide(answers(0.99,null)).target,'review');
 assert.equal(make().decide(answers(0.01,null)).action,'hold');
 const p=definePolicy({name:'null',questions:[mug],route:{clauses:[rule(all(mug.hasConfidence(),compare('gte',mug.confidence(),0.8)),assign('found',{data:mug.value()}))],otherwise:hold()}});
 assert.equal(p.decide({mug:{type:'box',box:coordinates}}).action,'hold');
 assert.equal(p.decide({mug:{type:'box',box:coordinates,confidence:0.9}}).action,'assign');
});
test('Box validates edges, confidence and unsupported gate/accessor metrics',()=>{
 for(const invalid of [{...coordinates,left:0.9},{...coordinates,top:-1},{...coordinates,bottom:Infinity},{left:0,right:1,top:0}])assert.throws(()=>validateAnswers({mug:{type:'box'}},{mug:{type:'box',box:invalid}}),/box|edge|bottom/);
 assert.throws(()=>validateAnswers({mug:{type:'box'}},{mug:{type:'box',box:coordinates,confidence:2}}),/confidence/);
 for(const by of ['topProb','margin'])assert.throws(()=>definePolicy({name:'bad',questions:[mug],gates:[gate(mug,0.8,hold(),{by})],route:{clauses:[],otherwise:hold()}}),/Box|box|metric/);
 assert.throws(()=>definePolicy({name:'bad',questions:[mug],route:{clauses:[rule(expression('mostLikely','mug',0),hold())],otherwise:hold()}}),/cannot read a box/);
});
test('long context is explicit and request/question budgets are independent',()=>{
 const questions={a:{type:'noul',instructions:'x'.repeat(80000)},b:{type:'noul',instructions:'x'.repeat(80000)},c:{type:'noul',instructions:'x'.repeat(80000)},d:{type:'noul',instructions:'x'.repeat(80000)}};
 assert.throws(()=>checkRequestBudget('',questions),/request/);
 assert.throws(()=>checkRequestBudget('x'.repeat(140000),{}),/question/);
 assert.doesNotThrow(()=>checkRequestBudget('x'.repeat(140000),questions,{experimental:{longContext:true}}));
 assert.throws(()=>checkRequestBudget('x'.repeat(1000),{}, {experimental:{longContext:true},tokenLimit:10}),/question/);
 const p=definePolicy({name:'long',typesafe:{experimental:{longContext:true}},questions:[present],route:{clauses:[],otherwise:hold()}});
 assert.equal(p.buildState('x'.repeat(140000)).state.length,140000);
});
