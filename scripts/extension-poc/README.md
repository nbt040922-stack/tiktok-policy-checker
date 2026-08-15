# YouTube Summary Electron POC

This isolated POC loads a copied unpacked extension into Electron's persistent
`persist:youtube-transcript-poc` partition. It never reads or copies browser
cookies, never uses the production session, and never writes extension/session
data inside the repository.

## Prepare the extension copy

```powershell
npm run poc:extension:prepare
$env:YOUTUBE_TRANSCRIPT_EXTENSION_PATH="$env:TEMP\TikTokPolicyChecker\extension-poc\youtube-summary\2.3.1"
```

The prepare command searches Chrome, Cốc Cốc, and Edge because the extension is
currently installed in the local Cốc Cốc Chromium profile. It prints the exact
copy path to use.

## Run and test persistence

```powershell
npm run poc:extension
```

Log into YouTube manually if necessary, then close the window and run the same
command again. The POC user data stays under:

```text
%LOCALAPPDATA%\TikTokPolicyChecker\ExtensionPOC
```

Do not enter credentials through automation. To test a specific video on the
next launch:

```powershell
$env:YOUTUBE_TRANSCRIPT_VIDEO_URL='https://www.youtube.com/watch?v=VIDEO_ID'
npm run poc:extension
```

Use the extension's normal **Copy transcript** control. Set
`POC_OPEN_DEVTOOLS=1` only when interactive inspection is needed. Console and
transcript-related request logs redact query strings, tokens, long identifiers,
and never inspect cookie values.
