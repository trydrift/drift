export function validateRecording(recording, schemaVersion = 2) {
  if (recording.schemaVersion !== schemaVersion) throw new Error('invalid recording schema');
  const ids = recording.candidates.map((candidate) => candidate.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error('invalid final candidate IDs');
  if (recording.candidates.some((candidate) => ['pending', 'checking'].includes(candidate.status))) throw new Error('unfinished final candidate');
  const live = new Map();
  for (const event of recording.timeline) {
    if (event.type === 'candidate-upsert') live.set(event.candidate.id, event.candidate);
    if (event.type === 'candidate-drop') live.delete(event.id);
  }
  if (JSON.stringify([...live.keys()].sort()) !== JSON.stringify([...ids].sort())) throw new Error('timeline/final candidate mismatch');
  for (const candidate of recording.candidates) {
    if (JSON.stringify(live.get(candidate.id)) !== JSON.stringify(candidate)) throw new Error(`stale final candidate: ${candidate.id}`);
  }
}

export function isSchemaStale(recording, schemaVersion = 2) {
  return recording?.schemaVersion !== schemaVersion;
}
