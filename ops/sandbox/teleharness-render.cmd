@echo off
rem FEAT-04.12: teleharness-render runs on the server, not inside the sandbox. The portal
rem intercepts it only as a WHOLE command; inside a chain (&&, |, >) this stub runs.
echo teleharness-render: run it as a separate command, without ^&^&, ^| or ^>:  teleharness-render "file.pptx" [--pages 1-3]
exit /b 2
