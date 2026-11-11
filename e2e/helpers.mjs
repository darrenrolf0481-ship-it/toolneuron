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

/**
 * Opens the app and waits until it has loaded its save and git history.
 * (Not "networkidle": background requests can keep the network busy forever.)
 */
export async function gotoApp(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitReady(page);
}

/** Reloads the page and waits for the app to be ready again. */
export async function reloadApp(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitReady(page);
}

function waitReady(page) {
  return page.locator('[data-ready="true"]').waitFor({ state: "attached", timeout: 30_000 });
}
