export function validateRecording(recording, schemaVersion = 2) {
  if (recording.schemaVersion !== schemaVersion) throw new Error('invalid recording schema');
  if (!Array.isArray(recording.timeline) || !Array.isArray(recording.candidates)) throw new Error('invalid recording lifecycle');
  const ids = recording.candidates.map((candidate) => candidate.id);
  if (ids.some((id) => typeof id !== 'string' || id.length === 0) || new Set(ids).size !== ids.length) throw new Error('invalid final candidate IDs');
  if (recording.candidates.some((candidate) => ['pending', 'checking'].includes(candidate.status))) throw new Error('unfinished final candidate');
  const live = new Map();
  let previousAt = -1;
  for (const event of recording.timeline) {
    if (!Number.isFinite(event.at) || event.at < previousAt) throw new Error('invalid recording timeline order');
    previousAt = event.at;
    if (event.type === 'candidate-upsert') {
      if (typeof event.candidate?.id !== 'string' || event.candidate.id.length === 0) throw new Error('invalid timeline candidate ID');
      live.set(event.candidate.id, event.candidate);
    } else if (event.type === 'candidate-drop') {
      if (typeof event.id !== 'string' || event.id.length === 0) throw new Error('invalid dropped candidate ID');
      live.delete(event.id);
    } else if (event.type !== 'progress') {
      throw new Error('invalid recording timeline event');
    }
  }
  if (JSON.stringify([...live.keys()].sort()) !== JSON.stringify([...ids].sort())) throw new Error('timeline/final candidate mismatch');
  for (const candidate of recording.candidates) {
    if (JSON.stringify(live.get(candidate.id)) !== JSON.stringify(candidate)) throw new Error(`stale final candidate: ${candidate.id}`);
  }
}

export function isSchemaStale(recording, schemaVersion = 2) {
  return recording?.schemaVersion !== schemaVersion;
}
