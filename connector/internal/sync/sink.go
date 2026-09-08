package sync

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sort"
	"strings"
	"sync"

	"munim/connector/internal/models"
)

// NDJSONSink writes one JSON record per line - the exact wire format of
// POST /v1/ingest. Piping this to a file gives you a fixture for API tests.
type NDJSONSink struct {
	w  *bufio.Writer
	mu sync.Mutex
}

func NewNDJSONSink(w io.Writer) *NDJSONSink {
	return &NDJSONSink{w: bufio.NewWriterSize(w, 1<<16)}
}

func (s *NDJSONSink) Send(_ context.Context, batch []models.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	enc := json.NewEncoder(s.w)
	for _, r := range batch {
		if err := enc.Encode(r); err != nil {
			return err
		}
	}
	return s.w.Flush()
}

// SummarySink computes, in memory, the same figures the cloud dashboard will
// compute in SQL. It exists so P0 can be verified against Tally's own reports
// before any database exists: if these numbers are wrong, the pipeline is
// wrong, and no amount of backend work will fix it.
type SummarySink struct {
	mu sync.Mutex

	Records    int
	Ledgers    int
	Vouchers   int
	SalesPaise int64
	PurchPaise int64
	Receivable int64
	Payable    int64
	CashPaise  int64
	ItemSales  map[string]int64
	PartyDues  map[string]int64
	OpenBills  int
}

func NewSummarySink() *SummarySink {
	return &SummarySink{ItemSales: map[string]int64{}, PartyDues: map[string]int64{}}
}

func (s *SummarySink) Send(_ context.Context, batch []models.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, r := range batch {
		s.Records++
		switch r.Kind {
		case "ledger":
			l, ok := r.Data.(models.NormalizedLedger)
			if !ok {
				continue
			}
			s.Ledgers++
			switch {
			case strings.EqualFold(l.Parent, "Sundry Debtors"):
				s.Receivable += l.ClosingPaise
				if l.ClosingPaise > 0 {
					s.PartyDues[l.Name] = l.ClosingPaise
				}
			case strings.EqualFold(l.Parent, "Sundry Creditors"):
				s.Payable += -l.ClosingPaise
			case strings.EqualFold(l.Parent, "Cash-in-Hand"), strings.EqualFold(l.Parent, "Bank Accounts"):
				s.CashPaise += l.ClosingPaise
			}

		case "voucher":
			v, ok := r.Data.(models.NormalizedVoucher)
			if !ok || v.IsCancelled || v.IsOptional {
				continue
			}
			s.Vouchers++
			// Tally credits sales, so a sale carries a negative amount.
			if v.AmountPaise < 0 {
				s.SalesPaise += -v.AmountPaise
			} else {
				s.PurchPaise += v.AmountPaise
			}
			for _, it := range v.Items {
				s.ItemSales[it.Item] += abs64(it.AmountPaise)
			}
			s.OpenBills += len(v.Bills)
		}
	}
	return nil
}

// TopItems returns the highest-selling items by value.
func (s *SummarySink) TopItems(n int) []KV {
	return topN(s.ItemSales, n)
}

// TopDebtors returns the parties owing the most.
func (s *SummarySink) TopDebtors(n int) []KV {
	return topN(s.PartyDues, n)
}

type KV struct {
	Name  string
	Paise int64
}

func topN(m map[string]int64, n int) []KV {
	out := make([]KV, 0, len(m))
	for k, v := range m {
		out = append(out, KV{k, v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Paise > out[j].Paise })
	return out[:min(n, len(out))]
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// TeeSink fans one batch out to several sinks, stopping at the first error.
type TeeSink struct{ Sinks []Sink }

func (t TeeSink) Send(ctx context.Context, batch []models.Record) error {
	for _, s := range t.Sinks {
		if err := s.Send(ctx, batch); err != nil {
			return err
		}
	}
	return nil
}
