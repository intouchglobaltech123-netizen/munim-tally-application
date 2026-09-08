package tally

import (
	"strings"
	"testing"
)

// The AlterID filter is the difference between incremental sync and
// re-downloading the whole book every 30 seconds. If this regresses, sync
// still "works" - it is just ruinously slow and nobody notices until a
// customer with 5 years of data installs it.
func TestCollectionRequestIncludesAlterIDFilter(t *testing.T) {
	req := CollectionRequest(Prime, "Voucher", "R & K Traders", 7172)

	if !strings.Contains(req, "$AlterID &gt; 7172") {
		t.Error("AlterID filter missing - sync would pull everything every time")
	}
	if !strings.Contains(req, "<FILTER>MunimAlterFilter</FILTER>") {
		t.Error("collection does not reference the filter")
	}
}

func TestCollectionRequestOmitsFilterForFullPull(t *testing.T) {
	req := CollectionRequest(Prime, "Ledger", "Acme", -1)
	if strings.Contains(req, "MunimAlterFilter") {
		t.Error("a full pull (-1) must not carry an AlterID filter")
	}
}

// Without FETCH, Tally returns voucher headers with no line items, and every
// invoice in the app shows a total with nothing inside it.
func TestVoucherRequestFetchesChildCollections(t *testing.T) {
	req := CollectionRequest(Prime, "Voucher", "Acme", 0)
	for _, want := range []string{"AllLedgerEntries", "AllInventoryEntries", "BillAllocations"} {
		if !strings.Contains(req, want) {
			t.Errorf("voucher request does not FETCH %s", want)
		}
	}
	// Only vouchers have child collections worth fetching.
	if strings.Contains(CollectionRequest(Prime, "Ledger", "Acme", 0), "<FETCH>") {
		t.Error("ledger request should not carry a FETCH")
	}
}

// A company name with & must be escaped, or the request itself is invalid XML
// and Tally rejects it. "R & K Traders" is a real customer name shape.
func TestCompanyNameIsEscaped(t *testing.T) {
	req := CollectionRequest(Prime, "Ledger", "R & K <Traders>", 0)
	if !strings.Contains(req, "<SVCURRENTCOMPANY>R &amp; K &lt;Traders&gt;</SVCURRENTCOMPANY>") {
		t.Error("company name not XML-escaped in the request")
	}
}

// ERP 9 builds without the GST add-on have no PartyGSTIN native method.
// Asking for it makes Tally return an empty collection with no error, which
// looks exactly like "no new data" - a silent, total sync failure.
func TestERP9OmitsPrimeOnlyFields(t *testing.T) {
	erp9 := CollectionRequest(ERP9, "Ledger", "Acme", 0)
	prime := CollectionRequest(Prime, "Ledger", "Acme", 0)

	if strings.Contains(erp9, "PartyGSTIN") {
		t.Error("ERP 9 request asks for PartyGSTIN")
	}
	if !strings.Contains(prime, "PartyGSTIN") {
		t.Error("Prime request should ask for PartyGSTIN")
	}
}

// The connector is read-only into Tally. An Import request would let it write
// vouchers into a customer's books - the single worst bug this product could
// ship. This test is the guard.
func TestNoRequestCanWriteToTally(t *testing.T) {
	reqs := []string{
		CompaniesRequest(Prime),
		CollectionRequest(Prime, "Voucher", "Acme", 0),
		CollectionRequest(ERP9, "Ledger", "Acme", -1),
		ReconcileRequest(Prime, "Acme", "202607"),
	}
	for _, r := range reqs {
		if strings.Contains(r, "<TALLYREQUEST>Import") || strings.Contains(r, "ISMODIFY=\"Yes\"") {
			t.Fatal("a request template can write to Tally - this must never ship")
		}
		if !strings.Contains(r, "<TALLYREQUEST>Export</TALLYREQUEST>") {
			t.Error("request is not an Export")
		}
	}
}
