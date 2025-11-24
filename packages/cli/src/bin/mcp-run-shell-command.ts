/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ShellExecutionService,
  stripShellWrapper,
} from '@google/gemini-cli-core';
import path from 'node:path';
import process from 'node:process';

const server = new McpServer({
  name: 'gemini-cli-mcp',
  version: '1.0.0',
});

server.registerTool(
  'run_shell_command',
  {
    description: `Executes a shell command on the host system.

This tool allows you to run command-line utilities, scripts, and system commands.
It supports standard shell features like piping and redirection, allowing you to filter and process output directly.

### Capabilities

- Execution: Runs commands in a sub-shell (bash on Unix, PowerShell/cmd on Windows).
- Environment: Inherits the host environment variables.

### Examples

1. Basic Execution
   List files in the current directory:
   ls -la

2. Searching and Filtering (Pipes)
   Find specific processes using grep:
   ps aux | grep node

3. File Operations (Redirection)
   Write command output to a file:
   echo "log entry" >> system.log

4. Chaining Commands
   Run multiple commands in sequence:
   npm install && npm run build

5. Processing JSON
   Use jq to extract data (if installed):
   cat data.json | jq .version`,
    inputSchema: {
      command: z.string().describe('The command to execute'),
      description: z.string().optional().describe('Description of the command'),
      dir_path: z.string().optional().describe('Directory to execute in'),
    },
    outputSchema: {
      command: z.string(),
      directory: z.string(),
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().nullable(),
      signal: z.number().nullable(),
      error: z.string().optional(),
    },
  },
  async ({ command, dir_path }) => {
    const cwd = dir_path
      ? path.resolve(process.cwd(), dir_path)
      : process.cwd();
    const cleanCommand = stripShellWrapper(command);

    // We use a fresh AbortController for each request.
    // In a future iteration, we could wire this up to MCP cancellation tokens.
    const abortController = new AbortController();

    // Execute the command. We don't use PTY for this headless MCP server to ensure
    // clean output capture and avoid terminal control codes complicating the response,
    // unless specifically requested or needed. Defaulting to false for safety.
    const { result } = await ShellExecutionService.execute(
      cleanCommand,
      cwd,
      () => {
        // We rely on the final accumulated result for now.
        // Streaming support could be added later via MCP notifications if the protocol supports it.
      },
      abortController.signal,
      false, // shouldUseNodePty
      {},
    );

    const executionResult = await result;

    const structuredOutput = {
      command,
      directory: dir_path || cwd,
      stdout: executionResult.output || '',
      // ShellExecutionService combines stdout and stderr into a single 'output' string.
      // Since separate streams are not available in the result, we map the combined output
      // to 'stdout' and leave 'stderr' empty.
      stderr: '',
      exitCode: executionResult.exitCode,
      signal: executionResult.signal,
      error: executionResult.error ? executionResult.error.message : undefined,
    };

    return {
      content: [
        { type: 'text', text: JSON.stringify(structuredOutput, null, 2) },
      ],
      structuredContent: structuredOutput,
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
