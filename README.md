# calc-ai-proxy

Cloudflare Pages Function: no-key AI proxy for 小明计算器 AA 分账.

- `POST /api/aa-recognize` with `{text, members}` returns `{headcount, items}`.
- Uses Workers AI binding (`env.AI`), models tried in order: qwen3.8-27b, gemma-4-26b, llama-3.1-8b-instruct-fast.
- Only callable from https://7866817.github.io (and the Android APK, Origin null).

Deploy: Cloudflare Pages -> connect this repo -> add Workers AI binding -> deploy.
