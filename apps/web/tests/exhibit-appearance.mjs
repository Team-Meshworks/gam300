import assert from "node:assert/strict";

export async function verifyExhibitAppearance(page) {
  const result = await page.evaluate(async () => {
    const { createExhibitAppearance } = await import("/graphics/exhibit-appearance.ts");
    const { BoxGeometry, Group, Mesh, MeshStandardMaterial, RepeatWrapping } =
      await import("/@id/three");
    const geometry = new BoxGeometry(2, 2, 2);
    const material = new MeshStandardMaterial();
    const glassMaterial = new MeshStandardMaterial({ transparent: true, opacity: 0.3 });
    const root = new Group();
    root.position.set(1000, 0, -500);
    root.scale.set(0.5, 2, 1);
    const frame = new Mesh(geometry, material);
    const pane = new Mesh(geometry, glassMaterial);
    root.add(frame, pane);
    const renderer = createExhibitAppearance();
    const countDisposals = (resource) => {
      let count = 0;
      resource.addEventListener("dispose", () => count++);
      return () => count;
    };
    const originalUv = Array.from(geometry.getAttribute("uv").array);
    const cached = countDisposals(geometry);
    try {
      renderer.apply(root, { color: "#ffffff", material: "wood" });
      const uv = frame.geometry.getAttribute("uv").array;
      const wood = countDisposals(frame.geometry);
      const texture = frame.material.map;
      const pixels = texture.image.getContext("2d").getImageData(0, 0, 128, 128).data;
      const first = Array.from(pixels.slice(0, 4));
      const varied = pixels.some((value, index) => value !== first[index % 4]);
      const projected = frame.geometry !== geometry;
      const originalUnchanged = geometry
        .getAttribute("uv")
        .array.every((value, index) => value === originalUv[index]);
      renderer.apply(root, { color: "#ffffff", material: "plain" });
      const plainRestored = frame.geometry === geometry;
      renderer.apply(root, { color: "#ffffff", material: "tile" });
      const panePreserved = pane.geometry === geometry && pane.material.opacity === 0.3;
      const tile = countDisposals(frame.geometry);
      renderer.dispose();
      return {
        range: [Math.min(...uv), Math.max(...uv)],
        projected,
        originalUnchanged,
        tiledCanvas:
          texture.image instanceof HTMLCanvasElement &&
          texture.wrapS === RepeatWrapping &&
          texture.wrapT === RepeatWrapping,
        varied,
        plainRestored,
        woodDisposals: wood(),
        cachedDisposals: cached(),
        panePreserved,
        tileDisposals: tile(),
        disposalRestored: frame.geometry === geometry,
      };
    } finally {
      renderer.dispose();
      geometry.dispose();
      material.dispose();
      glassMaterial.dispose();
    }
  });
  assert.deepEqual(result, {
    range: [-8, 8],
    projected: true,
    originalUnchanged: true,
    tiledCanvas: true,
    varied: true,
    plainRestored: true,
    woodDisposals: 1,
    cachedDisposals: 0,
    panePreserved: true,
    tileDisposals: 1,
    disposalRestored: true,
  });
}
