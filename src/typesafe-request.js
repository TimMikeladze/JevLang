import { checkRequestBudget } from './budgets.js';
import * as zlib from 'node:zlib';
import { object, own, requireAt, keysOnly, jsonCopy } from './common.js';
import { inspectAssets, assetManifest, validateAssetReferences, maxRequestBytes, maxPortableBytes } from './assets.js';

export function validateJevOptions(options={}, path='typesafe') {
  keysOnly(options,['assets','experimental','compression','assetTransport'],path);
  if(own(options,'assets'))validateAssetReferences(options.assets);
  if(own(options,'experimental')) {
    keysOnly(options.experimental,['images','longContext'],`${path}.experimental`);
    for(const [k,v] of Object.entries(options.experimental))requireAt(typeof v==='boolean',`${path}.experimental.${k}`,'expected boolean');
  }
  if(own(options,'compression'))requireAt([false,'auto','zstd','gzip'].includes(options.compression),`${path}.compression`,'expected auto, zstd, gzip or false');
  if(own(options,'assetTransport'))requireAt(['json','multipart'].includes(options.assetTransport),`${path}.assetTransport`,'expected json or multipart');
  return options;
}
export function requestHeaders(options={}) {
  const headers={Accept:'application/json'};
  requireAt(!options.headers||object(options.headers),'headers','expected header map');
  for(const [name,value] of Object.entries(options.headers??{})) {
    requireAt(!['authorization','content-type','content-length','content-encoding','host','transfer-encoding'].includes(name.toLowerCase())&&!name.toLowerCase().startsWith('typesafe-danger-zone-'),`headers.${name}`,'cannot override protected request header');
    requireAt(typeof value==='string',`headers.${name}`,'header values must be strings');headers[name]=value;
  }
  if(options.experimental?.images)headers['TypeSafe-Danger-Zone-Images']='true';
  if(options.experimental?.longContext)headers['TypeSafe-Danger-Zone-Long-Context']='true';
  return headers;
}
export function prepareJevRequest(state,questions,model,options={},extraBody=null) {
  validateJevOptions(Object.fromEntries(['assets','experimental','compression','assetTransport'].filter(k=>own(options,k)).map(k=>[k,options[k]])));
  const payload=jsonCopy({state,model,questions},{maxBytes:maxRequestBytes});
  if(extraBody) {
    requireAt(object(extraBody),'extraBody','expected object');
    for(const [k,v] of Object.entries(extraBody)) {
      requireAt(!['state','model','questions','assets'].includes(k),`extraBody.${k}`,`extraBody cannot set '${k}'`);payload[k]=jsonCopy(v);
    }
  }
  checkRequestBudget(state,questions,options);
  const inspected=inspectAssets(options.assets??{},payload), hasImages=Object.keys(inspected).length>0;
  const hasBox=Object.values(payload.questions).some(q=>q.type==='box');
  requireAt(!(hasImages||hasBox)||options.experimental?.images,'experimental.images','images and Box require experimental.images: true');
  requireAt(!hasBox||hasImages,'assets','Box questions require at least one image');
  requireAt(!hasBox||model!=='jev-1.13.0','model','Box requires Jev 1.14 or newer');
  if(hasImages)payload.assets=jsonCopy(options.assets,{maxBytes:maxPortableBytes});
  const headers=requestHeaders(options);
  return {payload,headers,inspected,manifest:assetManifest(inspected),experimental:{images:options.experimental?.images===true,longContext:options.experimental?.longContext===true}};
}
export async function encodeJevRequest(prepared,options={}) {
  const headers={...prepared.headers};let bytes;
  if(Object.keys(prepared.inspected).length&&options.assetTransport!=='json'&&typeof FormData!=='undefined') {
    const body=new FormData();const assets=Object.create(null);let i=0;
    for(const [ref,info] of Object.entries(prepared.inspected)) {
      const part=`image-${i++}`;assets[ref]={type:'image',part};
    }
    body.append('request',new Blob([JSON.stringify({...prepared.payload,assets})],{type:'application/json'}));
    for(const [ref,info] of Object.entries(prepared.inspected))body.append(assets[ref].part,new Blob([info.bytes],{type:info.format==='png'?'image/png':'image/jpeg'}),`${assets[ref].part}.${info.format}`);
    const response=new Response(body);headers['Content-Type']=response.headers.get('content-type');bytes=Buffer.from(await response.arrayBuffer());
  } else {headers['Content-Type']='application/json';bytes=Buffer.from(JSON.stringify(prepared.payload));}
  requireAt(bytes.length<=maxRequestBytes,'request','request body exceeds 32 MiB');
  const mode=options.compression??'auto';
  const encoding=mode==='auto'?(bytes.length>=1024&&typeof zlib.zstdCompressSync==='function'?'zstd':false):mode;
  if(encoding==='gzip')bytes=zlib.gzipSync(bytes);
  if(encoding==='zstd') {
    requireAt(typeof zlib.zstdCompressSync==='function','compression','zstd is unavailable on this Node runtime');
    bytes=zlib.zstdCompressSync(bytes,{params:{[zlib.constants.ZSTD_c_windowLog]:23}});
  }
  if(encoding)headers['Content-Encoding']=encoding;
  requireAt(bytes.length<=maxRequestBytes,'request','compressed request exceeds 32 MiB');
  return {body:bytes,headers};
}
