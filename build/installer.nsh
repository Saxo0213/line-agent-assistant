; Runs the installed app once in setup-only mode so the database and default folders exist before first launch.
; The exit code is ignored: a failure falls back to the in-app setup at first launch.
!macro customInstall
  ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --first-run-setup'
!macroend
