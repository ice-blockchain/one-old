package internal

import "testing"

func TestStoreSeedsProducts(t *testing.T) {
	if len(NewStore().Products()) == 0 {
		t.Fatal("expected the store to seed products")
	}
}
