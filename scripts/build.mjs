import { build } from 'esbuild';
import { mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/icons', { recursive: true });
const common = { bundle: true, target: 'chrome114', minify: false, sourcemap: false, legalComments: 'eof', loader: { '.css': 'text' } };
await build({ ...common, entryPoints: ['src/background.js'], outfile: 'dist/background.js', format: 'esm' });
await build({ ...common, entryPoints: ['src/content.js'], outfile: 'dist/content.js', format: 'iife' });
await build({ ...common, entryPoints: ['src/options.js'], outfile: 'dist/options.js', format: 'iife' });
await build({ ...common, entryPoints: ['src/popup.js'], outfile: 'dist/popup.js', format: 'iife' });
for (const name of ['manifest.json', 'options.html', 'options.css', 'popup.html', 'popup.css', 'select.css']) await cp(`src/${name}`, `dist/${name}`);

// Original geometric icon, encoded locally; no external image assets.
function crc32(b) { let c=0xffffffff; for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; }
function chunk(type, data){const t=Buffer.from(type);const n=Buffer.alloc(4);n.writeUInt32BE(data.length);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);}
for (const size of [16,48,128]) {
  const raw=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const u=x/size,v=y/size;let color=[22,30,43,255];
    if(u>.21&&u<.35&&v>.57&&v<.78)color=[77,149,255,255];
    if(u>.43&&u<.57&&v>.38&&v<.78)color=[134,116,249,255];
    if(u>.65&&u<.79&&v>.21&&v<.78)color=[63,210,176,255];
    const k=y*(size*4+1)+1+x*4;for(let c=0;c<4;c++)raw[k+c]=color[c];
  }
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  await writeFile(`dist/icons/${size}.png`,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
await mkdir('demo', { recursive: true });
await build({ ...common, entryPoints: ['demo/demo.js'], outfile: 'demo/demo.bundle.js', format: 'iife' });
console.log('Built dist/ (extension) and demo/demo.bundle.js (local preview).');
