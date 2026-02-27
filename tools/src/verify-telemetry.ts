/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { calculateSessionTelemetry } from "./analysis-utils.js";
import { CoreToolCallStatus } from "@google/gemini-cli-core/dist/src/scheduler/types.js";
import type { ConversationRecord } from "@google/gemini-cli-core/dist/src/services/chatRecordingService.js";

const T0 = new Date("2026-02-27T10:00:00.000Z").getTime();
const T1 = T0 + 5000; // 5s gap
const T2 = T1 + 10000; // 10s gap

function format(ms: number) {
  return ms / 1000 + "s";
}

console.log("--- Scenario 1: Textless Tool Call (Repro of issue) ---");
// In this scenario, Gemini message timestamp is recorded at T2 (end of tools)
const session1 = {
  startTime: new Date(T0).toISOString(),
  messages: [
    {
      type: "user",
      timestamp: new Date(T0).toISOString(),
      content: "hi"
    },
    {
      type: "gemini",
      timestamp: new Date(T2).toISOString(), // Recorded AFTER tools
      content: "",
      toolCalls: [
        {
          id: "c1",
          name: "t1",
          timestamp: new Date(T2).toISOString(), // Tool finished at T2
          status: CoreToolCallStatus.Success
        }
      ]
    }
  ]
} as unknown as ConversationRecord;

const tel1 = calculateSessionTelemetry(session1);
console.log("Total Gap (User to Gemini): 15s");
console.log("Expected: Model ~1s, Tools ~14s");
console.log(
  "Actual: Model " +
    format(tel1.totalWaitServerSuccessTimeMs) +
    ", Tools " +
    format(tel1.totalWaitToolsTimeMs)
);

console.log("\n--- Scenario 2: Normal Tool Call ---");
// Gemini message recorded at T1, tool finishes at T2
const session2 = {
  startTime: new Date(T0).toISOString(),
  messages: [
    {
      type: "user",
      timestamp: new Date(T0).toISOString(),
      content: "hi"
    },
    {
      type: "gemini",
      timestamp: new Date(T1).toISOString(), // Recorded BEFORE tools
      content: "I will help",
      toolCalls: [
        {
          id: "c1",
          name: "t1",
          timestamp: new Date(T2).toISOString(), // Tool finished at T2
          status: CoreToolCallStatus.Success
        }
      ]
    }
  ]
} as unknown as ConversationRecord;

const tel2 = calculateSessionTelemetry(session2);
console.log("Gap T0-T1 (Model): 5s");
console.log("Gap T1-T2 (Tools): 10s");
console.log(
  "Actual: Model " +
    format(tel2.totalWaitServerSuccessTimeMs) +
    ", Tools " +
    format(tel2.totalWaitToolsTimeMs)
);
