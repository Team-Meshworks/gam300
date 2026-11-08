import * as THREE from "three";
import type { TextRun } from "../project/project-content";
import { wrapDisplayText } from "./display-layout";

export function createTextTexture(
  text: string,
  width: number,
  height: number,
  runs?: readonly TextRun[],
  fontSize = 32,
  transparent = false,
  ink = "#292522",
  background = "#fffaf0",
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = Math.max(256, Math.min(2048, Math.round((height / width) * 1024)));
  const ctx = canvas.getContext("2d")!;
  if (!transparent) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = ink;
  ctx.font = `${fontSize}px sans-serif`;
  const lineHeight = Math.ceil(fontSize * 1.3);
  ctx.textBaseline = "top";
  if (runs) {
    let x = 44;
    let y = 44;
    outer: for (const run of runs) {
      ctx.font = `${run.marks.includes("italic") ? "italic " : ""}${run.marks.includes("bold") ? "bold " : ""}${fontSize}px sans-serif`;
      for (const char of run.text) {
        const advance = ctx.measureText(char).width;
        if (char === "\n" || x + advance > canvas.width - 44) {
          x = 44;
          y += lineHeight;
        }
        if (y > canvas.height - fontSize - 16) {
          ctx.fillText("…", x, y);
          break outer;
        }
        if (char === "\n") continue;
        ctx.fillText(char, x, y);
        if (run.marks.includes("underline")) ctx.fillRect(x, y + fontSize + 2, advance, 2);
        x += advance;
      }
    }
  } else {
    const lines = wrapDisplayText(
      text,
      canvas.width - 88,
      (line) => ctx.measureText(line).width,
      Math.max(1, Math.floor((canvas.height - 88) / 42)),
    );
    lines.forEach((line, i) => ctx.fillText(line, 44, 44 + i * 42));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
