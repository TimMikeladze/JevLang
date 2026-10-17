import { deflateSync } from 'node:zlib';
// A complete RGB PNG. CRCs are generated so the same fixture works with real decoders.
export function png(width = 280, height = 280, byte = 0) {
  const crc = b => { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i=0;i<8;i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
  const chunk = (name, data) => { const type = Buffer.from(name), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); type.copy(out,4); data.copy(out,8); out.writeUInt32BE(crc(Buffer.concat([type,data])),out.length-4); return out; };
  const head = Buffer.alloc(13); head.writeUInt32BE(width); head.writeUInt32BE(height,4); head[8]=8; head[9]=2;
  const pixels = Buffer.alloc((width*3+1)*height,byte ?? 0); if (byte === null) { let seed=123456; for(let i=0;i<pixels.length;i++){seed ^= seed<<13;seed ^= seed>>>17;seed ^= seed<<5;pixels[i]=seed&255;} } for(let y=0;y<height;y++) pixels[y*(width*3+1)]=0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
