package preflight

import "strings"

// detectVersion infers the Tally product line from a gateway response.
//
// This drives which XML request templates the connector uses, so getting it
// wrong means an empty sync that looks like "no new data". When in doubt,
// default to Prime: it is the majority of installs, and its templates degrade
// more gracefully on ERP 9 than the reverse.
func detectVersion(responseHead string) string {
	h := strings.ToUpper(responseHead)
	switch {
	case strings.Contains(h, "TALLYPRIME"), strings.Contains(h, "TALLY PRIME"):
		return "prime"
	case strings.Contains(h, "ERP 9"), strings.Contains(h, "ERP9"):
		return "erp9"
	}
	return "prime"
}
