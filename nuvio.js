// Nuvio sync API client + per-category pull/push/merge.
// RPC names and payload shapes mirror tapframe/NuvioStreaming composeApp sync adapters.

export const DEFAULT_SERVER = 'api.nuvio.tv';
const PAGE = 500;
const ORIGIN_CLIENT_ID = crypto.randomUUID();

export async function discover(server) {
  const base = (server.includes('://') ? server : `https://${server}`).replace(/\/+$/, '');
  const res = await fetch(`${base}/.well-known/nuvio`);
  if (!res.ok) throw new Error(`Server discovery failed (${res.status})`);
  const doc = await res.json();
  if (doc.service !== 'nuvio') throw new Error('Not a Nuvio server');
  return { url: doc.backend_url.replace(/\/+$/, ''), key: doc.publishable_key };
}

// shortcut: no token refresh (Supabase access tokens last ~1h), re-login if a huge transfer outlives it.
export async function login(server, email, password) {
  const { url, key } = await discover(server);
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || body.msg || `Login failed (${res.status})`);
  return new Api(url, key, body.access_token, body.user?.email ?? email);
}

export class Api {
  constructor(url, key, token, email) {
    Object.assign(this, { url, key, token, email });
  }

  async req(path, init = {}) {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: { apikey: this.key, Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  rpc(name, params = {}) {
    return this.req(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(params) });
  }

  push(name, params) {
    return this.rpc(name, { ...params, p_origin_client_id: ORIGIN_CLIENT_ID });
  }

  table(name, profileId) {
    return this.req(`/rest/v1/${name}?select=url,name,enabled,sort_order&profile_id=eq.${profileId}&order=sort_order.asc`);
  }

  profiles() {
    return this.rpc('sync_pull_profiles');
  }

  // sync_push_profiles takes the full list, so pass existing + new.
  pushProfiles(profiles) {
    return this.push('sync_push_profiles', { p_client_max_profiles: MAX_PROFILES, p_profiles: profiles.map(toProfilePayload) });
  }
}

export const MAX_PROFILES = 6;

export const toProfilePayload = p => ({
  profile_index: p.profile_index,
  name: p.name,
  avatar_color_hex: p.avatar_color_hex ?? '#1E88E5',
  uses_primary_addons: !!p.uses_primary_addons,
  uses_primary_plugins: !!p.uses_primary_plugins,
  avatar_id: p.avatar_id ?? null,
  avatar_url: p.avatar_url ?? null,
  profile_background_id: p.profile_background_id ?? null,
  profile_background_url: p.profile_background_url ?? null,
});

// Lowest free indices in 1..MAX_PROFILES, in order.
export function freeIndices(used, count) {
  const out = [];
  for (let i = 1; i <= MAX_PROFILES && out.length < count; i++) if (!used.includes(i)) out.push(i);
  if (out.length < count) throw new Error(`Target account has no room for ${count} new profile(s) (max ${MAX_PROFILES})`);
  return out;
}

async function pages(fetchPage) {
  const all = [];
  for (let n = 0; ; n++) {
    const page = await fetchPage(n);
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += PAGE) await fn(items.slice(i, i + PAGE));
}

// Target keeps everything it has; source adds what target lacks.
export function mergeList(target, source, keyFn) {
  const seen = new Set((target ?? []).map(keyFn));
  const added = (source ?? []).filter(x => !seen.has(keyFn(x)) && seen.add(keyFn(x)));
  return [...(target ?? []), ...added];
}

export const missing = (target, source, keyFn) => mergeList(target, source, keyFn).slice((target ?? []).length);

export const keys = {
  url: x => x.url.replace(/\/manifest\.json$/, ''),
  watched: x => `${x.content_id}|${x.season ?? ''}|${x.episode ?? ''}`,
  progress: x => x.progress_key || `${x.content_id}|${x.video_id}`,
  library: x => `${x.content_type}|${x.content_id}`,
  server: x => `${x.provider_id}|${x.remote_server_id}|${x.remote_user_id}`,
};

// Progress the target lacks, or where the source was watched more recently.
export function newerProgress(target, source) {
  const t = new Map((target ?? []).map(x => [keys.progress(x), x]));
  return (source ?? []).filter(x => !t.has(keys.progress(x)) || x.last_watched > t.get(keys.progress(x)).last_watched);
}

const reorder = list => list.map(({ url, name, enabled }, i) => ({ url, name: name ?? '', enabled: enabled ?? true, sort_order: i }));
const blob = async (api, fn, params) => (await api.rpc(fn, params))[0] ?? null;

// Each category: pull(api, pid) -> data, push(api, pid, source, target) -> count written.
export const CATEGORIES = {
  addons: {
    label: 'Addons',
    pull: (api, pid) => api.table('addons', pid),
    push: async (api, pid, src, tgt) => {
      const merged = mergeList(tgt, src, keys.url);
      if (merged.length > tgt.length) await api.push('sync_push_addons', { p_profile_id: pid, p_addons: reorder(merged) });
      return merged.length - tgt.length;
    },
  },
  plugins: {
    label: 'Plugins',
    // Missing on servers/builds without plugin support.
    pull: (api, pid) => api.table('plugins', pid).catch(() => []),
    push: async (api, pid, src, tgt) => {
      const merged = mergeList(tgt, src, keys.url);
      if (merged.length > tgt.length) await api.push('sync_push_plugins', { p_profile_id: pid, p_plugins: reorder(merged) });
      return merged.length - tgt.length;
    },
  },
  progress: {
    label: 'Continue watching (progress)',
    pull: (api, pid) => api.rpc('sync_pull_watch_progress', { p_profile_id: pid }),
    push: async (api, pid, src, tgt) => {
      const todo = newerProgress(tgt, src);
      await inBatches(todo, b => api.push('sync_push_watch_progress', { p_profile_id: pid, p_entries: b }));
      return todo.length;
    },
  },
  watched: {
    label: 'Watched history',
    pull: (api, pid) => pages(n => api.rpc('sync_pull_watched_items', { p_profile_id: pid, p_page: n + 1, p_page_size: PAGE })),
    push: async (api, pid, src, tgt) => {
      const todo = missing(tgt, src, keys.watched);
      await inBatches(todo, b => api.push('sync_push_watched_items', { p_profile_id: pid, p_items: b }));
      return todo.length;
    },
  },
  library: {
    label: 'Library',
    pull: (api, pid) => pages(n => api.rpc('sync_pull_library', { p_profile_id: pid, p_limit: PAGE, p_offset: n * PAGE })),
    push: async (api, pid, src, tgt) => {
      const todo = missing(tgt, src, keys.library);
      await inBatches(todo, b => api.push('sync_push_library_items', { p_profile_id: pid, p_items: b }));
      return todo.length;
    },
  },
  collections: {
    label: 'Collections',
    pull: async (api, pid) => (await blob(api, 'sync_pull_collections', { p_profile_id: pid }))?.collections_json ?? [],
    push: async (api, pid, src, tgt) => {
      const merged = mergeList(tgt, src, x => x.id);
      if (merged.length > tgt.length) await api.push('sync_push_collections', { p_profile_id: pid, p_collections_json: merged });
      return merged.length - tgt.length;
    },
  },
  settings: {
    label: 'App & home screen settings (replaces target’s)',
    pull: async (api, pid) => ({
      app: (await blob(api, 'sync_pull_profile_settings_blob', { p_profile_id: pid, p_platform: 'mobile' }))?.settings_json ?? null,
      home: (await blob(api, 'sync_pull_home_catalog_settings', { p_profile_id: pid, p_platform: 'home_catalog_shared' }))?.settings_json ?? null,
    }),
    push: async (api, pid, src) => {
      if (src.app) await api.push('sync_push_profile_settings_blob', { p_profile_id: pid, p_platform: 'mobile', p_settings_json: src.app });
      if (src.home) await api.push('sync_push_home_catalog_settings', { p_profile_id: pid, p_platform: 'home_catalog_shared', p_settings_json: src.home });
      return (src.app ? 1 : 0) + (src.home ? 1 : 0);
    },
  },
  credentials: {
    label: 'Debrid / provider API keys',
    secret: true,
    pull: async (api, pid) => (await api.rpc('sync_pull_provider_credentials', { p_profile_id: pid }))
      .map(({ provider, credential_json }) => ({ provider, credential_json })),
    push: async (api, pid, src, tgt) => {
      const merged = mergeList(tgt, src, x => x.provider);
      if (merged.length > tgt.length) await api.push('sync_push_provider_credentials', { p_profile_id: pid, p_credentials: merged });
      return merged.length - tgt.length;
    },
  },
  mediaServers: {
    label: 'Media servers (Plex/Jellyfin logins)',
    secret: true,
    pull: async (api, pid) => (await blob(api, 'sync_pull_media_servers', { p_profile_id: pid }))?.servers_json ?? [],
    push: async (api, pid, src, tgt) => {
      const merged = mergeList(tgt, src, keys.server);
      if (merged.length > tgt.length) await api.push('sync_push_media_servers', { p_profile_id: pid, p_servers: merged });
      return merged.length - tgt.length;
    },
  },
};

export async function pullProfile(api, pid, cats, log = () => {}) {
  const data = {};
  for (const c of cats) {
    data[c] = await CATEGORIES[c].pull(api, pid);
    log(`  ${CATEGORIES[c].label}: ${Array.isArray(data[c]) ? data[c].length + ' items' : 'ok'}`);
  }
  return data;
}

export const BACKUP_FORMAT = 'nuvio-backup';

export function parseBackup(text) {
  const b = JSON.parse(text);
  if (b.format !== BACKUP_FORMAT || !Array.isArray(b.profiles)) throw new Error('Not a Nuvio backup file');
  for (const p of b.profiles) {
    if (!Number.isInteger(p.profile?.profile_index) || typeof p.data !== 'object') throw new Error('Corrupt backup: bad profile entry');
    for (const c of Object.keys(p.data)) if (!CATEGORIES[c]) throw new Error(`Corrupt backup: unknown category "${c}"`);
  }
  return b;
}
