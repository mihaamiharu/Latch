// The instance ID is the pairing identity. It stays local to this extension, so each
// Chrome profile keeps its own: never restore it from the host, which cannot tell
// profiles apart. The IndexedDB copy only helps if storage.local alone comes back empty.
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DATABASE = 'latch-identity', STORE = 'identity', KEY = 'instanceId';

export function createIdentityBackup(factory) {
  const opened = () => new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Close after every operation, so an idle worker never blocks the database.
  const run = async (mode, operation) => {
    const database = await opened();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, mode), request = operation(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  };
  return {read: () => run('readonly', store => store.get(KEY)), write: id => run('readwrite', store => store.put(id, KEY))};
}

export async function resolveInstanceId({storage, backup, randomUUID}) {
  const stored = (await storage.get(KEY))[KEY];
  // A broken backup must never stop the extension or replace a valid stored ID.
  const saved = await backup.read().catch(() => undefined);
  const instanceId = stored || (uuid.test(saved) ? saved : randomUUID());
  if (!stored) await storage.set({[KEY]: instanceId});
  if (saved !== instanceId) await backup.write(instanceId).catch(() => {});
  return {instanceId, source: stored ? 'storage' : instanceId === saved ? 'backup' : 'new'};
}
