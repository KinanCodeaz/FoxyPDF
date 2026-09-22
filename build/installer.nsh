; ---------------------------------------------------------------------------
; FoxyPDF custom NSIS script (electron-builder `build/installer.nsh`)
;
; v1.3.11: Adds an "create desktop shortcut" checkbox to the assisted
; installer wizard. The checkbox is shown right after choosing the install
; destination, is CHECKED by default, and only creates the desktop shortcut
; when left checked (silent installs keep the default = create).
;
; electron-builder's assistedInstaller.nsh invokes the `customPageAfterChangeDir`
; macro between the directory page and instfiles (only when
; allowToChangeInstallationDirectory is on, which it is), and `customInit` from
; inside Function .onInit. `customInstall` is executed at the very end of the
; install section, right after the desktop shortcut was created, where we
; remove it again if the user un-ticked the box.
; ---------------------------------------------------------------------------

!include LogicLib.nsh
!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER

  Var DesktopShortcutCheckbox
  Var CreateDesktopShortcut

  !macro customInit
    ; Default: create the shortcut. The page (if shown) may override this.
    StrCpy $CreateDesktopShortcut "1"
  !macroend

  !macro customPageAfterChangeDir
    Page custom shortcutOptionsPageCreate shortcutOptionsPageLeave
  !macroend

  Function shortcutOptionsPageCreate
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0u 8u 100% 24u "Shortcuts"
    Pop $0

    ${NSD_CreateCheckbox} 0u 36u 100% 12u "Create a desktop shortcut"
    Pop $DesktopShortcutCheckbox
    ${NSD_SetState} $DesktopShortcutCheckbox ${BST_CHECKED}

    nsDialogs::Show
  FunctionEnd

  Function shortcutOptionsPageLeave
    ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcut
  FunctionEnd

  !macro customInstall
    ; If the user un-ticked the box, remove the desktop shortcut that
    ; electron-builder just created unconditionally (addDesktopLink writes
    ; "$DESKTOP\${SHORTCUT_NAME}.lnk").
    ${If} $CreateDesktopShortcut == ${BST_UNCHECKED}
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ${EndIf}
  !macroend

!endif