// Command catalog serves the browser bundle in web/ alongside its JSON API.
// A single Go binary hosting its own SPA: the shape this fixture exists to
// represent, and the reason its capability profile has BOTH a web surface and a
// Go backend.
package main

import (
	"encoding/json"
	"net/http"

	"example.com/catalog/internal"
)

func main() {
	http.Handle("/", http.FileServer(http.Dir("web")))
	http.HandleFunc("/api/items", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(internal.ListItems())
	})
	_ = http.ListenAndServe(":8080", nil)
}
