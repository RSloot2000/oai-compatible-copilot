# Contributing Guide

Thanks for taking the time to contribute to the RSloot2000 fork of [JohnnyZ93/oai-compatible-copilot](https://github.com/JohnnyZ93/oai-compatible-copilot).

Also the project welcome serious and willing maintainers.

## How to contribute?

### Creating an Issue

For anything else than a typo or a bug fix, please raise an issue to discuss your proposal before submitting any code.

### License for contributions

As the copyright owner, you agree to license your contributions under an irrevocable MIT license.

### For Developers: Creating a Pull Request

**Requirements:**
- VS Code 1.104.0 or higher.
- Node.js 22.
- Your OpenAI-compatible provider API key.

```bash
git clone https://github.com/RSloot2000/oai-compatible-copilot
cd oai-compatible-copilot
npm ci
npm run compile
```
Press F5 to launch an Extension Development Host.

To track upstream changes:

```bash
git remote add upstream https://github.com/JohnnyZ93/oai-compatible-copilot.git
git fetch upstream
```

**Common scripts:**
- Build: `npm run compile`
- Package: `npm run build`
- Watch: `npm run watch`
- Lint: `npm run lint`
- Format: `npm run format`

### Tests

You should use your own OpenAI-compatible provider API key for test.

The local OpenAI cancellation fix should also be tested manually: start a reasoning response, press Stop or send a steering message, and verify that the active server request ends immediately.

On Windows, the VS Code test launcher may truncate extension paths containing spaces. If `npm test` resolves only the path prefix, run the clone from a path without spaces before treating it as a test failure.