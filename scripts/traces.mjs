// Shared rules for traces of the author's computer, used by docs:check and by
// the pre-push check. Nothing about the author's machine may enter Git, a commit or a
// package: home or temporary paths, user or computer names, operating system details,
// local tool versions or a personal e-mail. This machine's own identifiers are read at
// run time, so they are never written into the repository.
import { extname } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';

/** The only address commits may be signed with. */
export const COMMIT_EMAIL = 'admin@cpa.rip';
/** Files that hold the patterns themselves: only this machine's identifiers are checked there. */
export const TRACE_RULE_FILES = new Set(['scripts/traces.mjs', 'scripts/check-docs.mjs']);

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.woff', '.woff2']);
const PROSE = new Set(['.md', '.html', '.txt']);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// [pattern, label, prose only]: OS names and versions are product data in code
// (visitor OS icons), but in prose they describe the author's machine.
const GENERIC = [
  [/(?:^|[\s`'"(=])\/Users\/[^\s/`'")]+|(?:^|[\s`'"(=])\/home\/[^\s/`'")]+|[A-Za-z]:\\Users\\/, 'home directory path'],
  [/~\/(?:Documents|Desktop|Downloads|Library|Projects)\b/, 'home directory path'],
  [/\/private\/(?:tmp|var)\/|\/var\/folders\/|(?:^|[\s`'"(=])\/tmp\//, 'temporary directory path'],
  [/\bscratchpad\b/i, 'agent scratch directory'],
  [/\bmacOS\b|\bMac ?OS\b|\bMacBook\b|\bXcode\b|\bHomebrew\b|\/opt\/homebrew|\bWindows\b|\bLinux\b|\bUbuntu\b|\bDebian\b|\bFedora\b|\bWSL\b/, 'author operating system', true],
  [/(?<!\p{L})(?:[Мм]ак(?:а|е|ом|у|и|ов)?|[Мм]акбук\p{L}*|Mac)(?!\p{L})/u, 'author operating system', true],
  [/\b(?:Node(?:\.js)?|npm|[Gg]it|[Pp]ython3?) v?\d+\.\d+\.\d+|\bChromium \d{3}\b/, 'author tool versions', true],
  [/@icloud\.com\b/i, 'personal e-mail'],
  // Internal identifiers must not reach published files.
  [/(?<![A-Za-z0-9])(?:D|BUG|UI|DOC)-\d{3}(?!\d)/, 'internal identifier'],
];

const MACHINE = [];
try {
  const home = homedir(), user = userInfo().username, host = hostname().replace(/\.local$/i, '').split('.')[0];
  if (home && home.length > 1) MACHINE.push([new RegExp(escape(home)), 'this machine\'s home directory']);
  if (user && user.length >= 3) MACHINE.push([new RegExp(`[/\\\\]${escape(user)}(?=[/\\\\\\s\`'"]|$)|(?<![\\w.])${escape(user)}@`, 'i'), 'this machine\'s user name']);
  const node = process.versions?.node;
  if (node) MACHINE.push([new RegExp(`node[^\\n]{0,20}?(?<![\\d.])${escape(node)}(?![\\d.])`, 'i'), 'this machine\'s Node.js version']);
  if (host && host.length >= 6 && host.toLowerCase() !== 'localhost') MACHINE.push([new RegExp(`(?<![\\w-])${escape(host)}(?![\\w-])`, 'i'), 'this machine\'s name']);
} catch { /* Without OS details the generic patterns still apply. */ }

export const isBinary = file => BINARY.has(extname(file).toLowerCase());
export const isProse = file => PROSE.has(extname(file).toLowerCase());

/** Lines of `text` that carry a trace: [{ line, label }]. Prose also gets OS and version
 * rules; a rules file gets only this machine's identifiers. */
export function findTraces(text, { prose = false, rules = false } = {}) {
  const patterns = rules ? MACHINE : [...GENERIC, ...MACHINE];
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const [pattern, label, proseOnly] of patterns) {
      if ((!proseOnly || prose) && pattern.test(line)) found.push({ line: index + 1, label });
    }
  });
  return found;
}
