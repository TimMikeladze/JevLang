import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { imageAsset,noul,definePolicy,hold,evaluateMany,runPipeline,clientSettings,cost } from '../src/index.js';
import { handleRequest } from '../src/serve.js';
import { policyMcpServer,handleMessage,makeMcpConn,modernVersion,metaProtocolVersion,metaClientCapabilities } from '../src/mcp.js';
import { loadAssetManifest } from '../src/cli.js';
import { png } from './helpers/png.js';
const q=noul('visible','Is a mug in `photo`?');
const policy=definePolicy({name:'surface',questions:[q],route:{clauses:[],otherwise:hold()}});
test('sidecar forwards only operator-enabled image options and preserves body cap',async()=>{
 let got;
 const evaluate=async(input,options)=>{got={input,options};return policy.decide({visible:{noul:0.9}});};
 const request=JSON.stringify({state:{photo:'image-ref'},assets:{'image-ref':imageAsset(png(),{format:'png'})},experimental:{images:true}});
 const no=await handleRequest(policy,'POST','/evaluate',request,{evaluate});assert.equal(no.status,422);
 const yes=await handleRequest(policy,'POST','/evaluate',request,{evaluate,experimental:{images:true}});assert.equal(yes.status,200);
 assert.equal(got.options.experimental.images,true);assert.ok(got.options.assets['image-ref']);
 const bad=await handleRequest(policy,'POST','/evaluate',JSON.stringify({state:'a',headers:{authorization:'bad'}}),{evaluate});assert.equal(bad.status,422);
});
test('MCP advertises JSON assets and forwards authorized options',async()=>{
 let got;const server=policyMcpServer(policy,{allowEvaluate:true,experimental:{images:true},evaluate:async(input,options)=>{got=options;return policy.decide({visible:{noul:0.9}});}});
 // The public message handler exercises schemas and the real tool adapter.
 const meta = { [metaProtocolVersion]: modernVersion, [metaClientCapabilities]: {} };
 const list=await handleMessage(server,{jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:meta}},makeMcpConn());
 const tool=list.result.tools.find(t=>t.name==='evaluate');assert.ok(tool.inputSchema.properties.assets);
 const called=await handleMessage(server,{jsonrpc:'2.0',id:2,method:'tools/call',params:{_meta:meta,name:'evaluate',arguments:{state:{photo:'image-ref'},assets:{'image-ref':imageAsset(png(),{format:'png'})}}}},makeMcpConn());
 assert.equal(called.result.isError,false);assert.ok(got.assets['image-ref']);
});
test('nullable usage keeps known subtotals without claiming a complete cost',async()=>{
 const report=await evaluateMany(async n=>{clientSettings.onUsage?.({input_tokens:n?20:null});return{action:'hold'};},[0,1],{rpm:null,tokensPerSecond:null});
 assert.equal(report.tokens,20);assert.equal(report.usage_complete,false);assert.equal(report.unreported_calls,1);assert.equal(report.cost,null);
 const result=await runPipeline({a:async()=>{clientSettings.onUsage?.({input_tokens:null,output_tokens:null});return{action:'hold'};}},{},{start:'a'});
 assert.equal(result.usage_complete,false);assert.equal(result.unreported_calls,1);
});
test('CLI help exposes image flags and manifest files are relative to the manifest',async()=>{
 const help=spawnSync('node',['src/cli.js','--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/jev models/);assert.match(help.stdout,/--assets/);
 const dir=mkdtempSync(join(tmpdir(),'jev-assets-'));writeFileSync(join(dir,'photo.png'),png());writeFileSync(join(dir,'assets.json'),JSON.stringify({'image-ref':{path:'photo.png'}}));
 assert.equal((await loadAssetManifest(join(dir,'assets.json')))['image-ref'].format,'png');
});
test('cost labels image tokens as unknown and uses effective context flags',()=>{
 const p=definePolicy({...policy.toJSON(),typesafe:{experimental:{images:true,longContext:true}}});
 const report=cost(p,{input:{photo:'image-ref'},assets:{'image-ref':imageAsset(png(),{format:'png'})}});
 assert.equal(report.image_tokens,null);assert.equal(report.per_call.tokens,null);assert.equal(report.per_call.usd,null);assert.ok(report.warnings.some(s=>/image tokens/i.test(s)));
});

test('CLI evaluate and record send image manifests through the real HTTP client',async t=>{
 const {createServer}=await import('node:http');const{execFile}=await import('node:child_process');const{promisify}=await import('node:util');const exec=promisify(execFile);
 let calls=0;const server=createServer(async(req,res)=>{calls++;const chunks=[];for await(const c of req)chunks.push(c);assert.equal(req.headers['typesafe-danger-zone-images'],'true');assert.match(Buffer.concat(chunks).toString('latin1'),/name="image-0"/);res.end(JSON.stringify({answers:{visible:{type:'noul',noul:0.9}},model:'jev-1.14.0',usage:{input_tokens:10}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const dir=mkdtempSync(join(tmpdir(),'jev-cli-image-'));writeFileSync(join(dir,'photo.png'),png());writeFileSync(join(dir,'assets.json'),JSON.stringify({'image-ref':{path:'photo.png'}}));writeFileSync(join(dir,'input.json'),JSON.stringify({photo:'image-ref'}));writeFileSync(join(dir,'policy.json'),JSON.stringify(policy.toJSON()));
 const args=[join(dir,'policy.json'),join(dir,'input.json'),'--assets',join(dir,'assets.json'),'--experimental-images','--compression','false'];
 const env={...process.env,TYPESAFE_API_KEY:'test',TYPESAFE_BASE_URL:`http://127.0.0.1:${server.address().port}`};
 const evaluated=JSON.parse((await exec('node',['src/cli.js','evaluate',...args],{env})).stdout);assert.equal(evaluated.action,'hold');
 const recorded=JSON.parse((await exec('node',['src/cli.js','record',...args],{env})).stdout);assert.equal(recorded.fixture.fixture_version,4);assert.ok(recorded.fixture.assets['image-ref'].sha256);assert.equal(calls,2);
});

test('Box confidence histograms include only reported numeric values',async()=>{
 const{summarize}=await import('../src/monitor.js');
 const summary=summarize([{action:'hold',readings:[{question:'mug',kind:'box',value:{left:0,top:0,right:1,bottom:1},confidence:0.9},{question:'missing',kind:'box',value:{left:0,top:0,right:1,bottom:1},confidence:null}]}]);
 assert.equal(summary.confidence.questions.length,1);assert.equal(summary.confidence.questions[0].question,'mug');
});

test('CLI state keeps working with optional state-building controls',async()=>{
 const{handle}=await import('../src/cli.js');
 const built=await handle({method:'state',policy:policy.toJSON(),input:{photo:'image-ref'}});
 assert.deepEqual(built.state,{photo:'image-ref'});
});

test('CLI record enforces the policy request budget before calling a provider',async()=>{
 const{handle}=await import('../src/cli.js');
 const p=definePolicy({name:'budget',questions:[noul('budget','x'.repeat(200))],stateOptions:{requestTokenLimit:10},route:{clauses:[],otherwise:hold()}});
 await assert.rejects(handle({method:'record',policy:p.toJSON(),input:'x'}),/per-request limit/);
});

test('policy metadata exposes experimental flags and asset digests without image bytes',async()=>{
 const{policyToJson}=await import('../src/mcp.js');
 const p=definePolicy({...policy.toJSON(),typesafe:{experimental:{images:true},assets:{'reference-image':imageAsset(png(),{format:'png'})}}});
 const metadata=policyToJson(p);assert.equal(metadata.typesafe.experimental.images,true);assert.ok(metadata.typesafe.assets['reference-image'].sha256);assert.equal(metadata.typesafe.assets['reference-image'].data_base64,undefined);
});
