# Plan: Expose `run_shell_command` via MCP

This plan outlines how to expose the existing `run_shell_command` tool
functionality via the Model Context Protocol (MCP) by creating a new entry point
in the CLI package. This approach minimizes changes to the existing codebase
while leveraging the core logic in `ShellExecutionService`.

## Objective

Create an MCP server that exposes the `run_shell_command` tool, matching the
input/output interface of the existing `ShellTool` as closely as possible.

## Architecture

- **Location:** `packages/cli/src/bin/mcp-run-shell-command.ts` (New entry
  point).
- **Dependencies:**
  - `packages/core`: Re-use `ShellExecutionService` and `shell-utils`.
  - `@modelcontextprotocol/sdk`: For MCP server implementation.
  - `zod`: For schema definition.
- **Transport:** `StdioServerTransport` (allows running via `npx` or directly as
  a subprocess).

## Steps

### 1. Add Dependencies

Update `packages/cli/package.json` to include:

- `@modelcontextprotocol/sdk`
- `zod` (Peer dependency of the SDK)

### 2. Create MCP Server Entry Point

Create a new file `packages/cli/src/bin/mcp-run-shell-command.ts`. This file
will:

1.  **Initialize `McpServer`:**

    ```typescript
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

    const server = new McpServer({
      name: 'gemini-cli-mcp',
      version: '1.0.0', // Should match package version ideally
    });
    ```

2.  **Register `run_shell_command` Tool:** Define the tool using the same
    parameters as `ShellTool`:
    - `command` (string, required): The command to execute.
    - `description` (string, optional): Description of the command.
    - `dir_path` (string, optional): Working directory.

3.  **Implement Tool Handler:** The handler will:
    - **Resolve Directory:** Use `process.cwd()` or the provided `dir_path`.
    - **Prepare Command:**
      - Import `stripShellWrapper` from `packages/core/src/utils/shell-utils.ts`
        to clean the command if necessary (matching `ShellTool` behavior).
    - **Execute:**
      - Import `ShellExecutionService` from
        `packages/core/src/services/shellExecutionService.ts`.
      - Call `ShellExecutionService.execute`.
      - **Configuration:**
        - `shouldUseNodePty`: Default to `false` (or `true` if we want PTY
          behavior, but strictly `false` is safer for headless MCP).
        - `shellExecutionConfig`: Default empty config.
        - `abortSignal`: Create a signal that can be triggered if the MCP
          request is cancelled (if supported) or just a fresh signal.
      - **Output Handling:**
        - Collect output events from the callback.
        - Since `ShellExecutionService` streams, we verify if we need to
          accumulate it. `ShellExecutionResult` returned by the promise contains
          the full `output`.
    - **Format Output:**
      - Construct the output string matching `ShellTool`'s `llmContent` format:
        ```text
        Command: <command>
        Directory: <dir>
        Output: <output>
        Error: <error>
        Exit Code: <code>
        ...
        ```
    - **Return:** Return the formatted text as the tool result.

4.  **Connect Transport:**
    - Connect the server to `StdioServerTransport`.

### 3. Expose Binary (Optional)

Optionally add a `bin` entry in `package.json` or a script to run this easily,
e.g., `gemini-mcp`.

## Implementation Details

### Handling Dependencies & Config

- **Avoid `Config` dependency:** The existing `ShellTool` heavily relies on the
  monolithic `Config` class. To avoid complex instantiation, we will **not** use
  `ShellTool` directly.
- **Logic Replication:** We will replicate the critical parts of
  `ShellTool.execute` manually:
  - `stripShellWrapper` call.
  - `ShellExecutionService.execute` call.
  - Output formatting.
- **Permissions:** We will **skip** the `isCommandAllowed` check found in
  `ShellTool`. In the MCP model, the _Host_ (Client) is responsible for asking
  the user for approval ("Do you want to run this command?"). Re-implementing
  the CLI's specific config-based allowlist inside the MCP server adds
  unnecessary complexity and dependency weight for this use case.

### Code Sketch (Mental Draft)

```typescript
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ShellExecutionService } from '@gemini-cli/core/services/shellExecutionService';
import { stripShellWrapper } from '@gemini-cli/core/utils/shell-utils';
import path from 'path';

// ... setup server ...

server.registerTool(
  'run_shell_command',
  {
    command: z.string(),
    description: z.string().optional(),
    dir_path: z.string().optional(),
  },
  async ({ command, dir_path }) => {
    const cwd = dir_path
      ? path.resolve(process.cwd(), dir_path)
      : process.cwd();
    const cleanCommand = stripShellWrapper(command);

    // Execute
    const { result } = await ShellExecutionService.execute(
      cleanCommand,
      cwd,
      () => {}, // We rely on the final result, not streaming for now
      new AbortController().signal,
      false, // No PTY
      {},
    );
    const executionResult = await result;

    // Format Output (paraphrased from ShellTool)
    const output =
      `Command: ${command}\n` +
      `Directory: ${cwd}\n` +
      `Output: ${executionResult.output || '(empty)'}\n` +
      `Exit Code: ${executionResult.exitCode}`;

    return { content: [{ type: 'text', text: output }] };
  },
);

// ... connect transport ...
```

## Verification Plan

1.  Build the `cli` package.
2.  Run the MCP server script manually.
3.  Use an MCP inspector or a simple script to send a JSON-RPC request to
    `stdin` and verify the `stdout` response.
