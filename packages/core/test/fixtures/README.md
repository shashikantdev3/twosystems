# Test fixtures

- `openrouter.*.json`: real responses from OpenRouter's Decisions API, captured on 15 October 2026 in the author's [decision-models-lab](https://github.com/shashikantdev3/decision-models-lab) project. They check that the response parser reads the shape the API really returns. They hold no keys.
- `sessions/*.json`: made-up sessions (prompts, tool calls and context sizes) replayed through the whole decision pipeline. Each file states the signals and bands it expects.

Part of twosystems, created by Shashikant.
