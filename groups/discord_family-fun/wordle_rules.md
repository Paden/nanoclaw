# Wordle Mechanics

## Word selection & publish

Each day's word is set in `Wordle Today` tab of Portillo Games sheet. Columns: Date, Word, Budgets (JSON: `{"Paden":6,"Brenda":7,"Danny":5}`). Budgets come from `node /workspace/group/scripts/compute-tiers.mjs`.

## Guess budgets (tiers)

Tiers are based on lifetime XP from Silverthorne Pet Log:
- Hatchling (0-499 XP): 7 guesses
- Fledgling (500-1499 XP): 6 guesses
- Adept (1500-2999 XP): 5 guesses
- Apex (3000+ XP): 4 guesses

## Submission flow

Players submit via the **`/wordle <word>`** Discord slash command, invoked in #family-fun. The host scores the guess against `Wordle Today`, writes the row to `Wordle State`, and replies **ephemerally** — only the guesser sees the grid, no one else in the channel. You do not see the guess, you do not score, you do not write rows — that all happens outside your container.

Your job is everything around the guess: the pinned status card, day resolution, saga narrative, pet voices.

## Wordlist

`wordle_wordlist.txt` — one word per line. Pick from this list when setting the next day's word. Track used words in `wordle_used_words.json` to avoid repeats. (The slash-command scorer reads this same file to validate guesses.)

## Day resolution

Run `node /workspace/group/scripts/resolve-day.mjs`. Trust its output — don't re-derive winners or stakes. The script:
- Reads all guesses from the sheet
- Determines winner (fewest guesses; tie → earliest solve)
- Writes Pet Log stakes to Silverthorne: winner +20 XP, failed/no-show -10 decay
- Holds stakes if a cheat review is pending

## Pinned card

Label: `wordle_card`. Always use `send_message({label: "wordle_card", pin: true, upsert: true, text: ...})`.

Card shows: day number, date, genre, per-player status (guesses/budget), all-time leaderboard (wins, streak, best, avg), and last chapter opening. Format is rendered by `renderCard()` in `wordle.mjs` — match that layout.

## Reveal poller

`wordle_poller_state.json` tracks whether you've checked for new guesses recently. Poll `Wordle State` on a cadence; when a player's guess count changes, update the pinned card to reflect it (without revealing letters or grids).
