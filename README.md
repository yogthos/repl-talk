# REPL Talk

Interactive REPL interface with AI integration using Babashka nREPL. An AI-powered tool that executes Clojure code through a single `eval_clojure` function, enabling natural language interaction with your system.

## Overview

REPL Talk provides a web-based interface where you can chat with an AI assistant that can execute Clojure code via Babashka nREPL. Instead of a fixed set of tools, the AI has access to the full Clojure runtime, allowing it to dynamically generate and execute code to accomplish tasks.

## Features

- **AI-Powered Code Execution**: Natural language prompts are converted to Clojure code and executed
- **Babashka Integration**: Full access to Babashka libraries (file system, HTTP, data processing, etc.)
- **Multiple AI Models**: Support for local models (Ollama) and cloud APIs (DeepSeek)
- **Web Interface**: Real-time chat interface via WebSocket
- **Headless Testing**: Comprehensive test suite for the REPL loop

## Requirements

- Node.js (v18+)
- Babashka (`bb` command available in PATH)
- AI model endpoint (Ollama running locally or DeepSeek API key)

## Installation

```bash
npm install
```

## Configuration

Edit `config.json` to configure AI models:

```json
{
  "models": {
    "local": {
      "endpoint": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "model": "qwen3:8b"
    },
    "deepseek": {
      "endpoint": "https://api.deepseek.com/v1",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "model": "deepseek-chat"
    }
  },
  "defaultModel": "local"
}
```

Environment variables can override config values:
- `AI_DEFAULT_MODEL`: Default model to use
- `DEEPSEEK_API_KEY`: DeepSeek API key
- `NREPL_HOSTNAME` / `NREPL_PORT`: Connect to existing nREPL server
- `BABASHKA_PATH`: Path to Babashka executable (default: `bb`)

## Usage

Start the server:

```bash
npm start
```

Open `http://localhost:3000` in your browser and start chatting. The AI will:
1. Understand your request
2. Generate appropriate Clojure code
3. Execute it via Babashka nREPL
4. Return the results

### Example

**You**: "List all files in the current directory"

**AI**: Generates and executes:
```clojure
(require '[babashka.fs :as fs])
(map str (fs/list-dir "."))
```

**Result**: Returns the list of files

## Testing

Run the test suite:

```bash
npm test
```

Tests verify:
- nREPL connection and code execution
- AI code generation
- Result serialization and error handling
- Full REPL loop integration

## Architecture

The system follows an 8-step loop:

1. **Initialize**: Connect to nREPL, register `eval_clojure` tool
2. **Prompt**: User provides task
3. **Decide**: AI analyzes and plans Clojure code
4. **Request**: AI calls `eval_clojure` with generated code
5. **Execute**: nREPL evaluates code
6. **Respond**: Results serialized and returned
7. **Update**: Results added to conversation context
8. **Answer**: AI synthesizes final response

## License

MIT

