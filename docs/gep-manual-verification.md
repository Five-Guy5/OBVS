# GEP capture — Overwolf dev-mode setup and manual verification

This walks through running PR #42 (`feature/session-lifecycle`) on Windows with
Valorant, then proving that the Client captures GEP updates and relays them as
the expected ingest events.

All commands are PowerShell, run from the repository root unless stated
otherwise. The local capture sink is a verification tool, not the production
Server; section 9 repeats the check against the real Server.

## 1. Overwolf account and dev-mode key

Dev mode is the automatic path for an unsigned local build; there is no
separate toggle in the app. It still authenticates with Overwolf before the
GEP package loads.

1. Sign in at <https://dev.overwolf.com>.
2. Open your profile and confirm **Developer status** is **Approved**.
   If it still says **Pending**, the approval email has not been applied to the
   account yet; use the DevRel contact in that email.
3. Under **Developer Key**, select **Generate key** (or **Extend** if a key
   already exists). Copy the value. This is the `OW_DEV_KEY`; it is not the
   confirmation email itself.
4. Keep the key out of git. This walkthrough passes it through
   `OW_DEV_KEY` in the terminal.

If Overwolf has already given you Developer Console access, `OW_CLI_EMAIL` and
`OW_CLI_API_KEY` also work and take precedence. `OW_DEV_KEY` is enough for this
test.

No app registration, app ID, or signing is needed for dev mode. The app ID is
derived from `Client/package.json` (`productName` and `author.name`).

## 2. Windows prerequisites

- Windows 10 or 11, x64.
- Valorant installed and working.
- Node.js 22 or newer:
  ```powershell
  node --version
  npm --version
  ```
- Git for Windows.
- The repository cloned locally.

If PowerShell blocks `npm.ps1`, use `npm.cmd` for the commands below, or run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

## 3. Get the PR branch and install

```powershell
git fetch origin
git switch -c verify/gep-capture origin/feature/session-lifecycle
npm ci
npm run build
npm test
```

If the branch already exists, use `git switch verify/gep-capture` and
`git pull --ff-only` instead of `git switch -c`.

`npm ci` downloads Electron/ow-electron and can take a few minutes. If `keytar`
fails to build, install the Visual Studio Build Tools **Desktop development
with C++** workload plus Python 3, then run `npm ci` again.

Check the branch's automated tests before touching GEP:

```powershell
npm test -w @obvs/client
npm run typecheck -w @obvs/client
```

Expected: all Client tests pass (40 with current `dev` merged) and typecheck
exits with code 0.

## 4. Set the dev-mode environment

In the terminal that will run the Client:

```powershell
$env:OW_DEV_KEY = '<paste-your-developer-key>'
$env:OBVS_ALLOW_INSECURE_URL = '1'
```

Use single quotes so PowerShell does not interpret characters in the key.

- `OW_DEV_KEY` lets the package manager load GEP in dev mode.
- `OBVS_ALLOW_INSECURE_URL=1` lets the source build use `http://127.0.0.1`;
  packaged builds ignore this flag. The Server URL must still be a loopback
  host.

Each new PowerShell window has its own environment. Set both variables again
in any new terminal that runs the Client.

## 5. Start the capture sink

Terminal A:

```powershell
npm run capture -w @obvs/server -- --self-test
npm run capture -w @obvs/server
```

The first command prints `self-test ok` and exits. The second prints:

```text
[capture] listening on ws://127.0.0.1:3100/ingest
[capture] writing ...\Server\gep-capture.jsonl
```

The sink accepts the Client's logon, replies with a fake Match Secret, and
writes every ingest frame verbatim to `Server/gep-capture.jsonl`. That file is
ignored by git. Press Ctrl+C in Terminal A when you are done to print a
per-event summary.

If port 3100 is busy:

```powershell
$env:OBVS_CAPTURE_PORT = '3101'
npm run capture -w @obvs/server
```

Then use `http://127.0.0.1:3101/ingest` in the Client.

## 6. Start the Client

Terminal B, with `OW_DEV_KEY` and `OBVS_ALLOW_INSECURE_URL` set:

```powershell
npm run dev -w @obvs/client
```

The Client settings window opens. The terminal should show:

```text
[gep] Valorant detected (21640); requesting features.
```

If instead you see `[gep] Overwolf package manager is unavailable.` or no GEP
line at all, use section 11 before continuing.

In the settings window:

| Field | Value |
| --- | --- |
| Server URL | `http://127.0.0.1:3100/ingest` |
| Group code | `gep-test` |
| Display name | your name |
| Auth key | leave blank |

Select **Save settings** and wait for **Settings saved.** The session stays
**Idle** until Valorant reaches a match scene.

## 7. Run a match

Start Valorant *after* the Client so the Client sees the scene changes.

1. Go to the **Range**. Expected: the Client stays **Idle** and the capture
   sink shows no logon. The Range is deliberately ignored.
2. Return to the main menu, then start a normal **Unrated** or **Swift** match.
   Do not use a custom game or training for the `match_end` check; Overwolf
   does not fire `match_end` in those modes.
3. At agent select, the Client should change from **Idle** to **Connecting**
   and then **Live**. The sink should show:
   ```text
   [capture] logon group=gep-test observer=YourName resume=false
   [capture] gep.raw game_info/scene
   [capture] scene
   ```
4. In game, the sink should keep showing raw updates, including:
   ```text
   [capture] gep.raw match_info/round_number
   [capture] gep.raw match_info/round_phase
   [capture] round
   [capture] gep.raw match_info/kill_feed
   [capture] gep.raw me/health
   ```
   The exact `me` and match fields vary with what GEP sends, but
   `game_info/scene`, `match_info/round_number`, and
   `match_info/round_phase` are the minimum for the lifecycle checks.
5. At the end of the match, the Client should return to **Idle**, the sink
   should show a final `round` at phase `game_end`, then `match.end`, then
   `disconnected`. No further frames should arrive after that.

### Manual controls

Do this during a live match, not before the first auto-connect:

1. Select **Disconnect**. The status changes to **Idle** and the sink logs
   `disconnected`.
2. Select **Connect** again. The sink logon line should show `resume=true`;
   the Client reused the in-memory Match Secret and returns to **Live**.
3. Disconnect once more and leave it disconnected. The Client must not
   reconnect while the same match continues. Start the next match; agent
   select should auto-connect again with `resume=false`.

Manual Disconnect suppresses auto-connect for the rest of that match. A manual
Connect clears that suppression.

## 8. Inspect the captured payloads

In Terminal C, from the repository root:

```powershell
$capture = '.\Server\gep-capture.jsonl'
$events = @(Get-Content $capture | ForEach-Object { $_ | ConvertFrom-Json })

"events: $($events.Count)"
$events | Group-Object type | Sort-Object Count -Descending |
  Format-Table Count, Name -AutoSize

$raw = @($events | Where-Object type -eq 'gep.raw')
$raw | Group-Object { "$($_.payload.feature)/$($_.payload.key)" } |
  Sort-Object Count -Descending | Format-Table Count, Name -AutoSize
```

Expected minimum after a complete match:

- at least one `gep.raw` frame;
- `scene` events for agent select and in-game;
- `round` events with a numeric `payload.number` and a `payload.phase`;
- raw keys `game_info/scene`, `match_info/round_number`,
  `match_info/round_phase`, and at least one gameplay field such as
  `match_info/kill_feed`, `match_info/scoreboard`, or `me/health`;
- exactly one `match.end`.

Run the assertions:

```powershell
function Assert([bool]$condition, [string]$message) {
  if (-not $condition) { throw "FAIL: $message" }
}

$rawCount = @($events | Where-Object type -eq 'gep.raw').Count
$sceneCount = @($events | Where-Object type -eq 'scene').Count
$roundCount = @($events | Where-Object type -eq 'round').Count
$endCount = @($events | Where-Object type -eq 'match.end').Count
$sceneKeys = @($raw | Where-Object {
  $_.payload.feature -eq 'game_info' -and $_.payload.key -eq 'scene'
}).Count
$phaseKeys = @($raw | Where-Object { $_.payload.key -eq 'round_phase' }).Count
$badTimestamps = @($raw | Where-Object {
  $_.payload.timestamp -ne $_.capturedAt
}).Count

Assert ($events.Count -gt 0) 'no events captured'
Assert ($rawCount -gt 0) 'no gep.raw frames'
Assert ($sceneCount -gt 0) 'no scene events'
Assert ($roundCount -gt 0) 'no round events'
Assert ($endCount -eq 1) 'expected exactly one match.end'
Assert ($sceneKeys -gt 0) 'no game_info/scene'
Assert ($phaseKeys -gt 0) 'no round_phase'
Assert ($badTimestamps -eq 0) 'gep.raw timestamp != capturedAt'
"capture checks passed"
```

Check the scene and round values:

```powershell
$events | Where-Object type -eq 'scene' |
  Select-Object -ExpandProperty payload | Select-Object scene

$events | Where-Object type -eq 'round' |
  Select-Object -Last 5 | Select-Object -ExpandProperty payload |
  Format-Table number, phase -AutoSize

$events | Where-Object type -eq 'match.end' |
  Select-Object -ExpandProperty payload
```

Pass criteria:

- `scene` contains `agent_select` and `in_game`.
- The last `round` has `phase = game_end`.
- `match.end` has `winningTeamId = null` (this PR does not derive the winner).
- Every `gep.raw` has `payload.timestamp` equal to its envelope `capturedAt`.
- No `gep.raw` appears before the accepted logon or after `match.end`.

If you only need the lifecycle and do not finish a match, skip the
`match.end` assertion; everything else can be checked after a few rounds.

## 9. Repeat against the real Server

Terminal C:

```powershell
npm run dev -w @obvs/server
```

Expected:

```text
OBVS ingest listening on 127.0.0.1:3000 (open ingest)
```

In the Client, set the Server URL to `http://127.0.0.1:3000/ingest`, save, and
restart the Client (or Disconnect and Connect) so it uses the new URL. Start
another match. The Server terminal should show:

```text
[ingest] logon accepted <ip> group=gep-test
[ingest] event gep-test gep.raw <uuid> (appended)
[ingest] event gep-test scene <uuid> (appended)
[ingest] event gep-test round <uuid> (appended)
[ingest] event gep-test match.end <uuid> (appended)
[ingest] disconnect <ip> group=gep-test
```

The real Server validates the logon and event envelopes, so this proves the
Client's relay is accepted end-to-end. The sink from section 5 proves the
payload contents; this step proves integration with the Server.

The Server currently accepts Client version `0.1.0` only. If it replies
`Unsupported client version`, align `SUPPORTED_CLIENT_VERSIONS` in
`Server/src/logon.ts` with `Client/package.json`.

## 10. What to record on PR #42

Paste a short result into the PR, for example:

```text
Manual GEP verification — 2026-11-14
Windows 11, Node 22.23.4, ow-electron 44.9.0, dev mode
Match: Unrated
Sink: 312 gep.raw, 6 scene, 31 round, 1 match.end
Keys seen: game_info/scene, match_info/round_number,
  match_info/round_phase, match_info/kill_feed, me/health
Timestamps: 0 mismatches
Real Server: logon accepted; gep.raw/scene/round/match.end appended
Manual controls: Disconnect/Connect resume=true; no auto-reconnect in same match
Result: pass
```

Also note anything that did not appear, especially a feature whose GEP status
was yellow or red.

## 11. Troubleshooting

### No `[gep] Valorant detected` line

- Confirm `OW_DEV_KEY` is set in the same terminal that launched `npm run dev`.
- Confirm the profile shows **Approved**.
- Try the GEP dev channel:
  ```powershell
  npm run build -w @obvs/client
  npm start -w @obvs/client -- --owepm-package-channel=gep:dev
  ```
- Reopen PowerShell as Administrator and retry. Some machines require an
  elevated launch for game detection.
- Check Overwolf's live status for Valorant:
  ```powershell
  (Invoke-RestMethod https://game-events-status.overwolf.com/21640_prod.json).features |
    Select-Object name, state
  ```

### GEP is detected but no events arrive

- Check the Client terminal for
  `[gep] could not set required features`.
- Check the status endpoint above. A `state` of `2` or `3` means Overwolf has
  partially or fully disabled that feature.
- Confirm the match is not in the Range. The Range is intentionally ignored.
- Restart Valorant after the Client so scene changes are observed from the
  start.

### Client stays Idle at agent select

- Confirm settings were saved; the Client shows
  `Save connection settings before connecting.` when they were not.
- Confirm `OBVS_ALLOW_INSECURE_URL=1` was set before launching the Client.
- Confirm the capture sink is listening on the same port as the Server URL.
- If the first auto-connect failed because the sink was not running, select
  **Connect** manually or restart the Client.

### `Could not connect` or immediate disconnect

- The sink or Server is not running.
- The URL port does not match.
- `http://` was rejected because `OBVS_ALLOW_INSECURE_URL` is missing.
- The Server rejected the auth key; leave the Client auth key blank for open
  ingest.

### No `match.end`

- Custom games and training do not fire `match_end`; use Unrated or Swift.
- The Client also stops on `round_phase=game_end`, so the session may return to
  Idle without a `match.end` if that event was missed.
- If you manually disconnected before the end, reconnect before the match ends
  or expect no `match.end`.

### No `round` events

`round` needs both `match_info/round_number` and `match_info/round_phase`.
If only one arrives, the raw frames are still captured but the typed `round`
event is intentionally withheld.
