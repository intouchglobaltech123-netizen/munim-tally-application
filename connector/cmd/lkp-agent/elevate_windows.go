//go:build windows

package main

import (
	"os"
	"strings"

	"golang.org/x/sys/windows"
)

// isAdmin reports whether this process can install a Windows service.
func isAdmin() bool {
	var sid *windows.SID
	// S-1-5-32-544 = BUILTIN\Administrators
	err := windows.AllocateAndInitializeSid(
		&windows.SECURITY_NT_AUTHORITY, 2,
		windows.SECURITY_BUILTIN_DOMAIN_RID,
		windows.DOMAIN_ALIAS_RID_ADMINS,
		0, 0, 0, 0, 0, 0, &sid)
	if err != nil {
		return false
	}
	defer windows.FreeSid(sid)

	member, err := windows.Token(0).IsMember(sid)
	return err == nil && member
}

// relaunchElevated restarts this program with a UAC prompt.
//
// We do NOT put requireAdministrator in the manifest, because then every
// support command (check, sync, companies) would demand admin too. Only the
// service install genuinely needs it, so we ask only at that moment - and the
// user sees the prompt right after clicking a button that says "Install".
func relaunchElevated(args ...string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	params, _ := windows.UTF16PtrFromString(strings.Join(args, " "))
	cwd, _ := windows.UTF16PtrFromString("")

	return windows.ShellExecute(0, verb, file, params, cwd, windows.SW_NORMAL)
}
