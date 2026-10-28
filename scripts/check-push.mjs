// Pre-push check: every commit about to leave this machine must carry no trace of
// the author's computer. Checked for each commit: author and committer address, message
// and every file in its tree (each file version once). Also checked: annotated tags.
// As a Git hook (--hook) it reads "<local ref> <local sha> <remote ref> <remote sha>" lines
// from stdin; by hand it checks the whole history of the current branch. Usage:
//   node scripts/check-push.mjs   (npm run check:push)
import { execFileSync } from 'node:child_process';
import { COMMIT_EMAIL, TRACE_RULE_FILES, findTraces, isBinary, isProse } from './traces.mjs';

const hook = process.argv[2] === '--hook';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
const lines = text => text.split('\n').filter(Boolean);
const ZERO = /^0+$/;

let input = '';
// Only Git feeds stdin; a manual run must not wait for input that never comes.
if (hook) for await (const chunk of process.stdin) input += chunk;
const updates = lines(input).map(line => line.split(' ')).filter(([, localSha]) => localSha && !ZERO.test(localSha));
if (!lines(input).length) updates.push(['HEAD', git(['rev-parse', 'HEAD']).trim(), '', '0']);

function commitsToPush(localSha, remoteSha) {
  // A known remote tip narrows the check to the new commits. A branch the remote does not
  // have yet gets its whole history checked: local remote-tracking refs may be stale (for
  // example, after the remote repository was recreated).
  if (!ZERO.test(remoteSha)) { try { return lines(git(['rev-list', `${remoteSha}..${localSha}`])); } catch { /* unknown tip */ } }
  return lines(git(['rev-list', localSha]));
}

const errors = [], checkedCommits = new Set(), checkedBlobs = new Set();
const signer = (where, role, email) => { if (email !== COMMIT_EMAIL) errors.push(`${where}: ${role} is not ${COMMIT_EMAIL}`); };
const prose = (where, text) => { for (const { line, label } of findTraces(text, { prose: true })) errors.push(`${where} line ${line}: ${label}`); };
// Commits carry one signature only: no co-author lines.
const coAuthors = (where, text) => { if (/^co-authored-by:/im.test(text)) errors.push(`${where}: co-author line; commits are signed ${COMMIT_EMAIL} only`); };

for (const [localRef, localSha, , remoteSha] of updates) {
  if (localRef.startsWith('refs/tags/') && git(['cat-file', '-t', localSha]).trim() === 'tag') {
    const tag = git(['cat-file', '-p', localSha]), tagger = /^tagger .*<([^>]*)>/m.exec(tag);
    signer(localRef, 'tagger', tagger?.[1]);
    prose(`${localRef} message`, tag.slice(tag.indexOf('\n\n') + 2));
  }
  for (const commit of commitsToPush(`${localSha}^{commit}`, remoteSha)) {
    if (checkedCommits.has(commit)) continue;
    checkedCommits.add(commit);
    const short = commit.slice(0, 7);
    const [author, committer] = lines(git(['show', '-s', '--format=%ae%n%ce', commit]));
    signer(short, 'author', author); signer(short, 'committer', committer);
    const message = git(['show', '-s', '--format=%B', commit]);
    prose(`${short} message`, message); coAuthors(`${short} message`, message);
    for (const entry of git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
      const [meta, file] = entry.split('\t'), [, type, blob] = meta.split(' ');
      if (type !== 'blob' || checkedBlobs.has(blob) || isBinary(file)) continue;
      checkedBlobs.add(blob);
      const text = git(['cat-file', 'blob', blob]);
      if (text.includes('\0')) continue;
      for (const { line, label } of findTraces(text, { prose: isProse(file), rules: TRACE_RULE_FILES.has(file) })) errors.push(`${short} ${file}:${line}: ${label}`);
    }
  }
}

if (errors.length) {
  console.error(`Push blocked: traces of the author's computer or a wrong signature.\n${errors.join('\n')}`);
  console.error('Fix the commits (amend or rewrite them before they leave this machine), then push again.');
  process.exitCode = 1;
} else {
  console.log(`Push check passed: ${checkedCommits.size} commit(s), ${checkedBlobs.size} file version(s), signed ${COMMIT_EMAIL}.`);
}
