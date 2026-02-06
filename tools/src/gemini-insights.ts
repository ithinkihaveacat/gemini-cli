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
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

const ANALYSIS_MODEL = "gemini-3-flash-preview";
const AGGREGATION_MODEL = "gemini-3-pro-preview";
const DEFAULT_CONVERSATION_LIMIT = 30;
const CONCURRENCY_LIMIT = 10;
const MAX_RETRIES_PER_REQUEST = 3;
const MAX_TOTAL_RETRIES = 10;

interface SessionInsight {
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
  console.log(`Usage: ${scriptName} [OPTIONS] DIRECTORY

Extracts tool usage insights from Gemini CLI logs for a given directory.

Arguments:
  DIRECTORY         The directory to look up history for.

Options:
  --limit NUMBER    Number of recent conversations to analyze (default: ${DEFAULT_CONVERSATION_LIMIT}).
  --all             Analyze all conversations (overrides --limit).
  -h, --help        Display this help message and exit

Environment:
  GEMINI_API_KEY    Required. Your Gemini API key.
`);
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      limit: { type: "string" },
      all: { type: "boolean" }
    },
    allowPositionals: true
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  if (positionals.length === 0) {
    usage();
    process.exit(1);
  }

  const targetDirArg = positionals[0];
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

  if (chatFiles.length === 0) {
    console.log("No chat logs found.");
    process.exit(0);
  }

  // Filter based on limit/all
  if (!values.all) {
    const limit = values.limit
      ? parseInt(values.limit, 10)
      : DEFAULT_CONVERSATION_LIMIT;
    if (isNaN(limit)) {
      console.error("Invalid limit specified.");
      process.exit(1);
    }
    chatFiles = chatFiles.slice(0, limit);
    console.error(`Analyzing most recent ${chatFiles.length} logs...`);
  } else {
    console.error(`Analyzing all ${chatFiles.length} logs...`);
  }

  const sessionInsights = await analyzeInParallel(
    chatFiles.map((f) => f.path),
    genAI
  );

  if (sessionInsights.length === 0) {
    console.log("No insights extracted.");
    process.exit(0);
  }

  console.error("Aggregating insights...");
  const finalReport = await aggregateInsights(sessionInsights, genAI);
  console.log(finalReport);
}

// Global retry counter
let totalRetries = 0;

async function analyzeInParallel(
  filePaths: string[],
  genAI: GoogleGenAI
): Promise<SessionInsight[]> {
  const results: SessionInsight[] = [];
  const queue = [...filePaths];
  const activePromises: Set<Promise<void>> = new Set();

  return new Promise((resolve) => {
    const next = () => {
      if (queue.length === 0 && activePromises.size === 0) {
        resolve(results);
        return;
      }

      while (activePromises.size < CONCURRENCY_LIMIT && queue.length > 0) {
        const filePath = queue.shift()!;
        const promise = (async () => {
          const result = await processLogFileWithRetry(filePath, genAI);
          if (result) {
            results.push(result);
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

async function processLogFileWithRetry(
  filePath: string,
  genAI: GoogleGenAI
): Promise<SessionInsight | null> {
  let attempts = 0;
  while (attempts <= MAX_RETRIES_PER_REQUEST) {
    try {
      return await processLogFile(filePath, genAI);
    } catch (e: unknown) {
      const isQuotaError =
        typeof e === "object" &&
        e !== null &&
        "status" in e &&
        (e as { status: unknown }).status === 429;

      if (isQuotaError) {
        console.error("Quota exceeded (429). Stopping analysis immediately.");
        process.exit(1); // Fail hard on quota
      }

      attempts++;
      totalRetries++;

      if (totalRetries > MAX_TOTAL_RETRIES) {
        console.error(
          `Max total retries (${MAX_TOTAL_RETRIES}) exceeded. Skipping ${path.basename(filePath)}.`
        );
        return null;
      }

      if (attempts > MAX_RETRIES_PER_REQUEST) {
        const errorMessage =
          typeof e === "object" && e !== null && "message" in e
            ? (e as { message: string }).message
            : String(e);

        console.error(
          `Failed to process ${path.basename(filePath)} after ${attempts} attempts:`,
          errorMessage
        );
        return null;
      }

      // Exponential backoff with jitter
      const delay = Math.pow(2, attempts) * 1000 + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

async function processLogFile(
  filePath: string,
  genAI: GoogleGenAI
): Promise<SessionInsight | null> {
  const content = fs.readFileSync(filePath, "utf8");
  const session: ConversationRecord = JSON.parse(content);

  const transcript = session.messages
    .map((m: MessageRecord) => {
      const role = m.type.toUpperCase();
      const text = partListUnionToString(m.content);
      return `${role}: ${text}`;
    })
    .join("\n\n");

  if (!transcript.trim()) return null;

  // Refined prompt based on gemini-text-analysis.md strategies
  const prompt = `
<role>
You are an expert software engineering analyst specializing in extracting tool usage patterns from AI agent logs.
</role>

<instructions>
1. **Analyze** the provided log to identify every tool invocation, command, or distinct action taken by the agent.
2. **Focus** on "tools" in the broadest sense:
    - Standard CLI tools (grep, find, git).
    - Build systems (gradlew).
    - Device interactions (adb, emumanager).
    - Specialized skills (jetpack-inspect, screenshot-compare).
    - *Debugging workflows*: Note simultaneous actions (e.g., background logcat + UI manipulation).
3. **Extract** details for each tool:
    - **Category**: Broad classification.
    - **Specific Tool**: The exact command or skill name.
    - **Params**: Key arguments/constraints (e.g., specific API levels, --snapshot).
    - **Context**: Why was it used? Was it part of a debugging loop?
    - **Human Intervention**: Did a human prompt its use?
</instructions>

<constraints>
- Output must be valid JSON matching the provided schema.
- Be exhaustive: capture even single-use tools if they solved a specific problem.
</constraints>

<log_excerpt>
${transcript.slice(0, 60000)}
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
  return JSON.parse(text);
}

async function aggregateInsights(
  insights: SessionInsight[],
  genAI: GoogleGenAI
): Promise<string> {
  const allTools = insights.flatMap((i) => i.tools || []);

  const prompt = `
<role>
You are a technical lead creating a "Tool Usage Report" for an AI coding agent.
</role>

<instructions>
Synthesize the provided JSON list of tool usages into a structured Markdown report.

**Report Structure:**

1.  **Executive Summary**: High-level overview of the agent's toolkit and capabilities.
2.  **Tool Categories**: Group tools logically (5-10 categories). For each:
    *   List specific tools/commands.
    *   Describe *how* and *why* they were used.
3.  **Debugging & Advanced Workflows**:
    *   Highlight complex interactions (e.g., "The agent ran \`adb logcat\` in the background while triggering UI events via \`adb shell input\`").
    *   Note efficient alternatives found (e.g., "Preferred \`adb-screenshot\` over \`screencap\` for speed").
4.  **Edge Cases & Constraints**:
    *   Specific versions (SNAPSHOTs, API levels).
    *   Workarounds for environment limitations.
5.  **Human-AI Collaboration**:
    *   Instances where human guidance unlocked new tool capabilities.
</instructions>

<input_data>
${JSON.stringify(allTools, null, 2).slice(0, 100000)}
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
