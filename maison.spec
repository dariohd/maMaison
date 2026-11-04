# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_submodules

hidden = []
for name in ("uvicorn", "fastapi", "starlette", "anyio", "python_multipart", "multipart", "segno", "webview", "pystray", "PIL", "paho"):
    hidden += collect_submodules(name)

a = Analysis(
    ["lancer.py"],
    pathex=["."],
    binaries=[],
    datas=[("static", "static"), ("assets/maison.ico", "assets")],
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="maMaisonConnectee",
    icon="assets/maison.ico",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=True,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
