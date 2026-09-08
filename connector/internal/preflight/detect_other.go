//go:build !windows

package preflight

import "syscall"

// On non-Windows we are in development against the mock Tally. Report "not
// installed" rather than pretending, so the wizard's Tally-gateway check is
// what decides - and that check works fine against the mock.
func findTally() (path string, version string) { return "", "" }

func freeSpace(path string) (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return st.Bavail * uint64(st.Bsize), nil
}
