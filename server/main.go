package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	fmt.Println("Ouroboros server starting...")

	http.HandleFunc("/ping", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "pong")
	})

	log.Println("Server running on port 8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}