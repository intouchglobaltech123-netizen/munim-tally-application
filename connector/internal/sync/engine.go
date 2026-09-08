package sync

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"munim/connector/internal/models"
	"munim/connector/internal/tally"
)

// BatchSize is how many records go in one ingest request. 500 keeps the
// server-side COPY in one short transaction and the payload under a few MB.
const BatchSize = 500

// ErrAlterIDRegression means Tally's max AlterID is below our stored cursor.
// That happens when the customer restores a backup or rewrites the company.
// The only correct response is a full resync from zero.
var ErrAlterIDRegression = errors.New("sync: AlterID regression detected")

// Sink receives normalized batches. In production this is the cloud API
// client; in the CLI it prints NDJSON. Keeping it an interface is what lets
// the whole sync engine be tested with no network.
type Sink interface {
	// Send must be idempotent from the caller's perspective: the engine will
	// retry the same batch after a failure.
	Send(ctx context.Context, batch []models.Record) error
}

type Engine struct {
	Client *tally.Client
	Store  *Store
	Sink   Sink
	Log    *slog.Logger
}

// Stats is what one company's sync produced.
type Stats struct {
	Company     string
	Masters     int
	Vouchers    int
	Batches     int
	FromMaster  int64
	ToMaster    int64
	FromVoucher int64
	ToVoucher   int64
	Duration    time.Duration
}

// masterCollections are pulled in dependency order: groups classify ledgers,
// ledgers are referenced by vouchers.
var masterCollections = []string{"Group", "Ledger", "StockItem"}

// SyncCompany pulls everything changed since the stored cursors.
//
// The cursor is advanced ONLY after the sink confirms the batch. Advancing
// first and crashing loses vouchers silently, and the customer discovers it at
// month end.
func (e *Engine) SyncCompany(ctx context.Context, companyGUID, companyName string) (*Stats, error) {
	start := time.Now()
	cur := e.Store.Get(companyGUID, companyName)
	st := &Stats{
		Company: companyName, FromMaster: cur.MasterAlter, FromVoucher: cur.VoucherAlter,
	}

	// --- masters ---
	maxMaster := cur.MasterAlter
	for _, coll := range masterCollections {
		env, err := e.Client.Collection(ctx, coll, companyName, cur.MasterAlter)
		if err != nil {
			return st, fmt.Errorf("pull %s: %w", coll, err)
		}
		records := e.normalizeMasters(companyGUID, coll, env)
		high, batches, err := e.flush(ctx, records)
		st.Masters += len(records)
		st.Batches += batches
		if err != nil {
			return st, err
		}
		maxMaster = max(maxMaster, high)
	}

	// --- vouchers ---
	env, err := e.Client.Collection(ctx, "Voucher", companyName, cur.VoucherAlter)
	if err != nil {
		return st, fmt.Errorf("pull Voucher: %w", err)
	}
	vouchers := make([]models.Record, 0, len(env.Collection.Vouchers))
	for _, v := range env.Collection.Vouchers {
		vouchers = append(vouchers, normalizeVoucher(companyGUID, v))
	}
	maxVoucher, batches, err := e.flush(ctx, vouchers)
	st.Vouchers = len(vouchers)
	st.Batches += batches
	if err != nil {
		return st, err
	}

	// A cursor above Tally's own maximum means the book was restored or
	// rewritten. Detect it here rather than reporting "no new data" forever.
	if cur.VoucherAlter > 0 && len(vouchers) == 0 {
		if regressed, err := e.checkRegression(ctx, companyName, cur.VoucherAlter); err == nil && regressed {
			return st, ErrAlterIDRegression
		}
	}

	// Commit both cursors only now that every batch was accepted.
	cur.MasterAlter = max(cur.MasterAlter, maxMaster)
	cur.VoucherAlter = max(cur.VoucherAlter, maxVoucher)
	cur.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
	if err := e.Store.Save(); err != nil {
		return st, fmt.Errorf("persisting cursor: %w", err)
	}

	st.ToMaster, st.ToVoucher = cur.MasterAlter, cur.VoucherAlter
	st.Duration = time.Since(start)
	return st, nil
}

func (e *Engine) normalizeMasters(companyGUID, coll string, env *models.Envelope) []models.Record {
	var out []models.Record
	switch coll {
	case "Group":
		for _, g := range env.Collection.Groups {
			out = append(out, normalizeGroup(companyGUID, g))
		}
	case "Ledger":
		for _, l := range env.Collection.Ledgers {
			out = append(out, normalizeLedger(companyGUID, l))
		}
	case "StockItem":
		for _, s := range env.Collection.StockItems {
			out = append(out, normalizeStockItem(companyGUID, s))
		}
	}
	return out
}

// flush sends records in batches and returns the highest AlterID accepted.
func (e *Engine) flush(ctx context.Context, records []models.Record) (highest int64, batches int, err error) {
	for i := 0; i < len(records); i += BatchSize {
		batch := records[i:min(i+BatchSize, len(records))]
		if err := e.Sink.Send(ctx, batch); err != nil {
			// Return the highest accepted so far; the caller will not advance
			// past it, so the next run resumes from exactly here.
			return highest, batches, fmt.Errorf("sending batch: %w", err)
		}
		batches++
		for _, r := range batch {
			highest = max(highest, r.AlterID)
		}
	}
	return highest, batches, nil
}

// checkRegression asks Tally for its true maximum voucher AlterID.
func (e *Engine) checkRegression(ctx context.Context, companyName string, cursor int64) (bool, error) {
	env, err := e.Client.Collection(ctx, "Voucher", companyName, -1)
	if err != nil {
		return false, err
	}
	var maxSeen int64
	for _, v := range env.Collection.Vouchers {
		maxSeen = max(maxSeen, parseAlter(v.AlterID))
	}
	// An empty company is not a regression - it is an empty company.
	if len(env.Collection.Vouchers) == 0 {
		return false, nil
	}
	return maxSeen < cursor, nil
}

// ResetCompany clears the cursors so the next sync does a full pull.
func (e *Engine) ResetCompany(companyGUID string) error {
	c := e.Store.Get(companyGUID, "")
	c.MasterAlter, c.VoucherAlter = 0, 0
	return e.Store.Save()
}
