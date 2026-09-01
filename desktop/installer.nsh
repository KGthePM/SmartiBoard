!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER
Var DesktopShortcutCheckbox
Var WantsDesktopShortcut

!macro customInit
  StrCpy $WantsDesktopShortcut ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom DesktopShortcutPage DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPage
  ; Keep electron-builder's remembered shortcut state on manual upgrades. The
  ; choice belongs only to a fresh assisted install.
  IfFileExists "$INSTDIR\${PRODUCT_FILENAME}.exe" 0 +2
  Abort
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Shortcuts"
  Pop $0
  ${NSD_CreateCheckbox} 0 30u 100% 12u "Create a desktop shortcut"
  Pop $DesktopShortcutCheckbox
  ${NSD_Check} $DesktopShortcutCheckbox
  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $WantsDesktopShortcut
FunctionEnd

!macro customInstall
  ; electron-builder creates its normal shortcut first. Removing it here lets
  ; its built-in KeepShortcuts logic preserve this choice on silent updates.
  ${If} $WantsDesktopShortcut != ${BST_CHECKED}
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
  ${EndIf}
!macroend
!endif

!macro customUnInit
  ; Board data deliberately survives uninstall. A fresh install finds it again.
!macroend
