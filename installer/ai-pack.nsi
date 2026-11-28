; "VoxBox - Voix IA" add-on: installs the RVC runtime, bundled AI voices and the
; .pth converter into an existing VoxBox installation. Built by
; .github/workflows/ai-pack.yml from the output of scripts/build_ai_pack.ps1:
;   makensis /DPACK_DIR=<dir> /DOUT_FILE=<exe> installer/ai-pack.nsi
!include "MUI2.nsh"
Unicode true
Name "VoxBox - Voix IA"
OutFile "${OUT_FILE}"
RequestExecutionLevel admin
InstallDir "$PROGRAMFILES64\VoxBox"
; Non-solid: a solid block of the whole pack (> 1 GB) exhausts 32-bit makensis
; ("error mmapping datablock"). Per-file LZMA stays well within its limits.
SetCompressor lzma
; A file that cannot be written (a locked DLL) aborts the install instead of being skipped,
; which silent mode (/S, the in-app pack update) would otherwise do without a word.
AllowSkipFiles off

!define MUI_DIRECTORYPAGE_TEXT_TOP "Choisissez le dossier où VoxBox est installé. Le pack ajoute les voix IA (RVC), le moteur ONNX Runtime + DirectML (cartes NVIDIA et AMD) et le convertisseur de modèles .pth."
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "French"

Function .onVerifyInstDir
  IfFileExists "$INSTDIR\voxbox.exe" ok
    Abort
  ok:
FunctionEnd

Section "Voix IA"
  SetOutPath "$INSTDIR\resources"
  ; The version marker goes first and comes back last: an install that stops halfway leaves
  ; no version, so the app offers the pack again (a pack of unknown version is the oldest).
  ClearErrors
  Delete "$INSTDIR\resources\ai-pack.json"
  ; Set only when the file exists and cannot be removed: replacing the pack would then leave
  ; the old version marker on a partly updated pack.
  IfErrors 0 marker_cleared
    Abort "Le marqueur de version du pack ne peut pas être retiré : installation annulée."
  marker_cleared:
  File /r "${PACK_DIR}\rvc-assets"
  File /r "${PACK_DIR}\rvc-voices"
  File /r "${PACK_DIR}\converter"
  ; Read by the app's pack update (version installed): written once every file above is.
  File "${PACK_DIR}\ai-pack.json"
  WriteUninstaller "$INSTDIR\uninstall-voix-ia.exe"
SectionEnd

Section "Uninstall"
  ; The version marker goes first: an uninstall that stops halfway leaves no version, so the
  ; app does not take a partly removed pack for an installed one.
  ClearErrors
  Delete "$INSTDIR\resources\ai-pack.json"
  IfErrors 0 marker_removed
    Abort "Le marqueur de version du pack ne peut pas être retiré : désinstallation annulée."
  marker_removed:
  ClearErrors
  RMDir /r "$INSTDIR\resources\rvc-assets"
  RMDir /r "$INSTDIR\resources\rvc-voices"
  RMDir /r "$INSTDIR\resources\converter"
  ; A file still in use (VoxBox open) stays: keep this uninstaller to try again.
  IfErrors 0 payload_removed
    Abort "Des fichiers du pack n'ont pas pu être supprimés : ferme VoxBox puis relance la désinstallation."
  payload_removed:
  Delete "$INSTDIR\uninstall-voix-ia.exe"
SectionEnd
