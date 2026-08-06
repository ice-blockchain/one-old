package internal

// Item is one catalogue entry served to the browser.
type Item struct {
	ID    string `json:"id"`
	Slug  string `json:"slug"`
	Title string `json:"title"`
}

// ListItems returns the catalogue the SPA renders.
func ListItems() []Item {
	return []Item{
		{ID: "1", Slug: "desk-lamp", Title: "Desk Lamp"},
		{ID: "2", Slug: "wall-clock", Title: "Wall Clock"},
	}
}

// ItemBySlug resolves a single entry by its slug.
func ItemBySlug(slug string) (Item, bool) {
	for _, item := range ListItems() {
		if item.Slug == slug {
			return item, true
		}
	}
	return Item{}, false
}
