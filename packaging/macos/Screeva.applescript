on run
  my launchStudio()
end run

on open location launchURL
  if launchURL is not "screeva://open" and launchURL is not "screeva://open/" then
    display alert "Unsupported Screeva link" message "Open Screeva directly or use the Open local studio button."
    return
  end if
  -- Never interpolate launchURL into a shell command.
  my launchStudio()
end open location

on launchStudio()
  set appRoot to (POSIX path of (path to me)) & "Contents/Resources/app/"
  set launchCommand to quoted form of (appRoot & "runtime/node") & " " & quoted form of (appRoot & "dist/apps/server/src/launcher/entry.js")
  tell application "Terminal"
    activate
    do script launchCommand
  end tell
end launchStudio
