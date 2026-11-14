export type ProjectImage = { type: "cover" | "panorama"; url: string };
export type EncodedProjectImage = {
  type: ProjectImage["type"];
  contentType: string;
  data: string;
};

export function validProjectImage(value: unknown): value is ProjectImage | null | undefined {
  if (value == null) return true;
  if (typeof value !== "object") return false;
  const image = value as Record<string, unknown>;
  return (
    (image.type === "cover" || image.type === "panorama") &&
    typeof image.url === "string" &&
    /^\/api\/v1\/projects\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/image$/i.test(image.url)
  );
}

export async function encodeProjectImage(
  file: File,
  type: ProjectImage["type"],
): Promise<EncodedProjectImage> {
  if (!file.size || file.size > 2 * 1024 * 1024)
    throw new Error("Choose an image no larger than 2 MB.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG or WebP image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be opened. Choose another image.");
  }
  try {
    const maximumWidth = type === "panorama" ? 8192 : 4096;
    if (
      bitmap.width > maximumWidth ||
      bitmap.height > 4096 ||
      bitmap.width * bitmap.height > 16_000_000
    )
      throw new Error("Choose an image below 16 megapixels and 4096 pixels high.");
    if (type === "panorama" && bitmap.width !== bitmap.height * 2)
      throw new Error("Choose a 360-degree panorama that is twice as wide as it is high.");
  } finally {
    bitmap.close();
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(new Error("The image could not be read. Choose it again."));
    reader.onabort = () => reject(new Error("Image selection was cancelled."));
    reader.readAsDataURL(file);
  });
  return { type, contentType: file.type, data };
}
