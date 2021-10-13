package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	fmt.Println("Starting Go container")

	targetUrl := os.Args[1]

	for {
		resp, err := http.Get(targetUrl)

		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("Got %v response\n", resp.StatusCode)

		time.Sleep(500 * time.Millisecond)
	}

}
