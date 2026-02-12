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

export function readAndFormatChatLog(filePath: string): {
  content: string;
  rawSize: number;
  filteredSize: number;
  session: ConversationRecord;
} | null {
  const fileContent = fs.readFileSync(filePath, "utf8");
  const rawSize = Buffer.byteLength(fileContent, "utf8");
  const session: ConversationRecord = JSON.parse(fileContent);

  const transcript = session.messages
    .map((m: MessageRecord) => {
      const role = m.type.toUpperCase();
      let text = partListUnionToString(m.content);
      if (text.length > 20000) {
        text =
          text.slice(0, 10000) + "\n... [TRUNCATED] ...\n" + text.slice(-10000);
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
    session
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
