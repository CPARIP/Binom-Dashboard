import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { COMMIT_EMAIL, TRACE_RULE_FILES, findTraces, isBinary, isProse } from './traces.mjs';

// Structural checks plus a scan for traces of the author's machine. They cannot
// verify prose freshness or the absence of secrets.
const root = process.cwd();
const required = ['README.md', 'PRIVACY.md', 'CHANGELOG.md'];
const errors = [];
for (const file of required) {
  try { await access(file); }
  catch { errors.push(`Missing required document: ${file}`); }
}
async function markdownFiles(dir) {
  const files = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return files; }
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (entry.isFile() && path.endsWith('.md')) files.push(path);
  }
  return files;
}
// What Git would commit: tracked and new files that are not ignored; null outside a work tree.
function committedFiles() {
  try { return new Set(execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean)); }
  catch { return null; }
}
const committed = committedFiles();
const isCommitted = path => committed.has(path) || [...committed].some(file => file.startsWith(`${path}/`));
const files = [...(await readdir('.')).filter(name => name.endsWith('.md')), ...await markdownFiles('docs')];
for (const file of files) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch { continue; }
  // Check file targets, not web availability or heading anchors. Code examples
  // are deliberately ignored; keep maintained prose links in standard Markdown.
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#')) continue;
    let path;
    try { path = decodeURIComponent(target.split(/[?#]/, 1)[0]); }
    catch { errors.push(`${file}: malformed link ${target}`); continue; }
    const absolute = resolve(dirname(resolve(file)), path);
    const rel = relative(root, absolute);
    if (rel === '..' || rel.startsWith(`..${sep}`) || path.startsWith('/')) {
      errors.push(`${file}: non-portable local link ${target}`);
      continue;
    }
    try { await access(absolute); }
    catch { errors.push(`${file}: broken local link ${target}`); continue; }
    // A published file must not point at a local-only file: the link would break for readers.
    if (committed?.has(file) && !isCommitted(rel.split(sep).join('/'))) errors.push(`${file}: link to a file that is not published ${target}`);
  }
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const manifest = JSON.parse(await readFile('src/manifest.json', 'utf8'));
for (const [name, version] of [['lock root', lock.version], ['lock package', lock.packages?.['']?.version], ['manifest', manifest.version]]) {
  if (version !== pkg.version) errors.push(`Version mismatch: ${name} ${version} vs package ${pkg.version}`);
}
// Nothing about the author's computer may enter Git or a package; the rules
// live in traces.mjs and are shared with the pre-push check.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', '.test-results', '.npm-cache', '.local', 'browser-profiles', 'playwright-report']);
const SKIP_FILES = new Set(['LOCAL_CONTEXT.md', 'demo/demo.bundle.js']);
async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = dir === '.' ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) found.push(...await walk(path)); }
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
async function projectFiles() {
  // What Git would commit; a plain walk where Git is absent (for example, an unpacked archive).
  return committed ? [...committed] : walk('.');
}
// Commits are signed with the project's public address, never a personal one.
// Only inside a work tree: outside it Git would report a global identity instead.
try {
  const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (git(['rev-parse', '--is-inside-work-tree']) === 'true' && git(['config', 'user.email']) !== COMMIT_EMAIL) {
    errors.push(`Git would sign commits with another address; run: git config --local user.email ${COMMIT_EMAIL}`);
  }
} catch { /* No Git or no identity configured: nothing can be signed. */ }
let scanned = 0;
for (const file of await projectFiles()) {
  if (SKIP_FILES.has(file) || isBinary(file) || file.split('/').some(part => SKIP_DIRS.has(part))) continue;
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  scanned++;
  for (const { line, label } of findTraces(text, { prose: isProse(file), rules: TRACE_RULE_FILES.has(file) })) {
    errors.push(`${file}:${line}: ${label}; keep such details out of published files`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed: ${files.length} Markdown files, local link targets, required documents, runtime version ${pkg.version}, no machine traces in ${scanned} project files.`);
  console.log('Freshness, historical claims and sensitive content still require review.');
}
