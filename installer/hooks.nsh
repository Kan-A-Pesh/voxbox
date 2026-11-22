; VoxBox NSIS hooks (included by Tauri's installer template).
; VB-CABLE is VB-Audio's donationware virtual audio cable, shipped AS IS
; (installer/resources/vbcable, fetched by scripts/fetch_vbcable.py) and installed with
; its own official setup. Attribution and the donation link are shown before install,
; as required by https://vb-audio.com/Services/licensing.htm.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$SYSDIR\drivers\vbaudio_cable64_win10.sys" vbcable_present 0
  IfFileExists "$INSTDIR\resources\vbcable\VBCABLE_Setup_x64.exe" 0 vbcable_missing
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION "VoxBox utilise VB-CABLE pour créer le micro virtuel « CABLE Output ».$\r$\n$\r$\nVB-CABLE est un donationware de VB-Audio (www.vb-cable.com), toutes les participations sont les bienvenues.$\r$\nUn usage professionnel en entreprise nécessite des licences VB-CABLE.$\r$\n$\r$\nOK : installer VB-CABLE maintenant (un redémarrage sera nécessaire).$\r$\nAnnuler : ne pas l'installer (VoxBox fonctionnera sans micro virtuel)." IDCANCEL vbcable_done
    DetailPrint "Installation de VB-CABLE..."
    ExecWait '"$INSTDIR\resources\vbcable\VBCABLE_Setup_x64.exe" -i -h' $0
    DetailPrint "VB-CABLE : code de sortie $0"
    SetRebootFlag true
    Goto vbcable_done
  vbcable_missing:
    DetailPrint "Pack VB-CABLE absent de l'installeur, étape ignorée."
    Goto vbcable_done
  vbcable_present:
    DetailPrint "VB-CABLE est déjà installé."
  vbcable_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; VB-CABLE is left installed: other applications may use it. It can be removed
  ; with VBCABLE_Setup_x64.exe from the VB-Audio pack.
!macroend
