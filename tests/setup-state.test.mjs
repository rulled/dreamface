import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETUP_STATE_KEY,
  collectAudioIds,
  hydrateSetupState,
  readSetupSnapshot,
  serializeSetupState,
  videoIdentity,
  writeSetupSnapshot,
  clearSetupSnapshot,
} from '../setup-state.js';

function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch)) data[key] = structuredClone(value);
    },
    async remove(key) {
      delete data[key];
    },
  };
}

const A = { avatarId: 'a', videoUrl: 'https://cdn/a.mp4', src: 'https://cdn/a.jpg?x=1', name: 'A' };
const B = { avatarId: 'b', videoUrl: 'https://cdn/b.mp4', src: 'https://cdn/b.jpg', name: 'B' };
const C = { avatarId: 'c', videoUrl: 'https://cdn/c.mp4', src: 'https://cdn/c.jpg?x=2', name: 'C' };

function audio(id, name) {
  return { id, name, type: 'audio/mpeg', lastModified: 42, blob: `blob-of-${name}` };
}

function makeFile({ id, name, blob, lastModified }) {
  return { name, blob, lastModified, setupAudioId: id };
}

test('a serialized selection hydrates back with its groups, videos and audio order intact', () => {
  const batches = [
    {
      id: 7,
      videoPage: 2,
      sortOrder: 'desc',
      audioExpanded: true,
      selectedIndices: [0, 2],
      audioFiles: [{ name: 'b.mp3' }, { name: 'a.mp3' }],
    },
  ];
  const ids = new Map([['b.mp3', 'audio-b'], ['a.mp3', 'audio-a']]);
  const snapshot = serializeSetupState({
    videos: [A, B, C],
    batches,
    audioIdOf: (file) => ids.get(file.name),
  });

  assert.deepEqual(snapshot.batches[0].selectedVideoKeys, [videoIdentity(A.src), videoIdentity(C.src)]);
  assert.deepEqual(snapshot.batches[0].audios.map((item) => item.id), ['audio-b', 'audio-a']);
  assert.equal(snapshot.batches[0].audioExpanded, true);
  assert.equal(snapshot.batches[0].sortOrder, 'desc');

  const records = new Map([['audio-a', audio('audio-a', 'a.mp3')], ['audio-b', audio('audio-b', 'b.mp3')]]);
  const restored = hydrateSetupState(snapshot, { audioRecords: records, makeFile });

  assert.equal(restored.videos.length, 3);
  assert.equal(restored.batches.length, 1);
  assert.deepEqual(restored.batches[0].selectedIndices, [0, 2]);
  assert.deepEqual(restored.batches[0].selectedAvatars.map((video) => video.name), ['A', 'C']);
  assert.deepEqual(restored.batches[0].audioFiles.map((file) => file.name), ['b.mp3', 'a.mp3']);
  assert.equal(restored.batches[0].audioFiles[0].blob, 'blob-of-b.mp3');
  assert.equal(restored.batches[0].audioFiles[0].setupAudioId, 'audio-b');
  assert.equal(restored.batches[0].videoPage, 2);
});

test('selection follows the video identity when the DreamFace list is reordered', () => {
  // New uploads land at the front of the library, so indices alone would point at other videos.
  const snapshot = {
    version: 1,
    videos: [C, A, B].map((video) => ({ ...video })),
    batches: [{ id: 1, selectedVideoKeys: [videoIdentity(A.src), videoIdentity(B.src)] }],
  };

  const { batches } = hydrateSetupState(snapshot, { audioRecords: new Map(), makeFile });

  assert.deepEqual(batches[0].selectedIndices, [1, 2]);
  assert.deepEqual(batches[0].selectedAvatars.map((video) => video.name), ['A', 'B']);
});

test('audio rows without a stored blob are dropped instead of failing the run later', () => {
  const snapshot = {
    version: 1,
    videos: [A],
    batches: [{
      id: 1,
      selectedVideoKeys: [videoIdentity(A.src)],
      audios: [{ id: 'kept', name: 'kept.mp3' }, { id: 'lost', name: 'lost.mp3' }],
    }],
  };

  const { batches } = hydrateSetupState(snapshot, {
    audioRecords: new Map([['kept', audio('kept', 'kept.mp3')]]),
    makeFile,
  });

  assert.deepEqual(batches[0].audioFiles.map((file) => file.name), ['kept.mp3']);
});

test('collectAudioIds reports exactly the blobs the snapshot still references', () => {
  const snapshot = serializeSetupState({
    videos: [A],
    batches: [
      { id: 1, selectedIndices: [], audioFiles: [{ name: 'one.mp3' }] },
      { id: 2, selectedIndices: [], audioFiles: [{ name: 'two.mp3' }] },
    ],
    audioIdOf: (file) => (file.name === 'one.mp3' ? 'id-one' : 'id-two'),
  });

  assert.deepEqual([...collectAudioIds(snapshot)].sort(), ['id-one', 'id-two']);
});

test('the snapshot round-trips through storage and survives only for the current version', async () => {
  const storage = createFakeStorage();
  assert.equal(await readSetupSnapshot(storage), null);

  const snapshot = serializeSetupState({ videos: [A], batches: [], audioIdOf: () => 'unused' });
  await writeSetupSnapshot(storage, snapshot);
  assert.equal(storage.data[SETUP_STATE_KEY].videos[0].videoUrl, A.videoUrl);

  const read = await readSetupSnapshot(storage);
  assert.deepEqual(read, snapshot);

  // A snapshot written by an older/newer popup has a different selection shape: ignore it.
  storage.data[SETUP_STATE_KEY] = { ...snapshot, version: 99 };
  assert.equal(await readSetupSnapshot(storage), null);

  storage.data[SETUP_STATE_KEY] = snapshot;
  await clearSetupSnapshot(storage);
  assert.equal(await readSetupSnapshot(storage), null);
});

test('video identity ignores cache-busting query strings but keeps the path', () => {
  assert.equal(videoIdentity('https://cdn/a.jpg?x=1&y=2#frag'), 'https://cdn/a.jpg');
  assert.equal(videoIdentity('https://cdn/a.jpg'), 'https://cdn/a.jpg');
  assert.notEqual(videoIdentity('https://cdn/a.jpg'), videoIdentity('https://cdn/b.jpg'));
  assert.equal(videoIdentity(undefined), '');
});
