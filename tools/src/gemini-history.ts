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

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY

Lists user questions from the latest gemini-cli session for a given directory.

Arguments:
  DIRECTORY         The directory to look up history for.

Options:
  --dir             Output the directory where history is stored and exit
  -h, --help        Display this help message and exit

Examples:
  # List history for the current directory
  ${scriptName} .

  # Show the history directory path
  ${scriptName} --dir .
`);
  process.exit(0);
}

const args = process.argv.slice(2);
let showDir = false;
let targetDirArg: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    usage();
  } else if (arg === "--dir") {
    showDir = true;
  } else if (arg.startsWith("-")) {
    console.error(`Unknown option ${arg}`);
    process.exit(1);
  } else {
    if (targetDirArg) {
      // Multiple directories not supported? Original script takes "$1" after parsing, ignoring others or putting them in POSITIONAL_ARGS.
      // Original script: POSITIONAL_ARGS+=("$1"); shift. Then set -- "${POSITIONAL_ARGS[@]}"; if [ -z "$1" ]...
      // It effectively takes the first positional arg as the directory.
      // We will do the same: ignore extra args or error?
      // Shell script usage implies only one directory.
      // Let's just take the first one and ignore or error on others.
      // Given "Arguments: DIRECTORY", singular, implies one.
    } else {
      targetDirArg = arg;
    }
  }
}

if (!targetDirArg) {
  usage();
}

// Check if the target directory itself exists
const resolvedTargetDir = path.resolve(targetDirArg!);
if (
  !fs.existsSync(resolvedTargetDir) ||
  !fs.statSync(resolvedTargetDir).isDirectory()
) {
  console.error(`Error: Directory '${resolvedTargetDir}' does not exist.`);
  process.exit(1);
}

const hash = getProjectHash(resolvedTargetDir);
const geminiTmp = path.join(os.homedir(), ".gemini/tmp", hash);
const chatsDir = path.join(geminiTmp, "chats");

if (showDir) {
  console.log(geminiTmp);
  process.exit(0);
}

if (!fs.existsSync(geminiTmp)) {
  console.error(
    `Error: No Gemini history found for directory: ${resolvedTargetDir}`
  );
  console.error(`Expected location: ${geminiTmp}`);
  process.exit(1);
}

if (!fs.existsSync(chatsDir)) {
  console.error(`Error: No 'chats' subdirectory found in: ${geminiTmp}`);
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
  console.error(`No chat history found in ${chatsDir}`);
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
