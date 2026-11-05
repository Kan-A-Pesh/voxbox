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
SetCompressor /SOLID lzma

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
  File /r "${PACK_DIR}\rvc-assets"
  File /r "${PACK_DIR}\rvc-voices"
  File /r "${PACK_DIR}\converter"
  WriteUninstaller "$INSTDIR\uninstall-voix-ia.exe"
SectionEnd

Section "Uninstall"
  RMDir /r "$INSTDIR\resources\rvc-assets"
  RMDir /r "$INSTDIR\resources\rvc-voices"
  RMDir /r "$INSTDIR\resources\converter"
  Delete "$INSTDIR\uninstall-voix-ia.exe"
SectionEnd
