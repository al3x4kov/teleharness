# Linux document rendering

`teleharness_render.py` remains the shared secure renderer: OOXML/ODF external links and
fields are stripped, macros removed, LibreOffice gets a hardened private profile,
HTML/SVG requests are restricted to a copied local folder, and input/output paths
must resolve inside `--root`. Output contract stays `_preview/<stem>/page-01.png`
(and converted PDF). Legacy Windows defaults/Edge/taskkill remain available.

Linux adds native LibreOffice/Node defaults, POSIX quoting, process-group timeout
cleanup and a subprocess environment allowlist that excludes provider credentials.
`html2pdf.mjs` uses explicit Chromium on Linux with browser sandbox enabled by default.

## Two distinct execution boundaries

- **Admin native flow:** a root-owned `/usr/local/bin/teleharness-render` wrapper (site-specific,
  not shipped) that runs `teleharness_render.py` with a dedicated Python venv, the distribution's
  LibreOffice/fonts and an installed Playwright Chromium (with its AppArmor userns profile),
  `--root` set to the admin's files root; configure it through the `TELEHARNESS_RENDER_*` env
  variables (`TELEHARNESS_RENDER_PLAYWRIGHT`, `TELEHARNESS_RENDER_CHROMIUM`, `TELEHARNESS_RENDER_NODE`, `TELEHARNESS_RENDER_TMP`).
- **Tenant flow:** unchanged Claude/opencode jail hooks send the command through the
  trusted helper into the pinned Docker image. Only own home is mounted; network=none,
  nonroot UID, read-only root, capabilities dropped, no Docker socket or provider keys.
  `/usr/local/bin/teleharness-render` inside the image runs the same renderer with HOME as root.
  There is no tenant host-renderer fallback.

The tenant image disables Chromium's *inner* sandbox and uses single-process/no-zygote
only inside the existing OS container boundary, keeping the original512MiB/pids128
limits. Native admin Chromium keeps sandbox enabled and normal process separation.
`Dockerfile.render` expects a prepared context containing only engine sources,
public Chromium files, playwright-core and the tenant wrapper; never copy portal
configs/data into its build context. Image assets must be readable by nonroot UID.

The runner is trusted shared-engine infrastructure, not an independent per-tenant
identity authority. It validates paths/ownership/payload but does not maintain an
identity registry; trusted engine guards remain responsible for choosing tenant home.
This transitional ADR-012rev2 limit is not claimed as rev3 workspace isolation.

## Verification

- `python3 -I ops/render/tests/test_linux_platform.py`: Linux defaults, quoting,
  credential-free child environment, actual process-group kill.
- `render-live.test.mjs` with `TELEHARNESS_RENDER_TEST_LIVE=1`, Python/Playwright/Chromium env:
  real DOCX/PPTX/PDF/HTML/SVG previews, hostile external fields/links, loopback canary,
  input/output symlink escape and traversal refusals. Default Windows live detection
  stays unchanged; Linux live tests run only when explicitly requested.
- Deployed native wrapper and pinned tenant image separately exercised with QA docs.
- Existing tenant Claude portal shell and opencode adapter→runner smoke after image switch.
  Provider-driven opencode turn remains blocked by provider.quota.

Raw legacy binary DOC/XLS/PPT remain refused because they cannot be safely sanitized;
convert to OOXML first. Persistent user files/credentials are never test fixtures.

The shell helper now prefers each tenant's own `HOME/.venv/bin` and disables the
Python user site; the renderer uses its explicit image interpreter independently.
Each shell job has a unique container. Caller PID/starttime liveness monitoring and
TERM/INT/HUP cleanup stop an aborted job without stopping sibling jobs or deleting
persistent tenant files. The trusted shared-engine identity limitation above remains.
