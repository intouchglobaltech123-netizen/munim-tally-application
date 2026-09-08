package sync

import (
	"strings"
	"time"

	"munim/connector/internal/models"
	"munim/connector/internal/parse"
)

// Normalizing is where Tally's string soup becomes typed data. It never
// returns an error: a malformed field degrades to a zero value so that one bad
// voucher cannot fail a 500-record batch. Money becomes integer paise.

func normalizeCompany(c models.Company) models.Record {
	return models.Record{
		Kind: "company", CompanyGUID: c.GUID, GUID: c.GUID, AlterID: parse.Int(c.AlterID),
		Data: models.NormalizedCompany{Name: c.DisplayName(), FyStart: parse.Date(c.FyStart)},
	}
}

func normalizeGroup(companyGUID string, g models.Group) models.Record {
	return models.Record{
		Kind: "group", CompanyGUID: companyGUID, GUID: g.GUID, AlterID: parse.Int(g.AlterID),
		Data: models.NormalizedGroup{Name: g.DisplayName(), Parent: g.Parent, PrimaryGroup: g.PrimaryGroup},
	}
}

func normalizeLedger(companyGUID string, l models.Ledger) models.Record {
	phone := l.Mobile
	if phone == "" {
		phone = l.Phone
	}
	return models.Record{
		Kind: "ledger", CompanyGUID: companyGUID, GUID: l.GUID, AlterID: parse.Int(l.AlterID),
		Data: models.NormalizedLedger{
			Name:   l.DisplayName(),
			Parent: l.Parent,
			// Tally signs Debit negative and Credit positive. We store the
			// opposite - Debit positive - because that is what every screen
			// wants: a customer who owes you money reads as a positive
			// receivable, and cash in hand is not a negative number.
			OpeningPaise: -parse.AmountOr(l.OpeningBal),
			ClosingPaise: -parse.AmountOr(l.ClosingBal),
			Phone:        phone,
			Email:        l.Email,
			GSTIN:        l.GSTIN,
			CreditDays:   parse.CreditDays(l.CreditDays),
		},
	}
}

func normalizeStockItem(companyGUID string, s models.StockItem) models.Record {
	qty, unit := parse.Qty(s.ClosingQty)
	if unit == "" {
		unit = s.Unit
	}
	return models.Record{
		Kind: "stockItem", CompanyGUID: companyGUID, GUID: s.GUID, AlterID: parse.Int(s.AlterID),
		Data: models.NormalizedStockItem{
			Name: s.DisplayName(), Unit: unit, ClosingQty: qty,
			ClosingValuePaise: parse.AmountOr(s.ClosingValue),
		},
	}
}

// resolveDueDate turns Tally's BILLCREDITPERIOD into an ISO date.
// It is a date on some exports and a period ("30 Days") on others.
func resolveDueDate(period, voucherDate string) string {
	if d := parse.Date(period); d != "" {
		return d
	}
	days := parse.CreditDays(period)
	if days == 0 {
		return ""
	}
	base, err := time.Parse("20060102", strings.TrimSpace(voucherDate))
	if err != nil {
		return ""
	}
	return base.AddDate(0, 0, days).Format("2006-01-02")
}

func normalizeVoucher(companyGUID string, v models.Voucher) models.Record {
	// Everything money-shaped is negated, exactly as ledger balances are:
	// Tally signs Debit negative, we store Debit positive. Flipping balances
	// but NOT entries makes a statement's running total end at the negative of
	// the ledger's closing figure - two different numbers for one party.
	nv := models.NormalizedVoucher{
		VchNo:       v.VchNo,
		VchType:     v.VchType,
		Date:        parse.Date(v.Date),
		Party:       v.PartyLedger,
		AmountPaise: -parse.AmountOr(v.Amount),
		Narration:   v.Narration,
		IsCancelled: parse.Bool(v.IsCancelled),
		IsOptional:  parse.Bool(v.IsOptional),
	}

	for _, e := range v.LedgerEntries {
		nv.Entries = append(nv.Entries, models.NormalizedEntry{
			Ledger: e.LedgerName, AmountPaise: -parse.AmountOr(e.Amount),
		})
		for _, b := range e.BillAllocations {
			nv.Bills = append(nv.Bills, models.NormalizedBill{
				Ref:      b.Name,
				BillType: b.BillType,
				// Tally stores a bill's credit period either as a date or as
				// "30 Days". Resolve both against the voucher date, or ageing
				// has nothing to measure from and every bill reads as not due.
				DueDate:     resolveDueDate(b.DueDate, v.Date),
				AmountPaise: -parse.AmountOr(b.Amount),
			})
		}
	}

	for _, it := range v.InventoryEntries {
		qty, unit := parse.Qty(it.ActualQty)
		nv.Items = append(nv.Items, models.NormalizedItem{
			Item: it.StockItemName, Qty: qty, Unit: unit,
			RatePaise:   parse.AmountOr(it.Rate),
			AmountPaise: -parse.AmountOr(it.Amount),
		})
	}

	return models.Record{
		Kind: "voucher", CompanyGUID: companyGUID, GUID: v.GUID,
		AlterID: parse.Int(v.AlterID), Data: nv,
	}
}
