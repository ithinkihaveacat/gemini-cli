/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getProjectHash } from "@google/gemini-cli-core/dist/src/utils/paths.js";
import { partListUnionToString } from "@google/gemini-cli-core/dist/src/core/geminiRequest.js";
import type {
  ConversationRecord,
  MessageRecord
} from "@google/gemini-cli-core/dist/src/services/chatRecordingService.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const targetDir = path.resolve(process.argv[2] || ".");
const hash = getProjectHash(targetDir);
const chatsDir = path.join(os.homedir(), ".gemini/tmp", hash, "chats");

if (!fs.existsSync(chatsDir)) {
  console.error(`No history found for ${targetDir} (hash: ${hash})`);
  process.exit(1);
}

const latestFile = fs
  .readdirSync(chatsDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    name: f,
    time: fs.statSync(path.join(chatsDir, f)).mtime.getTime()
  }))
  .sort((a, b) => b.time - a.time)[0];

if (!latestFile) {
  console.error("No chat sessions found.");
  process.exit(1);
}

const session: ConversationRecord = JSON.parse(
  fs.readFileSync(path.join(chatsDir, latestFile.name), "utf8")
);
session.messages
  .filter((m: MessageRecord) => m.type === "user")
  .forEach((m: MessageRecord) => {
    const text = partListUnionToString(m.content).split(
      "\n--- Content from referenced files ---"
    )[0];
    console.log(text + "\n\n---\n");
  });
