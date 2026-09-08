package sanitize

import (
	"encoding/xml"
	"strings"
	"testing"
)

// Every case here came from a real shape of Tally output. When you hit a new
// one in production, add it as a row - do not fix it inline elsewhere.
func TestClean(t *testing.T) {
	cases := []struct {
		name string
		in   []byte
		want string
	}{
		{
			name: "strips leading control bytes Tally prefixes",
			in:   []byte{0x04, 0x00, 0x1b, '<', 'A', '>', 'x', '<', '/', 'A', '>'},
			want: "<A>x</A>",
		},
		{
			name: "escapes a bare ampersand in a ledger name",
			in:   []byte("<NAME>R & K Traders</NAME>"),
			want: "<NAME>R &amp; K Traders</NAME>",
		},
		{
			name: "leaves an already-escaped ampersand alone",
			in:   []byte("<NAME>R &amp; K</NAME>"),
			want: "<NAME>R &amp; K</NAME>",
		},
		{
			// The naive "unescape all then re-escape all" approach breaks this:
			// it produces &amp;lt; and corrupts the name.
			name: "does not double-escape lt and gt entities",
			in:   []byte("<NAME>Paint &lt;Interior&gt;</NAME>"),
			want: "<NAME>Paint &lt;Interior&gt;</NAME>",
		},
		{
			name: "mixed bare and escaped in one string",
			in:   []byte("<N>A &amp; B &lt;x&gt; C & D</N>"),
			want: "<N>A &amp; B &lt;x&gt; C &amp; D</N>",
		},
		{
			name: "removes numeric refs for forbidden control chars",
			in:   []byte("<N>abc&#4;def</N>"),
			want: "<N>abcdef</N>",
		},
		{
			name: "keeps legal numeric refs",
			in:   []byte("<N>it&#39;s&#10;fine</N>"),
			want: "<N>it&#39;s&#10;fine</N>",
		},
		{
			name: "keeps tab newline carriage return",
			in:   []byte("<N>a\tb\nc\rd</N>"),
			want: "<N>a\tb\nc\rd</N>",
		},
		{
			name: "transcodes CP-1252 smart quote to UTF-8",
			in:   []byte{'<', 'N', '>', 0x92, '<', '/', 'N', '>'},
			want: "<N>’</N>",
		},
		{
			name: "strips a UTF-8 BOM",
			in:   append([]byte{0xEF, 0xBB, 0xBF}, []byte("<N>x</N>")...),
			want: "<N>x</N>",
		},
		{
			name: "trailing lone ampersand is escaped, not dropped",
			in:   []byte("<N>M/s &</N>"),
			want: "<N>M/s &amp;</N>",
		},
		{
			name: "ampersand followed by unterminated entity-like text",
			in:   []byte("<N>Steel &amp Iron</N>"),
			want: "<N>Steel &amp;amp Iron</N>",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(Clean(tc.in))
			if got != tc.want {
				t.Errorf("Clean()\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// The output must actually parse. This is the property that matters; the exact
// byte-for-byte result above is just how we get here.
func TestCleanOutputIsParseable(t *testing.T) {
	raw := []byte("\x04\x00<ENVELOPE><BODY><LEDGER><NAME>R & K Traders &lt;VIP&gt;</NAME>" +
		"<NOTE>ref&#4;001</NOTE></LEDGER></BODY></ENVELOPE>")

	var doc struct {
		Ledger struct {
			Name string `xml:"NAME"`
			Note string `xml:"NOTE"`
		} `xml:"BODY>LEDGER"`
	}
	if err := xml.Unmarshal(Clean(raw), &doc); err != nil {
		t.Fatalf("cleaned output failed to parse: %v", err)
	}
	if doc.Ledger.Name != "R & K Traders <VIP>" {
		t.Errorf("name round-trip wrong: %q", doc.Ledger.Name)
	}
	if doc.Ledger.Note != "ref001" {
		t.Errorf("note round-trip wrong: %q", doc.Ledger.Note)
	}
}

func TestCleanHandlesEmptyAndJunk(t *testing.T) {
	for _, in := range []string{"", "   ", "not xml at all", "<"} {
		if got := Clean([]byte(in)); got == nil && in != "" {
			t.Errorf("Clean(%q) returned nil", in)
		}
	}
}

func BenchmarkClean(b *testing.B) {
	payload := []byte(strings.Repeat("<LEDGER><NAME>R & K Traders</NAME></LEDGER>", 2000))
	b.SetBytes(int64(len(payload)))
	for b.Loop() {
		Clean(payload)
	}
}
