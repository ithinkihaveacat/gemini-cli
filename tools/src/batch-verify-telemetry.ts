/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import fs from "node:fs";
import path from "node:path";
import { calculateSessionTelemetry } from "./analysis-utils.js";

const CHATS_DIR = "/Users/stillers/.gemini/tmp/gemini-cli/chats";

function format(ms: number) {
  if (ms < 1000) return ms + "ms";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = s / 60;
  if (m < 60) return m.toFixed(1) + "m";
  const h = m / 60;
  return h.toFixed(1) + "h";
}

async function run() {
  if (!fs.existsSync(CHATS_DIR)) {
    console.error("Chats directory not found:", CHATS_DIR);
    return;
  }

  const files = fs
    .readdirSync(CHATS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(CHATS_DIR, f));

  console.log(`Analyzing ${files.length} files...
`);
  console.log(
    `${"FILE".padEnd(40)} | ${"TOTAL".padEnd(8)} | ${"SERVER".padEnd(8)} | ${"TOOLS".padEnd(8)} | ${"USER".padEnd(8)} | ${"IDLE".padEnd(8)} | ${"INTERNAL".padEnd(8)} | ${"TEXTLESS"}`
  );
  console.log("-".repeat(120));

  for (const file of files) {
    try {
      const content = fs.readFileSync(file, "utf8");
      const session = JSON.parse(content);

      if (!session.messages || !Array.isArray(session.messages)) continue;

      const tel = calculateSessionTelemetry(session);

      const fileName = path.basename(file);
      console.log(
        `${fileName.padEnd(40)} | ${format(tel.totalSessionTimeMs).padEnd(8)} | ${format(tel.totalWaitServerSuccessTimeMs).padEnd(8)} | ${format(tel.totalWaitToolsTimeMs).padEnd(8)} | ${format(tel.totalWaitUserTimeMs).padEnd(8)} | ${format(tel.totalWaitIdleTimeMs).padEnd(8)} | ${format(tel.totalInternalTimeMs).padEnd(8)} | ${tel.hasTextlessToolCalls ? "YES" : "no"}`
      );
    } catch (e) {
      console.error(`Error processing ${file}:`, e);
    }
  }
}

run();
