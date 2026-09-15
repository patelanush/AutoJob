import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PDFParse } from "pdf-parse";
import type { Profile } from "../config/profile.js";
import { root } from "../config/profile.js";
export async function verifiedResumeText(p: Profile) {
  if (!p.resume.verifiedTextPath) return "";
  const file = resolve(root, p.resume.verifiedTextPath);
  return readFileSync(file, "utf8").slice(0, 20000);
}
export async function extractResume(p: Profile) {
  const file = resolve(root, p.resume.path);
  if (!/\.pdf$/i.test(file)) return "";
  const parser = new PDFParse({ data: readFileSync(file) });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}
