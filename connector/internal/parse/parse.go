// Package parse converts Tally's field formats into values the cloud can store.
//
// Tally speaks a dialect: amounts use Indian digit grouping and carry a unit
// suffix, dates are YYYYMMDD, quantities are "12 Nos", and booleans are
// "Yes"/"No". strconv.ParseFloat on any of these returns garbage or an error.
package parse

import (
	"errors"
	"strconv"
	"strings"
	"time"
)

// ErrNotANumber is returned when a field holds no parseable digits at all.
var ErrNotANumber = errors.New("parse: no numeric content")

// Amount converts a Tally amount to integer paise.
//
// Money is integer paise everywhere in this system - never float64. A float
// rupee value accumulates rounding error across a 400k-voucher aggregation,
// and an accounting product that is off by a paisa is a product nobody trusts.
//
//	"-1,25,000.00"  -> -12500000
//	"1,234.50 Dr"   ->    123450
//	"(2,500.00)"    ->   -250000
//	""              ->         0
func Amount(s string) (int64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}

	neg := false
	// Accountants' parentheses mean negative.
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg = true
		s = strings.TrimSuffix(strings.TrimPrefix(s, "("), ")")
	}
	// Dr/Cr suffixes: Cr is negative in Tally's export convention.
	upper := strings.ToUpper(s)
	switch {
	case strings.HasSuffix(upper, " CR"), strings.HasSuffix(upper, "CR"):
		neg = !neg
		s = upper[:len(upper)-2]
	case strings.HasSuffix(upper, " DR"), strings.HasSuffix(upper, "DR"):
		s = upper[:len(upper)-2]
	}

	var digits strings.Builder
	seenDot := false
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
			digits.WriteRune(r)
		case r == '-':
			if digits.Len() == 0 {
				neg = !neg
			}
		case r == '.' && !seenDot:
			seenDot = true
			digits.WriteRune('.')
		}
		// Commas, currency symbols, unit suffixes and spaces are dropped.
	}

	clean := digits.String()
	if clean == "" || clean == "." {
		return 0, ErrNotANumber
	}

	whole, frac, _ := strings.Cut(clean, ".")
	if whole == "" {
		whole = "0"
	}
	rupees, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, err
	}
	// Pad or truncate the fraction to exactly two digits.
	frac = (frac + "00")[:2]
	paise, err := strconv.ParseInt(frac, 10, 64)
	if err != nil {
		return 0, err
	}

	total := rupees*100 + paise
	if neg {
		total = -total
	}
	return total, nil
}

// AmountOr returns Amount(s), falling back to 0 on any error. Use it for
// non-critical fields where a malformed value should degrade one number rather
// than fail an entire batch.
func AmountOr(s string) int64 {
	v, err := Amount(s)
	if err != nil {
		return 0
	}
	return v
}

// Date converts Tally's YYYYMMDD to an ISO date string. An unparseable or
// empty date returns "" rather than an error - Tally leaves optional dates
// blank routinely, and that must not fail a voucher.
func Date(s string) string {
	s = strings.TrimSpace(s)
	if len(s) != 8 {
		return ""
	}
	t, err := time.Parse("20060102", s)
	if err != nil {
		return ""
	}
	return t.Format("2006-01-02")
}

// Qty converts "12 Nos" or "-3.500 Kg" to a float and its unit.
// Quantity is genuinely fractional (3.5 kg), so float is correct here -
// unlike money.
func Qty(s string) (float64, string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, ""
	}
	i := strings.IndexFunc(s, func(r rune) bool {
		return !(r >= '0' && r <= '9') && r != '.' && r != '-' && r != ',' && r != ' '
	})
	numPart, unit := s, ""
	if i > 0 {
		numPart, unit = s[:i], strings.TrimSpace(s[i:])
	}
	numPart = strings.ReplaceAll(strings.TrimSpace(numPart), ",", "")
	v, err := strconv.ParseFloat(numPart, 64)
	if err != nil {
		return 0, unit
	}
	return v, unit
}

// Bool reads Tally's "Yes"/"No" (and the blanks it sends instead of "No").
func Bool(s string) bool {
	return strings.EqualFold(strings.TrimSpace(s), "yes")
}

// CreditDays reads "30 Days" -> 30. Blank means no credit period set.
func CreditDays(s string) int {
	f, _ := Qty(s)
	return int(f)
}

// Int reads a plain integer field such as AlterID. Blank or malformed returns
// 0, which for a cursor means "treat as unknown" rather than crashing a batch.
func Int(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}
