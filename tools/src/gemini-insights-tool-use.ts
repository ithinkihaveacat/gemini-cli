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

interface SessionInsight {
  sessionFile?: string;
  tools?: Array<{
    category: string;
    specific_tool: string;
    params?: string;
    is_edge_case: boolean;
    human_suggested: boolean;
    debugging_context?: string;
    notes?: string;
  }>;
}

function usage() {
  const scriptName = path.basename(process.argv[1]);
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY OUTPUT_FILE

Extracts tool usage insights from Gemini CLI logs for a given directory.

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
  ): Promise<BaseProcessResult<SessionInsight> | null> => {
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

  if (sessionInsights.length === 0) {
    console.log("No insights extracted.");
    process.exit(0);
  }

  if (values["dump-analysis"]) {
    let rawOutput = "# Raw Analysis Output\n\n";
    for (const insight of sessionInsights) {
      if (insight.sessionFile) {
        rawOutput += `## Session: ${path.basename(insight.sessionFile)}\n\n`;
      } else {
        rawOutput += `## Session: Unknown\n\n`;
      }

      if (insight.tools && insight.tools.length > 0) {
        rawOutput += "```json\n";
        rawOutput += JSON.stringify(insight.tools, null, 2);
        rawOutput += "\n```\n\n";
      } else {
        rawOutput += "_No tools detected._\n\n";
      }
      rawOutput += "---\n\n";
    }
    fs.writeFileSync(values["dump-analysis"], rawOutput);
    console.error(`Raw output written to: ${values["dump-analysis"]}`);
  }

  console.error("\nAggregating insights...");
  const finalReport = await aggregateInsights(sessionInsights, genAI, {
    directory: resolvedTargetDir,
    totalFound: totalFoundCount,
    selectedCount: selectedCount,
    analyzedCount: sessionInsights.length,
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
): Promise<BaseProcessResult<SessionInsight> | null> {
  const resultData = readAndFormatChatLog(filePath);
  if (!resultData) return null;

  const { content: transcript, rawSize, filteredSize } = resultData;

  // Refined prompt based on gemini-text-analysis.md strategies
  const prompt = `
<role>
You are an expert software engineering analyst specializing in evaluating the effectiveness of tools used by AI agents.
</role>

<instructions>
1. **Analyze** the provided log to identify every tool invocation, command, or distinct action taken by the agent.
2. **Goal**: Identify which tools were essential, which were efficient, and where the agent struggled or needed to invent its own solutions.
3. **Focus** on "tools" in the broadest sense:
    - Standard CLI tools (grep, find, git).
    - Build systems (gradlew).
    - Device interactions (adb, emumanager).
    - Specialized skills (jetpack-inspect, screenshot-compare).
    - *Debugging workflows*: Note simultaneous actions (e.g., background logcat + UI manipulation).
    - **Script Creation & Modification**: identify when the agent writes a script (bash, python, etc.) to investigate behavior or automate a task.
4. **Extract** details for each tool:
    - **Category**: Broad classification.
    - **Specific Tool**: The exact command or skill name.
    - **Params**: Key arguments/constraints (e.g., specific API levels, --snapshot).
    - **Context**: Why was it used? Was it part of a debugging loop?
    - **Human Intervention**: Did a human prompt its use or suggest the script creation?
    - **Hunt & Resolve**: Did the agent "hunt" for a tool or create one to resolve an error or missing capability?
    - **Utility/Gap**: Was this tool highly effective, or was it a workaround for a missing capability?
</instructions>

<constraints>
- Output must be valid JSON matching the provided schema.
- Be exhaustive: capture even single-use tools if they solved a specific problem.
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
          tools: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                category: { type: Type.STRING },
                specific_tool: { type: Type.STRING },
                params: { type: Type.STRING },
                is_edge_case: { type: Type.BOOLEAN },
                human_suggested: { type: Type.BOOLEAN },
                debugging_context: {
                  type: Type.STRING,
                  description:
                    "Details on debugging workflow (e.g., background processes, monitoring)."
                },
                notes: { type: Type.STRING }
              },
              required: [
                "category",
                "specific_tool",
                "is_edge_case",
                "human_suggested"
              ]
            }
          }
        }
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
  insights: SessionInsight[],
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
  const sessionData = insights.map((insight) => ({
    session: insight.sessionFile
      ? path.basename(insight.sessionFile)
      : "unknown",
    tools: insight.tools || []
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
You are a Product Manager for an "AI for Android Development" platform.
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
- Compression Ratio (Raw -> Summary): ${(metadata.totalRawBytes / metadata.totalSummarizedBytes || 0).toFixed(1)}x
</context>

<instructions>
Synthesize the provided JSON list of tool usages into a comprehensive "Agent Capabilities & Tooling Requirements Report".
The goal of this report is to inform the development of a standard toolset for Android-focused AI agents.

**Report Structure:**

1.  **Header**:
    *   Title: "# Gemini CLI Tool Usage Report"
    *   Date: "Date: ${now}" (on a new line)
    *   Target Directory: "Target Directory: ${metadata.directory}" (on a new line)
2.  **Executive Summary**: High-level overview of the agent's demonstrated workflows and key tool dependencies.
3.  **Essential Toolset (The "Standard Library")**:
    *   Group tools logically (5-10 categories).
    *   For each, list the specific tools/commands that proved most useful.
    *   Describe *why* they are essential for an Android agent.
4.  **Custom Tool Creation & "Missing" Tools**:
    *   Highlight instances where the agent **created** or **modified** scripts. These represent **GAPS** in the standard toolset.
    *   Analyze "hunting" behaviors where the agent struggled to find the right tool.
    *   *Actionable Insight*: What standard tool should be built to replace these ad-hoc scripts?
5.  **Advanced Debugging Workflows**:
    *   Describe complex, multi-step workflows (e.g., log injection + UI automation).
    *   Highlight tools that enabled "super-human" or highly efficient debugging (e.g., AI vision for UI verification).
6.  **Edge Cases & Environment Constraints**:
    *   Specific versions (SNAPSHOTs, API levels) and how tools handled them.
7.  **Recommendations for Future Tooling**:
    *   Based on the analysis, propose a prioritized list of tools/capabilities that should be added to the core Android Agent platform to improve efficiency and autonomy.

**Note:** The input data may be large. Do not truncate the list of tools; a longer, detailed report is preferred over a summary that misses edge cases.
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
