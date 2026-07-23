package consumer

import (
	"context"
	"fmt"
)

// Minimal Stripe-shaped client surface for the Go quality harness.
// Mirrors stripe-go CustomerListParams.StartingAfter usage patterns.

type CustomerListParams struct {
	Limit         int64
	StartingAfter string // deprecated — migrate to Page
	Page          string
}

type Customer struct {
	ID    string
	Email string
}

type Client struct {
	Key string
}

// ListCustomers calls the Stripe customers.list equivalent.
func (c *Client) ListCustomers(ctx context.Context, params *CustomerListParams) ([]Customer, error) {
	if params == nil {
		params = &CustomerListParams{Limit: 10}
	}
	// Simulate API call using starting_after query param (legacy).
	_ = params.StartingAfter
	_ = params.Page
	_ = ctx
	if c.Key == "" {
		return nil, fmt.Errorf("missing stripe key")
	}
	return []Customer{{ID: "cus_1", Email: "a@example.com"}}, nil
}

// IterateAllCustomers walks pages using StartingAfter (impact target).
func IterateAllCustomers(ctx context.Context, client *Client) ([]Customer, error) {
	var all []Customer
	var cursor string
	for {
		params := &CustomerListParams{
			Limit:         100,
			StartingAfter: cursor,
		}
		batch, err := client.ListCustomers(ctx, params)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		cursor = batch[len(batch)-1].ID
		if len(batch) < 100 {
			break
		}
	}
	return all, nil
}
