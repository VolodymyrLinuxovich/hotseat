// Shared settings for the interview engine.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Vercel sets VERCEL. There the disk is read-only except /tmp, and Bruin isn't installed.
export const HOSTED = Boolean(process.env.VERCEL);
export const DATA = HOSTED ? "/tmp/hotseat-data" : path.join(ROOT, "data");

export const MODEL = "claude-opus-5-5";
export const MAX_QUESTIONS = 5;
export const CODING_ROUND = 3;

// Spoken questions longer than this get cut at a sentence boundary.
export const MAX_QUESTION_WORDS = 45;
