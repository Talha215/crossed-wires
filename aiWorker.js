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

function generateHint(storySoFar, { isFinalTurn = false, turnIndex = 1, turnsTotal = 8, theme = null } = {}) {
  // Tell the model where we are in the story arc so hints create forward
  // motion instead of an endless loop of reactions to the latest event.
  const progress = turnsTotal > 1 ? turnIndex / (turnsTotal - 1) : 1;
  let beat;
  if (isFinalTurn) {
    beat = 'FINAL TURN. Nudge the writer to bring the story to an absurd but satisfying conclusion that lands.';
  } else if (progress < 0.4) {
    beat = 'Early in the story. Steer the writer toward a complication, a goal, or a problem worth chasing.';
  } else if (progress < 0.75) {
    beat = 'Middle of the story. Escalate, or move the story somewhere new — do not let it idle where it is.';
  } else {
    beat = 'Late in the story. Steer toward consequences; things should start coming to a head.';
  }

  const mustInclude = isFinalTurn
    ? 'It may be a NEW concrete thing (object, character, place, event, or style twist), or a twist that ties the story together.'
    : 'It must be a NEW concrete thing — an object, character, place, event, or style twist that does NOT already appear in the story. Never a reaction, opinion, or commentary on what just happened.';

  const prompt = `You are the game master for a "telephone story" party game.
You are given the full story so far. The next player will write the next 1-3 sentences WITHOUT seeing any of it, using only your hint.

Story position: turn ${turnIndex + 1} of ${turnsTotal}. ${beat}
${theme ? `The story's theme: ${theme}. Keep your hint and the mandatory element leaning into that flavor.\n` : ''}
Write a hint (2-3 sentences) that:
- Conveys the story's momentum and tone — where things seem to be heading, and the energy level.
- Hides the specifics: never name the story's characters, objects, or exact events. Refer to them obliquely or not at all. NEVER quote the story.
- Pushes the story FORWARD. If the recent contributions are all reactions to one event in one place, your hint must move things along: suggest time has passed, the scene has changed, or a new development has begun.

Then end with exactly one line starting with "Must include:" naming ONE mandatory element the player must work in. ${mustInclude}

Output: plain text only, no markdown, no headers, no preamble. Just the 2-3 sentence hint, then the "Must include:" line.

Story so far:
"""
${storySoFar}
"""`;

  return runClaude(prompt);
}

function generateTitle(fullStory) {
  return runClaude(`Invent one ridiculous, funny title for this story. Output only the title - plain text, no quotation marks, no markdown.\n\n"""\n${fullStory}\n"""`)
    // belt and suspenders: strip stray markdown/quote wrappers
    .then(t => t.replace(/^[\s"*#'_]+/, '').replace(/[\s"*'_]+$/, ''));
}

module.exports = { generateHint, generateTitle };