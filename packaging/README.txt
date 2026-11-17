SCREEVA LOCAL STUDIO

Windows: Extract the whole folder to a permanent writable location. Double-click
Enable Screeva links.cmd once to register screeva://open for your Windows account
(no administrator access). Re-run setup if you move the folder. Start Screeva.cmd
also launches directly without registration. Existing recordings stay in data/.
To remove the link registration, delete only HKCU\Software\Classes\screeva using
Registry Editor, after confirming its command points to this Screeva folder.

macOS Apple Silicon: Move Screeva.app into Applications and open it once. The app
registers the screeva URL scheme through its bundle metadata. Use macOS's normal
app-opening approval flow. This build is ad-hoc signed, not Apple-notarized.
Recordings stay in ~/Library/Application Support/Screeva/data across app updates.

After setup, Open local studio on the website launches the installed app. Your
browser may ask you to confirm. Nothing is installed or recorded by that link.
If nothing opens, launch directly or repeat setup. Older releases lack this link.

The launcher starts/reuses the service at http://127.0.0.1:4317 and opens the studio
only after a valid readiness response. Keep the launcher/Terminal window open
while recording. Stop recording first, then press Ctrl+C in that window to stop
the service. Closing the browser alone does not stop the local server. A second
launch reuses the running service and never kills it or resets its recordings.

Node.js is bundled. FFmpeg and FFprobe are NOT bundled: install a trusted FFmpeg
distribution containing both tools and add its bin folder to PATH. Both are
required for durable recording finalization/recovery and MP4 export. Launch from
a newly opened terminal if your operating system hasn't refreshed PATH yet.
On macOS the launcher uses Terminal so normal shell PATH configuration applies.

The website remains usable without installation for temporary WebM recording.
Download browser recordings before closing/reloading the tab (128 MiB limit).
The launch link never transfers browser recordings to the local studio.
