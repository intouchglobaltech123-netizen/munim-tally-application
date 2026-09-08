// Package sanitize repairs the byte stream Tally returns so that a standard XML
// parser can read it.
//
// Tally's output is not valid XML. On real customer data you will meet, in
// roughly this order of frequency:
//
//  1. control bytes (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F) sprinkled anywhere
//  2. numeric character references for those same control chars: &#4;
//  3. bare, unescaped & in ledger names: "R & K Traders"
//  4. CP-1252 / ISO-8859-1 bytes claiming to be UTF-8 (smart quotes, accents)
//  5. a UTF-8 BOM, or leading junk before the first '<'
//
// Every fix here exists because the naive version corrupts real data. In
// particular, do NOT "unescape everything then re-escape everything" - that
// turns &lt; into &amp;lt; and silently mangles every name in the book.
package sanitize

import (
	"bytes"
	"unicode/utf8"
)

// Clean returns a byte slice safe to hand to encoding/xml.
func Clean(data []byte) []byte {
	data = stripControlBytes(data)
	data = toUTF8(data)
	data = trimToEnvelope(data)
	data = stripControlEntities(data)
	data = escapeBareAmpersands(data)
	return data
}

// 1. Drop the control bytes XML 1.0 forbids. Tab (0x09), LF (0x0A) and CR
// (0x0D) are legal and must survive.
func stripControlBytes(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for _, b := range in {
		switch {
		case b <= 0x08, b == 0x0B, b == 0x0C, b >= 0x0E && b <= 0x1F:
			continue
		}
		out = append(out, b)
	}
	return out
}

// 4. If the payload is not valid UTF-8 it is almost always CP-1252 from a
// Windows Tally build. Transcode rather than dropping bytes, or party names
// with accented or regional characters get mangled.
func toUTF8(in []byte) []byte {
	if utf8.Valid(in) {
		return bytes.TrimPrefix(in, []byte{0xEF, 0xBB, 0xBF}) // strip BOM
	}
	out := make([]byte, 0, len(in)+len(in)/4)
	for _, b := range in {
		if b < 0x80 {
			out = append(out, b)
			continue
		}
		out = utf8.AppendRune(out, cp1252[b-0x80])
	}
	return out
}

// 5. Tally sometimes prefixes junk (or serves an HTML error page) before the
// XML. Start at the first '<'.
func trimToEnvelope(in []byte) []byte {
	if i := bytes.IndexByte(in, '<'); i > 0 {
		return in[i:]
	}
	return in
}

// 2. &#4; and friends are legal-looking but illegal in XML 1.0. Remove them.
func stripControlEntities(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); {
		if in[i] == '&' && i+2 < len(in) && in[i+1] == '#' {
			if code, end, ok := parseNumericRef(in, i); ok && isForbiddenChar(code) {
				i = end
				continue
			}
		}
		out = append(out, in[i])
		i++
	}
	return out
}

// 3. Escape only the ampersands that do not already start a valid entity.
// "R & K" becomes "R &amp; K", while "&lt;" and "&#39;" are left untouched.
func escapeBareAmpersands(in []byte) []byte {
	out := make([]byte, 0, len(in))
	for i := 0; i < len(in); i++ {
		if in[i] != '&' {
			out = append(out, in[i])
			continue
		}
		if isEntityStart(in, i) {
			out = append(out, '&')
			continue
		}
		out = append(out, "&amp;"...)
	}
	return out
}

// isEntityStart reports whether the '&' at i begins a well-formed entity
// reference. Scans at most 10 bytes - a longer run is not an entity.
func isEntityStart(in []byte, i int) bool {
	const maxEntityLen = 10
	end := min(i+maxEntityLen, len(in))
	j := i + 1
	if j < end && in[j] == '#' {
		_, _, ok := parseNumericRef(in, i)
		return ok
	}
	start := j
	for j < end && isAlnum(in[j]) {
		j++
	}
	return j > start && j < end && in[j] == ';'
}

// parseNumericRef reads "&#123;" or "&#x1F;" starting at i. It returns the code
// point, the index just past the ';', and whether it parsed.
func parseNumericRef(in []byte, i int) (code int, end int, ok bool) {
	j := i + 2 // skip "&#"
	base := 10
	if j < len(in) && (in[j] == 'x' || in[j] == 'X') {
		base = 16
		j++
	}
	start := j
	for j < len(in) && j-start < 8 {
		d := digitVal(in[j], base)
		if d < 0 {
			break
		}
		code = code*base + d
		j++
	}
	if j == start || j >= len(in) || in[j] != ';' {
		return 0, 0, false
	}
	return code, j + 1, true
}

// isForbiddenChar reports whether a code point is illegal in XML 1.0 text.
func isForbiddenChar(c int) bool {
	if c == 0x09 || c == 0x0A || c == 0x0D {
		return false
	}
	return c < 0x20
}

func isAlnum(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9'
}

func digitVal(b byte, base int) int {
	var v int
	switch {
	case b >= '0' && b <= '9':
		v = int(b - '0')
	case b >= 'a' && b <= 'f':
		v = int(b-'a') + 10
	case b >= 'A' && b <= 'F':
		v = int(b-'A') + 10
	default:
		return -1
	}
	if v >= base {
		return -1
	}
	return v
}

// cp1252 maps bytes 0x80-0xFF to their Unicode code points. 0xA0-0xFF match
// Latin-1; only 0x80-0x9F differ, and that is exactly where the smart quotes
// and dashes Tally emits live.
var cp1252 = [128]rune{
	0x20AC, 0xFFFD, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
	0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0xFFFD, 0x017D, 0xFFFD,
	0xFFFD, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
	0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0xFFFD, 0x017E, 0x0178,
	0x00A0, 0x00A1, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7,
	0x00A8, 0x00A9, 0x00AA, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF,
	0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x00B6, 0x00B7,
	0x00B8, 0x00B9, 0x00BA, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x00BF,
	0x00C0, 0x00C1, 0x00C2, 0x00C3, 0x00C4, 0x00C5, 0x00C6, 0x00C7,
	0x00C8, 0x00C9, 0x00CA, 0x00CB, 0x00CC, 0x00CD, 0x00CE, 0x00CF,
	0x00D0, 0x00D1, 0x00D2, 0x00D3, 0x00D4, 0x00D5, 0x00D6, 0x00D7,
	0x00D8, 0x00D9, 0x00DA, 0x00DB, 0x00DC, 0x00DD, 0x00DE, 0x00DF,
	0x00E0, 0x00E1, 0x00E2, 0x00E3, 0x00E4, 0x00E5, 0x00E6, 0x00E7,
	0x00E8, 0x00E9, 0x00EA, 0x00EB, 0x00EC, 0x00ED, 0x00EE, 0x00EF,
	0x00F0, 0x00F1, 0x00F2, 0x00F3, 0x00F4, 0x00F5, 0x00F6, 0x00F7,
	0x00F8, 0x00F9, 0x00FA, 0x00FB, 0x00FC, 0x00FD, 0x00FE, 0x00FF,
}
