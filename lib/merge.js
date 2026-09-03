// Sloučí výsledky z více lokalit do jednoho pole, bez duplicit podle `id`
// (může se stát, že se okruhy dvou blízkých měst překrývají).

export function mergeUniqueById(itemLists) {
  const seenIds = new Set();
  const merged = [];
  for (const list of itemLists) {
    for (const item of list) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}
