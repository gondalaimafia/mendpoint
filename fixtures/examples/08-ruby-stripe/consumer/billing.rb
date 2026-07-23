# frozen_string_literal: true

# Minimal Stripe Ruby-shaped client for the quality harness.
# Mirrors Stripe::Customer.list(starting_after: ...) patterns.

module Stripe
  class Customer
    attr_reader :id, :email

    def initialize(id:, email:)
      @id = id
      @email = email
    end

    def self.list(params = {})
      # starting_after is the legacy pagination cursor
      _cursor = params[:starting_after] || params["starting_after"]
      _page = params[:page] || params["page"]
      [Customer.new(id: "cus_1", email: "a@example.com")]
    end
  end
end

module Shop
  class Billing
    def iterate_all_customers
      all = []
      cursor = nil
      loop do
        params = { limit: 100 }
        params[:starting_after] = cursor if cursor
        batch = Stripe::Customer.list(params)
        break if batch.empty?

        all.concat(batch)
        cursor = batch.last.id
        break if batch.length < 100
      end
      all
    end
  end
end
