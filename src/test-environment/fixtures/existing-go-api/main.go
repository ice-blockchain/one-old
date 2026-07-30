// Command catalogue serves the product and news catalogue.
package main

import (
	"fmt"

	"example.com/catalogue/internal"
)

func main() {
	store := internal.NewStore()
	fmt.Printf("catalogue ready with %d products\n", len(store.Products()))
}
