export async function exhaustStorage(page, storageName = "localStorage") {
  const key = "test-storage-padding:" + crypto.randomUUID();
  await page.evaluate(
    ({ paddingKey, storageName }) => {
      const storage = window[storageName];
      let lower = 0;
      let upper = 10 * 1024 * 1024;
      while (upper - lower > 1) {
        const size = Math.floor((upper + lower) / 2);
        try {
          storage.setItem(paddingKey, "x".repeat(size));
          lower = size;
        } catch (error) {
          if (!(error instanceof DOMException) || error.name !== "QuotaExceededError") throw error;
          upper = size;
        }
      }
      if (upper === 10 * 1024 * 1024) throw new Error("Storage quota was not reached");
    },
    { paddingKey: key, storageName },
  );
  return () =>
    page.evaluate(({ paddingKey, storageName }) => window[storageName].removeItem(paddingKey), {
      paddingKey: key,
      storageName,
    });
}
