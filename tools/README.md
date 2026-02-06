# Custom Gemini CLI Tools

This directory contains custom auxiliary tools for the Gemini CLI. These tools
are designed to interact with Gemini CLI data (like history files) using the
official core libraries, ensuring compatibility with the data formats used by
the main application.

## Relationship to Main Repository

These tools are developed separately from the main `gemini-cli` packages
(`packages/cli`, `packages/core`) but have a direct dependency on
`@google/gemini-cli-core`.

- **Dependency**: The tools link directly to the local `packages/core`
  directory.
- **Isolation**: They are kept in this `tools/` directory to minimize conflicts
  with the main codebase and have their own `package.json` and build process.

## Building and Running

### Prerequisites

- Node.js (>= 20.0.0)
- npm

### Build

To build the tools, run the provided build script. This script will first ensure
the main `packages/core` is built and up-to-date, then install dependencies for
these tools and compile them.

```bash
./tools/build.sh
```

### Run

After building, the compiled JavaScript files are located in `tools/dist`. You
can run them using `node`.

**Example: Running gemini-history**

```bash
node tools/dist/gemini-history.js [path/to/project]
```

**Example: Running gemini-insights**

```bash
node tools/dist/gemini-insights.js [path/to/project]
```

## Tools

### `gemini-history`

Lists user questions from the latest gemini-cli session for a given directory.

### `gemini-insights`

Analyzes Gemini CLI chat logs to extract insights about tool usage, debugging
workflows, and agent capabilities. It generates a comprehensive Markdown report
useful for tool developers and product managers.

**Features:**

- **Parallel Analysis:** Processes multiple chat logs concurrently.
- **Aggregation:** Synthesizes findings into a structured report.
- **Gap Analysis:** Identifies custom scripts created by the agent, highlighting
  missing standard tools.

**Usage:**

```bash
node tools/dist/gemini-insights.js [OPTIONS] DIRECTORY
```

**Options:**

- `--limit <NUMBER>`: Analyze the N most recent conversations (default: 30).
- `--all`: Analyze all conversations in the directory.

**Requirements:**

- `GEMINI_API_KEY`: Must be set in the environment.

## Maintenance and Troubleshooting

Since these tools import directly from the internal structure of
`@google/gemini-cli-core`, they may be susceptible to breaking changes in the
main repository.

### Common Issues & Solutions

1.  **Module Resolution Errors (`Cannot find module...`)**
    - **Cause**: The file structure in `packages/core` may have changed (files
      moved or renamed).
    - **Fix**: Check the `packages/core/dist` directory to find the new location
      of the required files and update the import paths in `tools/src/*.ts`.
    - **Tip**: The `tools/tsconfig.json` maps `@google/gemini-cli-core/*` to
      `../packages/core/*`. Ensure this mapping remains valid.

2.  **Type Errors**
    - **Cause**: Interfaces or function signatures in `packages/core` (e.g.,
      `ConversationRecord`, `partListUnionToString`) have changed.
    - **Fix**: Update the TypeScript code in `tools/src/` to match the new
      definitions. You can often find the updated types by looking at the source
      code in `packages/core/src`.

3.  **Build Failures**
    - **Cause**: The local `packages/core` might not be built or is in an
      inconsistent state.
    - **Fix**: Run `./tools/build.sh` again. It explicitly triggers a rebuild of
      `packages/core` before building these tools.

### Development Guidelines

- **Imports**: When importing from core, try to import from stable utilities or
  services. Avoid deep links into internal implementation details if possible.
- **Data Handling**: Always use the provided utility functions (like
  `partListUnionToString`) to handle data structures, as these handle backward
  compatibility and format changes (e.g., string vs. array content).
