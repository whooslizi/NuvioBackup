// Run: node nuvio.test.mjs
import assert from 'node:assert/strict';
import { mergeList, missing, newerProgress, freeIndices, keys, parseBackup } from './nuvio.js';

const t = [{ url: 'https://a/manifest.json' }, { url: 'https://b/manifest.json' }];
const s = [{ url: 'https://b' }, { url: 'https://c/manifest.json' }, { url: 'https://c/manifest.json' }];
assert.deepEqual(mergeList(t, s, keys.url).map(x => x.url), ['https://a/manifest.json', 'https://b/manifest.json', 'https://c/manifest.json']);
assert.deepEqual(missing(t, s, keys.url).map(x => x.url), ['https://c/manifest.json']);
assert.deepEqual(mergeList(null, s, keys.url).length, 2);

const tp = [{ progress_key: 'k1', last_watched: 10 }, { progress_key: 'k2', last_watched: 50 }];
const sp = [{ progress_key: 'k1', last_watched: 20 }, { progress_key: 'k2', last_watched: 40 }, { progress_key: 'k3', last_watched: 1 }];
assert.deepEqual(newerProgress(tp, sp).map(x => x.progress_key), ['k1', 'k3']);

assert.deepEqual(missing([{ content_id: 'tt1', season: 1, episode: 2 }], [{ content_id: 'tt1', season: 1, episode: 2 }, { content_id: 'tt1', season: 1, episode: 3 }], keys.watched).length, 1);

assert.deepEqual(freeIndices([1, 3], 2), [2, 4]);
assert.throws(() => freeIndices([1, 2, 3, 4, 5], 2), /no room/);

assert.throws(() => parseBackup('{"format":"x"}'), /Not a Nuvio backup/);
assert.throws(() => parseBackup('{"format":"nuvio-backup","profiles":[{"profile":{"profile_index":1},"data":{"evil":1}}]}'), /unknown category/);
assert.equal(parseBackup('{"format":"nuvio-backup","profiles":[{"profile":{"profile_index":1},"data":{"addons":[]}}]}').profiles.length, 1);
console.log('ok');
