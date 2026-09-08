//go:build !windows

package main

import "errors"

// On non-Windows there is no service to install, so the first-run flow treats
// the process as already privileged and never tries to elevate.
func isAdmin() bool { return true }

func relaunchElevated(args ...string) error {
	return errors.New("elevation is only supported on Windows")
}
