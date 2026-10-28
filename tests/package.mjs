import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, readFile, writeFile, rm, readdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root=process.cwd();
const digest=b=>createHash('sha256').update(b).digest('hex');
async function releaseHashes(dir) {
  const hashes={};
  let entries;
  try { entries=await readdir(join(dir,'release')); }
  catch(error) { if(error.code==='ENOENT') return hashes; throw error; }
  for(const name of entries) if(name.endsWith('.zip')||name==='SHA256SUMS.txt') hashes[name]=digest(await readFile(join(dir,'release',name)));
  return hashes;
}
const before=await releaseHashes(root);
const temp=await mkdtemp(join(tmpdir(),'binom-docs-package-'));
// The copy holds only the published project, as a fresh clone would.
const roots=['src','tests','scripts','demo','dist','package.json','package-lock.json','.gitignore','README.md','PRIVACY.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.txt','preview.png'];
// Scenarios below place files under docs/, which is never packaged.
await mkdir(join(temp,'docs'),{recursive:true});
for(const name of roots) await cp(join(root,name),join(temp,name),{recursive:true});
await mkdir(join(temp,'.test-results'),{recursive:true});
for(const name of ['extension-dashboard-page.png']) await cp(join(root,'.test-results',name),join(temp,'.test-results',name));
for(const [name,files] of [['echarts',['package.json','LICENSE','NOTICE']],['zrender',['package.json','LICENSE']],['tslib',['package.json','LICENSE.txt']]]) {
  await mkdir(join(temp,'node_modules',name),{recursive:true});
  for(const file of files) await cp(join(root,'node_modules',name,file),join(temp,'node_modules',name,file));
}
const records=[];
function run(cwd,file) { return spawnSync(process.execPath,[file],{cwd,encoding:'utf8',timeout:30000,maxBuffer:2_000_000}); }
function expect(result,ok,pattern,label) {
  assert.equal(result.status===0,ok,`${label}: ${result.stdout}\n${result.stderr}`);
  if(pattern) assert.match(result.stdout+result.stderr,pattern,label);
  records.push(label);
}
expect(run(temp,'scripts/check-docs.mjs'),true,/passed/,'Clean documentation passes');
const readmePath=join(temp,'README.md');
const readme=await readFile(readmePath,'utf8');
await writeFile(readmePath,readme+'\n[broken](does-not-exist.md)\n');
expect(run(temp,'scripts/check-docs.mjs'),false,/broken local link/,'Broken documentation link fails');
// A path of the author's machine must never pass; the probe is assembled so that this file holds none.
await writeFile(readmePath,readme+'\nBuilt in '+['','tmp','example'].join('/')+'.\n');
expect(run(temp,'scripts/check-docs.mjs'),false,/temporary directory path/,'Machine trace in documentation fails');
// Internal identifiers must not be published.
await writeFile(readmePath,readme+'\nFixed in '+['UI','001'].join('-')+'.\n');
expect(run(temp,'scripts/check-docs.mjs'),false,/internal identifier/,'Internal identifier in documentation fails');
await writeFile(readmePath,readme);
const changelogPath=join(temp,'CHANGELOG.md');
const changelog=await readFile(changelogPath);
await rm(changelogPath);
expect(run(temp,'scripts/check-docs.mjs'),false,/Missing required document/,'Missing changelog fails');
await writeFile(changelogPath,changelog);
const manifestPath=join(temp,'dist/manifest.json');
const manifest=await readFile(manifestPath,'utf8');
await writeFile(manifestPath,JSON.stringify({...JSON.parse(manifest),version:'0.0.0'}));
expect(run(temp,'scripts/package.mjs'),false,/Build dist/,'Mismatched build version fails before packaging');
await writeFile(manifestPath,manifest);
for(const file of ['docs/binom-openapi.json','src/.env','tests/capture.har']) {
  await writeFile(join(temp,file),'synthetic-private-file-marker');
  expect(run(temp,'scripts/package.mjs'),false,/Private or diagnostic/,'Refuses '+file);
  await rm(join(temp,file));
}
await writeFile(join(temp,'docs/unreviewed.html'),'<p>Synthetic unreviewed document</p>');
expect(run(temp,'scripts/package.mjs'),false,/Unexpected source artifact/,'Unreviewed HTML remains refused');
await rm(join(temp,'docs/unreviewed.html'));
const outside=join(temp,'external.txt');
await writeFile(outside,'Synthetic external symlink target');
await symlink(outside,join(temp,'docs/external.md'));
expect(run(temp,'scripts/package.mjs'),false,/Symlink must not be packaged/,'Symlink refused');
await rm(join(temp,'docs/external.md'));
await assert.rejects(access(join(temp,'release')),'Preflight failures must not create release directory');
await writeFile(join(temp,'LOCAL_CONTEXT.md'),'LOCAL-NOTES-SYNTHETIC-MARKER');
// Stray Markdown files next to the project are never packaged.
await writeFile(join(temp,'probe.md'),'# Synthetic probe\n');
await writeFile(join(temp,'docs/probe.md'),'# Synthetic probe\n');
await writeFile(join(temp,'.env'),'PRIVATE-SYNTHETIC-MARKER');
expect(run(temp,'scripts/package.mjs'),true,/Packaged/,'Full packaging succeeds in isolated copy');
const fresh=await releaseHashes(temp);
for(const filename of Object.keys(fresh).filter(name=>name.endsWith('.zip'))) {
  const archive=join(temp,'release',filename);
  const listed=spawnSync('/usr/bin/unzip',['-Z1',archive],{encoding:'utf8'});
  assert.equal(listed.status,0);
  const files=listed.stdout.trim().split('\n');
  for(const name of ['README.md','PRIVACY.md','CHANGELOG.md','src/manifest.json','scripts/check-docs.mjs','scripts/traces.mjs']) assert.ok(files.includes(name),filename+' missing '+name);
  assert.deepEqual(files.filter(name=>/^[^/]+\.md$/.test(name)).sort(),['CHANGELOG.md','PRIVACY.md','README.md'],'Only the published documents are packaged');
  assert.ok(!files.some(name=>name.startsWith('docs/')),'Nothing under docs/ is packaged');
  assert.ok(!files.some(name=>/(^|\/)(LOCAL_CONTEXT.md|\.env|node_modules|\.git)(\/|$)|demo\/demo.bundle.js/.test(name)),'Private/generated files excluded');
  const unpacked=join(temp,filename.replace('.zip',''));
  await mkdir(unpacked);
  const unzip=spawnSync('/usr/bin/unzip',['-q',archive,'-d',unpacked],{encoding:'utf8'});
  assert.equal(unzip.status,0);
  expect(run(unpacked,'scripts/check-docs.mjs'),true,/passed/,'Extracted '+filename+' documentation is portable');
}
expect(run(temp,'scripts/package.mjs'),false,/Release already exists/,'Repeat packaging refuses old version');
assert.deepEqual(await releaseHashes(temp),fresh,'Failed repeat must preserve archives and checksum file');
const version=JSON.parse(await readFile('package.json','utf8')).version;
if(before[`binom-dashboard-${version}.zip`]||before[`binom-dashboard-${version}-source.zip`]) expect(run(root,'scripts/package.mjs'),false,/Release already exists/,'Original released version refuses overwrite');
assert.deepEqual(await releaseHashes(root),before,'Original ZIPs and SHA256SUMS unchanged');
records.push(`All ${Object.keys(before).filter(name=>name.endsWith('.zip')).length} original release archives and any SHA256SUMS remain byte-identical`);
await writeFile(join(root,'.test-results/documentation-check.json'),JSON.stringify({date:new Date().toISOString(),temp,checks:records,originalArchives:before,temporaryArchives:fresh},null,2)+'\n');
console.log(JSON.stringify({passed:records.length,checks:records,temporaryPackage:temp},null,2));
