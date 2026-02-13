/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { getProjectHash } from "@google/gemini-cli-core/dist/src/utils/paths.js";
import {
  analyzeInParallel,
  formatBytes,
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

interface FrictionInsight {
  sessionFile?: string;
  friction_points?: Array<{
    task_description: string;
    friction_type:
      | "autonomous_retry"
      | "user_intervention"
      | "hunting"
      | "repetition"
      | "tool_failure"
      | "other";
    severity: "low" | "medium" | "high";
    resolution: "success" | "failure" | "partial";
    details: string;
    user_quote?: string;
  }>;
}

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY OUTPUT_FILE

Extracts "friction" insights from Gemini CLI logs for a given directory.
Focuses on identifying tasks where the agent had to retry, hunt for information, or required user intervention.

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
  ): Promise<BaseProcessResult<FrictionInsight> | null> => {
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
    results: frictionInsights,
    totalRawBytes,
    totalFilteredBytes,
    totalSummarizedBytes,
    failedCount,
    skippedCount
  } = await analyzeInParallel(
    chatFiles.map((f) => f.path),
    processLogFileWrapper
  );

  if (frictionInsights.length === 0) {
    console.log("No insights extracted.");
    process.exit(0);
  }

  if (values["dump-analysis"]) {
    let rawOutput = "# Raw Friction Analysis Output\n\n";
    for (const insight of frictionInsights) {
      if (insight.sessionFile) {
        rawOutput += `## Session: ${path.basename(insight.sessionFile)}\n\n`;
      } else {
        rawOutput += `## Session: Unknown\n\n`;
      }

      if (insight.friction_points && insight.friction_points.length > 0) {
        rawOutput += "```json\n";
        rawOutput += JSON.stringify(insight.friction_points, null, 2);
        rawOutput += "\n```\n\n";
      } else {
        rawOutput += "_No friction detected._\n\n";
      }
      rawOutput += "---\n\n";
    }
    fs.writeFileSync(values["dump-analysis"], rawOutput);
    console.error(`Raw output written to: ${values["dump-analysis"]}`);
  }

  console.error("\nAggregating insights...");
  const finalReport = await aggregateInsights(frictionInsights, genAI, {
    directory: resolvedTargetDir,
    totalFound: totalFoundCount,
    selectedCount: selectedCount,
    analyzedCount: frictionInsights.length,
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
): Promise<BaseProcessResult<FrictionInsight> | null> {
  const resultData = readAndFormatChatLog(filePath);
  if (!resultData) return null;

  const { content: transcript, rawSize, filteredSize } = resultData;

  // Refined prompt based on gemini-text-analysis.md strategies
  const prompt = `
<role>
You are an expert software engineering analyst specializing in evaluating AI agent performance and identifying friction points.
</role>

<instructions>
1. **Analyze** the provided log to identify moments of "friction" where the agent struggled.
2. **Definition of Friction**:
    - **Autonomous Retries**: The agent tries essentially the same action multiple times (loops) or tries slightly different variations without success.
    - **User Intervention**: The user has to step in to correct the agent ("no, stop", "try this instead"), provide a hint, or interrupt a failing process.
    - **Hunting**: The agent blindly searches for information (e.g., repeatedly using 'find' or 'grep' with different patterns) to locate a file or code snippet (especially source code).
    - **Tool Failure**: The agent attempts to use a tool that fails or doesn't exist, and struggles to recover.
    - **Repetition**: The agent repeats the same output or mistake.
3. **Extract** details for each friction point:
    - **Task Description**: What was the high-level goal?
    - **Type**: Classify the friction (autonomous_retry, user_intervention, hunting, repetition, tool_failure, other).
    - **Severity**: How disruptive was it? (Low: minor delay; Medium: required several turns; High: user had to intervene or agent gave up).
    - **Resolution**: Did it eventually succeed?
    - **Details**: Specific context (e.g., "Tried to grep for 'MainActivity' 3 times", "User said 'use ripgrep'").
</instructions>

<constraints>
- Output must be valid JSON matching the provided schema.
- Only report actual friction points. If the interaction was smooth, return an empty list.
</constraints>

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
          friction_points: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                task_description: { type: Type.STRING },
                friction_type: {
                  type: Type.STRING,
                  enum: [
                    "autonomous_retry",
                    "user_intervention",
                    "hunting",
                    "repetition",
                    "tool_failure",
                    "other"
                  ]
                },
                severity: {
                  type: Type.STRING,
                  enum: ["low", "medium", "high"]
                },
                resolution: {
                  type: Type.STRING,
                  enum: ["success", "failure", "partial"]
                },
                details: { type: Type.STRING },
                user_quote: { type: Type.STRING }
              },
              required: [
                "task_description",
                "friction_type",
                "severity",
                "resolution",
                "details"
              ]
            }
          }
        }
      }
    }
  });

  const text = result.text;
  if (!text) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error(`Failed to parse JSON for ${path.basename(filePath)}`);
    return null;
  }

  data.sessionFile = filePath;

  return {
    insight: data,
    rawSize: rawSize,
    filteredSize: filteredSize
  };
}

async function aggregateInsights(
  insights: FrictionInsight[],
  genAI: GoogleGenAI,
  metadata: {
    directory: string;
    totalFound: number;
    selectedCount: number;
    analyzedCount: number;
    failedCount: number;
    skippedCount: number;
    totalRawBytes: number;
    totalFilteredBytes: number;
    totalSummarizedBytes: number;
  }
): Promise<string> {
  const sessionData = insights
    .map((insight) => ({
      session: insight.sessionFile
        ? path.basename(insight.sessionFile)
        : "unknown",
      friction_points: insight.friction_points || []
    }))
    .filter((s) => s.friction_points.length > 0); // Only include sessions with friction

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
You are a Product Manager and UX Researcher for an "AI for Android Development" platform.
</role>

<context>
Target Directory: ${metadata.directory}
Analysis Date: ${now}
Input Statistics:
- Total Logs Found: ${metadata.totalFound}
- Logs Selected for Analysis: ${metadata.selectedCount}
- Successfully Analyzed: ${metadata.analyzedCount}
- Failed Analysis: ${metadata.failedCount}
- Skipped (Size Limit Reached): ${metadata.skippedCount}

Data Volume:
- Total Raw Input Log Size: ${formatBytes(metadata.totalRawBytes)}
- Total Filtered Input Size (for Analysis): ${formatBytes(metadata.totalFilteredBytes)}
- Total Summarized Input Size (for Aggregation): ${formatBytes(metadata.totalSummarizedBytes)}
</context>

<instructions>
Synthesize the provided JSON list of "Agent Friction Points" into a comprehensive "Friction & Failure Report".
The goal is to identify where the agent is failing, frustrating users, or wasting time, to inform product improvements.

**Report Structure:**

1.  **Header**:
    *   Title: "# Gemini CLI Friction & Failure Report"
    *   Date: "Date: ${now}\\" (on a new line)
    *   Target Directory: "Target Directory: ${metadata.directory}"
2.  **Executive Summary**: High-level overview of the friction points. Is the agent generally reliable, or does it struggle with specific categories of tasks?
3.  **Top Friction Categories**:
    *   Group the friction points into logical categories (e.g., "File Navigation", "Build Errors", "Code Editing", "Context Gathering").
    *   For each category, describe the common failure modes.
    *   *Example*: "The agent frequently struggles to find source files for Android classes, often resorting to brute-force \`grep\`."
3.  **User Intervention Patterns**:
    *   When do users typically intervene?
    *   What are the common corrections users have to make?
    *   *Insight*: Are users guiding the agent because it's lost, or because it's about to make a mistake?
4.  **"Hunting" Behaviors**:
    *   Analyze instances where the agent blindly searches for information.
    *   What specific information is it usually looking for? (e.g., specific class definitions, resource IDs).
    *   *Recommendation*: What new tool or capability would solve this? (e.g., "A dedicated \`find_class\` tool").
5.  **Severity Analysis**:
    *   Highlight the "High Severity" incidents where the agent completely failed or required major user intervention.
6.  **Recommendations for Improvement**:
    *   Propose concrete actions:
        *   **New Tools**: (e.g., "Add a tool to resolve Android resource IDs").
        *   **Prompt Improvements**: (e.g., "Instruct the agent to ask for help sooner instead of looping").
        *   **UX Changes**: (e.g., "Better error messages").

**Note:**
- The input contains raw "friction" events. Synthesize them into patterns. Do not just list every single event.
- Use the provided Analysis Date in the report header.
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
