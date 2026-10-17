import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as waitFor } from 'node:timers/promises';
import { gunzipSync } from 'node:zlib';
import { jevCall, listModels, settings } from '../src/client.js';
import { imageAsset } from '../src/assets.js';
import { png } from './helpers/png.js';

async function server(t, handler) {
  const old = {...settings};
  t.after(() => Object.assign(settings,old));
  Object.assign(settings,{sleep:(seconds,signal)=>waitFor(seconds*1000,undefined,{signal}),transport:null,apiKey:'test',environment:()=>undefined,extraBody:null,defaultModel:null});
  const s=createServer(handler); await new Promise(r=>s.listen(0,'127.0.0.1',r)); t.after(()=>s.close());
  settings.baseUrl=`http://127.0.0.1:${s.address().port}`;
}
const result={answers:{visible:{type:'noul',noul:0.9}},model:'jev-1.14.0',usage:{input_tokens:null}};
const questions={visible:{type:'noul',instructions:'Is there a mug in `photo`?'}};

test('images use explicit opt-in and multipart with request first', async t => {
  let calls=0;
  await server(t, async(req,res)=>{
    calls++; const chunks=[]; for await(const c of req)chunks.push(c);
    const body=Buffer.concat(chunks).toString('latin1');
    assert.match(req.headers['content-type'],/^multipart\/form-data; boundary=/);
    assert.equal(req.headers['typesafe-danger-zone-images'],'true');
    assert.match(body,/name="request"/); assert.match(body,/"part":"image-0"/);
    assert.ok(body.indexOf('name="request"')<body.indexOf('name="image-0"'));
    res.end(JSON.stringify(result));
  });
  const assets={photo:imageAsset(png(),{format:'png'})};
  await assert.rejects(jevCall({photo:'photo'},questions,{assets}),/experimental.images/);
  assert.equal(calls,0);
  const r=await jevCall({photo:'photo'},questions,{assets,experimental:{images:true},compression:false});
  assert.equal(r.usage.input_tokens,null);
  assert.equal(calls,1);
});

test('gzip JSON, protected headers, partial retries and models listing work', async t => {
  await server(t,async(req,res)=>{
    if(req.method==='GET') { assert.equal(req.url,'/v1/models'); res.end(JSON.stringify({models:[{name:'jev-preview',description:'preview',release_date:'2026-10-14'}]})); return; }
    const chunks=[]; for await(const c of req)chunks.push(c);
    assert.equal(req.headers['content-encoding'],'gzip');
    const body=JSON.parse(gunzipSync(Buffer.concat(chunks)));
    assert.equal(body.model,'jev-1.14.0');
    assert.equal(req.headers['typesafe-danger-zone-long-context'],'true');
    res.end(JSON.stringify(result));
  });
  await assert.rejects(jevCall('hello',questions,{headers:{AUTHORIZATION:'bad'}}),/protected|override/);
  const r=await jevCall('hello',questions,{compression:'gzip',experimental:{longContext:true},retry:{maxRetries:0}});
  assert.equal(r.model,'jev-1.14.0');
  assert.equal((await listModels()).models[0].name,'jev-preview');
});

test('caller cancellation prevents an HTTP attempt and cancels a pending retry', async t => {
  let calls=0;
  await server(t,(req,res)=>{calls++;res.writeHead(429,{'retry-after':'10'}).end('{}');});
  const before=AbortSignal.abort();
  await assert.rejects(jevCall('hello',questions,{signal:before}),e=>e.kind==='cancelled');
  assert.equal(calls,0);
  let waiting; const retrying=new Promise(resolve=>{waiting=resolve;});
  const sleep=settings.sleep; settings.sleep=(seconds,signal)=>{waiting();return sleep(seconds,signal);};
  const ac=new AbortController(); const pending=jevCall('hello',questions,{signal:ac.signal});
  await retrying; ac.abort();
  await assert.rejects(pending,e=>e.kind==='cancelled');
  assert.equal(calls,1);
});

test('multipart preserves prototype-named asset references',async()=>{
 const{prepareJevRequest,encodeJevRequest}=await import('../src/typesafe-request.js');
 const options={assets:Object.fromEntries([['__proto__',imageAsset(png(),{format:'png'})]]),experimental:{images:true},compression:false};
 const encoded=await encodeJevRequest(prepareJevRequest({photo:'__proto__'},questions,'jev-1.14.0',options),options);
 const form=await new Response(encoded.body,{headers:encoded.headers}).formData();
 const wire=JSON.parse(await form.get('request').text());assert.equal(wire.assets.__proto__.part,'image-0');
});

test('multipart accepts binary uploads whose base64 representation exceeds 32 MiB',async()=>{
 const{readFile}=await import('node:fs/promises');const{prepareJevRequest,encodeJevRequest}=await import('../src/typesafe-request.js');
 const base=await readFile(new URL('./fixtures/jev-baseline.jpg',import.meta.url));
 const chunks=[base.subarray(0,2)];let remaining=13*1024*1024-base.length;
 while(remaining>0){const size=Math.min(65537,remaining),part=Buffer.alloc(size);part[0]=0xff;part[1]=0xef;part.writeUInt16BE(size-2,2);chunks.push(part);remaining-=size;}
 chunks.push(base.subarray(2));const image=imageAsset(Buffer.concat(chunks),{format:'jpg'});
 const options={assets:{'image-ref-a':image,'image-ref-b':image},experimental:{images:true},compression:false};
 const prepared=prepareJevRequest({a:'image-ref-a',b:'image-ref-b'},questions,'jev-1.14.0',options);
 assert.ok(Buffer.byteLength(JSON.stringify(prepared.payload))>32*1024*1024);
 const encoded=await encodeJevRequest(prepared,options);assert.ok(encoded.body.length<32*1024*1024);
});

test('cancelling a retry clears its timer so Node can exit promptly',async()=>{
 const{spawnSync}=await import('node:child_process');
 const script=`import {createServer} from 'node:http';import{jevCall,settings}from './src/client.js';const s=createServer((q,r)=>r.writeHead(429,{'retry-after':'10'}).end('{}'));await new Promise(r=>s.listen(0,'127.0.0.1',r));settings.baseUrl='http://127.0.0.1:'+s.address().port;settings.apiKey='test';const c=new AbortController();setTimeout(()=>c.abort(),30);try{await jevCall('x',{q:{type:'noul'}},{signal:c.signal});}catch(e){if(e.kind!=='cancelled')throw e;}await new Promise(r=>s.close(r));`;
 const result=spawnSync('node',['--input-type=module','-e',script],{encoding:'utf8',timeout:1500});
 assert.equal(result.status,0,result.stderr||result.error?.message);
});
