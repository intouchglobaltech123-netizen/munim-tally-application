package tally

import (
	"os"
	"testing"
)

// Writes the exact companies request to a file so it can be replayed with curl.
func TestDumpCompaniesRequest(t *testing.T) {
	if os.Getenv("DUMP_REQ") == "" {
		t.Skip("set DUMP_REQ=1 to dump")
	}
	if err := os.WriteFile("/tmp/goreq.xml", []byte(CompaniesRequest(Prime)), 0o644); err != nil {
		t.Fatal(err)
	}
}
