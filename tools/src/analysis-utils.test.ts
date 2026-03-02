/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from "vitest";
import { calculateSessionTelemetry } from "./analysis-utils.js";
import type { ConversationRecord } from "@google/gemini-cli-core/dist/src/services/chatRecordingService.js";
import fs from "node:fs";

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("calculateSessionTelemetry", () => {
  describe("Unit Tests: Attribution Logic", () => {
    const T0 = new Date("2026-02-27T10:00:00.000Z").getTime();

    it("should correctly attribute textless tool calls", () => {
      const T1 = T0 + 15000; // 15s gap

      const session = {
        startTime: new Date(T0).toISOString(),
        messages: [
          {
            type: "user",
            timestamp: new Date(T0).toISOString(),
            content: "hi"
          },
          {
            type: "gemini",
            timestamp: new Date(T1).toISOString(),
            content: "",
            toolCalls: [
              {
                id: "c1",
                name: "t1",
                timestamp: new Date(T1).toISOString(),
                status: "success"
              }
            ]
          }
        ]
      } as unknown as ConversationRecord;

      const tel = calculateSessionTelemetry(session);
      // We expect 1s for model, and the rest for tools
      expect(tel.totalWaitServerSuccessTimeMs).toBe(1000);
      expect(tel.totalWaitToolsTimeMs).toBe(14000);
      expect(tel.hasTextlessToolCalls).toBe(true);
    });

    it("should correctly attribute normal tool calls", () => {
      const T1 = T0 + 5000; // 5s gap (model)
      const T2 = T1 + 10000; // 10s gap (tools)

      const session = {
        startTime: new Date(T0).toISOString(),
        messages: [
          {
            type: "user",
            timestamp: new Date(T0).toISOString(),
            content: "hi"
          },
          {
            type: "gemini",
            timestamp: new Date(T1).toISOString(),
            content: "I will help",
            toolCalls: [
              {
                id: "c1",
                name: "t1",
                timestamp: new Date(T2).toISOString(),
                status: "success"
              }
            ]
          }
        ]
      } as unknown as ConversationRecord;

      const tel = calculateSessionTelemetry(session);
      expect(tel.totalWaitServerSuccessTimeMs).toBe(5000);
      expect(tel.totalWaitToolsTimeMs).toBe(10000);
      expect(tel.hasTextlessToolCalls).toBe(false);
    });

    it("should handle large gaps as user time", () => {
      const T1 = T0 + 5000; // 5s model latency
      const T2 = T1 + 10000; // 10s thinking/streaming
      const T3 = T2 + 3600000; // 1 hour pause by user

      const session = {
        startTime: new Date(T0).toISOString(),
        messages: [
          {
            type: "user",
            timestamp: new Date(T0).toISOString(),
            content: "q1"
          },
          {
            type: "gemini",
            timestamp: new Date(T2).toISOString(),
            content: "a1"
          },
          { type: "user", timestamp: new Date(T3).toISOString(), content: "q2" }
        ]
      } as unknown as ConversationRecord;

      const tel = calculateSessionTelemetry(session);
      expect(tel.totalWaitServerSuccessTimeMs).toBe(T2 - T0);
      // User wait time is capped at 10 minutes (600,000ms)
      expect(tel.totalWaitUserTimeMs).toBe(600000);
      expect(tel.totalWaitIdleTimeMs).toBe(3000000);
    });

    it("should split long user gaps into user time and idle time", () => {
      const T1 = T0 + 5000;
      const T2 = T1 + 1800000; // 30 minutes gap

      const session = {
        startTime: new Date(T0).toISOString(),
        messages: [
          {
            type: "user",
            timestamp: new Date(T0).toISOString(),
            content: "q1"
          },
          {
            type: "gemini",
            timestamp: new Date(T1).toISOString(),
            content: "a1"
          },
          { type: "user", timestamp: new Date(T2).toISOString(), content: "q2" }
        ]
      } as unknown as ConversationRecord;

      const tel = calculateSessionTelemetry(session);
      // User wait time is capped at 10 minutes (600,000ms)
      expect(tel.totalWaitUserTimeMs).toBe(600000);
      // Remainder is idle
      expect(tel.totalWaitIdleTimeMs).toBe(1200000);
    });
  });

  describe("Integration Tests: Real Session Data", () => {
    const testDataDir = path.resolve(__dirname, "../test-data");

    if (!fs.existsSync(testDataDir)) {
      console.warn("test-data directory not found, skipping integration tests");
      return;
    }

    const fixtures = fs
      .readdirSync(testDataDir)
      .filter((f) => f.endsWith(".json"));

    fixtures.forEach((fixture) => {
      it(`should process ${fixture} without errors and return valid telemetry`, () => {
        const filePath = path.join(testDataDir, fixture);
        const session = JSON.parse(
          fs.readFileSync(filePath, "utf8")
        ) as ConversationRecord;

        const tel = calculateSessionTelemetry(session);

        expect(tel.totalSessionTimeMs).toBeGreaterThan(0);
        expect(tel.totalInternalTimeMs).toBeGreaterThanOrEqual(0);

        // Ensure no field is NaN or Infinity
        Object.entries(tel).forEach(([key, value]) => {
          if (typeof value === "number") {
            expect(
              value,
              `Field ${key} in ${fixture} is invalid`
            ).not.toBeNaN();
            expect(value, `Field ${key} in ${fixture} is invalid`).not.toBe(
              Infinity
            );
          }
        });

        // Specific assertions for known fixtures
        if (fixture === "textless-calls.json") {
          expect(tel.hasTextlessToolCalls).toBe(true);
        }
        if (fixture === "overnight-idle.json") {
          // Total idle time should be very large (over 11 hours)
          expect(tel.totalWaitIdleTimeMs).toBeGreaterThan(11 * 3600000);
          // Active user time should be capped
          expect(tel.totalWaitUserTimeMs).toBeLessThan(1 * 3600000);
        }
      });
    });
  });
});
