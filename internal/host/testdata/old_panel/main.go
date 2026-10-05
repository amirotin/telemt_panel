package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println("telemt-panel 1.0.0 (fixture without privileged CLI)")
		return
	}
	fmt.Fprintln(os.Stderr, "this older panel has no privileged command")
	os.Exit(2)
}
