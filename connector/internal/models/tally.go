// Package models holds the XML shapes Tally returns and the normalized records
// we push to the cloud.
//
// Rule: every field in the XML structs is a string. Tally omits fields, sends
// blanks, and changes formats between versions - decoding straight into int64
// or time.Time makes one odd customer record fail an entire batch. Parse in
// Normalize(), where a bad field can degrade to zero instead of erroring.
package models

import (
	"encoding/xml"
	"strings"
)

// Envelope is the outer shape of every Tally Collection response.
type Envelope struct {
	XMLName    xml.Name `xml:"ENVELOPE"`
	Collection struct {
		Companies    []Company     `xml:"COMPANY"`
		Groups       []Group       `xml:"GROUP"`
		Ledgers      []Ledger      `xml:"LEDGER"`
		StockItems   []StockItem   `xml:"STOCKITEM"`
		VoucherTypes []VoucherType `xml:"VOUCHERTYPE"`
		Vouchers     []Voucher     `xml:"VOUCHER"`
	} `xml:"BODY>DATA>COLLECTION"`
	// Tally reports failures as a LINEERROR rather than an HTTP status.
	LineError string `xml:"BODY>DESC>LINEERROR"`
}

type Company struct {
	NameAttr string `xml:"NAME,attr"`
	Name     string `xml:"NAME"`
	GUID     string `xml:"GUID"`
	FyStart  string `xml:"STARTINGFROM"`
	AlterID  string `xml:"ALTERID"`
}

type Group struct {
	NameAttr     string `xml:"NAME,attr"`
	Name         string `xml:"NAME"`
	GUID         string `xml:"GUID"`
	Parent       string `xml:"PARENT"`
	PrimaryGroup string `xml:"PRIMARYGROUP"`
	AlterID      string `xml:"ALTERID"`
}

type Ledger struct {
	// Real Tally returns the name as an attribute; the <NAME> child is usually
	// empty because it holds a language list. Read both and prefer whichever
	// is populated - see Ledger.DisplayName.
	NameAttr   string `xml:"NAME,attr"`
	Name       string `xml:"NAME"`
	GUID       string `xml:"GUID"`
	Parent     string `xml:"PARENT"`
	OpeningBal string `xml:"OPENINGBALANCE"`
	ClosingBal string `xml:"CLOSINGBALANCE"`
	Phone      string `xml:"LEDGERPHONE"`
	Mobile     string `xml:"LEDGERMOBILE"`
	Email      string `xml:"EMAIL"`
	GSTIN      string `xml:"PARTYGSTIN"`
	CreditDays string `xml:"BILLCREDITPERIOD"`
	AlterID    string `xml:"ALTERID"`
}

type StockItem struct {
	NameAttr     string `xml:"NAME,attr"`
	Name         string `xml:"NAME"`
	GUID         string `xml:"GUID"`
	Unit         string `xml:"BASEUNITS"`
	ClosingQty   string `xml:"CLOSINGBALANCE"`
	ClosingValue string `xml:"CLOSINGVALUE"`
	AlterID      string `xml:"ALTERID"`
}

type VoucherType struct {
	Name   string `xml:"NAME"`
	GUID   string `xml:"GUID"`
	Parent string `xml:"PARENT"`
}

type Voucher struct {
	GUID        string `xml:"GUID"`
	Date        string `xml:"DATE"`
	VchType     string `xml:"VOUCHERTYPENAME"`
	VchNo       string `xml:"VOUCHERNUMBER"`
	PartyLedger string `xml:"PARTYLEDGERNAME"`
	Narration   string `xml:"NARRATION"`
	Amount      string `xml:"AMOUNT"`
	IsCancelled string `xml:"ISCANCELLED"`
	IsOptional  string `xml:"ISOPTIONAL"`
	AlterID     string `xml:"ALTERID"`

	LedgerEntries    []LedgerEntry    `xml:"ALLLEDGERENTRIES.LIST"`
	InventoryEntries []InventoryEntry `xml:"ALLINVENTORYENTRIES.LIST"`
}

type LedgerEntry struct {
	LedgerName       string           `xml:"LEDGERNAME"`
	Amount           string           `xml:"AMOUNT"`
	IsDeemedPositive string           `xml:"ISDEEMEDPOSITIVE"`
	BillAllocations  []BillAllocation `xml:"BILLALLOCATIONS.LIST"`
}

type BillAllocation struct {
	Name     string `xml:"NAME"`
	BillType string `xml:"BILLTYPE"`
	DueDate  string `xml:"BILLCREDITPERIOD"`
	Amount   string `xml:"AMOUNT"`
}

type InventoryEntry struct {
	StockItemName string `xml:"STOCKITEMNAME"`
	ActualQty     string `xml:"ACTUALQTY"`
	Rate          string `xml:"RATE"`
	Amount        string `xml:"AMOUNT"`
}

// DisplayName returns whichever of the attribute or child element Tally
// actually filled in. Mock servers tend to populate the child; real Tally
// populates the attribute - so relying on either alone silently yields blank
// names against one of them.
func (l Ledger) DisplayName() string    { return firstNonEmpty(l.NameAttr, l.Name) }
func (s StockItem) DisplayName() string { return firstNonEmpty(s.NameAttr, s.Name) }
func (g Group) DisplayName() string     { return firstNonEmpty(g.NameAttr, g.Name) }
func (c Company) DisplayName() string   { return firstNonEmpty(c.Name, c.NameAttr) }

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// --- normalized records pushed to the cloud --------------------------------

// Record is one line of the NDJSON batch sent to POST /v1/ingest.
type Record struct {
	Kind        string `json:"kind"` // company|group|ledger|stockItem|voucher
	CompanyGUID string `json:"companyGuid"`
	GUID        string `json:"guid"`
	AlterID     int64  `json:"alterId"`
	Data        any    `json:"data"`
}

type NormalizedCompany struct {
	Name    string `json:"name"`
	FyStart string `json:"fyStart,omitempty"`
}

type NormalizedGroup struct {
	Name         string `json:"name"`
	Parent       string `json:"parent,omitempty"`
	PrimaryGroup string `json:"primaryGroup,omitempty"`
}

type NormalizedLedger struct {
	Name         string `json:"name"`
	Parent       string `json:"parentGroup"`
	OpeningPaise int64  `json:"openingPaise"`
	ClosingPaise int64  `json:"closingPaise"`
	Phone        string `json:"phone,omitempty"`
	Email        string `json:"email,omitempty"`
	GSTIN        string `json:"gstin,omitempty"`
	CreditDays   int    `json:"creditDays"`
}

type NormalizedStockItem struct {
	Name              string  `json:"name"`
	Unit              string  `json:"unit,omitempty"`
	ClosingQty        float64 `json:"closingQty"`
	ClosingValuePaise int64   `json:"closingValuePaise"`
}

type NormalizedVoucher struct {
	VchNo       string            `json:"vchNo"`
	VchType     string            `json:"vchType"`
	Date        string            `json:"date"` // ISO YYYY-MM-DD
	Party       string            `json:"party"`
	AmountPaise int64             `json:"amountPaise"`
	Narration   string            `json:"narration,omitempty"`
	IsCancelled bool              `json:"isCancelled"`
	IsOptional  bool              `json:"isOptional"`
	Entries     []NormalizedEntry `json:"entries,omitempty"`
	Items       []NormalizedItem  `json:"items,omitempty"`
	Bills       []NormalizedBill  `json:"bills,omitempty"`
}

type NormalizedEntry struct {
	Ledger      string `json:"ledger"`
	AmountPaise int64  `json:"amountPaise"`
}

type NormalizedItem struct {
	Item        string  `json:"item"`
	Qty         float64 `json:"qty"`
	Unit        string  `json:"unit,omitempty"`
	RatePaise   int64   `json:"ratePaise"`
	AmountPaise int64   `json:"amountPaise"`
}

type NormalizedBill struct {
	Ref         string `json:"ref"`
	BillType    string `json:"billType,omitempty"`
	DueDate     string `json:"dueDate,omitempty"`
	AmountPaise int64  `json:"amountPaise"`
}
