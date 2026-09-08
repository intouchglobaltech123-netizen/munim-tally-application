package sync

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Cursor is the incremental-sync position for one company.
//
// Masters and vouchers have SEPARATE AlterID sequences in Tally, so they need
// separate cursors. Using one for both silently skips records.
type Cursor struct {
	CompanyGUID  string `json:"companyGuid"`
	CompanyName  string `json:"companyName"`
	MasterAlter  int64  `json:"masterAlterId"`
	VoucherAlter int64  `json:"voucherAlterId"`
	LastSyncedAt string `json:"lastSyncedAt,omitempty"`
}

// Store persists cursors across restarts.
//
// A JSON file is fine for P0. Before shipping, move to BoltDB: this file is
// rewritten on every successful batch, and a power cut mid-write on a shop PC
// can truncate it. The interface stays the same.
type Store struct {
	path string
	mu   sync.Mutex
	data map[string]*Cursor
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path, data: map[string]*Cursor{}}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, &s.data); err != nil {
		// A corrupt cursor file must not brick the connector. Start clean and
		// let the next sync do a full pull.
		s.data = map[string]*Cursor{}
	}
	return s, nil
}

func (s *Store) Get(companyGUID, name string) *Cursor {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.data[companyGUID]
	if !ok {
		c = &Cursor{CompanyGUID: companyGUID, CompanyName: name}
		s.data[companyGUID] = c
	}
	return c
}

func (s *Store) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	// Write-then-rename so a crash cannot leave a half-written cursor file.
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) All() []*Cursor {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*Cursor, 0, len(s.data))
	for _, c := range s.data {
		out = append(out, c)
	}
	return out
}

func (s *Store) String() string {
	return fmt.Sprintf("cursor store at %s (%d companies)", s.path, len(s.data))
}
