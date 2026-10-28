import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { COMMIT_EMAIL, findTraces } from '../scripts/traces.mjs';

// Probes are assembled at run time so that this file itself holds no trace.
const path = (...parts) => ['', ...parts].join('/');
const checkPush = resolve('scripts/check-push.mjs');

test('Traces of the author computer are found; product OS names in code are not', () => {
  const labels = text => findTraces(text, { prose: true }).map(found => found.label);
  assert.deepEqual(labels(`Built in ${path('Users', 'someone', 'project')}`), ['home directory path']);
  assert.deepEqual(labels(`Saved to ${path('tmp', 'report.json')}`), ['temporary directory path']);
  assert.ok(labels('Checked on Linux with Node 1.2.3').includes('author operating system'));
  assert.ok(labels('Checked with Node 1.2.3').includes('author tool versions'));
  // The running Node.js version is this machine's own detail: caught in code too.
  assert.ok(findTraces(`const runtime = 'node ${process.versions.node}';`).map(found => found.label).includes('this machine\'s Node.js version'));
  assert.ok(labels(`Built in ${homedir()}`).includes('this machine\'s home directory'));
  assert.deepEqual(findTraces("if (/^windows/.test(value)) return 'os-icon';"), [], 'Visitor OS names are product data in code');
  assert.deepEqual(findTraces('const rule = /Linux/;', { rules: true }), [], 'Rules files are checked only for this machine');
  assert.deepEqual(labels(`Signed by ${COMMIT_EMAIL}, version 0.6.12, see README.md`), []);
});

test('The pre-push check passes clean commits and blocks traces and other signers', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'binom-push-check-'));
  try {
    const git = (args, email = COMMIT_EMAIL) => execFileSync('git', ['-c', 'user.name=Test', '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    const push = (from = '') => {
      const head = git(['rev-parse', 'HEAD']);
      const base = from || '0'.repeat(40);
      return spawnSync(process.execPath, [checkPush, '--hook', 'origin'], { cwd: repo, encoding: 'utf8', input: `refs/heads/main ${head} refs/heads/main ${base}\n` });
    };
    const commit = async (file, text, message = 'Synthetic change', email = COMMIT_EMAIL) => {
      await writeFile(join(repo, file), text);
      git(['add', file]); git(['commit', '-q', '-m', message], email);
      return git(['rev-parse', 'HEAD']);
    };
    git(['init', '-q', '-b', 'main']);
    const clean = await commit('README.md', 'Synthetic project\n');
    let result = push();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Push check passed/);

    await commit('NOTES.md', `Built in ${path('tmp', 'build')}\n`);
    result = push(clean);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /NOTES\.md:1: temporary directory path/);

    git(['reset', '-q', '--hard', clean]);
    await commit('NOTES.md', 'Clean notes\n', 'Checked on Linux');
    result = push(clean);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /message line 1: author operating system/);

    git(['reset', '-q', '--hard', clean]);
    await commit('NOTES.md', 'Clean notes\n', 'Clean message\n\nCo-Authored-By: Someone <someone@example.com>');
    result = push(clean);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /co-author line/);

    git(['reset', '-q', '--hard', clean]);
    await commit('NOTES.md', 'Clean notes\n', 'Clean message', 'someone@example.com');
    result = push(clean);
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`author is not ${COMMIT_EMAIL.replace('.', '\\.')}`));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
