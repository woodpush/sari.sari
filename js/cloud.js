// cloud.js — backs up the store data to a PRIVATE GitHub repository.
//
// Every backup is a Git commit, so GitHub keeps every earlier version. Even if a
// backup file is deleted, it can be brought back from the repository's history.
//
// Files written:
//   backups/latest.json        always the newest backup
//   backups/YYYY-MM-DD.json    one per day (the day's last backup)

const API = 'https://api.github.com';

function headers(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function explain(res) {
  if (res.status === 401) return 'GitHub rejected the token. It may be wrong or expired — create a new one.';
  if (res.status === 403) return 'The token is not allowed to write to this repository. Give it "Contents: Read and write".';
  if (res.status === 404) return 'Repository not found. Check the name (owner/repo) and that the token can access it.';
  let msg = '';
  try { msg = (await res.json()).message || ''; } catch { /* no body */ }
  return `GitHub error ${res.status}${msg ? ': ' + msg : ''}`;
}

async function call(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('Could not reach GitHub. Check the internet connection and try again.');
  }
  return res;
}

// UTF-8 text -> base64 without blowing the call stack on big backups.
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function parseRepo(value) {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(value || '');
  return m ? `${m[1]}/${m[2]}` : null;
}

// Checks the token and repository. Refuses public repositories.
export async function testConnection({ repo, token }) {
  const res = await call(`${API}/repos/${repo}`, { headers: headers(token) });
  if (!res.ok) throw new Error(await explain(res));
  const info = await res.json();
  if (!info.private) {
    throw new Error('This repository is PUBLIC, so anyone could see your sales and prices. ' +
      'Make it private (Settings → General → Danger Zone → Change visibility) or use a new private repository.');
  }
  if (info.permissions && info.permissions.push === false) {
    throw new Error('The token can read but not write. Give it "Contents: Read and write".');
  }
  return { name: info.full_name, branch: info.default_branch };
}

async function currentSha({ repo, token }, path) {
  const res = await call(`${API}/repos/${repo}/contents/${path}`, { headers: headers(token) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await explain(res));
  return (await res.json()).sha;
}

async function putFile(cfg, path, content, message) {
  const body = { message, content };
  const sha = await currentSha(cfg, path);
  if (sha) body.sha = sha;
  const res = await call(`${API}/repos/${cfg.repo}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers(cfg.token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await explain(res));
}

function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export async function backup(cfg, data) {
  const text = JSON.stringify(data);
  const content = toBase64(text);
  const when = new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' });
  const msg = `Backup ${when}: ${data.summary.items} items, ${data.summary.sales} sales`;
  await putFile(cfg, 'backups/latest.json', content, msg);
  await putFile(cfg, `backups/${localDay()}.json`, content, msg);
  return { bytes: text.length };
}

// Newest first. Each entry: { name, path, size }
export async function listBackups(cfg) {
  const res = await call(`${API}/repos/${cfg.repo}/contents/backups`, { headers: headers(cfg.token) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(await explain(res));
  const files = (await res.json()).filter((f) => f.type === 'file' && f.name.endsWith('.json'));
  return files
    .map((f) => ({ name: f.name.replace('.json', ''), path: f.path, size: f.size }))
    .sort((a, b) => (a.name === 'latest' ? -1 : b.name === 'latest' ? 1 : b.name.localeCompare(a.name)));
}

export async function download(cfg, path) {
  const res = await call(`${API}/repos/${cfg.repo}/contents/${path}`, {
    headers: headers(cfg.token, 'application/vnd.github.raw+json'),
  });
  if (!res.ok) throw new Error(await explain(res));
  return res.json();
}
