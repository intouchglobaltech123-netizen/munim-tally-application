package parse

import "testing"

func TestAmount(t *testing.T) {
	cases := []struct {
		in   string
		want int64 // paise
	}{
		{"", 0},
		{"0.00", 0},
		{"1,234.50", 123450},
		{"-1,25,000.00", -12500000}, // Indian grouping, the common case
		{"25,48,000.00", 254800000},
		{"1,00,00,000.00", 1000000000}, // one crore
		{"(2,500.00)", -250000},        // accountants' parentheses
		{"1234.5", 123450},             // one decimal place
		{"1234", 123400},               // no decimal place
		{"1,234.567", 123456},          // extra places truncate, no rounding surprise
		{"5000.00 Dr", 500000},
		{"5000.00 Cr", -500000},
		{"  1,000.00  ", 100000},
		{"1 234.00", 123400}, // stray space inside the number
	}
	for _, tc := range cases {
		got, err := Amount(tc.in)
		if err != nil {
			t.Errorf("Amount(%q) error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("Amount(%q) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestAmountRejectsNonNumeric(t *testing.T) {
	if _, err := Amount("N/A"); err == nil {
		t.Error("expected an error for non-numeric input")
	}
	if got := AmountOr("N/A"); got != 0 {
		t.Errorf("AmountOr fallback = %d, want 0", got)
	}
}

// Float money loses precision at scale; integer paise does not. This is the
// reason Amount returns int64.
func TestAmountStaysExactWhenAccumulated(t *testing.T) {
	var total int64
	for range 100000 {
		v, _ := Amount("0.10")
		total += v
	}
	if want := int64(1000000); total != want { // 100k * 10 paise = Rs 10,000
		t.Errorf("accumulated = %d, want %d", total, want)
	}
}

func TestDate(t *testing.T) {
	cases := map[string]string{
		"20260415": "2026-04-15",
		"20240229": "2024-02-29", // leap day
		"":         "",
		"2026041":  "", // wrong length
		"20261345": "", // impossible month
	}
	for in, want := range cases {
		if got := Date(in); got != want {
			t.Errorf("Date(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestQty(t *testing.T) {
	cases := []struct {
		in       string
		wantVal  float64
		wantUnit string
	}{
		{"12 Nos", 12, "Nos"},
		{"-3.500 Kg", -3.5, "Kg"},
		{"1,200 Mtr", 1200, "Mtr"},
		{"", 0, ""},
		{"5", 5, ""},
	}
	for _, tc := range cases {
		v, u := Qty(tc.in)
		if v != tc.wantVal || u != tc.wantUnit {
			t.Errorf("Qty(%q) = (%v, %q), want (%v, %q)", tc.in, v, u, tc.wantVal, tc.wantUnit)
		}
	}
}

func TestBoolAndCreditDays(t *testing.T) {
	if !Bool("Yes") || !Bool("yes") || Bool("No") || Bool("") {
		t.Error("Bool mishandled Tally yes/no")
	}
	if got := CreditDays("30 Days"); got != 30 {
		t.Errorf("CreditDays = %d, want 30", got)
	}
	if got := CreditDays(""); got != 0 {
		t.Errorf("CreditDays(blank) = %d, want 0", got)
	}
}
