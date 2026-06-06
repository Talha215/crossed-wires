// aiWorker.js
const { spawn } = require('child_process');

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', prompt,
      '--model', 'haiku',     // fast + cheap; plenty for hints
      '--max-turns', '1',
      '--output-format', 'json',
    ], {
      // MAX_THINKING_TOKENS=0 disables extended thinking: hints went from
      // ~659 output tokens / ~9.6s to ~70 tokens / ~2.9s, same quality.
      env: { ...process.env, MAX_THINKING_TOKENS: '0' },
    });

    // Close stdin right away — otherwise the CLI waits 3 seconds for piped
    // input before doing anything, on every single call.
    child.stdin.end();

    let out = '', err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err || `claude exited ${code}`));
      try {
        const parsed = JSON.parse(out);
        resolve((parsed.result || '').trim());
      } catch {
        reject(new Error('Could not parse claude output: ' + out));
      }
    });
  });
}

function generateHint(storySoFar, { isFinalTurn = false } = {}) {
  const closing = isFinalTurn
    ? `This is the FINAL turn. Nudge the next writer to bring the story to an absurd but satisfying conclusion.`
    : `Write a hint for the next writer.`;

  const prompt = `You are the game master for a "telephone story" party game.
You are given the full story so far. The next player will write the next 1-3 sentences WITHOUT seeing any of it, using only your hint.

${closing}

Rules for your hint (2-3 sentences max):
- Give a vague sense of the current situation and tone, but deliberately blur or omit key specifics so the story drifts in funny directions.
- NEVER quote the story directly.
- End with exactly one MANDATORY element the player must include (an object, twist, character, or style), on its own line starting with "Must include:".
- Output ONLY the hint. No preamble.

Story so far:
"""
${storySoFar}
"""`;

  return runClaude(prompt);
}

function generateTitle(fullStory) {
  return runClaude(`Invent one ridiculous, funny title for this story. Output only the title, nothing else.\n\n"""\n${fullStory}\n"""`);
}

module.exports = { generateHint, generateTitle };