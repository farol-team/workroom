require "test_helper"
require_relative "store_contract"

# Memory::Local must satisfy the contract. When Memory::OpenViking lands it gets
# a sibling class here and nothing else changes.
class Memory::LocalContractTest < ActiveSupport::TestCase
  include Memory::StoreContract

  def build_store = Memory::Local.new
end
