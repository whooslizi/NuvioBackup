import { CATEGORIES, DEFAULT_SERVER, BACKUP_FORMAT, login, pullProfile, parseBackup, freeIndices, toProfilePayload } from './nuvio.js';

const $ = s => document.querySelector(s);
const src = { api: null, backup: null, profiles: [], cache: new Map() };
const tgt = { api: null, profiles: [] };

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function log(line) {
  $('#progress').hidden = false;
  $('#log').textContent += line + '\n';
  $('#log').scrollTop = 1e9;
}

const profileLabel = p => `${p.name || 'Profile'} (#${p.profile_index})`;

for (const f of document.querySelectorAll('form')) f.server.value = DEFAULT_SERVER;

// Source: tabs
for (const b of document.querySelectorAll('[data-tab]')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('[data-tab]')) x.setAttribute('aria-pressed', x === b);
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== b.dataset.tab;
  };
}

async function withBusy(button, errEl, fn) {
  button.disabled = true;
  errEl.textContent = '';
  try { await fn(); } catch (e) { errEl.textContent = e.message; log(`ERROR: ${e.message}`); } finally { button.disabled = false; }
}

$('#srcLogin').onsubmit = e => {
  e.preventDefault();
  const f = e.target;
  withBusy(f.querySelector('button'), $('#srcErr'), async () => {
    src.api = await login(f.server.value, f.email.value, f.password.value);
    f.password.value = '';
    src.backup = null;
    src.cache.clear();
    src.profiles = await src.api.profiles();
    showPicker(`Logged in as ${src.api.email}`, Object.keys(CATEGORIES));
  });
};

$('#srcFile').onchange = async e => {
  $('#srcErr').textContent = '';
  try {
    src.backup = parseBackup(await e.target.files[0].text());
    src.api = null;
    src.profiles = src.backup.profiles.map(p => p.profile);
    const cats = Object.keys(CATEGORIES).filter(c => src.backup.profiles.some(p => c in p.data));
    showPicker(`Backup of ${src.backup.source_email ?? 'unknown account'} from ${src.backup.exported_at}`, cats);
    $('#backupBtn').hidden = true;
  } catch (err) {
    $('#srcErr').textContent = err.message;
  }
};

function showPicker(who, cats) {
  $('#srcWho').textContent = who;
  $('#profiles').replaceChildren(...src.profiles.map(p =>
    el('label', {}, el('input', { type: 'checkbox', checked: true, value: p.profile_index }), ' ', profileLabel(p))));
  $('#cats').replaceChildren(...cats.map(c =>
    el('label', {}, el('input', { type: 'checkbox', checked: !CATEGORIES[c].secret, value: c }), ' ', CATEGORIES[c].label,
      CATEGORIES[c].secret ? el('span', { className: 'muted', textContent: ' — contains secrets' }) : '')));
  $('#pick').hidden = false;
  $('#backupBtn').hidden = false;
  $('#target').hidden = true;
}

const checked = sel => [...document.querySelectorAll(`${sel} input:checked`)].map(i => i.value);
const selectedProfiles = () => checked('#profiles').map(Number).map(i => src.profiles.find(p => p.profile_index === i));
const selectedCats = () => checked('#cats');

function requireSelection() {
  if (!selectedProfiles().length) throw new Error('Select at least one profile');
  if (!selectedCats().length) throw new Error('Select at least one thing to include');
}

async function sourceData(pid, cats) {
  if (src.backup) {
    const all = src.backup.profiles.find(p => p.profile.profile_index === pid).data;
    return Object.fromEntries(cats.filter(c => c in all).map(c => [c, all[c]]));
  }
  const cached = src.cache.get(pid) ?? {};
  const need = cats.filter(c => !(c in cached));
  if (need.length) {
    log(`Reading "${profileLabel(src.profiles.find(p => p.profile_index === pid))}" from ${src.api.email}`);
    Object.assign(cached, await pullProfile(src.api, pid, need, log));
    src.cache.set(pid, cached);
  }
  return Object.fromEntries(cats.map(c => [c, cached[c]]));
}

$('#backupBtn').onclick = e => withBusy(e.target, $('#srcErr'), async () => {
  requireSelection();
  const cats = selectedCats();
  const profiles = [];
  for (const p of selectedProfiles()) profiles.push({ profile: p, data: await sourceData(p.profile_index, cats) });
  const file = { format: BACKUP_FORMAT, version: 1, exported_at: new Date().toISOString(), source_email: src.api.email, profiles };
  const a = el('a', {
    href: URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })),
    download: `nuvio-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  log(`Backup saved (${profiles.length} profile(s)).${cats.some(c => CATEGORIES[c].secret) ? ' It contains API keys — keep it private.' : ''}`);
});

$('#toTargetBtn').onclick = () => {
  try { requireSelection(); } catch (e) { $('#srcErr').textContent = e.message; return; }
  $('#srcErr').textContent = '';
  $('#target').hidden = false;
  if (tgt.api) renderMapping();
  $('#target').scrollIntoView({ behavior: 'smooth' });
};

$('#tgtLogin').onsubmit = e => {
  e.preventDefault();
  const f = e.target;
  withBusy(f.querySelector('button'), $('#tgtErr'), async () => {
    tgt.api = await login(f.server.value, f.email.value, f.password.value);
    f.password.value = '';
    if (src.api && tgt.api.url === src.api.url && tgt.api.email === src.api.email) {
      tgt.api = null;
      throw new Error('Destination is the same account as the source');
    }
    tgt.profiles = await tgt.api.profiles();
    renderMapping();
  });
};

function renderMapping() {
  $('#tgtWho').textContent = `Logged in as ${tgt.api.email}`;
  $('#maps').replaceChildren(...selectedProfiles().map(p => {
    const same = tgt.profiles.find(t => t.name.trim().toLowerCase() === (p.name ?? '').trim().toLowerCase());
    const select = el('select', { 'aria-label': `Destination for ${profileLabel(p)}` },
      ...tgt.profiles.map(t => el('option', { value: t.profile_index, textContent: `Merge into ${profileLabel(t)}`, selected: t === same })),
      el('option', { value: 'new', textContent: 'Create as new profile', selected: !same }));
    select.dataset.src = p.profile_index;
    return el('div', { className: 'map' }, el('span', { textContent: profileLabel(p) }), el('span', { textContent: '→' }), select);
  }));
  $('#mapping').hidden = false;
}

$('#runBtn').onclick = e => withBusy(e.target, $('#tgtErr'), async () => {
  requireSelection();
  const cats = selectedCats();
  const plan = [...document.querySelectorAll('#maps select')].map(s => ({
    from: src.profiles.find(p => p.profile_index === Number(s.dataset.src)),
    to: s.value === 'new' ? null : Number(s.value),
  }));

  const fresh = plan.filter(m => m.to === null);
  if (fresh.length) {
    const idx = freeIndices(tgt.profiles.map(p => p.profile_index), fresh.length);
    fresh.forEach((m, i) => { m.to = idx[i]; });
    log(`Creating ${fresh.length} new profile(s) on ${tgt.api.email}`);
    await tgt.api.pushProfiles([...tgt.profiles, ...fresh.map(m => toProfilePayload({ ...m.from, profile_index: m.to }))]);
    tgt.profiles = await tgt.api.profiles();
  }

  let failures = 0;
  for (const { from, to } of plan) {
    const data = await sourceData(from.profile_index, cats);
    log(`Writing "${profileLabel(from)}" → profile #${to}`);
    for (const c of cats.filter(c => data[c] != null)) {
      try {
        const current = await CATEGORIES[c].pull(tgt.api, to);
        const n = await CATEGORIES[c].push(tgt.api, to, data[c], current);
        log(`  ${CATEGORIES[c].label}: ${n} added/updated`);
      } catch (err) {
        failures++;
        log(`  ${CATEGORIES[c].label}: FAILED — ${err.message}`);
      }
    }
  }
  log(failures ? `Finished with ${failures} failure(s). Re-running is safe: it only adds what is still missing.` : 'Done. Open Nuvio on the destination account to see everything.');
  renderMapping();
});
