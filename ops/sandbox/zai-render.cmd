@echo off
rem FEAT-04.12: zai-render runs on the server, not inside the sandbox. The portal
rem intercepts it only as a WHOLE command; inside a chain (&&, |, >) this stub runs.
echo zai-render: run it as a separate command, without ^&^&, ^| or ^>:  zai-render "file.pptx" [--pages 1-3]
exit /b 2
