export function validateRecording(recording, schemaVersion = 2) {
  if (!recording || typeof recording !== 'object' || recording.schemaVersion !== schemaVersion) {
    throw new Error('invalid recording schema');
  }
  if (!Array.isArray(recording.timeline) || !Array.isArray(recording.candidates)) {
    throw new Error('invalid recording lifecycle');
  }

  const ids = [];
  for (const candidate of recording.candidates) {
    if (!candidate || typeof candidate !== 'object' || typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('invalid final candidate IDs');
    }
    ids.push(candidate.id);
  }
  if (new Set(ids).size !== ids.length) throw new Error('invalid final candidate IDs');
  if (recording.candidates.some((candidate) => ['pending', 'checking', 'dropped'].includes(candidate.status))) {
    throw new Error('unfinished final candidate');
  }

  const live = new Map();
  let previousAt = -1;
  for (const event of recording.timeline) {
    if (!event || typeof event !== 'object' || !Number.isFinite(event.at) || event.at < 0 || event.at < previousAt) {
      throw new Error('invalid recording timeline order');
    }
    previousAt = event.at;

    if (event.type === 'candidate-upsert') {
      if (!event.candidate || typeof event.candidate !== 'object' || typeof event.candidate.id !== 'string' || event.candidate.id.length === 0) {
        throw new Error('invalid timeline candidate ID');
      }
      live.set(event.candidate.id, event.candidate);
    } else if (event.type === 'candidate-drop') {
      if (typeof event.id !== 'string' || event.id.length === 0) throw new Error('invalid dropped candidate ID');
      live.delete(event.id);
    } else if (event.type !== 'progress') {
      throw new Error('invalid recording timeline event');
    }
  }

  if (JSON.stringify([...live.keys()].sort()) !== JSON.stringify([...ids].sort())) {
    throw new Error('timeline/final candidate mismatch');
  }
  for (const candidate of recording.candidates) {
    if (JSON.stringify(live.get(candidate.id)) !== JSON.stringify(candidate)) {
      throw new Error(`stale final candidate: ${candidate.id}`);
    }
  }
}

export function isSchemaStale(recording, schemaVersion = 2) {
  return recording?.schemaVersion !== schemaVersion;
}
