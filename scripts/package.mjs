import { access, cp, mkdir, rm, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const binary=`binom-dashboard-${version}.zip`;
const source=`binom-dashboard-${version}-source.zip`;
// Check before any writes: a documentation update must not replace an issued build.
for (const name of [binary,source]) {
  let exists=false;
  try { await access(`release/${name}`); exists=true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) throw new Error(`Release already exists: ${name}. Preserve issued archives and choose a new version for a new release.`);
}
execFileSync(process.execPath,['scripts/check-docs.mjs'],{stdio:'inherit'});
if (JSON.parse(await readFile('dist/manifest.json','utf8')).version !== version) throw new Error('Build dist/ for the current version before packaging.');
// Only the published project files are packaged.
const sourceTrees=['src','tests','scripts','demo'];
const sourceRootFiles=['package.json','package-lock.json','.gitignore','README.md','PRIVACY.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.txt','preview.png'];
const allowedExtensions={src:['.js','.css','.html','.json'],tests:['.js','.mjs'],scripts:['.mjs'],demo:['.js','.html','.css'],docs:['.md']};
const distFiles=new Set(['background.js','content.js','options.js','options.html','options.css','popup.js','popup.html','popup.css','select.css','manifest.json','icons/16.png','icons/48.png','icons/128.png','LICENSE','PRIVACY.md','THIRD_PARTY_NOTICES.txt']);
// zip does not respect .gitignore. Refuse unexpected/private files and symlinks
// in exported trees before changing anything; this is not a content secret scan.
async function inspectExport(path, tree=null) {
  const info=await lstat(path);
  if(info.isSymbolicLink()) throw new Error(`Symlink must not be packaged: ${path}`);
  const name=basename(path);
  if(name==='LOCAL_CONTEXT.md'||/^binom-openapi/i.test(name)||(/^[.]/.test(name)&&path!=='.gitignore')||/\.(?:har|pem|key|log)$/i.test(name)) throw new Error(`Private or diagnostic file must not be packaged: ${path}`);
  if(info.isDirectory()) {
    for(const entry of await readdir(path)) await inspectExport(`${path}/${entry}`,tree);
  } else if(!info.isFile()) throw new Error(`Unsupported file type: ${path}`);
  else if(tree==='dist'&&!distFiles.has(path.slice('dist/'.length))) throw new Error(`Unexpected build artifact: ${path}`);
  else if(tree&&tree!=='dist'&&!allowedExtensions[tree].includes(extname(path))) throw new Error(`Unexpected source artifact: ${path}`);
  else if(tree==='src'&&extname(path)==='.json'&&path!=='src/manifest.json') throw new Error(`Unreviewed JSON source artifact: ${path}`);
}
for(const tree of [...sourceTrees,'dist']) await inspectExport(tree,tree);
for(const file of sourceRootFiles) await inspectExport(file);
// docs/ is never packaged; private or unexpected files there still stop packaging.
let hasDocs=true;
try { await access('docs'); } catch { hasDocs=false; }
if(hasDocs) await inspectExport('docs','docs');
for(const file of ['.test-results/extension-dashboard-page.png']) await inspectExport(file);
const notices=[];
for(const [name,files] of [['echarts',['LICENSE','NOTICE']],['zrender',['LICENSE']],['tslib',['LICENSE.txt']]]) {
  const pkg=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8'));
  notices.push(`${name} ${pkg.version}\n${'='.repeat(60)}`);
  for(const file of files)notices.push(await readFile(`node_modules/${name}/${file}`,'utf8'));
}
await writeFile('THIRD_PARTY_NOTICES.txt',notices.join('\n\n'));
await cp('THIRD_PARTY_NOTICES.txt','dist/THIRD_PARTY_NOTICES.txt');
await cp('LICENSE','dist/LICENSE');
await cp('PRIVACY.md','dist/PRIVACY.md');
await mkdir('release',{recursive:true});
await rm('release/.staging',{recursive:true,force:true});
await mkdir('release/.staging/binom-dashboard',{recursive:true});
await cp('dist','release/.staging/binom-dashboard',{recursive:true});
await cp('README.md','release/.staging/README.md');
await cp('PRIVACY.md','release/.staging/PRIVACY.md');
await cp('CHANGELOG.md','release/.staging/CHANGELOG.md');
// Include readable sources alongside the built extension so document links work
// in either archive. Only binom-dashboard/ is loaded into Chrome.
for(const tree of sourceTrees) await cp(tree,`release/.staging/${tree}`,{recursive:true,filter:path=>!path.endsWith('demo/demo.bundle.js')});
for(const file of ['package.json','package-lock.json','.gitignore','LICENSE','THIRD_PARTY_NOTICES.txt']) await cp(file,`release/.staging/${file}`);
await cp('.test-results/extension-dashboard-page.png','release/.staging/preview.png');
await cp('.test-results/extension-dashboard-page.png','preview.png');
execFileSync('/usr/bin/zip',['-X','-q','-r',resolve('release',binary),...sourceRootFiles,...sourceTrees,'binom-dashboard'],{cwd:'release/.staging'});
await rm('release/.staging',{recursive:true,force:true});
execFileSync('/usr/bin/zip',['-X','-q','-r',resolve('release',source),...sourceTrees,...sourceRootFiles,'-x','demo/demo.bundle.js']);
const hashes=[];for(const file of [binary,source])hashes.push(`${createHash('sha256').update(await readFile(`release/${file}`)).digest('hex')}  ${file}`);
await writeFile('release/SHA256SUMS.txt',hashes.join('\n')+'\n');
console.log(`Packaged release/${binary} and release/${source}`);
