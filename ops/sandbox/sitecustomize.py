# zai tenant sandbox (AppContainer, 2026-11-04): WMI is not reachable from an
# AppContainer — platform._wmi_query crashes the process (0xc06d007e) instead of
# failing. Make it fail politely so platform.* falls back to the registry/ver.
try:
    import platform as _p
    def _zai_no_wmi(*a, **k):
        raise OSError("WMI is not available in the zai sandbox")
    _p._wmi_query = _zai_no_wmi
except Exception:
    pass

# FEAT-04.12 (2026-11-06): only inside a tenant AppContainer (zai-jail rewrites
# TEMP/LOCALAPPDATA into <folder>\.appdata\Packages\zai-t-<name>\AC).
import os as _os
_zai_tmp = (_os.environ.get("TEMP") or "") + "|" + (_os.environ.get("LOCALAPPDATA") or "")
if r"\Packages\zai-t-" in _zai_tmp or "/Packages/zai-t-" in _zai_tmp:
    # Python 3.12.4+ on Windows turns mkdir(mode=0o700) (tempfile.mkdtemp, pip)
    # into an owner-only ACL; the container SID is not the owner, so the process
    # could not write into the folder it had just made ([Errno 13] in pip).
    # The container is already isolated by its own SID — plain mkdir is enough.
    try:
        _zai_mkdir = _os.mkdir
        def _zai_mkdir_open(path, mode=0o777, *a, **k):
            if mode == 0o700:
                mode = 0o777
            return _zai_mkdir(path, mode, *a, **k)
        _os.mkdir = _zai_mkdir_open
    except Exception:
        pass
    # pip install goes to the user's own folder (<folder>\.pylibs, hidden from
    # file cards) and those packages are importable in every later command.
    try:
        import sys as _sys
        _home = _os.environ.get("USERPROFILE") or _os.environ.get("HOME") or ""
        if _home:
            _libs = _os.path.join(_home, ".pylibs")
            _os.environ.setdefault("PIP_TARGET", _libs)
            _os.environ.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
            # the cache would land in a visible «pip» folder of the user's root
            _os.environ.setdefault("PIP_CACHE_DIR", _os.path.join(_home, ".appdata", "pip-cache"))
            if _libs not in _sys.path:
                _sys.path.append(_libs)
    except Exception:
        pass
