/** Shared helpers for the browser tests (not a test file itself). */

/** The git history the app saved to IndexedDB: { meta, blobs: count }. */
export function readGitDb(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("toolneuron");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction(["meta", "blobs"]);
          const meta = tx.objectStore("meta").get("git");
          const blobs = tx.objectStore("blobs").count();
          tx.oncomplete = () => resolve({ meta: meta.result, blobs: blobs.result });
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
}
