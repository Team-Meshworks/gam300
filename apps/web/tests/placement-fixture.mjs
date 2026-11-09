// The default overview camera targets the starter room's origin at the viewport centre
export async function placeAtRoomCenter(page) {
  const stage = page.locator(".viewport-stage[data-placing-asset]");
  await stage.waitFor();
  await page.getByRole("status").filter({ hasText: "Scene ready" }).waitFor();
  const bounds = await stage.boundingBox();
  if (!bounds) throw new Error("The placement viewport must be visible");
  await stage.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
}
