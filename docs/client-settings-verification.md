# Client settings — manual verification

Use this walkthrough on Windows to verify the fixes on `fix/branch-name` and to
record the first-time setup time required by issue #21.

All terminal commands below are PowerShell.

## 1. Get the branch

```powershell
git fetch origin
git switch -c fix/branch-name origin/fix/branch-name
```

If the branch already exists locally:

```powershell
git switch fix/branch-name
git pull origin fix/branch-name
```

## 2. Check the branch changes

The branch fixes the stale comment in the blank-key test and adds this guide.

```powershell
Select-String -Path Client/tests/settings-storage.test.cjs -Pattern 'README documents the auth key as optional'
if (Select-String -Path Client/tests/settings-storage.test.cjs -Pattern 'note in the PR') {
  throw 'The stale PR-note comment is still present.'
}
Test-Path docs/client-settings-verification.md
```

Expected: one match from the first command, no match from the `if`, and `True`
from `Test-Path`.

## 3. Run the automated checks

```powershell
npm ci
npm test -w @obvs/client
npm run typecheck -w @obvs/client
```

Expected: all Client tests pass (23 currently), and typecheck exits with code 0.
Run the full suite if you want:

```powershell
npm test
```

## 4. Reset to a clean first-time state

Close the Client if it is running.

1. If the Client still opens, click **Remove saved key**.
2. Remove the saved settings:

```powershell
$settingsDir = Join-Path $env:APPDATA 'OBVS Client'
Remove-Item -Path $settingsDir -Recurse -Force -ErrorAction SilentlyContinue
Test-Path $settingsDir   # False
```

If that folder does not exist, find the actual one:

```powershell
Get-ChildItem $env:APPDATA -Recurse -Filter settings.json -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'OBVS|obvs' } |
  Select-Object FullName
```

Keytar stores the auth key in Windows Credential Manager. Check for the entry:

```powershell
cmdkey /list | Select-String 'io.obvs.client'
```

The target name can vary, so the reliable way to remove it is the app's
**Remove saved key** button. If you prefer the terminal, delete the target shown
by `cmdkey /list`:

```powershell
$target = 'io.obvs.client'   # use the exact target shown by cmdkey /list
cmdkey /delete:$target
```

## 5. Time the first-time setup

Record the start time and launch the Client in the background:

```powershell
$start = Get-Date
Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev","-w","@obvs/client" -WorkingDirectory (Get-Location).Path
```

Complete the form with a valid URL, group code, display name, and a distinctive
auth key such as `TEST-KEY-12345`. Click **Save settings**. When the status reads
**Settings saved.**, calculate the elapsed time in the same PowerShell window:

```powershell
(Get-Date) - $start
```

Record the elapsed time here. It must be **2 minutes or less**.

| Date | Machine | Node | Clean install? | Elapsed | Result |
| --- | --- | --- | --- | --- | --- |
|  |  | `node --version` | Yes |  |  |

If you have a packaged build, repeat this from a clean install and record that
result instead. The source run above is a proxy when no packaged build is
available.

## 6. Functional checks

### 6.1 Empty and malformed fields

1. Record the current settings file state:

```powershell
$settings = Join-Path $env:APPDATA 'OBVS Client\settings.json'
$before = if (Test-Path $settings) { (Get-FileHash $settings).Hash } else { 'missing' }
$before
```

2. Clear **Server URL**, **Group code**, and **Display name**, then click
   **Save settings**.
3. Verify each field shows its own error and the first invalid field gets focus.
4. Verify the invalid save did not write or change the file:

```powershell
$after = if (Test-Path $settings) { (Get-FileHash $settings).Hash } else { 'missing' }
$after
$before -eq $after   # True
```

5. Fill in a valid Server URL and Display name, set Group code to `bad.code`;
   only the group-code error should appear.
6. Set Server URL to `http://localhost:3000/ingest`; without the development
   flag it should be rejected with a message about HTTPS or WSS.

### 6.2 The auth key is not plaintext

Fill in valid values again, set the auth key to `TEST-KEY-12345`, and save. Then
inspect the file:

```powershell
$settings = Join-Path $env:APPDATA 'OBVS Client\settings.json'
Get-Content $settings
Select-String -Path $settings -Pattern 'TEST-KEY-12345'   # no output
```

Check Windows Credential Manager:

```powershell
cmdkey /list | Select-String 'io.obvs.client'
```

The settings file must contain only `serverUrl`, `groupCode`, and
`displayName`. The secret must not appear.

### 6.3 Settings survive a restart

Close the Client and relaunch:

```powershell
npm run dev -w @obvs/client
```

Expected: URL, group code, and display name are restored; the hint says
**Auth key saved securely**; the auth-key field is blank.

### 6.4 A blank key keeps the stored key

Change only the display name, leave the auth key blank, and save. Expected:
**Settings saved.** and the hint still says **Auth key saved securely**. Close
and reopen; the new display name and the saved-key state persist.

### 6.5 Remove saved key

Click **Remove saved key**. Expected: the hint changes to
**Auth key is optional**, the button hides, and the key is gone. Close and
reopen; the hint stays optional.

### 6.6 TLS and local development

With the development flag set:

```powershell
$env:OBVS_ALLOW_INSECURE_URL = '1'
npm run dev -w @obvs/client
```

- `http://localhost:3000/ingest` saves.
- `http://127.0.0.1:3000/ingest` saves.
- `http://example.test/ingest` is rejected.
- `https://example.test/ingest` saves.

Remove the flag and relaunch:

```powershell
Remove-Item Env:OBVS_ALLOW_INSECURE_URL
npm run dev -w @obvs/client
```

`http://localhost:3000/ingest` should now be rejected. Packaged builds ignore
the flag; verify that separately with a packaged build if one is available.

## 7. Record the result

Update the PR description with:

- What changed.
- How you tested it, including the elapsed time and the table in section 5.
- Anything the reviewer should check.

If the elapsed time is over 2 minutes, do not close issue #21.
