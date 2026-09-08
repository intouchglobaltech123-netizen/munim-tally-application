package tally

import (
	"fmt"
	"strings"
)

// Version selects the request dialect. Tally Prime and ERP 9 differ in which
// native methods exist; asking ERP 9 for a Prime-only field makes it return an
// empty collection with no error, which looks exactly like "no new data".
type Version string

const (
	Prime Version = "prime"
	ERP9  Version = "erp9"
)

// Native methods per collection, per version. Keep these lists explicit: adding
// a field that a version does not support silently breaks that version's sync.
var nativeMethods = map[Version]map[string]string{
	Prime: {
		"Company":     "Name,StartingFrom,EndingAt,GUID,AlterID",
		"Group":       "Name,Parent,PrimaryGroup,GUID,AlterID",
		"Ledger":      "Name,Parent,OpeningBalance,ClosingBalance,LedgerPhone,LedgerMobile,Email,PartyGSTIN,BillCreditPeriod,GUID,AlterID",
		"StockItem":   "Name,BaseUnits,ClosingBalance,ClosingValue,GUID,AlterID",
		"VoucherType": "Name,Parent,GUID",
		"Voucher":     "Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Narration,Amount,IsCancelled,IsOptional,GUID,AlterID",
	},
	ERP9: {
		"Company": "Name,StartingFrom,EndingAt,GUID,AlterID",
		"Group":   "Name,Parent,PrimaryGroup,GUID,AlterID",
		// ERP 9 builds without the GST add-on have no PartyGSTIN method.
		"Ledger":      "Name,Parent,OpeningBalance,ClosingBalance,LedgerPhone,LedgerMobile,Email,BillCreditPeriod,GUID,AlterID",
		"StockItem":   "Name,BaseUnits,ClosingBalance,ClosingValue,GUID,AlterID",
		"VoucherType": "Name,Parent,GUID",
		"Voucher":     "Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Narration,Amount,IsCancelled,IsOptional,GUID,AlterID",
	},
}

// Child collections to pull down with a voucher. Without FETCH you get a
// voucher header and no line items.
const voucherFetch = "AllLedgerEntries,LedgerEntries,AllInventoryEntries,BillAllocations"

// CollectionRequest builds an Export/Collection envelope.
//
// sinceAlterID is the incremental cursor: pass -1 for "everything". The filter
// is what makes sync incremental instead of a full re-download every 30s.
func CollectionRequest(v Version, collType, company string, sinceAlterID int64) string {
	methods, ok := nativeMethods[v][collType]
	if !ok {
		methods = "Name,GUID,AlterID"
	}

	var filter, system string
	if sinceAlterID >= 0 {
		filter = "\n        <FILTER>MunimAlterFilter</FILTER>"
		// &gt; because this XML is itself XML-escaped inside the envelope.
		system = fmt.Sprintf(
			"\n      <SYSTEM TYPE=\"Formulae\" NAME=\"MunimAlterFilter\">$AlterID &gt; %d</SYSTEM>",
			sinceAlterID)
	}

	var fetch string
	if collType == "Voucher" {
		fetch = "\n        <FETCH>" + voucherFetch + "</FETCH>"
	}

	var companyVar string
	if company != "" {
		companyVar = "\n      <SVCURRENTCOMPANY>" + escape(company) + "</SVCURRENTCOMPANY>"
	}

	name := "Munim" + collType + "s"
	return fmt.Sprintf(`<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>%s</ID>
  </HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>%s
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="%s" ISMODIFY="No">
        <TYPE>%s</TYPE>
        <NATIVEMETHOD>%s</NATIVEMETHOD>%s%s
      </COLLECTION>%s
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`, name, companyVar, name, collType, methods, fetch, filter, system)
}

// CompaniesRequest lists the companies present in this Tally installation.
func CompaniesRequest(v Version) string {
	return `<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>ListOfCompanies</ID>
  </HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVIsSimpleCompany>No</SVIsSimpleCompany>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="ListOfCompanies" ISINITIALIZE="Yes">
        <TYPE>Company</TYPE>
        <NATIVEMETHOD>` + nativeMethods[v]["Company"] + `</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`
}

// ReconcileRequest asks for GUIDs only, for one month. Used by the nightly
// deletion check - deleted vouchers never appear in an AlterID delta, so
// without this the cloud keeps showing invoices the customer already deleted.
func ReconcileRequest(v Version, company, month string) string {
	return fmt.Sprintf(`<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>MunimReconcile</ID>
  </HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>%s</SVCURRENTCOMPANY>
      <SVMONTH>%s</SVMONTH>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="MunimReconcile" ISMODIFY="No">
        <TYPE>Voucher</TYPE>
        <NATIVEMETHOD>GUID,AlterID</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>`, escape(company), month)
}

func escape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}
