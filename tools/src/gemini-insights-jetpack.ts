/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getProjectHash } from "@google/gemini-cli-core/dist/src/utils/paths.js";
import {
  analyzeInParallel,
  readAndFormatChatLog,
  runWithRetry,
  MAX_AGGREGATION_BYTES
} from "./analysis-utils.js";
import type { BaseProcessResult } from "./analysis-utils.js";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

const ANALYSIS_MODEL = "gemini-3-flash-preview";
const AGGREGATION_MODEL = "gemini-3-pro-preview";
const MAX_TOTAL_RETRIES = 10;
const MAX_RETRIES_PER_REQUEST = 3;

interface JetpackInsight {
  sessionFile?: string;
  has_jetpack_usage: boolean;
  invocations?: Array<{
    command: string;
    subcommand?: string;
    args?: string;
    user_intent:
      | "debug_crash"
      | "explore_source"
      | "verify_version"
      | "resolve_dependency"
      | "unknown";
    outcome: "success" | "error" | "confusion";
    failure_type?: "tool_crash" | "user_error" | "empty_result" | "none";
    friction_points?: string;
    improvement_idea?: string;
  }>;
}

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY OUTPUT_FILE

Extracts Jetpack tool usage insights from Gemini CLI logs for a given directory.

Arguments:
  DIRECTORY         The directory to look up history for.
  OUTPUT_FILE       The path to write the Markdown report to.

Options:
  --limit NUMBER        Limit analysis to the N most recent conversations (default: all).
  --dump-analysis FILE  Output intermediate analysis data to FILE (Markdown format).
  -h, --help            Display this help message and exit

Environment:
  GEMINI_API_KEY    Required. Your Gemini API key.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      limit: { type: "string" },
      "dump-analysis": { type: "string" }
    },
    allowPositionals: true
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  if (positionals.length < 2) {
    usage();
    process.exit(1);
  }

  const targetDirArg = positionals[0];
  const outputFile = positionals[1];
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("Error: GEMINI_API_KEY environment variable not set.");
    process.exit(1);
  }

  const genAI = new GoogleGenAI({ apiKey });

  const resolvedTargetDir = path.resolve(targetDirArg);
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

  if (!fs.existsSync(chatsDir)) {
    console.error(`Error: No 'chats' subdirectory found in: ${geminiTmp}`);
    process.exit(0);
  }

  let chatFiles = fs
    .readdirSync(chatsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({
      name: f,
      path: path.join(chatsDir, f),
      time: fs.statSync(path.join(chatsDir, f)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time); // Newest first

  const totalFoundCount = chatFiles.length;

  if (totalFoundCount === 0) {
    console.log("No chat logs found.");
    process.exit(0);
  }

  // Filter based on limit
  if (values.limit) {
    const limit = parseInt(values.limit, 10);
    if (isNaN(limit) || limit <= 0) {
      console.error("Invalid limit specified.");
      process.exit(1);
    }
    chatFiles = chatFiles.slice(0, limit);
    console.error(`Analyzing most recent ${chatFiles.length} logs...`);
  } else {
    console.error(`Analyzing all ${chatFiles.length} logs...`);
  }

  const selectedCount = chatFiles.length;

  // Global retry counter for this run
  let totalRetries = 0;

  const processLogFileWrapper = async (
    filePath: string
  ): Promise<BaseProcessResult<JetpackInsight> | null> => {
    return runWithRetry(() => processLogFile(filePath, genAI), {
      maxRetries: MAX_RETRIES_PER_REQUEST,
      onRetry: () => {
        totalRetries++;
        if (totalRetries > MAX_TOTAL_RETRIES) {
          console.error(
            `\nMax total retries (${MAX_TOTAL_RETRIES}) exceeded. Skipping ${path.basename(filePath)}.`
          );
          return false; // Stop retrying
        }
        return true; // Continue retrying
      }
    });
  };

  const {
    results: sessionInsights,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes,
    failedCount,
    skippedCount
  } = await analyzeInParallel(
    chatFiles.map((f) => f.path),
    processLogFileWrapper
  );

  // Filter out sessions with no Jetpack usage
  const relevantInsights = sessionInsights.filter(
    (i) => i.has_jetpack_usage && i.invocations && i.invocations.length > 0
  );

  if (relevantInsights.length === 0) {
    console.log("No Jetpack tool usage found in the analyzed logs.");
    process.exit(0);
  }

  if (values["dump-analysis"]) {
    let rawOutput = "# Raw Jetpack Analysis Output\n\n";
    for (const insight of relevantInsights) {
      if (insight.sessionFile) {
        rawOutput += `## Session: ${path.basename(insight.sessionFile)}\n\n`;
      } else {
        rawOutput += `## Session: Unknown\n\n`;
      }

      if (insight.invocations && insight.invocations.length > 0) {
        rawOutput += "```json\n";
        rawOutput += JSON.stringify(insight.invocations, null, 2);
        rawOutput += "\n```\n\n";
      }
      rawOutput += "---\n\n";
    }
    fs.writeFileSync(values["dump-analysis"], rawOutput);
    console.error(`Raw output written to: ${values["dump-analysis"]}`);
  }

  console.error(
    `\nAggregating insights from ${relevantInsights.length} relevant sessions...`
  );
  const finalReport = await aggregateInsights(relevantInsights, genAI, {
    directory: resolvedTargetDir,
    totalFound: totalFoundCount,
    selectedCount: selectedCount,
    analyzedCount: sessionInsights.length,
    relevantCount: relevantInsights.length,
    failedCount: failedCount,
    skippedCount: skippedCount,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes
  });

  fs.writeFileSync(outputFile, finalReport);
  console.log(`Report written to: ${outputFile}`);
}

async function processLogFile(
  filePath: string,
  genAI: GoogleGenAI
): Promise<BaseProcessResult<JetpackInsight> | null> {
  const resultData = readAndFormatChatLog(filePath);
  if (!resultData) return null;

  const { content: transcript, rawSize, filteredSize } = resultData;

  // Check if "jetpack" is even mentioned in the transcript to save LLM calls
  if (!transcript.toLowerCase().includes("jetpack")) {
    return {
      insight: { has_jetpack_usage: false },
      rawSize,
      filteredSize
    };
  }

  const prompt = `
<role>
You are an expert analyst investigating the usage of the 'jetpack' CLI tool within a developer's workflow.
</role>

<instructions>
1. **Plan**: Scan the log to identify every invocation of the \`jetpack\` command. If none, set \`has_jetpack_usage\` to false.
2. **Execute**: For each invocation, extract the following:
    - **Command**: The full command string.
    - **User Intent**: Categorize *why* the user ran this command:
        - \`debug_crash\`: Investigating a runtime error or stack trace.
        - \`explore_source\`: Reading code to understand logic or find implementations.
        - \`verify_version\`: Checking library versions (Alpha/Beta/SNAPSHOT).
        - \`resolve_dependency\`: Finding the artifact for a class or fixing build errors.
        - \`unknown\`: Cannot determine from context.
    - **Outcome**: Was the command successful?
    - **Failure Type**: If it failed, categorize the failure:
        - \`tool_crash\`: The tool threw an exception or returned an error code.
        - \`user_error\`: Invalid arguments or command syntax.
        - \`empty_result\`: Tool ran but returned nothing useful (e.g., class not found).
        - \`none\`: Success.
    - **Friction**: Note any retries, confusion, or workarounds the user employed.
    - **Improvement Idea**: Suggest how the tool could have prevented this specific friction.
3. **Validate**: Review your extraction against the log context. Ensure the intent matches the user's surrounding dialogue.
</instructions>

<log_excerpt>
${transcript}
</log_excerpt>
`;

  const result = await genAI.models.generateContent({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          has_jetpack_usage: { type: Type.BOOLEAN },
          invocations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                command: { type: Type.STRING },
                subcommand: { type: Type.STRING },
                args: { type: Type.STRING },
                user_intent: {
                  type: Type.STRING,
                  enum: [
                    "debug_crash",
                    "explore_source",
                    "verify_version",
                    "resolve_dependency",
                    "unknown"
                  ]
                },
                outcome: {
                  type: Type.STRING,
                  enum: ["success", "error", "confusion"]
                },
                failure_type: {
                  type: Type.STRING,
                  enum: ["tool_crash", "user_error", "empty_result", "none"]
                },
                friction_points: { type: Type.STRING },
                improvement_idea: { type: Type.STRING }
              },
              required: ["command", "user_intent", "outcome", "failure_type"]
            }
          }
        },
        required: ["has_jetpack_usage"]
      }
    }
  });

  const text = result.text;
  if (!text) return null;
  const data = JSON.parse(text);
  data.sessionFile = filePath;

  return {
    insight: data,
    rawSize: rawSize,
    filteredSize: filteredSize
  };
}

async function aggregateInsights(
  insights: JetpackInsight[],
  genAI: GoogleGenAI,
  metadata: {
    directory: string;
    totalFound: number;
    selectedCount: number;
    analyzedCount: number;
    relevantCount: number;
    failedCount: number;
    skippedCount: number;
    totalRawBytes: number;
    totalFilteredBytes: number;
    totalSummarizedBytes: number;
  }
): Promise<string> {
  const sessionData = insights.map((insight) => ({
    session: insight.sessionFile
      ? path.basename(insight.sessionFile)
      : "unknown",
    invocations: insight.invocations || []
  }));
  const inputData = JSON.stringify(sessionData, null, 2);
  const inputSize = Buffer.byteLength(inputData, "utf8");

  console.error(`Aggregation Input Size: ${inputSize} bytes`);

  if (inputSize > MAX_AGGREGATION_BYTES) {
    console.error(
      `WARNING: Input data (${inputSize} bytes) exceeds the limit of ${MAX_AGGREGATION_BYTES} bytes. Aggregation might fail.`
    );
  }

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");

  const prompt = `
<role>
You are a Product Manager for the "Android Developer Tools" team. You are writing a Product Requirements Document (PRD) for the next version of the \`jetpack\` CLI tool.
</role>

<context>
Target Directory: ${metadata.directory}
Analysis Date: ${now}
Data:
- Analyzed Sessions: ${metadata.analyzedCount}
- Sessions with Jetpack Usage: ${metadata.relevantCount}
</context>

<instructions>
Synthesize the provided usage data into a structured **Product Requirements Document (PRD)**.

**Report Structure:**

1.  **Header**:
    *   Title: "# Jetpack Tool: Usage Analysis & PRD"
    *   Date: "Date: ${now}"
    *   Target: "Target Directory: ${metadata.directory}"
2.  **Executive Summary**: Brief overview of how the tool is currently being used and the primary pain points.
3.  **Quantitative Usage**:
    *   **Intent Breakdown**: Breakdown of \`user_intent\` (e.g., "60% Debugging Crash", "30% Explore Source").
    *   **Failure Analysis**: Breakdown of \`failure_type\` (e.g., "Most failures were 'empty_result' due to missing artifacts").
4.  **Friction Analysis (The "Why it's hard")**:
    *   Detail specific failure modes (e.g., "Agent tries to search but tool doesn't support it").
    *   Highlight user confusion (e.g., "Agent unsure if it needs to specify version").
    *   Identify "workarounds" the agent had to perform.
5.  **Product Requirements (The "What we need to build")**:
    *   **P0 (Critical)**: Fixes for common errors or severe usability issues.
    *   **P1 (Important)**: New features that would significantly speed up workflows (e.g., "Add \`search\` command").
    *   **P2 (Nice to have)**: Quality of life improvements (e.g., "JSON output format").
6.  **Conclusion**: Final recommendation on the direction for the tool.

**Tone**: Professional, actionable, data-driven.
</instructions>

<input_data>
${inputData}
</input_data>
`;

  const result = await genAI.models.generateContent({
    model: AGGREGATION_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }]
  });
  return result.text || "No report generated.";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
