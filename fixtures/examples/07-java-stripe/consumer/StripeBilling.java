package com.example.shop;

import java.util.ArrayList;
import java.util.List;

/**
 * Minimal Stripe Java-shaped client for the quality harness.
 * Mirrors com.stripe.param.CustomerListParams.startingAfter usage.
 */
public class StripeBilling {

  public static class CustomerListParams {
    private Long limit;
    private String startingAfter; // deprecated — migrate to page
    private String page;

    public CustomerListParams setLimit(Long limit) {
      this.limit = limit;
      return this;
    }

    public CustomerListParams setStartingAfter(String startingAfter) {
      this.startingAfter = startingAfter;
      return this;
    }

    public CustomerListParams setPage(String page) {
      this.page = page;
      return this;
    }

    public String getStartingAfter() {
      return startingAfter;
    }

    public Long getLimit() {
      return limit;
    }

    public String getPage() {
      return page;
    }
  }

  public static class Customer {
    public final String id;
    public final String email;

    public Customer(String id, String email) {
      this.id = id;
      this.email = email;
    }
  }

  private final String apiKey;

  public StripeBilling(String apiKey) {
    this.apiKey = apiKey;
  }

  public List<Customer> listCustomers(CustomerListParams params) {
    // Simulate Stripe customers.list using startingAfter cursor.
    String cursor = params.getStartingAfter();
    List<Customer> out = new ArrayList<>();
    out.add(new Customer("cus_1", "a@example.com"));
    if (cursor != null) {
      out.add(new Customer("cus_2", "b@example.com"));
    }
    return out;
  }

  public List<Customer> iterateAll() {
    List<Customer> all = new ArrayList<>();
    String cursor = null;
    for (int i = 0; i < 10; i++) {
      CustomerListParams params = new CustomerListParams().setLimit(100L);
      if (cursor != null) {
        params.setStartingAfter(cursor);
      }
      List<Customer> batch = listCustomers(params);
      if (batch.isEmpty()) break;
      all.addAll(batch);
      cursor = batch.get(batch.size() - 1).id;
      if (batch.size() < 100) break;
    }
    return all;
  }
}
