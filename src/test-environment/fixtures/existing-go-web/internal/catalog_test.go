package internal

import "testing"

func TestListItemsReturnsCatalogue(t *testing.T) {
	if len(ListItems()) == 0 {
		t.Fatal("expected the catalogue to list items")
	}
}

func TestItemBySlugResolves(t *testing.T) {
	if _, ok := ItemBySlug("desk-lamp"); !ok {
		t.Fatal("expected an item with slug \"desk-lamp\"")
	}
	if _, ok := ItemBySlug("missing"); ok {
		t.Fatal("expected no item for an unknown slug")
	}
}
