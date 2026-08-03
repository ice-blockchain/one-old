package internal

// Product is one catalogue entry.
type Product struct {
	ID    string
	Slug  string
	Title string
}

// Store holds the in-memory catalogue.
type Store struct {
	products []Product
}

// NewStore builds a store seeded with the demo catalogue.
func NewStore() *Store {
	return &Store{products: []Product{
		{ID: "p-1", Slug: "desk-lamp", Title: "Desk Lamp"},
	}}
}

// Products returns every product in the catalogue.
func (s *Store) Products() []Product {
	return s.products
}
