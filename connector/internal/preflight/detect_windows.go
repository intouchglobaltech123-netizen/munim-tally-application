//go:build windows

package preflight

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// findTally locates a Tally installation. Registry first (authoritative), then
// the well-known paths, because portable/copied Tally installs are common in
// Indian SMBs and leave no registry entry.
func findTally() (path string, version string) {
	if p, v := tallyFromRegistry(); p != "" {
		return p, v
	}
	return tallyFromDisk()
}

var registryRoots = []struct {
	key  registry.Key
	path string
}{
	{registry.LOCAL_MACHINE, `SOFTWARE\Tally Solutions\TallyPrime`},
	{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Tally Solutions\TallyPrime`},
	{registry.LOCAL_MACHINE, `SOFTWARE\Tally Solutions\Tally.ERP9`},
	{registry.LOCAL_MACHINE, `SOFTWARE\WOW6432Node\Tally Solutions\Tally.ERP9`},
	{registry.CURRENT_USER, `SOFTWARE\Tally Solutions\TallyPrime`},
}

func tallyFromRegistry() (string, string) {
	for _, root := range registryRoots {
		k, err := registry.OpenKey(root.key, root.path, registry.QUERY_VALUE|registry.ENUMERATE_SUB_KEYS)
		if err != nil {
			continue
		}
		// Tally nests the install under a version subkey on some builds.
		for _, name := range []string{"ApplicationPath", "InstallPath", "Path"} {
			if v, _, err := k.GetStringValue(name); err == nil && v != "" {
				k.Close()
				return v, versionFromPath(root.path, v)
			}
		}
		subs, _ := k.ReadSubKeyNames(-1)
		k.Close()
		for _, sub := range subs {
			sk, err := registry.OpenKey(root.key, root.path+`\`+sub, registry.QUERY_VALUE)
			if err != nil {
				continue
			}
			v, _, err := sk.GetStringValue("ApplicationPath")
			sk.Close()
			if err == nil && v != "" {
				return v, versionFromPath(root.path, v)
			}
		}
	}
	return "", ""
}

var diskCandidates = []string{
	`Tally\TallyPrime`,
	`TallyPrime`,
	`Tally.ERP9`,
	`Tally\Tally.ERP9`,
}

func tallyFromDisk() (string, string) {
	var roots []string
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "SystemDrive"} {
		if v := os.Getenv(env); v != "" {
			roots = append(roots, v)
		}
	}
	for _, root := range roots {
		for _, c := range diskCandidates {
			dir := filepath.Join(root, c)
			for _, exe := range []string{"tally.exe", "tallyprime.exe"} {
				full := filepath.Join(dir, exe)
				if _, err := os.Stat(full); err == nil {
					return dir, versionFromPath(dir, exe)
				}
			}
		}
	}
	return "", ""
}

func versionFromPath(hints ...string) string {
	joined := strings.ToLower(strings.Join(hints, " "))
	switch {
	case strings.Contains(joined, "erp9"), strings.Contains(joined, "erp 9"):
		return "Tally ERP 9"
	case strings.Contains(joined, "prime"):
		return "Tally Prime"
	}
	return "Tally"
}

func freeSpace(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var freeToCaller, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeToCaller, &total, &free); err != nil {
		return 0, err
	}
	return freeToCaller, nil
}
