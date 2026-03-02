/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { partListUnionToString } from "@google/gemini-cli-core/dist/src/core/geminiRequest.js";
import type {
  ConversationRecord,
  MessageRecord
} from "@google/gemini-cli-core/dist/src/services/chatRecordingService.js";
import fs from "node:fs";
import path from "node:path";

export const CONCURRENCY_LIMIT = 10;
export const MAX_AGGREGATION_BYTES = 700000;

export interface BaseProcessResult<T> {
  insight: T;
  rawSize: number;
  filteredSize: number;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export async function analyzeInParallel<T>(
  filePaths: string[],
  processFunction: (filePath: string) => Promise<BaseProcessResult<T> | null>,
  concurrencyLimit: number = CONCURRENCY_LIMIT,
  maxAggregationBytes: number = MAX_AGGREGATION_BYTES
): Promise<{
  results: T[];
  totalRawBytes: number;
  totalFilteredBytes: number;
  totalSummarizedBytes: number;
  failedCount: number;
  skippedCount: number;
}> {
  const results: T[] = [];
  const queue = [...filePaths];
  const activePromises: Set<Promise<void>> = new Set();
  const total = filePaths.length;
  let completed = 0;
  let totalRawBytes = 0;
  let totalFilteredBytes = 0;
  let totalSummarizedBytes = 0;
  let failedCount = 0;
  let skippedCount = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (queue.length === 0 && activePromises.size === 0) {
        if (process.stderr.isTTY) {
          process.stderr.write("\n"); // Clear progress line
        }
        resolve({
          results,
          totalRawBytes,
          totalFilteredBytes,
          totalSummarizedBytes,
          failedCount,
          skippedCount
        });
        return;
      }

      while (activePromises.size < concurrencyLimit && queue.length > 0) {
        if (totalSummarizedBytes >= maxAggregationBytes) {
          console.error(
            `\nLimit of ${formatBytes(maxAggregationBytes)} reached (collected ${formatBytes(totalSummarizedBytes)}). Stopping analysis early.`
          );
          skippedCount = queue.length;
          queue.length = 0; // Clear queue
          break;
        }

        const filePath = queue.shift()!;
        const promise = (async () => {
          const result = await processFunction(filePath);
          let sumSize = 0;
          let rawSize = 0;
          let filteredSize = 0;

          if (result) {
            results.push(result.insight);
            sumSize = Buffer.byteLength(JSON.stringify(result.insight), "utf8");
            rawSize = result.rawSize;
            filteredSize = result.filteredSize;

            totalSummarizedBytes += sumSize;
            totalRawBytes += rawSize;
            totalFilteredBytes += filteredSize;
          } else {
            failedCount++;
          }
          completed++;

          const msg = `Analyzed ${completed}/${total}: ${path.basename(filePath)} | Last: ${formatBytes(rawSize)} -> ${formatBytes(filteredSize)} -> ${formatBytes(sumSize)} | Total: ${formatBytes(totalSummarizedBytes)}`;

          if (process.stderr.isTTY) {
            process.stderr.clearLine(0);
            process.stderr.cursorTo(0);
            process.stderr.write(`\r${msg}`);
          } else {
            process.stderr.write(`${msg}\n`);
          }
        })();

        activePromises.add(promise);
        promise.finally(() => {
          activePromises.delete(promise);
          next();
        });
      }
    };

    next();
  });
}

export interface SessionTelemetry {
  /** Total wall-clock time from session start to last activity */
  totalSessionTimeMs: number;
  /** (1) Total time spent waiting for the model to respond successfully */
  totalWaitServerSuccessTimeMs: number;
  /** (3) Total time spent waiting for a response that resulted in an API error */
  totalWaitServerErrorTimeMs: number;
  /** Total time spent waiting before the user interrupted/cancelled the request */
  totalWaitServerCancelTimeMs: number;

  /** Total time spent waiting for tools/scripts to execute (Environment bottleneck) */
  totalWaitToolsTimeMs: number;
  /** Total time spent waiting for the human user to provide input (Human bottleneck) */
  totalWaitUserTimeMs: number;
  /** Time where the user likely walked away (gaps > 10m) */
  totalWaitIdleTimeMs: number;
  /** Remainder time (internal CLI processing, overhead) */
  totalInternalTimeMs: number;
  /** Whether any textless tool calls were detected and re-attributed */
  hasTextlessToolCalls: boolean;

  /** Breakdown of wait times by model */
  modelBreakdown: Record<
    string,
    { successMs: number; errorMs: number; cancelMs: number }
  >;

  /** Details of API errors encountered */
  apiErrors: {
    message: string;
    waitTimeMs: number;
    timestamp: string;
  }[];
  /** Details of successful responses that were exceptionally slow */
  slowResponses: {
    waitTimeMs: number;
    timestamp: string;
    firstThoughtSubject?: string;
  }[];
  /** Details of user cancellations */
  cancelledResponses: {
    waitTimeMs: number;
    timestamp: string;
  }[];
}

/**
 * Deterministically calculates session wait times and friction points.
 * @param session The conversation record to analyze.
 */
export function calculateSessionTelemetry(
  session: ConversationRecord
): SessionTelemetry {
  const SLOW_RESPONSE_THRESHOLD_MS = 180000; // 3 minutes
  const USER_WALKAWAY_THRESHOLD_MS = 600000; // 10 minutes

  let totalWaitServerSuccessTimeMs = 0;
  let totalWaitServerErrorTimeMs = 0;
  let totalWaitServerCancelTimeMs = 0;
  let totalWaitToolsTimeMs = 0;
  let totalWaitUserTimeMs = 0;
  let totalWaitIdleTimeMs = 0;
  let hasTextlessToolCalls = false;

  const modelBreakdown: SessionTelemetry["modelBreakdown"] = {};

  const apiErrors: SessionTelemetry["apiErrors"] = [];
  const slowResponses: SessionTelemetry["slowResponses"] = [];
  const cancelledResponses: SessionTelemetry["cancelledResponses"] = [];

  // Track the absolute "last known activity" timestamp to measure gaps.
  let lastActivityTime = new Date(session.startTime).getTime();

  // Keep track of the model being used (defaults to session model or first found)
  let currentModel = "unknown-model";
  for (const m of session.messages) {
    if (m.type === "gemini" && m.model) {
      currentModel = m.model;
      break;
    }
  }

  for (let i = 0; i < session.messages.length; i++) {
    const msg = session.messages[i];
    const msgTime = new Date(msg.timestamp).getTime();

    // Update current model if message specifies one
    if (msg.type === "gemini" && msg.model) {
      currentModel = msg.model;
    }

    // Ensure model exists in breakdown
    if (!modelBreakdown[currentModel]) {
      modelBreakdown[currentModel] = { successMs: 0, errorMs: 0, cancelMs: 0 };
    }

    let isTextlessToolCall = false;

    // Gap Analysis (from last activity to start of this message)
    if (msgTime > lastActivityTime) {
      const gap = msgTime - lastActivityTime;

      if (msg.type === "gemini") {
        // DETECT TEXTLESS TOOL CALLS:
        // In the CLI, if Gemini provides tool calls without text, the "gemini" message
        // is recorded AFTER the tools finish. In this case, msg.timestamp matches
        // the end of the tool calls. We should attribute most of this gap to tools,
        // using a small constant (1s) for model latency.
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const latestToolTimestamp = Math.max(
            ...msg.toolCalls.map((tc) =>
              tc.timestamp ? new Date(tc.timestamp).getTime() : 0
            )
          );
          if (msgTime === latestToolTimestamp) {
            isTextlessToolCall = true;
          }
        }

        if (isTextlessToolCall) {
          hasTextlessToolCalls = true;
          const estimatedModelLatency = Math.min(1000, gap);
          totalWaitServerSuccessTimeMs += estimatedModelLatency;
          modelBreakdown[currentModel].successMs += estimatedModelLatency;
          totalWaitToolsTimeMs += gap - estimatedModelLatency;
        } else {
          totalWaitServerSuccessTimeMs += gap;
          modelBreakdown[currentModel].successMs += gap;
        }

        if (gap > SLOW_RESPONSE_THRESHOLD_MS) {
          slowResponses.push({
            waitTimeMs: gap,
            timestamp: msg.timestamp,
            firstThoughtSubject: msg.thoughts?.[0]?.subject
          });
        }
      } else if (msg.type === "error") {
        totalWaitServerErrorTimeMs += gap;
        modelBreakdown[currentModel].errorMs += gap;
        const content = partListUnionToString(msg.content);
        if (content.includes("[API Error:")) {
          apiErrors.push({
            message: content,
            waitTimeMs: gap,
            timestamp: msg.timestamp
          });
        }
      } else if (msg.type === "user") {
        if (gap > USER_WALKAWAY_THRESHOLD_MS) {
          totalWaitUserTimeMs += USER_WALKAWAY_THRESHOLD_MS;
          totalWaitIdleTimeMs += gap - USER_WALKAWAY_THRESHOLD_MS;
        } else {
          totalWaitUserTimeMs += gap;
        }
      } else if (
        msg.type === "info" &&
        msg.content.toString().includes("Request cancelled")
      ) {
        totalWaitServerCancelTimeMs += gap;
        modelBreakdown[currentModel].cancelMs += gap;
        cancelledResponses.push({ waitTimeMs: gap, timestamp: msg.timestamp });
      }
    }

    // Update last activity to the END of this message/turn
    lastActivityTime = msgTime;

    // If it's a normal tool call (not textless), we need to add the tool execution time
    // that happened AFTER the gemini message was recorded.
    if (
      !isTextlessToolCall &&
      msg.type === "gemini" &&
      msg.toolCalls &&
      msg.toolCalls.length > 0
    ) {
      let turnEndTime = msgTime;
      for (const tc of msg.toolCalls) {
        if (tc.timestamp) {
          const tcEndTime = new Date(tc.timestamp).getTime();
          if (tcEndTime > turnEndTime) turnEndTime = tcEndTime;
        }
      }
      const toolWait = turnEndTime - msgTime;

      // HEURISTIC: "Action Required" prompts.
      // We only apply this to tools that are expected to be near-instantaneous.
      // If they take > 2s, it's almost certainly a user confirmation prompt.
      // We do NOT apply this to run_shell_command as it can legitimately take minutes.
      const FAST_TOOLS = new Set([
        "read_file",
        "replace",
        "write_file",
        "grep_search",
        "glob",
        "list_directory"
      ]);

      // Check if all tools in this turn are "fast" tools
      const isAllFastTools = msg.toolCalls.every((tc) =>
        FAST_TOOLS.has(tc.name)
      );

      const PROMPT_THRESHOLD_MS = 2000;
      if (isAllFastTools && toolWait > PROMPT_THRESHOLD_MS) {
        totalWaitToolsTimeMs += PROMPT_THRESHOLD_MS;
        totalWaitUserTimeMs += toolWait - PROMPT_THRESHOLD_MS;
      } else {
        totalWaitToolsTimeMs += toolWait;
      }

      lastActivityTime = turnEndTime;
    }
  }

  // Determine the effective end time of the session based on the last activity
  // (message or tool call) rather than the file's modification time, which
  // can include hours of idle time after the user walked away.
  let sessionEndTime = new Date(session.startTime).getTime();
  if (session.messages.length > 0) {
    const lastMsg = session.messages[session.messages.length - 1];
    sessionEndTime = new Date(lastMsg.timestamp).getTime();

    // If the last message has tool calls, checking their timestamps is also prudent,
    // though usually the message timestamp covers the thought process.
    if (lastMsg.type === "gemini" && lastMsg.toolCalls) {
      for (const tc of lastMsg.toolCalls) {
        if (tc.timestamp) {
          const tcEnd = new Date(tc.timestamp).getTime();
          if (tcEnd > sessionEndTime) sessionEndTime = tcEnd;
        }
      }
    }
  }

  const totalSessionTimeMs =
    sessionEndTime - new Date(session.startTime).getTime();

  const totalInternalTimeMs = Math.max(
    0,
    totalSessionTimeMs -
      totalWaitServerSuccessTimeMs -
      totalWaitServerErrorTimeMs -
      totalWaitServerCancelTimeMs -
      totalWaitToolsTimeMs -
      totalWaitUserTimeMs -
      totalWaitIdleTimeMs
  );

  return {
    totalSessionTimeMs,
    totalWaitServerSuccessTimeMs,
    totalWaitServerErrorTimeMs,
    totalWaitServerCancelTimeMs,
    totalWaitToolsTimeMs,
    totalWaitUserTimeMs,
    totalWaitIdleTimeMs,
    totalInternalTimeMs,

    hasTextlessToolCalls,
    modelBreakdown,
    apiErrors,
    slowResponses,
    cancelledResponses
  };
}

export function readAndFormatChatLog(filePath: string): {
  content: string;
  rawSize: number;
  filteredSize: number;
  session: ConversationRecord;
  telemetry: SessionTelemetry;
} | null {
  const fileContent = fs.readFileSync(filePath, "utf8");
  const rawSize = Buffer.byteLength(fileContent, "utf8");
  const session: ConversationRecord = JSON.parse(fileContent);

  const telemetry = calculateSessionTelemetry(session);

  const transcript = session.messages
    .map((m: MessageRecord) => {
      const role = m.type.toUpperCase();
      let text = partListUnionToString(m.content);
      if (text.length > 20000) {
        text =
          text.slice(0, 10000) +
          "\n... [ANALYSIS_SCRIPT_TRUNCATED_THIS_LOG_FOR_BREVITY_THE_AGENT_SAW_FULL_CONTENT] ...\n" +
          text.slice(-10000);
      }
      return `${role}: ${text}`;
    })
    .join("\n\n");

  const filteredSize = Buffer.byteLength(transcript, "utf8");

  if (!transcript.trim()) return null;

  return {
    content: transcript,
    rawSize,
    filteredSize,
    session,
    telemetry
  };
}

export interface RetryOptions {
  maxRetries?: number;
  /**
   * Callback invoked before a retry.
   * @param attempt The current attempt number (starting at 1).
   * @param error The error that caused the failure.
   * @returns true to proceed with retry, false to abort.
   */
  onRetry?: (attempt: number, error: unknown) => boolean;
}

/**
 * Executes an async operation with retry logic.
 */
export async function runWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T | null> {
  const maxRetries = options.maxRetries ?? 3;
  let attempts = 0;

  while (attempts <= maxRetries) {
    try {
      return await operation();
    } catch (e: unknown) {
      const isQuotaError =
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        (e as { status: unknown }).status === 429;

      if (isQuotaError) {
        console.error("\nQuota exceeded (429). Stopping analysis immediately.");
        process.exit(1);
      }

      attempts++;

      if (attempts > maxRetries) {
        const errorMessage =
          typeof e === "object" && e !== null && "message" in e
            ? (e as { message: string }).message
            : String(e);
        console.error(`\nFailed after ${attempts} attempts:`, errorMessage);
        return null;
      }

      // Allow caller to control retry policy (e.g., global limits)
      if (options.onRetry) {
        const shouldRetry = options.onRetry(attempts, e);
        if (!shouldRetry) {
          return null;
        }
      }

      // Exponential backoff with jitter
      const delay = Math.pow(2, attempts) * 1000 + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}
