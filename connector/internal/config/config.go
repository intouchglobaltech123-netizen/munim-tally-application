// Package config stores connector settings and the device token on disk.
package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// Config is what survives a restart. It lives in ProgramData, not the install
// directory, so an upgrade that replaces the binary never wipes the pairing.
type Config struct {
	CloudURL     string    `json:"cloudUrl"`
	TallyURL     string    `json:"tallyUrl"`
	TallyVersion string    `json:"tallyVersion"`
	DeviceToken  string    `json:"deviceToken"`
	ConnectorID  string    `json:"connectorId"`
	OrgID        string    `json:"orgId"`
	OrgName      string    `json:"orgName"`
	Phone        string    `json:"phone"`
	Companies    []Company `json:"companies"`
	PairedAt     string    `json:"pairedAt"`
	IntervalSecs int       `json:"intervalSecs"`
}

type Company struct {
	TallyGUID string `json:"tallyGuid"`
	Name      string `json:"name"`
	FyStart   string `json:"fyStart,omitempty"`
	Enabled   bool   `json:"enabled"`
}

func (c *Config) Paired() bool { return c.DeviceToken != "" }

// EnabledCompanies returns only what the owner chose to sync.
func (c *Config) EnabledCompanies() []Company {
	var out []Company
	for _, co := range c.Companies {
		if co.Enabled {
			out = append(out, co)
		}
	}
	return out
}

// Dir is where connector state lives.
//
//	MUNIM_HOME set: that directory
//	Windows:        C:\ProgramData\Munim
//	dev:            ./.munim
//
// MUNIM_HOME is honoured on every platform, Windows included. It is what lets
// you run a demo, or a second instance on a support call, without touching the
// real installation's pairing and cursors.
func Dir() string {
	if d := os.Getenv("MUNIM_HOME"); d != "" {
		return d
	}
	if runtime.GOOS == "windows" {
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, "Munim")
		}
		return `C:\ProgramData\Munim`
	}
	return ".munim"
}

func Path() string { return filepath.Join(Dir(), "config.json") }

func Load() (*Config, error) {
	c := &Config{
		CloudURL:     "https://api.munim.app",
		TallyURL:     "http://localhost:9000",
		TallyVersion: "prime",
		IntervalSecs: 30,
	}
	b, err := os.ReadFile(Path())
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil // first run: defaults, unpaired
		}
		return c, err
	}
	if err := json.Unmarshal(b, c); err != nil {
		// A corrupt config must not brick the service. Keep defaults and let
		// the user re-run setup rather than crash-looping on boot.
		return c, nil
	}
	return c, nil
}

func (c *Config) Save() error {
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// 0600: the device token is a credential. On Windows, ProgramData\Munim
	// should additionally be ACL'd to SYSTEM+Administrators by the installer.
	tmp := Path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, Path())
}

// StatePath is where sync cursors live, beside the config.
func StatePath() string { return filepath.Join(Dir(), "cursors.json") }

// LogPath is the connector's rolling log.
func LogPath() string { return filepath.Join(Dir(), "connector.log") }
