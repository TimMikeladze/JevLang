// Portable image assets. No filesystem reads or implicit image transformations.
import { createHash } from 'node:crypto';
import { object, own, requireAt, keysOnly } from './common.js';
export const maxRequestBytes = 32 * 1024 * 1024;
// Base64 expands binary data; portable storage is bounded separately from the wire body.
export const maxPortableBytes = 48 * 1024 * 1024;
const maxImageBytes = 16 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function geometry(bytes, format, path) {
  let width, height;
  if (format === 'png') {
    requireAt(bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16)==='IHDR' && bytes.readUInt32BE(8)===13,path,'invalid PNG image header');
    width=bytes.readUInt32BE(16); height=bytes.readUInt32BE(20);
    let at=8, ended=false, pixels=false;
    while(at+12<=bytes.length) {
      const n=bytes.readUInt32BE(at), kind=bytes.toString('ascii',at+4,at+8);
      requireAt(at+12+n<=bytes.length,path,'incomplete PNG image');
      requireAt(kind!=='acTL',path,'animated PNG images are unsupported');
      pixels ||= kind==='IDAT';
      if(kind==='IEND') { ended=true; break; }
      at+=n+12;
    }
    requireAt(ended&&pixels,path,'incomplete PNG image');
  } else {
    requireAt(bytes.length>4 && bytes[0]===0xff && bytes[1]===0xd8,path,'invalid JPEG image header');
    let at=2, ended=false, scanBytes=0;
    while(at<bytes.length) {
      requireAt(bytes[at]===0xff,path,'invalid JPEG marker');
      while(bytes[at]===0xff)at++;
      const marker=bytes[at++];
      if(marker===0xd9) { ended=true;break; }
      requireAt(marker!==0x00&&marker!==0xd8,path,'invalid JPEG marker');
      if(marker===0x01 || (marker>=0xd0&&marker<=0xd7))continue;
      requireAt(at+2<=bytes.length,path,'incomplete JPEG image');
      const n=bytes.readUInt16BE(at);
      requireAt(n>=2&&at+n<=bytes.length,path,'incomplete JPEG segment');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        requireAt(n>=11&&bytes[at+7]>0&&n===8+3*bytes[at+7],path,'invalid JPEG frame component structure');
        height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);
      }
      if(marker===0xda) {
        requireAt(n>=8&&bytes[at+2]>0&&n===6+2*bytes[at+2],path,'invalid JPEG scan header');
        at+=n;
        while(at<bytes.length) {
          if(bytes[at]!==0xff){scanBytes++;at++;continue;}
          const next=bytes[at+1];
          if(next===0x00){scanBytes++;at+=2;continue;}
          if(next>=0xd0&&next<=0xd7){at+=2;continue;}
          if(next===0xff){at++;continue;}
          break;
        }
      } else at+=n;
    }
    requireAt(ended&&scanBytes>0,path,'incomplete JPEG image: missing scan data or end marker');
    requireAt(width&&height,path,'JPEG image has no dimensions');
  }
  requireAt(width>=280&&height>=280&&width<=1568&&height<=1568,path,'image dimensions must each be 280 to 1568 pixels');
  return {width,height};
}
export function imageAsset(bytes,{format}={}) {
  requireAt(bytes instanceof Uint8Array,'image','expected image bytes (Uint8Array or Buffer)');
  const asset={type:'image',format,data_base64:Buffer.from(bytes).toString('base64')};
  inspectImage(asset,'image'); return asset;
}
export function inspectImage(asset,path='image') {
  keysOnly(asset,['type','format','data_base64'],path);
  requireAt(!own(asset,'type')||asset.type==='image',path,'asset type must be image');
  requireAt(['png','jpg','jpeg'].includes(asset.format),`${path}.format`,'image format must be png, jpg or jpeg');
  const data=asset.data_base64;
  requireAt(typeof data==='string'&&data.length>0&&data.length<=Math.ceil(maxImageBytes/3)*4&&data.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(data),`${path}.data_base64`,'expected standard padded base64 without whitespace or a data URL prefix; image limit is 16 MiB');
  const bytes=Buffer.from(data,'base64');
  requireAt(bytes.length<=maxImageBytes&&bytes.toString('base64')===data,path,'invalid base64 or image exceeds 16 MiB');
  return {format:asset.format==='jpeg'?'jpg':asset.format,bytes,sha256:digest(bytes),...geometry(bytes,asset.format,path)};
}
// Return replacement segments with the same whole-value and nonoverlapping rules as the API.
export function replaceReferences(value, references, replace) {
  const refs=validateAssetReferences(references);
  const string = s => {
    if(own(references,s))return replace(s);
    let out='', at=0;
    while(at<s.length) {
      let match=null,pos=s.length;
      for(const ref of refs) { const i=s.indexOf(ref,at); if(i>=0&&(i<pos||(i===pos&&ref.length>(match?.length??0)))){pos=i;match=ref;} }
      if(match===null){out+=s.slice(at);break;}
      out+=s.slice(at,pos)+replace(match);at=pos+match.length;
    }
    return out;
  };
  const walk=v=>typeof v==='string'?string(v):Array.isArray(v)?v.map(walk):object(v)?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)])):v;
  return walk(value);
}
export function validateAssetReferences(assets = {}) {
  requireAt(object(assets), 'assets', 'assets must be an object');
  let total = 0;
  for (const ref of Object.keys(assets)) {
    const bytes = Buffer.byteLength(ref); total += bytes;
    requireAt(ref.trim() && bytes <= 1024, 'assets', 'asset reference must be nonblank and at most 1,024 UTF-8 bytes');
  }
  requireAt(total <= 65536, 'assets', 'asset references exceed 65,536 UTF-8 bytes');
  return Object.keys(assets);
}
export function inspectAssets(assets={}, {state,questions}) {
  validateAssetReferences(assets);
  let referenceBytes=0,total=0;
  const inspected=Object.fromEntries(Object.entries(assets).map(([ref,asset])=>{
    const n=Buffer.byteLength(ref);referenceBytes+=n;
    requireAt(ref.trim()&&n<=1024,`assets.${ref}`,'asset reference must be nonblank and at most 1,024 UTF-8 bytes');
    const info=inspectImage(asset,`assets.${ref}`);total+=info.bytes.length;
    return [ref,{...info,occurrences:0}];
  }));
  requireAt(referenceBytes<=65536,'assets','asset references exceed 65,536 UTF-8 bytes');
  requireAt(total<=maxRequestBytes,'assets','image uploads exceed 32 MiB');
  const contentQuestions=Object.fromEntries(Object.entries(questions).map(([id,q])=>[id,Object.fromEntries(['instructions','criteria'].filter(k=>own(q,k)).map(k=>[k,q[k]]))]));
  replaceReferences({state,questions:contentQuestions},inspected,ref=>{inspected[ref].occurrences++;return ref;});
  let expanded=Buffer.byteLength(JSON.stringify({state,questions}));
  for(const [ref,info] of Object.entries(inspected)) {
    requireAt(info.occurrences>0,`assets.${ref}`,'asset is unused; every asset must be referenced in state, instructions or criteria');
    expanded+=info.occurrences*(info.bytes.length-Buffer.byteLength(ref));
  }
  requireAt(expanded<=maxRequestBytes,'assets','expanded image request exceeds 32 MiB before server image processing');
  return inspected;
}
export function assetManifest(inspected) {
  return Object.fromEntries(Object.entries(inspected).map(([ref,{format,width,height,sha256,occurrences}])=>[ref,{format,width,height,sha256,occurrences}]));
}
export function assetIdentity(state,questions,inspected) {
  const refs=validateAssetReferences(inspected);
  // Type every JSON node so user text/objects cannot impersonate image tags.
  const normalize = (value, images = true) => {
    if (typeof value === 'string') {
      if (!images || !refs.length) return ['string',value];
      const parts=[];let at=0;
      while (at<value.length) {
        let ref=null,pos=value.length;
        for (const key of refs) { const i=value.indexOf(key,at); if(i>=0&&(i<pos||(i===pos&&key.length>(ref?.length??0)))){pos=i;ref=key;} }
        if(ref===null){parts.push(['text',value.slice(at)]);break;}
        if(pos>at)parts.push(['text',value.slice(at,pos)]);
        parts.push(['image',inspected[ref].sha256]);at=pos+ref.length;
      }
      return ['content',parts];
    }
    if(Array.isArray(value))return ['array',value.map(v=>normalize(v,images))];
    if(object(value))return ['object',Object.keys(value).sort().map(k=>[k,normalize(value[k],images)])];
    return ['scalar',value];
  };
  return {state:normalize(state),questions:Object.fromEntries(Object.entries(questions).map(([id,q])=>[id,Object.fromEntries(Object.entries(q).map(([k,v])=>[k,normalize(v,['instructions','criteria'].includes(k))]))])),images:[...new Set(Object.values(inspected).map(a=>a.sha256))].sort()};
}

export function mergeAssets(...maps) {
  const entries=[];const used=new Set();
  for(const map of maps) { validateAssetReferences(map ?? {}); for(const [ref,asset] of Object.entries(map??{})) {
    requireAt(!used.has(ref),`assets.${ref}`,'duplicate static/runtime asset reference'); used.add(ref);entries.push([ref,asset]);
  }}
  return Object.fromEntries(entries);
}
